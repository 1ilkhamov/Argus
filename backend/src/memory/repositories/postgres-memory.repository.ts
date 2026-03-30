import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';

import type { AgentUserProfile } from '../../agent/profile/user-profile.types';
import { PostgresConnectionService } from '../../storage/postgres-connection.service';
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
  allow_pushback: boolean;
  allow_proactive_suggestions: boolean;
}

interface UserProfileFactRow {
  scope_key: string;
  fact_key: UserProfileFact['key'];
  fact_value: string;
  source: UserProfileFact['source'];
  confidence: number;
  pinned: boolean;
  updated_at: Date | string;
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
  pinned: boolean;
  updated_at: Date | string;
  provenance_json: string | null;
  revision: number | null;
  revision_history_json: string | null;
}

interface ManagedMemoryScopeStateRow {
  scope_key: string;
  version: number;
  last_processed_conversation_id: string | null;
  last_processed_message_id: string | null;
  last_processed_created_at: Date | string | null;
}

@Injectable()
export class PostgresMemoryRepository extends MemoryRepository {
  constructor(private readonly connectionService: PostgresConnectionService) {
    super();
  }

  async getInteractionPreferences(scopeKey: string): Promise<AgentUserProfile | undefined> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<AgentUserProfileRow>(
      `
        SELECT profile_key, preferred_language, tone, detail, structure, allow_pushback, allow_proactive_suggestions
        FROM agent_user_profiles
        WHERE profile_key = $1
      `,
      [scopeKey],
    );

