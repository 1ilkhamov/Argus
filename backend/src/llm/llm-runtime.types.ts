export type LlmFailureCode = 
  | 'auth'
  | 'budget_exhausted'
  | 'empty_stream'
  | 'malformed_stream'
  | 'rate_limited'
  | 'timeout'
  | 'upstream'
  | 'unknown';

export interface LlmFailureClassification {
  code: LlmFailureCode;
  message: string;
  retryable: boolean;
}

export interface LlmRuntimeProfile {
  provider: string;
  model: string;
  maxCompletionTokens: number;
  contextWindowTokens: number;
  completionTimeoutMs: number;
  streamTimeoutMs: number;
}
