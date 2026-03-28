import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { stat } from 'fs/promises';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

import type { ArchivedChatMessageHit, ArchivedChatSearchRequest } from '../../memory/archive/archive-chat-retrieval.types';
import { Conversation } from '../entities/conversation.entity';
import { Message } from '../entities/message.entity';
import { ChatRepository } from './chat.repository';

interface FileStoreData {
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
export class SqliteChatRepository extends ChatRepository implements OnModuleInit {
  private readonly logger = new Logger(SqliteChatRepository.name);
  private database?: DatabaseSync;

  constructor(private readonly configService: ConfigService) {
    super();
  }

  onModuleInit(): void {
    const storageDriver = this.configService.get<string>('storage.driver', 'sqlite');
    if (storageDriver !== 'sqlite') {
      return;
    }

    this.getDatabase();
  }

  async createConversation(scopeKey?: string): Promise<Conversation> {
    const conversation = new Conversation({ scopeKey });
    await this.saveConversation(conversation);
    return conversation;
  }

  async getConversation(id: string, scopeKey?: string): Promise<Conversation | undefined> {
    const database = this.getDatabase();
    const scopeClause = scopeKey ? 'AND scope_key = ?' : '';
    const rawConversation = database
      .prepare(
        `
          SELECT id, scope_key, title, created_at, updated_at
          FROM conversations
          WHERE id = ?
          ${scopeClause}
        `,
      )
      .get(...(scopeKey ? [id, scopeKey] : [id])) as
      | {
          id: string;
          scope_key: string;
          title: string;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!rawConversation) {
      return undefined;
    }

    const rawMessages = database
      .prepare(
        `
          SELECT id, conversation_id, role, content, created_at
          FROM messages
          WHERE conversation_id = ?
          ORDER BY position ASC
        `,
      )
      .all(id) as Array<{
      id: string;
      conversation_id: string;
      role: Message['role'];
      content: string;
      created_at: string;
    }>;

    return new Conversation({
      id: rawConversation.id,
      scopeKey: rawConversation.scope_key,
      title: rawConversation.title,
      createdAt: new Date(rawConversation.created_at),
      updatedAt: new Date(rawConversation.updated_at),
      messages: rawMessages.map(
        (message) =>
          new Message({
            id: message.id,
            conversationId: message.conversation_id,
            role: message.role,
            content: message.content,
            createdAt: new Date(message.created_at),
          }),
      ),
    });
  }

  async getAllConversations(scopeKey?: string): Promise<Conversation[]> {
    const database = this.getDatabase();
    const conversations = scopeKey
      ? (database
          .prepare(
            `
              SELECT id
              FROM conversations
              WHERE scope_key = ?
              ORDER BY updated_at DESC
            `,
          )
          .all(scopeKey) as Array<{ id: string }>)
      : (database
          .prepare(
            `
              SELECT id
              FROM conversations
              ORDER BY updated_at DESC
            `,
          )
          .all() as Array<{ id: string }>);

    const hydrated = await Promise.all(conversations.map(async ({ id }) => this.getConversation(id, scopeKey)));

    return hydrated.filter((conversation): conversation is Conversation => Boolean(conversation));
  }

