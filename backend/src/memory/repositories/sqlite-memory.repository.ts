import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { existsSync, mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

import type { AgentUserProfile } from '../../agent/profile/user-profile.types';
import type { EpisodicMemoryEntry, EpisodicMemoryEntryRevision } from '../episodic-memory.types';
import { MemoryStateVersionConflictError } from '../memory-state-version-conflict.error';
import type { ManagedMemoryStateMetadata, ManagedMemoryStateWrite } from '../memory.types';
import type { StructuredMemoryTurnReference } from '../structured-memory-metadata.types';
import type { UserProfileFact, UserProfileFactRevision } from '../user-profile-facts.types';
import { MemoryRepository } from './memory.repository';

interface AgentUserProfileRow {
  profile_key: string;
  preferred_language: AgentUserProfile['communication']['preferredLanguage'];
  tone: AgentUserProfile['communication']['tone'];
  detail: AgentUserProfile['communication']['detail'];
  structure: AgentUserProfile['communication']['structure'];
  allow_pushback: number;
  allow_proactive_suggestions: number;
}

interface UserProfileFactRow {
  scope_key: string;
  fact_key: UserProfileFact['key'];
  fact_value: string;
  source: UserProfileFact['source'];
  confidence: number;
  pinned: number;
  updated_at: string;
  provenance_json: string | null;
  revision: number | null;
  revision_history_json: string | null;
}

interface EpisodicMemoryEntryRow {
  scope_key: string;
  entry_id: string;
  kind: EpisodicMemoryEntry['kind'];
  summary: string;
  source: EpisodicMemoryEntry['source'];
  salience: number;
  pinned: number;
  updated_at: string;
  provenance_json: string | null;
  revision: number | null;
  revision_history_json: string | null;
}

interface ManagedMemoryScopeStateRow {
  scope_key: string;
  version: number;
  last_processed_conversation_id: string | null;
  last_processed_message_id: string | null;
  last_processed_created_at: string | null;
}

@Injectable()
export class SqliteMemoryRepository extends MemoryRepository implements OnModuleInit {
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

  async getInteractionPreferences(scopeKey: string): Promise<AgentUserProfile | undefined> {
    const database = this.getDatabase();
    const row = database
      .prepare(
        `
          SELECT profile_key, preferred_language, tone, detail, structure, allow_pushback, allow_proactive_suggestions
          FROM agent_user_profiles
          WHERE profile_key = ?
        `,
      )
      .get(scopeKey) as AgentUserProfileRow | undefined;

    return row ? this.rowToProfile(row) : undefined;
  }

  async saveInteractionPreferences(scopeKey: string, profile: AgentUserProfile): Promise<void> {
    this.withTransaction((database) => {
      const currentState = this.getStateRow(database, scopeKey);
      this.upsertProfile(database, scopeKey, profile);
      this.upsertState(database, scopeKey, (currentState?.version ?? 0) + 1, this.rowToTurnReference(currentState));
    });
  }

  async getManagedMemoryStateMetadata(scopeKey: string): Promise<ManagedMemoryStateMetadata> {
    const state = this.getStateRow(this.getDatabase(), scopeKey);
    return {
      version: state?.version ?? 0,
      lastProcessedUserMessage: this.rowToTurnReference(state),
    };
  }

  async saveManagedMemoryState(state: ManagedMemoryStateWrite): Promise<void> {
    this.withTransaction((database) => {
      const currentState = this.getStateRow(database, state.scopeKey);
      const currentVersion = currentState?.version ?? 0;

      if (state.expectedVersion !== undefined && state.expectedVersion !== currentVersion) {
        throw new MemoryStateVersionConflictError(state.scopeKey, state.expectedVersion, currentVersion);
      }

      if (state.interactionPreferences) {
        this.upsertProfile(database, state.scopeKey, state.interactionPreferences);
      } else {
        database.prepare(`DELETE FROM agent_user_profiles WHERE profile_key = ?`).run(state.scopeKey);
      }

      this.replaceFacts(database, state.scopeKey, state.userFacts);
      this.replaceEntries(database, state.scopeKey, state.episodicMemories);
      this.upsertState(
        database,
        state.scopeKey,
        currentVersion + 1,
        state.lastProcessedUserMessage ?? this.rowToTurnReference(currentState),
      );
    });
  }

  async getUserProfileFacts(scopeKey: string): Promise<UserProfileFact[]> {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `
          SELECT scope_key, fact_key, fact_value, source, confidence, pinned, updated_at, provenance_json, revision, revision_history_json
          FROM agent_user_profile_facts
          WHERE scope_key = ?
          ORDER BY updated_at DESC, fact_key ASC
        `,
      )
      .all(scopeKey) as unknown as UserProfileFactRow[];

    return rows.map((row) => this.rowToFact(row));
  }

  async saveUserProfileFacts(scopeKey: string, facts: UserProfileFact[]): Promise<void> {
    this.withTransaction((database) => {
      const currentState = this.getStateRow(database, scopeKey);
      this.replaceFacts(database, scopeKey, facts);
      this.upsertState(database, scopeKey, (currentState?.version ?? 0) + 1, this.rowToTurnReference(currentState));
    });
  }

  async getEpisodicMemoryEntries(scopeKey: string): Promise<EpisodicMemoryEntry[]> {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `
          SELECT scope_key, entry_id, kind, summary, source, salience, pinned, updated_at, provenance_json, revision, revision_history_json
          FROM agent_episodic_memory_entries
          WHERE scope_key = ?
          ORDER BY updated_at DESC, entry_id ASC
        `,
      )
      .all(scopeKey) as unknown as EpisodicMemoryEntryRow[];

    return rows.map((row) => this.rowToEntry(row));
  }

  async saveEpisodicMemoryEntries(scopeKey: string, entries: EpisodicMemoryEntry[]): Promise<void> {
    this.withTransaction((database) => {
      const currentState = this.getStateRow(database, scopeKey);
      this.replaceEntries(database, scopeKey, entries);
      this.upsertState(database, scopeKey, (currentState?.version ?? 0) + 1, this.rowToTurnReference(currentState));
    });
  }

  private withTransaction<T>(operation: (database: DatabaseSync) => T): T {
    const database = this.getDatabase();
    database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation(database);
      database.exec('COMMIT');
      return result;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  private getStateRow(database: DatabaseSync, scopeKey: string): ManagedMemoryScopeStateRow | undefined {
    return database
      .prepare(
        `
          SELECT scope_key, version, last_processed_conversation_id, last_processed_message_id, last_processed_created_at
          FROM managed_memory_scope_state
          WHERE scope_key = ?
        `,
      )
      .get(scopeKey) as ManagedMemoryScopeStateRow | undefined;
  }

  private upsertProfile(database: DatabaseSync, scopeKey: string, profile: AgentUserProfile): void {
    database
      .prepare(
        `
          INSERT INTO agent_user_profiles (
            profile_key,
            preferred_language,
            tone,
            detail,
            structure,
            allow_pushback,
            allow_proactive_suggestions,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_key) DO UPDATE SET
            preferred_language = excluded.preferred_language,
            tone = excluded.tone,
            detail = excluded.detail,
            structure = excluded.structure,
            allow_pushback = excluded.allow_pushback,
            allow_proactive_suggestions = excluded.allow_proactive_suggestions,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        scopeKey,
        profile.communication.preferredLanguage,
        profile.communication.tone,
        profile.communication.detail,
        profile.communication.structure,
        profile.interaction.allowPushback ? 1 : 0,
        profile.interaction.allowProactiveSuggestions ? 1 : 0,
        new Date().toISOString(),
      );
  }

  private replaceFacts(database: DatabaseSync, scopeKey: string, facts: UserProfileFact[]): void {
    database.prepare(`DELETE FROM agent_user_profile_facts WHERE scope_key = ?`).run(scopeKey);
    const statement = database.prepare(
      `
        INSERT INTO agent_user_profile_facts (
          scope_key,
          fact_key,
          fact_value,
          source,
          confidence,
          pinned,
          updated_at,
          provenance_json,
          revision,
          revision_history_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const fact of facts) {
      statement.run(
        scopeKey,
        fact.key,
        fact.value,
        fact.source,
        fact.confidence,
        fact.pinned ? 1 : 0,
        fact.updatedAt,
        fact.provenance ? JSON.stringify(fact.provenance) : null,
        fact.revision ?? null,
        fact.revisionHistory ? JSON.stringify(fact.revisionHistory) : null,
      );
    }
  }

  private replaceEntries(database: DatabaseSync, scopeKey: string, entries: EpisodicMemoryEntry[]): void {
    database.prepare(`DELETE FROM agent_episodic_memory_entries WHERE scope_key = ?`).run(scopeKey);
    const statement = database.prepare(
      `
        INSERT INTO agent_episodic_memory_entries (
          scope_key,
          entry_id,
          kind,
          summary,
          source,
          salience,
          pinned,
          updated_at,
          provenance_json,
          revision,
          revision_history_json
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
    );

    for (const entry of entries) {
      statement.run(
        scopeKey,
        entry.id,
        entry.kind,
        entry.summary,
        entry.source,
        entry.salience,
        entry.pinned ? 1 : 0,
        entry.updatedAt,
        entry.provenance ? JSON.stringify(entry.provenance) : null,
        entry.revision ?? null,
        entry.revisionHistory ? JSON.stringify(entry.revisionHistory) : null,
      );
    }
  }

  private upsertState(
    database: DatabaseSync,
    scopeKey: string,
    version: number,
    lastProcessedUserMessage?: StructuredMemoryTurnReference,
  ): void {
    database
      .prepare(
        `
          INSERT INTO managed_memory_scope_state (
            scope_key,
            version,
            last_processed_conversation_id,
            last_processed_message_id,
            last_processed_created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(scope_key) DO UPDATE SET
            version = excluded.version,
            last_processed_conversation_id = excluded.last_processed_conversation_id,
            last_processed_message_id = excluded.last_processed_message_id,
            last_processed_created_at = excluded.last_processed_created_at,
            updated_at = excluded.updated_at
        `,
      )
      .run(
        scopeKey,
        version,
        lastProcessedUserMessage?.conversationId ?? null,
        lastProcessedUserMessage?.messageId ?? null,
        lastProcessedUserMessage?.createdAt ?? null,
        new Date().toISOString(),
      );
  }

  private rowToProfile(row: AgentUserProfileRow): AgentUserProfile {
    return {
      communication: {
        preferredLanguage: row.preferred_language,
        tone: row.tone,
        detail: row.detail,
        structure: row.structure,
      },
      interaction: {
        allowPushback: row.allow_pushback === 1,
        allowProactiveSuggestions: row.allow_proactive_suggestions === 1,
      },
    };
  }

  private rowToFact(row: UserProfileFactRow): UserProfileFact {
    return {
      key: row.fact_key,
      value: row.fact_value,
      source: row.source,
      confidence: Number(row.confidence),
      pinned: row.pinned === 1 || undefined,
      updatedAt: row.updated_at,
      provenance: this.parseJson(row.provenance_json),
      revision: row.revision ?? undefined,
      revisionHistory: this.parseJson<UserProfileFactRevision[]>(row.revision_history_json),
    };
  }

  private rowToEntry(row: EpisodicMemoryEntryRow): EpisodicMemoryEntry {
    return {
      id: row.entry_id,
      kind: row.kind,
      summary: row.summary,
      source: row.source,
      salience: Number(row.salience),
      pinned: row.pinned === 1 || undefined,
      updatedAt: row.updated_at,
      provenance: this.parseJson(row.provenance_json),
      revision: row.revision ?? undefined,
      revisionHistory: this.parseJson<EpisodicMemoryEntryRevision[]>(row.revision_history_json),
    };
  }

  private rowToTurnReference(row?: ManagedMemoryScopeStateRow): StructuredMemoryTurnReference | undefined {
    if (!row?.last_processed_conversation_id || !row.last_processed_message_id || !row.last_processed_created_at) {
      return undefined;
    }

    return {
      conversationId: row.last_processed_conversation_id,
      messageId: row.last_processed_message_id,
      createdAt: row.last_processed_created_at,
    };
  }

  private parseJson<T>(value: string | null | undefined): T | undefined {
    if (!value) {
      return undefined;
    }

    try {
      return JSON.parse(value) as T;
    } catch {
      return undefined;
    }
  }

  private getDatabase(): DatabaseSync {
    if (this.database) {
      return this.database;
    }

    const filePath = this.getDbFilePath();
    const directory = dirname(filePath);
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true });
    }

    const database = new DatabaseSync(filePath);
    database.exec('PRAGMA journal_mode = WAL');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec(`
      CREATE TABLE IF NOT EXISTS agent_user_profiles (
        profile_key TEXT PRIMARY KEY,
        preferred_language TEXT NOT NULL,
        tone TEXT NOT NULL,
        detail TEXT NOT NULL,
        structure TEXT NOT NULL,
        allow_pushback INTEGER NOT NULL,
        allow_proactive_suggestions INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_user_profile_facts (
        scope_key TEXT NOT NULL,
        fact_key TEXT NOT NULL,
        fact_value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
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
        salience REAL NOT NULL,
        pinned INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        provenance_json TEXT,
        revision INTEGER,
        revision_history_json TEXT,
        PRIMARY KEY (scope_key, entry_id)
      );

      CREATE TABLE IF NOT EXISTS managed_memory_scope_state (
        scope_key TEXT PRIMARY KEY,
        version INTEGER NOT NULL,
        last_processed_conversation_id TEXT,
        last_processed_message_id TEXT,
        last_processed_created_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_agent_user_profile_facts_scope_key ON agent_user_profile_facts (scope_key);`);
    database.exec(`CREATE INDEX IF NOT EXISTS idx_agent_episodic_memory_entries_scope_key ON agent_episodic_memory_entries (scope_key);`);

    this.database = database;
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.memoryDbFilePath', 'data/memory.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