    return result.rows[0] ? this.rowToProfile(result.rows[0]) : undefined;
  }

  async saveInteractionPreferences(scopeKey: string, profile: AgentUserProfile): Promise<void> {
    await this.withTransaction(async (client) => {
      const currentState = await this.getStateRow(client, scopeKey);
      await this.upsertProfile(client, scopeKey, profile);
      await this.upsertState(client, scopeKey, Number(currentState?.version ?? 0) + 1, this.rowToTurnReference(currentState));
    });
  }

  async getManagedMemoryStateMetadata(scopeKey: string): Promise<ManagedMemoryStateMetadata> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<ManagedMemoryScopeStateRow>(
      `
        SELECT scope_key, version, last_processed_conversation_id, last_processed_message_id, last_processed_created_at
        FROM managed_memory_scope_state
        WHERE scope_key = $1
      `,
      [scopeKey],
    );
    const state = result.rows[0];
    return {
      version: Number(state?.version ?? 0),
      lastProcessedUserMessage: this.rowToTurnReference(state),
    };
  }

  async saveManagedMemoryState(state: ManagedMemoryStateWrite): Promise<void> {
    await this.withTransaction(async (client) => {
      const currentState = await this.getStateRow(client, state.scopeKey);
      const currentVersion = Number(currentState?.version ?? 0);

      if (state.expectedVersion !== undefined && state.expectedVersion !== currentVersion) {
        throw new MemoryStateVersionConflictError(state.scopeKey, state.expectedVersion, currentVersion);
      }

      if (state.interactionPreferences) {
        await this.upsertProfile(client, state.scopeKey, state.interactionPreferences);
      } else {
        await client.query(`DELETE FROM agent_user_profiles WHERE profile_key = $1`, [state.scopeKey]);
      }

      await this.replaceFacts(client, state.scopeKey, state.userFacts);
      await this.replaceEntries(client, state.scopeKey, state.episodicMemories);
      await this.upsertState(
        client,
        state.scopeKey,
        currentVersion + 1,
        state.lastProcessedUserMessage ?? this.rowToTurnReference(currentState),
      );
    });
  }

  async getUserProfileFacts(scopeKey: string): Promise<UserProfileFact[]> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<UserProfileFactRow>(
      `
        SELECT scope_key, fact_key, fact_value, source, confidence, pinned, updated_at, provenance_json, revision, revision_history_json
        FROM agent_user_profile_facts
        WHERE scope_key = $1
        ORDER BY updated_at DESC, fact_key ASC
      `,
      [scopeKey],
    );

    return result.rows.map((row) => this.rowToFact(row));
  }

  async saveUserProfileFacts(scopeKey: string, facts: UserProfileFact[]): Promise<void> {
    await this.withTransaction(async (client) => {
      const currentState = await this.getStateRow(client, scopeKey);
      await this.replaceFacts(client, scopeKey, facts);
      await this.upsertState(client, scopeKey, Number(currentState?.version ?? 0) + 1, this.rowToTurnReference(currentState));
    });
  }

  async getEpisodicMemoryEntries(scopeKey: string): Promise<EpisodicMemoryEntry[]> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<EpisodicMemoryEntryRow>(
      `
        SELECT scope_key, entry_id, kind, summary, source, salience, pinned, updated_at, provenance_json, revision, revision_history_json
        FROM agent_episodic_memory_entries
        WHERE scope_key = $1
        ORDER BY updated_at DESC, entry_id ASC
      `,
      [scopeKey],
    );

    return result.rows.map((row) => this.rowToEntry(row));
  }

  async saveEpisodicMemoryEntries(scopeKey: string, entries: EpisodicMemoryEntry[]): Promise<void> {
    await this.withTransaction(async (client) => {
      const currentState = await this.getStateRow(client, scopeKey);
      await this.replaceEntries(client, scopeKey, entries);
      await this.upsertState(client, scopeKey, Number(currentState?.version ?? 0) + 1, this.rowToTurnReference(currentState));
    });
  }

  private async withTransaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const pool = await this.connectionService.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async getStateRow(client: PoolClient, scopeKey: string): Promise<ManagedMemoryScopeStateRow | undefined> {
    const result = await client.query<ManagedMemoryScopeStateRow>(
      `
        SELECT scope_key, version, last_processed_conversation_id, last_processed_message_id, last_processed_created_at
        FROM managed_memory_scope_state
        WHERE scope_key = $1
      `,
      [scopeKey],
    );

    return result.rows[0];
  }

  private async upsertProfile(client: PoolClient, scopeKey: string, profile: AgentUserProfile): Promise<void> {
    await client.query(
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT(profile_key) DO UPDATE SET
          preferred_language = EXCLUDED.preferred_language,
          tone = EXCLUDED.tone,
          detail = EXCLUDED.detail,
          structure = EXCLUDED.structure,
          allow_pushback = EXCLUDED.allow_pushback,
          allow_proactive_suggestions = EXCLUDED.allow_proactive_suggestions,
          updated_at = EXCLUDED.updated_at
      `,
      [
        scopeKey,
        profile.communication.preferredLanguage,
        profile.communication.tone,
        profile.communication.detail,
        profile.communication.structure,
        profile.interaction.allowPushback,
        profile.interaction.allowProactiveSuggestions,
        new Date().toISOString(),
      ],
    );
  }

  private async replaceFacts(client: PoolClient, scopeKey: string, facts: UserProfileFact[]): Promise<void> {
    await client.query(`DELETE FROM agent_user_profile_facts WHERE scope_key = $1`, [scopeKey]);
    for (const fact of facts) {
      await client.query(
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        `,
        [
          scopeKey,
          fact.key,
          fact.value,
          fact.source,
          fact.confidence,
          fact.pinned ?? false,
          fact.updatedAt,
          fact.provenance ? JSON.stringify(fact.provenance) : null,
          fact.revision ?? null,
          fact.revisionHistory ? JSON.stringify(fact.revisionHistory) : null,
        ],
      );
    }
  }

  private async replaceEntries(client: PoolClient, scopeKey: string, entries: EpisodicMemoryEntry[]): Promise<void> {
    await client.query(`DELETE FROM agent_episodic_memory_entries WHERE scope_key = $1`, [scopeKey]);
    for (const entry of entries) {
      await client.query(
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
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          scopeKey,
          entry.id,
          entry.kind,
          entry.summary,
          entry.source,
          entry.salience,
          entry.pinned ?? false,
          entry.updatedAt,
          entry.provenance ? JSON.stringify(entry.provenance) : null,
          entry.revision ?? null,
          entry.revisionHistory ? JSON.stringify(entry.revisionHistory) : null,
        ],
      );
    }
  }

  private async upsertState(
    client: PoolClient,
    scopeKey: string,
    version: number,
    lastProcessedUserMessage?: StructuredMemoryTurnReference,
  ): Promise<void> {
    await client.query(
      `
        INSERT INTO managed_memory_scope_state (
          scope_key,
          version,
          last_processed_conversation_id,
          last_processed_message_id,
          last_processed_created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(scope_key) DO UPDATE SET
          version = EXCLUDED.version,
          last_processed_conversation_id = EXCLUDED.last_processed_conversation_id,
          last_processed_message_id = EXCLUDED.last_processed_message_id,
          last_processed_created_at = EXCLUDED.last_processed_created_at,
          updated_at = EXCLUDED.updated_at
      `,
      [
        scopeKey,
        version,
        lastProcessedUserMessage?.conversationId ?? null,
        lastProcessedUserMessage?.messageId ?? null,
        lastProcessedUserMessage?.createdAt ?? null,
        new Date().toISOString(),
      ],
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
        allowPushback: row.allow_pushback,
        allowProactiveSuggestions: row.allow_proactive_suggestions,
      },
    };
  }

  private rowToFact(row: UserProfileFactRow): UserProfileFact {
    return {
      key: row.fact_key,
      value: row.fact_value,
      source: row.source,
      confidence: Number(row.confidence),
      pinned: row.pinned || undefined,
      updatedAt: new Date(row.updated_at).toISOString(),
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
      pinned: row.pinned || undefined,
      updatedAt: new Date(row.updated_at).toISOString(),
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
      createdAt: new Date(row.last_processed_created_at).toISOString(),
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
}
