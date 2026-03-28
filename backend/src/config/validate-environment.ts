import { resolveEnvValue } from './env.utils';
import {
  DEFAULT_CORS_ORIGIN,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_PROVIDER,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_PORT,
  DEFAULT_RATE_LIMIT_BACKEND,
  DEFAULT_RATE_LIMIT_MAX_REQUESTS,
  DEFAULT_RATE_LIMIT_STORE_FILE,
  DEFAULT_RATE_LIMIT_WINDOW_MS,
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_ENABLED,
  DEFAULT_EMBEDDING_MODEL,
  DEFAULT_STORAGE_DATA_FILE,
  DEFAULT_STORAGE_DB_FILE,
  DEFAULT_STORAGE_DRIVER,
  DEFAULT_STORAGE_MEMORY_DB_FILE,
  SupportedLlmProvider,
  getDefaultLlmApiBase,
  getDefaultLlmModel,
} from './defaults';

type EnvRecord = Record<string, string | undefined>;

const ALLOWED_NODE_ENVS = new Set(['development', 'test', 'production']);
const ALLOWED_STORAGE_DRIVERS = new Set(['file', 'sqlite', 'postgres']);
const ALLOWED_RATE_LIMIT_BACKENDS = new Set(['memory', 'sqlite', 'redis']);
const ALLOWED_LLM_PROVIDERS = new Set<SupportedLlmProvider>(['openai', 'anthropic', 'google', 'local']);

function parseInteger(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }

  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative integer`);
  }

  return parsed;
}

function parseFloatNumber(value: string | undefined, fallback: number, key: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${key} must be a valid number`);
  }

  return parsed;
}

function parseBoolean(value: string | undefined, fallback: boolean, key: string): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }

  if (value !== 'true' && value !== 'false') {
    throw new Error(`${key} must be either "true" or "false"`);
  }

  return value === 'true';
}

