import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdirSync } from 'fs';
import { dirname, isAbsolute, resolve } from 'path';
import { DatabaseSync } from 'node:sqlite';

import { TurnExecutionStateRepository } from './turn-execution-state.repository';
import type { TurnExecutionCheckpointInput, TurnExecutionState } from './turn-execution-state.types';

interface TurnExecutionStateRow {
  conversation_id: string;
  scope_key: string;
  user_message_id: string;
  mode: TurnExecutionState['mode'];
  phase: TurnExecutionState['phase'];
  status: TurnExecutionState['status'];
  working_summary: string;
  remaining_steps_json: string;
  partial_response: string | null;
  last_error_code: string | null;
  budget_json: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

const DEFAULT_TURN_EXECUTION_TTL_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class SqliteTurnExecutionStateRepository extends TurnExecutionStateRepository implements OnModuleInit {
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

  async save(checkpoint: TurnExecutionCheckpointInput): Promise<TurnExecutionState> {
    const database = this.getDatabase();
    const existing = database
      .prepare(
        `
          SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
                 partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
          FROM turn_execution_states
          WHERE conversation_id = ? AND user_message_id = ? AND scope_key = ?
        `,
      )
      .get(checkpoint.conversationId, checkpoint.userMessageId, checkpoint.scopeKey) as TurnExecutionStateRow | undefined;

    const now = new Date().toISOString();
    const state: TurnExecutionState = {
      conversationId: checkpoint.conversationId,
      scopeKey: checkpoint.scopeKey,
      userMessageId: checkpoint.userMessageId,
      mode: checkpoint.mode,
      phase: checkpoint.phase,
      status: 'active',
      workingSummary: checkpoint.workingSummary,
      remainingSteps: [...checkpoint.remainingSteps],
      ...(checkpoint.partialResponse ? { partialResponse: checkpoint.partialResponse } : {}),
      ...(checkpoint.lastErrorCode ? { lastErrorCode: checkpoint.lastErrorCode } : {}),
      budget: checkpoint.budget,
      createdAt: existing?.created_at ?? now,
      updatedAt: now,
      expiresAt: checkpoint.expiresAt ?? existing?.expires_at ?? new Date(Date.now() + DEFAULT_TURN_EXECUTION_TTL_MS).toISOString(),
    };

    database
      .prepare(
        `
          INSERT INTO turn_execution_states (
            conversation_id,
            scope_key,
            user_message_id,
            mode,
            phase,
            status,
            working_summary,
            remaining_steps_json,
            partial_response,
            last_error_code,
            budget_json,
            created_at,
            updated_at,
            expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id, user_message_id, scope_key) DO UPDATE SET
            mode = excluded.mode,
            phase = excluded.phase,
            status = excluded.status,
            working_summary = excluded.working_summary,
            remaining_steps_json = excluded.remaining_steps_json,
            partial_response = excluded.partial_response,
            last_error_code = excluded.last_error_code,
            budget_json = excluded.budget_json,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
        `,
      )
      .run(
        state.conversationId,
        state.scopeKey,
        state.userMessageId,
        state.mode,
        state.phase,
        state.status,
        state.workingSummary,
        JSON.stringify(state.remainingSteps),
        state.partialResponse ?? null,
        state.lastErrorCode ?? null,
        JSON.stringify(state.budget),
        state.createdAt,
        state.updatedAt,
        state.expiresAt,
      );

    return state;
  }

  async findActiveByConversation(conversationId: string, scopeKey?: string): Promise<TurnExecutionState | undefined> {
    const database = this.getDatabase();
    const row = database
      .prepare(
        `
          SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
                 partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
          FROM turn_execution_states
          WHERE conversation_id = ?
            ${scopeKey ? 'AND scope_key = ?' : ''}
            AND status = 'active'
            AND expires_at > ?
          ORDER BY updated_at DESC
          LIMIT 1
        `,
      )
      .get(...(scopeKey ? [conversationId, scopeKey, new Date().toISOString()] : [conversationId, new Date().toISOString()])) as
      | TurnExecutionStateRow
      | undefined;

    return row ? this.rowToState(row) : undefined;
  }

  async listActive(limit = 20): Promise<TurnExecutionState[]> {
    const database = this.getDatabase();
    const rows = database
      .prepare(
        `
          SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
                 partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
          FROM turn_execution_states
          WHERE status = 'active' AND expires_at > ?
          ORDER BY updated_at DESC
          LIMIT ?
        `,
      )
      .all(new Date().toISOString(), Math.max(1, limit)) as unknown as TurnExecutionStateRow[];

    return rows.map((row) => this.rowToState(row));
  }

  async findByUserMessage(
    conversationId: string,
    userMessageId: string,
    scopeKey?: string,
  ): Promise<TurnExecutionState | undefined> {
    const database = this.getDatabase();
    const row = database
      .prepare(
        `
          SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
                 partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
          FROM turn_execution_states
          WHERE conversation_id = ? AND user_message_id = ?
            ${scopeKey ? 'AND scope_key = ?' : ''}
          LIMIT 1
        `,
      )
      .get(...(scopeKey ? [conversationId, userMessageId, scopeKey] : [conversationId, userMessageId])) as
      | TurnExecutionStateRow
      | undefined;

    return row ? this.rowToState(row) : undefined;
  }

  async complete(conversationId: string, userMessageId: string, scopeKey?: string): Promise<void> {
    this.updateStatus(conversationId, userMessageId, 'completed', undefined, scopeKey);
  }

  async fail(conversationId: string, userMessageId: string, errorCode?: string, scopeKey?: string): Promise<void> {
    this.updateStatus(conversationId, userMessageId, 'failed', errorCode, scopeKey);
  }

  async expireOlderThan(isoTimestamp: string): Promise<number> {
    const database = this.getDatabase();
    const result = database
      .prepare(
        `
          UPDATE turn_execution_states
          SET status = 'expired', updated_at = ?
          WHERE status = 'active' AND expires_at <= ?
        `,
      )
      .run(new Date().toISOString(), isoTimestamp) as { changes?: number };

    return result.changes ?? 0;
  }

  private updateStatus(
    conversationId: string,
    userMessageId: string,
    status: TurnExecutionState['status'],
    errorCode?: string,
    scopeKey?: string,
  ): void {
    const database = this.getDatabase();
    database
      .prepare(
        `
          UPDATE turn_execution_states
          SET status = ?,
              updated_at = ?,
              last_error_code = COALESCE(?, last_error_code)
          WHERE conversation_id = ?
            AND user_message_id = ?
            ${scopeKey ? 'AND scope_key = ?' : ''}
        `,
      )
      .run(
        status,
        new Date().toISOString(),
        errorCode ?? null,
        ...(scopeKey ? [conversationId, userMessageId, scopeKey] : [conversationId, userMessageId]),
      );
  }

  private rowToState(row: TurnExecutionStateRow): TurnExecutionState {
    return {
      conversationId: row.conversation_id,
      scopeKey: row.scope_key,
      userMessageId: row.user_message_id,
      mode: row.mode,
      phase: row.phase,
      status: row.status,
      workingSummary: row.working_summary,
      remainingSteps: this.parseStringArray(row.remaining_steps_json),
      ...(row.partial_response ? { partialResponse: row.partial_response } : {}),
      ...(row.last_error_code ? { lastErrorCode: row.last_error_code } : {}),
      budget: this.parseBudget(row.budget_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      expiresAt: row.expires_at,
    };
  }

  private parseStringArray(raw: string): string[] {
    try {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  }

  private parseBudget(raw: string): TurnExecutionState['budget'] {
    try {
      const parsed = JSON.parse(raw) as Partial<TurnExecutionState['budget']>;
      if (parsed && typeof parsed === 'object') {
        return {
          provider: parsed.provider ?? 'unknown',
          model: parsed.model ?? 'unknown',
          maxContextTokens: parsed.maxContextTokens ?? 0,
          reservedCompletionTokens: parsed.reservedCompletionTokens ?? 0,
          reservedRetryTokens: parsed.reservedRetryTokens ?? 0,
          reservedToolRoundTokens: parsed.reservedToolRoundTokens ?? 0,
          reservedStructuredFinishTokens: parsed.reservedStructuredFinishTokens ?? 0,
          availablePromptTokens: parsed.availablePromptTokens ?? 0,
          estimatedInputTokens: parsed.estimatedInputTokens ?? 0,
          finalInputTokens: parsed.finalInputTokens ?? 0,
          trimmedSectionIds: parsed.trimmedSectionIds ?? [],
          trimmedHistoryCount: parsed.trimmedHistoryCount ?? 0,
          compressedSectionIds: parsed.compressedSectionIds ?? [],
          budgetPressure: parsed.budgetPressure ?? 'low',
        };
      }
    } catch {
      // ignore
    }

    return {
      provider: 'unknown',
      model: 'unknown',
      maxContextTokens: 0,
      reservedCompletionTokens: 0,
      reservedRetryTokens: 0,
      reservedToolRoundTokens: 0,
      reservedStructuredFinishTokens: 0,
      availablePromptTokens: 0,
      estimatedInputTokens: 0,
      finalInputTokens: 0,
      trimmedSectionIds: [],
      trimmedHistoryCount: 0,
      compressedSectionIds: [],
      budgetPressure: 'low',
    };
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

      CREATE TABLE IF NOT EXISTS turn_execution_states (
        conversation_id TEXT NOT NULL,
        scope_key TEXT NOT NULL DEFAULT 'local:default',
        user_message_id TEXT NOT NULL,
        mode TEXT NOT NULL,
        phase TEXT NOT NULL,
        status TEXT NOT NULL,
        working_summary TEXT NOT NULL,
        remaining_steps_json TEXT NOT NULL,
        partial_response TEXT,
        last_error_code TEXT,
        budget_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        PRIMARY KEY (conversation_id, user_message_id, scope_key)
      );

      CREATE INDEX IF NOT EXISTS idx_turn_execution_states_active
      ON turn_execution_states (conversation_id, scope_key, status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_turn_execution_states_expires_at
      ON turn_execution_states (expires_at);
    `);

    this.database = database;
    return database;
  }

  private getDbFilePath(): string {
    const configuredPath = this.configService.get<string>('storage.dbFilePath', 'data/chat.db');
    return isAbsolute(configuredPath) ? configuredPath : resolve(process.cwd(), configuredPath);
  }
}
