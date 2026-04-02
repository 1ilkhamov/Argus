import { Injectable } from '@nestjs/common';

import { PostgresConnectionService } from '../../storage/postgres-connection.service';
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
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
}

const DEFAULT_TURN_EXECUTION_TTL_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class PostgresTurnExecutionStateRepository extends TurnExecutionStateRepository {
  constructor(private readonly connectionService: PostgresConnectionService) {
    super();
  }

  async save(checkpoint: TurnExecutionCheckpointInput): Promise<TurnExecutionState> {
    const pool = await this.connectionService.getPool();
    const nowIso = new Date().toISOString();
    const existing = await pool.query<TurnExecutionStateRow>(
      `
        SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
               partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
        FROM turn_execution_states
        WHERE conversation_id = $1 AND user_message_id = $2 AND scope_key = $3
      `,
      [checkpoint.conversationId, checkpoint.userMessageId, checkpoint.scopeKey],
    );

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
      createdAt: existing.rows[0] ? new Date(existing.rows[0].created_at).toISOString() : nowIso,
      updatedAt: nowIso,
      expiresAt:
        checkpoint.expiresAt ??
        (existing.rows[0] ? new Date(existing.rows[0].expires_at).toISOString() : new Date(Date.now() + DEFAULT_TURN_EXECUTION_TTL_MS).toISOString()),
    };

    await pool.query(
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
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT(conversation_id, user_message_id, scope_key) DO UPDATE SET
          mode = EXCLUDED.mode,
          phase = EXCLUDED.phase,
          status = EXCLUDED.status,
          working_summary = EXCLUDED.working_summary,
          remaining_steps_json = EXCLUDED.remaining_steps_json,
          partial_response = EXCLUDED.partial_response,
          last_error_code = EXCLUDED.last_error_code,
          budget_json = EXCLUDED.budget_json,
          updated_at = EXCLUDED.updated_at,
          expires_at = EXCLUDED.expires_at
      `,
      [
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
      ],
    );

    return state;
  }

  async findActiveByConversation(conversationId: string, scopeKey?: string): Promise<TurnExecutionState | undefined> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<TurnExecutionStateRow>(
      `
        SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
               partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
        FROM turn_execution_states
        WHERE conversation_id = $1
          ${scopeKey ? 'AND scope_key = $2' : ''}
          AND status = 'active'
          AND expires_at > ${scopeKey ? '$3' : '$2'}
        ORDER BY updated_at DESC
        LIMIT 1
      `,
      scopeKey ? [conversationId, scopeKey, new Date().toISOString()] : [conversationId, new Date().toISOString()],
    );

    return result.rows[0] ? this.rowToState(result.rows[0]) : undefined;
  }

  async listActive(limit = 20): Promise<TurnExecutionState[]> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<TurnExecutionStateRow>(
      `
        SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
               partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
        FROM turn_execution_states
        WHERE status = 'active'
          AND expires_at > $1
        ORDER BY updated_at DESC
        LIMIT $2
      `,
      [new Date().toISOString(), Math.max(1, limit)],
    );

    return result.rows.map((row) => this.rowToState(row));
  }

  async findByUserMessage(
    conversationId: string,
    userMessageId: string,
    scopeKey?: string,
  ): Promise<TurnExecutionState | undefined> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query<TurnExecutionStateRow>(
      `
        SELECT conversation_id, scope_key, user_message_id, mode, phase, status, working_summary, remaining_steps_json,
               partial_response, last_error_code, budget_json, created_at, updated_at, expires_at
        FROM turn_execution_states
        WHERE conversation_id = $1 AND user_message_id = $2
          ${scopeKey ? 'AND scope_key = $3' : ''}
        LIMIT 1
      `,
      scopeKey ? [conversationId, userMessageId, scopeKey] : [conversationId, userMessageId],
    );

    return result.rows[0] ? this.rowToState(result.rows[0]) : undefined;
  }

  async complete(conversationId: string, userMessageId: string, scopeKey?: string): Promise<void> {
    await this.updateStatus(conversationId, userMessageId, 'completed', undefined, scopeKey);
  }

  async fail(conversationId: string, userMessageId: string, errorCode?: string, scopeKey?: string): Promise<void> {
    await this.updateStatus(conversationId, userMessageId, 'failed', errorCode, scopeKey);
  }

  async expireOlderThan(isoTimestamp: string): Promise<number> {
    const pool = await this.connectionService.getPool();
    const result = await pool.query(
      `
        UPDATE turn_execution_states
        SET status = 'expired', updated_at = $1
        WHERE status = 'active' AND expires_at <= $2
      `,
      [new Date().toISOString(), isoTimestamp],
    );

    return result.rowCount ?? 0;
  }

  private async updateStatus(
    conversationId: string,
    userMessageId: string,
    status: TurnExecutionState['status'],
    errorCode?: string,
    scopeKey?: string,
  ): Promise<void> {
    const pool = await this.connectionService.getPool();
    await pool.query(
      `
        UPDATE turn_execution_states
        SET status = $1,
            updated_at = $2,
            last_error_code = COALESCE($3, last_error_code)
        WHERE conversation_id = $4
          AND user_message_id = $5
          ${scopeKey ? 'AND scope_key = $6' : ''}
      `,
      scopeKey
        ? [status, new Date().toISOString(), errorCode ?? null, conversationId, userMessageId, scopeKey]
        : [status, new Date().toISOString(), errorCode ?? null, conversationId, userMessageId],
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
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
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
}