  async saveConversation(conversation: Conversation): Promise<void> {
    const database = this.getDatabase();

    try {
      database.exec('BEGIN IMMEDIATE');
      database
        .prepare(
          `
            INSERT INTO conversations (id, scope_key, title, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              scope_key = excluded.scope_key,
              title = excluded.title,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at
          `,
        )
        .run(
          conversation.id,
          conversation.scopeKey,
          conversation.title,
          conversation.createdAt.toISOString(),
          conversation.updatedAt.toISOString(),
        );

      database.prepare('DELETE FROM messages WHERE conversation_id = ?').run(conversation.id);

      const insertMessage = database.prepare(
        `
          INSERT INTO messages (id, conversation_id, role, content, created_at, position)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      );

      conversation.messages.forEach((message, index) => {
        insertMessage.run(
          message.id,
          message.conversationId,
          message.role,
          message.content,
          message.createdAt.toISOString(),
          index,
        );
      });

      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async deleteConversation(id: string, scopeKey?: string): Promise<boolean> {
    const database = this.getDatabase();
    const result = database
      .prepare(`DELETE FROM conversations WHERE id = ?${scopeKey ? ' AND scope_key = ?' : ''}`)
      .run(...(scopeKey ? [id, scopeKey] : [id])) as {
      changes?: number;
    };

    return (result.changes ?? 0) > 0;
  }

  async searchArchivedChatMessages(request: ArchivedChatSearchRequest): Promise<ArchivedChatMessageHit[]> {
    const database = this.getDatabase();
    const tokens = request.tokens.map((token) => token.toLocaleLowerCase()).filter((token) => token.length > 0);
    if (tokens.length === 0) {
      return [];
    }

    try {
      const matchQuery = tokens.map((token) => token.replace(/[^\p{L}\p{N}_-]+/gu, ' ').trim()).filter(Boolean).join(' OR ');
      if (!matchQuery) {
        return [];
      }

      const params: string[] = [matchQuery];
      const filters: string[] = [];
      if (request.scopeKey) {
        filters.push('c.scope_key = ?');
        params.push(request.scopeKey);
      }
      if (request.excludeConversationId) {
        filters.push('m.conversation_id != ?');
        params.push(request.excludeConversationId);
      }

      const filterClause = filters.length > 0 ? `AND ${filters.join(' AND ')}` : '';
      const query = `
        SELECT m.id AS message_id,
               m.conversation_id,
               m.role,
               m.content,
               m.created_at,
               c.updated_at AS conversation_updated_at
        FROM messages_fts f
        JOIN messages m ON m.id = f.id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE f.content MATCH ?
        ${filterClause}
        ORDER BY c.updated_at DESC
        LIMIT ${Math.max(request.limit * 6, request.limit)}
      `;

      const rows = database.prepare(query).all(...params) as Array<{
        message_id: string;
        conversation_id: string;
        role: 'user' | 'assistant' | 'system';
        content: string;
        created_at: string;
        conversation_updated_at: string;
      }>;

      const scored = rows
        .map((row) => {
          const normalized = (row.content ?? '').toLocaleLowerCase();
          let matchCount = 0;
          for (const token of tokens) {
            if (normalized.includes(token)) {
              matchCount += 1;
            }
          }

          return {
            conversationId: row.conversation_id,
            messageId: row.message_id,
            role: row.role,
            content: row.content,
            createdAt: row.created_at,
            conversationUpdatedAt: row.conversation_updated_at,
            matchCount,
          } satisfies ArchivedChatMessageHit;
        })
        .filter((hit) => hit.matchCount > 0);

      return scored
        .sort((left, right) => {
          if (right.matchCount !== left.matchCount) {
            return right.matchCount - left.matchCount;
          }

          return right.conversationUpdatedAt.localeCompare(left.conversationUpdatedAt);
        })
        .slice(0, request.limit);
    } catch {
      // fall through to LIKE-based scan
    }

    const clauses = tokens.map(() => 'LOWER(m.content) LIKE ?').join(' OR ');
    const params: string[] = [];
    const filters: string[] = [];
    if (request.scopeKey) {
      filters.push('c.scope_key = ?');
      params.push(request.scopeKey);
    }
    if (request.excludeConversationId) {
      filters.push('m.conversation_id != ?');
      params.push(request.excludeConversationId);
    }
    params.push(...tokens.map((token) => `%${token}%`));

    const whereConversation = filters.length > 0 ? `${filters.join(' AND ')} AND` : '';
    const query = `
      SELECT m.id AS message_id, m.conversation_id, m.role, m.content, m.created_at, c.updated_at AS conversation_updated_at
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      WHERE ${whereConversation} (${clauses})
      ORDER BY c.updated_at DESC
      LIMIT ${Math.max(request.limit * 6, request.limit)}
    `;

    const rows = database.prepare(query).all(...params) as Array<{
      message_id: string;
      conversation_id: string;
      role: 'user' | 'assistant' | 'system';
      content: string;
      created_at: string;
      conversation_updated_at: string;
    }>;

    const scored = rows
      .map((row) => {
        const normalized = (row.content ?? '').toLocaleLowerCase();
        let matchCount = 0;
        for (const token of tokens) {
          if (normalized.includes(token)) {
            matchCount += 1;
          }
        }

        return {
          conversationId: row.conversation_id,
          messageId: row.message_id,
          role: row.role,
          content: row.content,
          createdAt: row.created_at,
          conversationUpdatedAt: row.conversation_updated_at,
          matchCount,
        } satisfies ArchivedChatMessageHit;
      })
      .filter((hit) => hit.matchCount > 0);

    return scored
      .sort((left, right) => {
        if (right.matchCount !== left.matchCount) {
          return right.matchCount - left.matchCount;
        }

        return right.conversationUpdatedAt.localeCompare(left.conversationUpdatedAt);
      })
      .slice(0, request.limit);
  }

  async checkHealth(): Promise<{
    status: 'up' | 'down';
    driver: string;
    target: string;
    conversationCount: number;
    error?: string;
  }> {
    try {
      const database = this.getDatabase();
      const filePath = this.getDbFilePath();
      await stat(filePath);
      const row = database.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number };

      return {
        status: 'up',
        driver: 'sqlite',
        target: filePath,
        conversationCount: row.count,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown storage error';
      return {
        status: 'down',
        driver: 'sqlite',
        target: this.getDbFilePath(),
        conversationCount: 0,
        error: message,
      };
    }
  }

  private getDatabase(): DatabaseSync {
    if (this.database) {
      return this.database;
    }

    const filePath = this.getDbFilePath();
    mkdirSync(dirname(filePath), { recursive: true });

    const database = new DatabaseSync(filePath);
    database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY,
        scope_key TEXT NOT NULL DEFAULT 'local:default',
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        position INTEGER NOT NULL,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
      USING fts5(id UNINDEXED, content, tokenize='unicode61');

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts (id, content) VALUES (new.id, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        DELETE FROM messages_fts WHERE id = old.id;
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
        UPDATE messages_fts SET content = new.content WHERE id = old.id;
      END;

      CREATE INDEX IF NOT EXISTS idx_messages_conversation_id_position
      ON messages (conversation_id, position);

      CREATE INDEX IF NOT EXISTS idx_conversations_updated_at
      ON conversations (updated_at DESC);

    `);

    const conversationColumns = database
      .prepare(`PRAGMA table_info(conversations)`)
      .all() as Array<{ name: string }>;
    if (!conversationColumns.some((column) => column.name === 'scope_key')) {
      database.exec(`ALTER TABLE conversations ADD COLUMN scope_key TEXT NOT NULL DEFAULT 'local:default';`);
    }
    database.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_scope_key ON conversations (scope_key);`);

    this.database = database;
    try {
      database.exec(`INSERT INTO messages_fts(messages_fts) VALUES('rebuild');`);
    } catch {
      // ignore: FTS might not be available in the underlying build
    }
    this.migrateFromJsonStoreIfNeeded(database);
    return database;
  }

  private migrateFromJsonStoreIfNeeded(database: DatabaseSync): void {
    const existing = database.prepare('SELECT COUNT(*) AS count FROM conversations').get() as { count: number };

    if (existing.count > 0) {
      return;
    }

    const filePath = this.getLegacyDataFilePath();
    if (!existsSync(filePath)) {
      return;
    }

    try {
      const raw = readFileSync(filePath, 'utf-8').trim();
      if (!raw) {
        return;
      }

      const parsed = JSON.parse(raw) as FileStoreData;
      const conversations = Array.isArray(parsed.conversations) ? parsed.conversations : [];
      if (conversations.length === 0) {
        return;
      }

      const insertConversation = database.prepare(
        `
          INSERT INTO conversations (id, title, created_at, updated_at)
          VALUES (?, ?, ?, ?)
        `,
      );
      const insertMessage = database.prepare(
        `
          INSERT INTO messages (id, conversation_id, role, content, created_at, position)
          VALUES (?, ?, ?, ?, ?, ?)
        `,
      );

      database.exec('BEGIN IMMEDIATE');
      for (const conversation of conversations) {
        insertConversation.run(
          conversation.id,
          conversation.title,
          conversation.createdAt,
          conversation.updatedAt,
        );

        const messages = Array.isArray(conversation.messages) ? conversation.messages : [];
        messages.forEach((message, index) => {
          insertMessage.run(
            message.id,
            message.conversationId,
            message.role,
            message.content,
            message.createdAt,
            index,
          );
        });
      }
      database.exec('COMMIT');
      this.logger.log(`Migrated ${conversations.length} conversations from JSON store to SQLite`);
    } catch (error) {
      database.exec('ROLLBACK');
      const message = error instanceof Error ? error.message : 'Unknown migration error';
      this.logger.warn(`SQLite migration skipped: ${message}`);
    }
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.dbFilePath', 'data/chat-store.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }

  private getLegacyDataFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.dataFilePath', 'data/chat-store.json');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
