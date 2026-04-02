import { Injectable } from '@nestjs/common';

import { FileStoreService } from '../../storage/file-store.service';
import { TurnExecutionStateRepository } from './turn-execution-state.repository';
import type { TurnExecutionCheckpointInput, TurnExecutionState } from './turn-execution-state.types';

const DEFAULT_TURN_EXECUTION_TTL_MS = 12 * 60 * 60 * 1000;

@Injectable()
export class FileTurnExecutionStateRepository extends TurnExecutionStateRepository {
  constructor(private readonly fileStoreService: FileStoreService) {
    super();
  }

  async save(checkpoint: TurnExecutionCheckpointInput): Promise<TurnExecutionState> {
    return this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      const now = new Date().toISOString();
      const existingIndex = store.turnExecutionStates.findIndex(
        (state) =>
          state.conversationId === checkpoint.conversationId &&
          state.userMessageId === checkpoint.userMessageId &&
          state.scopeKey === checkpoint.scopeKey,
      );
      const existing = existingIndex >= 0 ? store.turnExecutionStates[existingIndex] : undefined;
      const nextState: TurnExecutionState = {
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
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        expiresAt: checkpoint.expiresAt ?? existing?.expiresAt ?? new Date(Date.now() + DEFAULT_TURN_EXECUTION_TTL_MS).toISOString(),
      };

      if (existingIndex >= 0) {
        store.turnExecutionStates[existingIndex] = nextState;
      } else {
        store.turnExecutionStates.push(nextState);
      }

      await this.fileStoreService.writeStore(store);
      return nextState;
    });
  }

  async findActiveByConversation(conversationId: string, scopeKey?: string): Promise<TurnExecutionState | undefined> {
    const store = await this.fileStoreService.readStore();
    const now = Date.now();
    const state = store.turnExecutionStates
      .filter(
        (state) =>
          state.conversationId === conversationId &&
          state.status === 'active' &&
          (!scopeKey || state.scopeKey === scopeKey) &&
          Date.parse(state.expiresAt) > now,
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];

    return state ? this.normalizeState(state) : undefined;
  }

  async listActive(limit = 20): Promise<TurnExecutionState[]> {
    const store = await this.fileStoreService.readStore();
    const now = Date.now();
    return store.turnExecutionStates
      .filter((state) => state.status === 'active' && Date.parse(state.expiresAt) > now)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.max(1, limit))
      .map((state) => this.normalizeState(state));
  }

  async findByUserMessage(
    conversationId: string,
    userMessageId: string,
    scopeKey?: string,
  ): Promise<TurnExecutionState | undefined> {
    const store = await this.fileStoreService.readStore();
    const state = store.turnExecutionStates.find(
      (state) =>
        state.conversationId === conversationId &&
        state.userMessageId === userMessageId &&
        (!scopeKey || state.scopeKey === scopeKey),
    );

    return state ? this.normalizeState(state) : undefined;
  }

  async complete(conversationId: string, userMessageId: string, scopeKey?: string): Promise<void> {
    await this.updateStatus(conversationId, userMessageId, 'completed', undefined, scopeKey);
  }

  async fail(conversationId: string, userMessageId: string, errorCode?: string, scopeKey?: string): Promise<void> {
    await this.updateStatus(conversationId, userMessageId, 'failed', errorCode, scopeKey);
  }

  async expireOlderThan(isoTimestamp: string): Promise<number> {
    return this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      let expired = 0;
      const nextStates = store.turnExecutionStates.map((state) => {
        if (state.status !== 'active' || state.expiresAt >= isoTimestamp) {
          return state;
        }

        expired += 1;
        return {
          ...state,
          status: 'expired' as const,
          updatedAt: new Date().toISOString(),
        };
      });

      if (expired > 0) {
        await this.fileStoreService.writeStore({
          ...store,
          turnExecutionStates: nextStates,
        });
      }

      return expired;
    });
  }

  private async updateStatus(
    conversationId: string,
    userMessageId: string,
    status: TurnExecutionState['status'],
    errorCode?: string,
    scopeKey?: string,
  ): Promise<void> {
    await this.fileStoreService.withWriteLock(async () => {
      const store = await this.fileStoreService.readStore();
      const nextStates = store.turnExecutionStates.map((state) => {
        if (
          state.conversationId !== conversationId ||
          state.userMessageId !== userMessageId ||
          (scopeKey && state.scopeKey !== scopeKey)
        ) {
          return state;
        }

        return {
          ...state,
          status,
          ...(errorCode ? { lastErrorCode: errorCode } : {}),
          updatedAt: new Date().toISOString(),
        };
      });

      await this.fileStoreService.writeStore({
        ...store,
        turnExecutionStates: nextStates,
      });
    });
  }

  private normalizeState(state: TurnExecutionState): TurnExecutionState {
    return {
      ...state,
      budget: {
        provider: state.budget.provider ?? 'unknown',
        model: state.budget.model ?? 'unknown',
        maxContextTokens: state.budget.maxContextTokens ?? 0,
        reservedCompletionTokens: state.budget.reservedCompletionTokens ?? 0,
        reservedRetryTokens: state.budget.reservedRetryTokens ?? 0,
        reservedToolRoundTokens: state.budget.reservedToolRoundTokens ?? 0,
        reservedStructuredFinishTokens: state.budget.reservedStructuredFinishTokens ?? 0,
        availablePromptTokens: state.budget.availablePromptTokens ?? 0,
        estimatedInputTokens: state.budget.estimatedInputTokens ?? 0,
        finalInputTokens: state.budget.finalInputTokens ?? 0,
        trimmedSectionIds: state.budget.trimmedSectionIds ?? [],
        trimmedHistoryCount: state.budget.trimmedHistoryCount ?? 0,
        compressedSectionIds: state.budget.compressedSectionIds ?? [],
        budgetPressure: state.budget.budgetPressure ?? 'low',
      },
    };
  }
}
