export type TurnExecutionMode = 'standard' | 'staged';

export type TurnExecutionPhase = 'analyze' | 'plan' | 'execute' | 'finalize';

export type TurnExecutionStatus = 'active' | 'completed' | 'expired' | 'failed';

export interface TurnExecutionBudgetSnapshot {
  provider: string;
  model: string;
  maxContextTokens: number;
  reservedCompletionTokens: number;
  reservedRetryTokens: number;
  reservedToolRoundTokens: number;
  reservedStructuredFinishTokens: number;
  availablePromptTokens: number;
  estimatedInputTokens: number;
  finalInputTokens: number;
  trimmedSectionIds: string[];
  trimmedHistoryCount: number;
  compressedSectionIds: string[];
  budgetPressure: 'low' | 'medium' | 'high';
}

export interface TurnExecutionState {
  conversationId: string;
  scopeKey: string;
  userMessageId: string;
  mode: TurnExecutionMode;
  phase: TurnExecutionPhase;
  status: TurnExecutionStatus;
  workingSummary: string;
  remainingSteps: string[];
  partialResponse?: string;
  lastErrorCode?: string;
  budget: TurnExecutionBudgetSnapshot;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
}

export interface TurnExecutionCheckpointInput {
  conversationId: string;
  scopeKey: string;
  userMessageId: string;
  mode: TurnExecutionMode;
  phase: TurnExecutionPhase;
  workingSummary: string;
  remainingSteps: string[];
  partialResponse?: string;
  lastErrorCode?: string;
  budget: TurnExecutionBudgetSnapshot;
  expiresAt?: string;
}
