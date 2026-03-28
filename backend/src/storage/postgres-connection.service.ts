import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, resolve } from 'path';
import { Pool, type PoolClient } from 'pg';

import type { Message } from '../chat/entities/message.entity';

interface LegacyJsonStoreData {
  conversations?: Array<{
    id: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    messages?: Array<{
      id: string;
      conversationId: string;
      role: Message['role'];
      content: string;
      createdAt: string;
    }>;
  }>;
}

@Injectable()
export class PostgresConnectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostgresConnectionService.name);
  private pool?: Pool;

  constructor(private readonly configService: ConfigService) {}

  async onModuleInit(): Promise<void> {
    const storageDriver = this.configService.get<string>('storage.driver', 'sqlite');
    if (storageDriver !== 'postgres') {
      return;
    }

    await this.getPool();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = undefined;
    }
  }

  async getPool(): Promise<Pool> {
    if (this.pool) {
      return this.pool;
    }

    const pool = new Pool({
      connectionString: this.getPostgresUrl(),
      max: 10,
    });

    await this.initializeSchema(pool);
    await this.migrateFromLegacyStoresIfNeeded(pool);
    this.pool = pool;
    return pool;
  }

  getMaskedPostgresUrl(): string {
    const connectionString = this.getPostgresUrl();
    if (!connectionString) {
      return 'postgres://unconfigured';
    }

    try {
      const url = new URL(connectionString);
      if (url.password) {
        url.password = '***';
      }
      return url.toString();
    } catch {
      return 'postgres://invalid-url';
    }
  }

  private async initializeSchema(client: Pool | PoolClient): Promise<void> {
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'local:default',
        title TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_conversations_scope_key
      ON conversations (scope_key);

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        position INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_position
      ON messages (conversation_id, position);

      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations (updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_content_fts
      ON messages USING GIN (to_tsvector('simple', content));

      CREATE TABLE IF NOT EXISTS agent_user_profiles (
        profile_key TEXT PRIMARY KEY,
        preferred_language TEXT NOT NULL,
        tone TEXT NOT NULL,
        detail TEXT NOT NULL,
        structure TEXT NOT NULL,
        allow_pushback BOOLEAN NOT NULL,
        allow_proactive_suggestions BOOLEAN NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_user_profile_facts (
        scope_key TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        fact_value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence DOUBLE PRECISION NOT NULL,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL,
        provenance_json TEXT,
        revision INTEGER,
        revision_history_json TEXT,
        PRIMARY KEY (scope_key, fact_key)
      );

      CREATE TABLE IF NOT EXISTS agent_episodic_memory_entries (
        scope_key TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        source TEXT NOT NULL,
        salience DOUBLE PRECISION NOT NULL,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL,
        provenance_json TEXT,
        revision INTEGER,
        revision_history_json TEXT,
        PRIMARY KEY (scope_key, entry_id)
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        embedding BYTEA NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        PRIMARY KEY (scope_key, source_type, source_id)
      );

      CREATE TABLE IF NOT EXISTS managed_memory_scope_state (
        scope_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        last_processed_conversation_id TEXT,
        last_processed_message_id TEXT,
        last_processed_created_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL
      );

      -- ═══ Memory v2: unified memory entries ═══

      CREATE TABLE IF NOT EXISTS memory_entries (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'local:default',
        kind TEXT NOT NULL,
        category TEXT,
        content TEXT NOT NULL,
        summary TEXT,
        tags_json TEXT DEFAULT '[]',
        source TEXT NOT NULL,
        provenance_json TEXT,
        horizon TEXT NOT NULL,
        importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
        decay_rate DOUBLE PRECISION NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        pinned BOOLEAN NOT NULL DEFAULT FALSE,
        superseded_by TEXT,
        consolidated_from_json TEXT,
        embedding_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memory_entries_kind ON memory_entries (kind);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_horizon ON memory_entries (horizon);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_importance ON memory_entries (importance DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_updated_at ON memory_entries (updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_source ON memory_entries (source);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_category ON memory_entries (category);
      CREATE INDEX IF NOT EXISTS idx_memory_entries_content_fts
        ON memory_entries USING GIN (to_tsvector('simple', content));
      CREATE INDEX IF NOT EXISTS idx_memory_entries_scope_key ON memory_entries (scope_key);

      -- Migration: add scope_key to existing tables (idempotent)
      DO $$ BEGIN
        ALTER TABLE memory_entries ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'local:default';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;

      -- ═══ Memory v2: knowledge graph ═══

      CREATE TABLE IF NOT EXISTS knowledge_nodes (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        name TEXT NOT NULL,
        properties_json TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_type ON knowledge_nodes (type);
      CREATE INDEX IF NOT EXISTS idx_knowledge_nodes_name ON knowledge_nodes (name);

      CREATE TABLE IF NOT EXISTS knowledge_edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        target_id TEXT NOT NULL REFERENCES knowledge_nodes(id) ON DELETE CASCADE,
        relation TEXT NOT NULL,
        weight DOUBLE PRECISION NOT NULL DEFAULT 1.0,
        properties_json TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        UNIQUE (source_id, target_id, relation)
      );

      CREATE INDEX IF NOT EXISTS idx_knowledge_edges_source ON knowledge_edges (source_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_edges_target ON knowledge_edges (target_id);
      CREATE INDEX IF NOT EXISTS idx_knowledge_edges_relation ON knowledge_edges (relation);
    `);

    await client.query(`ALTER TABLE agent_user_profile_facts ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE agent_episodic_memory_entries ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`ALTER TABLE agent_user_profile_facts ADD COLUMN IF NOT EXISTS provenance_json TEXT`);
    await client.query(`ALTER TABLE agent_user_profile_facts ADD COLUMN IF NOT EXISTS revision INTEGER`);
    await client.query(`ALTER TABLE agent_user_profile_facts ADD COLUMN IF NOT EXISTS revision_history_json TEXT`);
    await client.query(`ALTER TABLE agent_episodic_memory_entries ADD COLUMN IF NOT EXISTS provenance_json TEXT`);
    await client.query(`ALTER TABLE agent_episodic_memory_entries ADD COLUMN IF NOT EXISTS revision INTEGER`);
    await client.query(`ALTER TABLE agent_episodic_memory_entries ADD COLUMN IF NOT EXISTS revision_history_json TEXT`);
    await client.query(`ALTER TABLE managed_memory_scope_state ADD COLUMN IF NOT EXISTS suppressed_facts_json TEXT`);
    await client.query(`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS scope_key TEXT NOT NULL DEFAULT 'local:default'`);
  }

  private async migrateFromLegacyStoresIfNeeded(pool: Pool): Promise<void> {
    const existing = await pool.query<{ count: string }>('SELECT COUNT(*) AS count FROM conversations');
    if (Number.parseInt(existing.rows[0]?.count ?? '0', 10) > 0) {
      return;
    }

    const migratedFromSqlite = await this.migrateFromSqliteIfNeeded(pool);
    if (migratedFromSqlite) {
      return;
    }

    await this.migrateFromJsonIfNeeded(pool);
  }

  private async migrateFromSqliteIfNeeded(pool: Pool): Promise<boolean> {
    const sqlitePath = this.getLegacySqliteFilePath();
    if (!sqlitePath || !existsSync(sqlitePath)) {
      return false;
    }

    try {
      const database = new DatabaseSync(sqlitePath);
      const existing = database.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number };
      if (existing.count === 0) {
        database.close();
        return false;
      }

      const conversations = database.prepare('SELECT id, title, created_at, updated_at FROM conversations').all() as Array<{
        id: string;
        title: string;
        created_at: string;
        updated_at: string;
      }>;
      const messages = database.prepare(
        'SELECT id, conversation_id, role, content, created_at, position FROM messages ORDER BY conversation_id ASC, position ASC',
      ).all() as Array<{
        id: string;
        conversation_id: string;
        role: Message['role'];
        content: string;
        created_at: string;
        position: number;
      }>;
      database.close();

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const conversation of conversations) {
          await client.query(
            `
              INSERT INTO conversations (id, title, created_at, updated_at)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT(id) DO NOTHING
            `,
            [conversation.id, conversation.title, conversation.created_at, conversation.updated_at],
          );
        }

        for (const message of messages) {
          await client.query(
            `
              INSERT INTO messages (id, conversation_id, role, content, created_at, position)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT(id) DO NOTHING
            `,
            [
              message.id,
              message.conversation_id,
              message.role,
              message.content,
              message.created_at,
              message.position,
            ],
          );
        }
        await client.query('COMMIT');
        this.logger.log(`Migrated ${conversations.length} conversations from SQLite to PostgreSQL`);
        return true;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown SQLite migration error';
      this.logger.warn(`PostgreSQL SQLite migration skipped: ${message}`);
      return false;
    }
  }

  private async migrateFromJsonIfNeeded(pool: Pool): Promise<void> {
    const filePath = this.getLegacyJsonFilePath();
    if (!filePath || !existsSync(filePath)) {
      return;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as LegacyJsonStoreData;
      const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
      if (conversations.length === 0) {
        return;
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const conversation of conversations) {
          await client.query(
            `
              INSERT INTO conversations (id, title, created_at, updated_at)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT(id) DO NOTHING
            `,
            [conversation.id, conversation.title, conversation.createdAt, conversation.updatedAt],
          );

          const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
          for (const [index, message] of messages.entries()) {
            await client.query(
              `
                INSERT INTO messages (id, conversation_id, role, content, created_at, position)
                VALUES ($1, $2, $3, $4, $5, $6)
                ON CONFLICT(id) DO NOTHING
              `,
              [
                message.id,
                message.conversationId,
                message.role,
                message.content,
                message.createdAt,
                index,
              ],
            );
          }
        }
        await client.query('COMMIT');
        this.logger.log(`Migrated ${conversations.length} conversations from JSON store to PostgreSQL`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown JSON migration error';
      this.logger.warn(`PostgreSQL JSON migration skipped: ${message}`);
    }
  }

  private getPostgresUrl(): string {
    return this.configService.get<string>('storage.postgresUrl', '');
  }

  private getLegacySqliteFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.dbFilePath', '');
    if (!configuredPath) {
      return '';
    }

    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private getLegacyJsonFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.dataFilePath', '');
    if (!configuredPath) {
      return '';
    }

    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
