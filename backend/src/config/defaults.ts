export type SupportedLlmProvider = 'openai' | 'anthropic' | 'google' | 'local';

export const DEFAULT_PORT = 2901;
export const DEFAULT_NODE_ENV = 'development';
export const DEFAULT_CORS_ORIGIN = 'http://localhost:2101';

export const DEFAULT_LLM_PROVIDER: SupportedLlmProvider = 'local';
export const DEFAULT_LLM_API_BASE_LOCAL = 'http://localhost:8317/v1';
export const DEFAULT_LLM_MODEL_LOCAL = 'local-model';
export const DEFAULT_LLM_MAX_TOKENS = 4096;
export const DEFAULT_LLM_TEMPERATURE = 0.7;

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60000;
export const DEFAULT_RATE_LIMIT_MAX_REQUESTS = 60;
export const DEFAULT_RATE_LIMIT_BACKEND = 'sqlite';
export const DEFAULT_RATE_LIMIT_STORE_FILE = 'data/rate-limit.db';

export const DEFAULT_STORAGE_DRIVER = 'sqlite';
export const DEFAULT_STORAGE_DATA_FILE = 'data/chat-store.json';
export const DEFAULT_STORAGE_DB_FILE = 'data/chat.db';
export const DEFAULT_STORAGE_MEMORY_DB_FILE = 'data/memory.db';

export const DEFAULT_EMBEDDING_ENABLED = false;
export const DEFAULT_EMBEDDING_MODEL = '';
export const DEFAULT_EMBEDDING_DIMENSIONS = 0;

export function resolveLlmProvider(value: string | undefined): SupportedLlmProvider {
  if (value === 'openai' || value === 'anthropic' || value === 'google' || value === 'local') {
    return value;
  }

  return DEFAULT_LLM_PROVIDER;
}

export function getDefaultLlmApiBase(provider: SupportedLlmProvider): string {
  if (provider === 'openai') {
    return 'https://api.openai.com/v1';
  }

  if (provider === 'anthropic') {
    return 'https://api.anthropic.com/v1';
  }

  if (provider === 'google') {
    return 'https://generativelanguage.googleapis.com/v1beta';
  }

  return DEFAULT_LLM_API_BASE_LOCAL;
}

export function getDefaultLlmModel(provider: SupportedLlmProvider): string {
  if (provider === 'openai') {
    return 'gpt-5-mini';
  }

  if (provider === 'anthropic') {
    return 'claude-sonnet-4-6';
  }

  if (provider === 'google') {
    return 'gemini-2.5-flash';
  }

  return DEFAULT_LLM_MODEL_LOCAL;
}
