import { Inject, Injectable } from '@nestjs/common';

import {
  TURN_EXECUTION_STATE_REPOSITORY,
  TurnExecutionStateRepository,
} from './turn-execution-state.repository';
import type { TurnExecutionCheckpointInput, TurnExecutionState } from './turn-execution-state.types';

@Injectable()
export class ConversationExecutionStateService {
  constructor(
    @Inject(TURN_EXECUTION_STATE_REPOSITORY)
    private readonly repository: TurnExecutionStateRepository,
  ) {}

  async getActiveCheckpoint(conversationId: string, scopeKey?: string): Promise<TurnExecutionState | undefined> {
    return this.repository.findActiveByConversation(conversationId, scopeKey);
  }

  async listActiveCheckpoints(limit = 20): Promise<TurnExecutionState[]> {
    return this.repository.listActive(limit);
  }

  async getCheckpointByUserMessage(
    conversationId: string,
    userMessageId: string,
    scopeKey?: string,
  ): Promise<TurnExecutionState | undefined> {
    return this.repository.findByUserMessage(conversationId, userMessageId, scopeKey);
  }

  async saveCheckpoint(input: TurnExecutionCheckpointInput): Promise<TurnExecutionState> {
    return this.repository.save(input);
  }

  async completeTurn(conversationId: string, userMessageId: string, scopeKey?: string): Promise<void> {
    await this.repository.complete(conversationId, userMessageId, scopeKey);
  }

  async failTurn(
    conversationId: string,
    userMessageId: string,
    errorCode?: string,
    scopeKey?: string,
  ): Promise<void> {
    await this.repository.fail(conversationId, userMessageId, errorCode, scopeKey);
  }

  async expireStaleCheckpoints(now = new Date()): Promise<number> {
    return this.repository.expireOlderThan(now.toISOString());
  }
}