export function validateEnvironment(config: EnvRecord): EnvRecord {
  const nodeEnv = config.NODE_ENV ?? 'development';
  if (!ALLOWED_NODE_ENVS.has(nodeEnv)) {
    throw new Error('NODE_ENV must be one of development, test, production');
  }

  const llmProviderValue = config.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER;
  if (!ALLOWED_LLM_PROVIDERS.has(llmProviderValue as SupportedLlmProvider)) {
    throw new Error('LLM_PROVIDER must be one of openai, anthropic, google, local');
  }
  const llmProvider = llmProviderValue as SupportedLlmProvider;

  const port = parseInteger(config.PORT, DEFAULT_PORT, 'PORT');
  const maxTokens = parseInteger(config.LLM_MAX_TOKENS, DEFAULT_LLM_MAX_TOKENS, 'LLM_MAX_TOKENS');
  const temperature = parseFloatNumber(config.LLM_TEMPERATURE, DEFAULT_LLM_TEMPERATURE, 'LLM_TEMPERATURE');
  const rateLimitWindowMs = parseInteger(
    config.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    'RATE_LIMIT_WINDOW_MS',
  );
  const rateLimitMaxRequests = parseInteger(
    config.RATE_LIMIT_MAX_REQUESTS,
    DEFAULT_RATE_LIMIT_MAX_REQUESTS,
    'RATE_LIMIT_MAX_REQUESTS',
  );

  if (temperature < 0 || temperature > 2) {
    throw new Error('LLM_TEMPERATURE must be between 0 and 2');
  }

  const llmApiBase = config.LLM_API_BASE ?? getDefaultLlmApiBase(llmProvider);
  const corsOrigin = config.CORS_ORIGIN ?? DEFAULT_CORS_ORIGIN;
  const embeddingEnabled = parseBoolean(config.EMBEDDING_ENABLED, DEFAULT_EMBEDDING_ENABLED, 'EMBEDDING_ENABLED');
  const embeddingModel = (config.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL).trim();
  const embeddingApiBase = (config.EMBEDDING_API_BASE ?? '').trim();
  const embeddingApiKey = resolveEnvValue(config, 'EMBEDDING_API_KEY') ?? '';
  const embeddingDimensions = parseNonNegativeInteger(
    config.EMBEDDING_DIMENSIONS,
    DEFAULT_EMBEDDING_DIMENSIONS,
    'EMBEDDING_DIMENSIONS',
  );

  if (embeddingEnabled && !embeddingModel) {
    throw new Error('EMBEDDING_MODEL must be set when EMBEDDING_ENABLED=true');
  }

  const storageDriver = config.STORAGE_DRIVER ?? DEFAULT_STORAGE_DRIVER;
  const storageDataFile = config.STORAGE_DATA_FILE ?? DEFAULT_STORAGE_DATA_FILE;
  const storageDbFile = config.STORAGE_DB_FILE ?? DEFAULT_STORAGE_DB_FILE;
  const storageMemoryDbFile = config.STORAGE_MEMORY_DB_FILE ?? DEFAULT_STORAGE_MEMORY_DB_FILE;
  const storagePostgresUrl = resolveEnvValue(config, 'STORAGE_POSTGRES_URL') ?? '';
  const rateLimitBackend = config.RATE_LIMIT_BACKEND ?? DEFAULT_RATE_LIMIT_BACKEND;
  const rateLimitStoreFile = config.RATE_LIMIT_STORE_FILE ?? DEFAULT_RATE_LIMIT_STORE_FILE;
  const rateLimitRedisUrl = resolveEnvValue(config, 'RATE_LIMIT_REDIS_URL') ?? '';
  const authEnabled = parseBoolean(
    config.AUTH_ENABLED,
    nodeEnv === 'production',
    'AUTH_ENABLED',
  );
  const publicSessionsEnabled = parseBoolean(
    config.AUTH_PUBLIC_SESSIONS_ENABLED,
    false,
    'AUTH_PUBLIC_SESSIONS_ENABLED',
  );
  const rateLimitEnabled = parseBoolean(config.RATE_LIMIT_ENABLED, true, 'RATE_LIMIT_ENABLED');
  const authApiKeys = resolveEnvValue(config, 'AUTH_API_KEYS') ?? '';
  const publicSessionSecret = resolveEnvValue(config, 'AUTH_PUBLIC_SESSION_SECRET') ?? '';
  const llmApiKey = resolveEnvValue(config, 'LLM_API_KEY') ?? '';
  const publicSessionTtlDays = parseInteger(config.AUTH_PUBLIC_SESSION_TTL_DAYS, 30, 'AUTH_PUBLIC_SESSION_TTL_DAYS');
  const trustedProxyHops = parseNonNegativeInteger(config.TRUST_PROXY_HOPS, 0, 'TRUST_PROXY_HOPS');

  if (!ALLOWED_STORAGE_DRIVERS.has(storageDriver)) {
    throw new Error('STORAGE_DRIVER must be one of file, sqlite, postgres');
  }

  if (!ALLOWED_RATE_LIMIT_BACKENDS.has(rateLimitBackend)) {
    throw new Error('RATE_LIMIT_BACKEND must be one of memory, sqlite, redis');
  }

  if (nodeEnv === 'production') {
    if (
      llmProvider !== 'local' &&
      (!llmApiKey || llmApiKey === 'your-api-key' || llmApiKey === 'proxypal-local')
    ) {
      throw new Error('LLM_API_KEY must be set to a real secret in production');
    }

    if (!authEnabled) {
      throw new Error('AUTH_ENABLED must be true in production');
    }
  }

  if (authEnabled && authApiKeys.trim().length === 0 && !publicSessionsEnabled) {
    throw new Error('AUTH_API_KEYS must be provided when authentication is enabled unless public sessions are enabled');
  }

  if (publicSessionsEnabled && publicSessionSecret.trim().length === 0) {
    throw new Error('AUTH_PUBLIC_SESSION_SECRET must be provided when AUTH_PUBLIC_SESSIONS_ENABLED=true');
  }

  if (storageDataFile.trim().length === 0) {
    throw new Error('STORAGE_DATA_FILE must not be empty');
  }

  if (storageDbFile.trim().length === 0) {
    throw new Error('STORAGE_DB_FILE must not be empty');
  }

  if (storageMemoryDbFile.trim().length === 0) {
    throw new Error('STORAGE_MEMORY_DB_FILE must not be empty');
  }

  if (storageDriver === 'postgres' && storagePostgresUrl.trim().length === 0) {
    throw new Error('STORAGE_POSTGRES_URL must be provided when STORAGE_DRIVER=postgres');
  }

  if (rateLimitStoreFile.trim().length === 0) {
    throw new Error('RATE_LIMIT_STORE_FILE must not be empty');
  }

  if (rateLimitBackend === 'redis' && rateLimitRedisUrl.trim().length === 0) {
    throw new Error('RATE_LIMIT_REDIS_URL must be provided when RATE_LIMIT_BACKEND=redis');
  }

  return {
    ...config,
    NODE_ENV: nodeEnv,
    LLM_PROVIDER: llmProvider,
    PORT: String(port),
    LLM_API_BASE: llmApiBase,
    LLM_API_KEY: llmApiKey,
    LLM_MODEL: config.LLM_MODEL ?? getDefaultLlmModel(llmProvider),
    LLM_MAX_TOKENS: String(maxTokens),
    LLM_TEMPERATURE: String(temperature),
    CORS_ORIGIN: corsOrigin,
    AUTH_ENABLED: String(authEnabled),
    AUTH_API_KEYS: authApiKeys,
    AUTH_PUBLIC_SESSIONS_ENABLED: String(publicSessionsEnabled),
    AUTH_PUBLIC_SESSION_SECRET: publicSessionSecret,
    AUTH_PUBLIC_SESSION_TTL_DAYS: String(publicSessionTtlDays),
    TRUST_PROXY_HOPS: String(trustedProxyHops),
    RATE_LIMIT_ENABLED: String(rateLimitEnabled),
    RATE_LIMIT_WINDOW_MS: String(rateLimitWindowMs),
    RATE_LIMIT_MAX_REQUESTS: String(rateLimitMaxRequests),
    RATE_LIMIT_BACKEND: rateLimitBackend,
    RATE_LIMIT_STORE_FILE: rateLimitStoreFile,
    RATE_LIMIT_REDIS_URL: rateLimitRedisUrl,
    EMBEDDING_ENABLED: String(embeddingEnabled),
    EMBEDDING_MODEL: embeddingModel,
    EMBEDDING_API_BASE: embeddingApiBase,
    EMBEDDING_API_KEY: embeddingApiKey,
    EMBEDDING_DIMENSIONS: String(embeddingDimensions),
    STORAGE_DRIVER: storageDriver,
    STORAGE_DATA_FILE: storageDataFile,
    STORAGE_DB_FILE: storageDbFile,
    STORAGE_MEMORY_DB_FILE: storageMemoryDbFile,
    STORAGE_POSTGRES_URL: storagePostgresUrl,
  };
}
