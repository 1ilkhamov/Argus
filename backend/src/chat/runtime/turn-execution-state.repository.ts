import type { TurnExecutionCheckpointInput, TurnExecutionState } from './turn-execution-state.types';

export const TURN_EXECUTION_STATE_REPOSITORY = Symbol('TURN_EXECUTION_STATE_REPOSITORY');

export abstract class TurnExecutionStateRepository {
  abstract save(checkpoint: TurnExecutionCheckpointInput): Promise<TurnExecutionState>;
  abstract findActiveByConversation(conversationId: string, scopeKey?: string): Promise<TurnExecutionState | undefined>;
  abstract listActive(limit?: number): Promise<TurnExecutionState[]>;
  abstract findByUserMessage(conversationId: string, userMessageId: string, scopeKey?: string): Promise<TurnExecutionState | undefined>;
  abstract complete(conversationId: string, userMessageId: string, scopeKey?: string): Promise<void>;
  abstract fail(conversationId: string, userMessageId: string, errorCode?: string, scopeKey?: string): Promise<void>;
  abstract expireOlderThan(isoTimestamp: string): Promise<number>;
}
