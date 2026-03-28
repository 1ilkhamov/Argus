import * as path from 'node:path';

import { resolveEnvValue } from './env.utils';
import {
  DEFAULT_CORS_ORIGIN,
  DEFAULT_LLM_MAX_TOKENS,
  DEFAULT_LLM_TEMPERATURE,
  DEFAULT_NODE_ENV,
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
  getDefaultLlmApiBase,
  getDefaultLlmModel,
  resolveLlmProvider,
} from './defaults';

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return value === 'true';
}

function parseNonNegativeInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function parseStringArray(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export default () => {
  const resolvedLlmApiKey = resolveEnvValue(process.env, 'LLM_API_KEY') || '';
  const resolvedAuthApiKeys = resolveEnvValue(process.env, 'AUTH_API_KEYS');
  const resolvedAuthAdminApiKey = resolveEnvValue(process.env, 'AUTH_ADMIN_API_KEY') || '';
  const resolvedPublicSessionSecret = resolveEnvValue(process.env, 'AUTH_PUBLIC_SESSION_SECRET') || '';
  const resolvedStoragePostgresUrl = resolveEnvValue(process.env, 'STORAGE_POSTGRES_URL') || '';
  const resolvedRateLimitRedisUrl = resolveEnvValue(process.env, 'RATE_LIMIT_REDIS_URL') || '';
  const resolvedLlmProvider = resolveLlmProvider(process.env.LLM_PROVIDER);

  return {
    port: Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10),
    nodeEnv: process.env.NODE_ENV || DEFAULT_NODE_ENV,

    llm: {
      provider: resolvedLlmProvider,
      apiBase: process.env.LLM_API_BASE || getDefaultLlmApiBase(resolvedLlmProvider),
      apiKey: resolvedLlmApiKey,
      model: process.env.LLM_MODEL || getDefaultLlmModel(resolvedLlmProvider),
      maxTokens: Number.parseInt(process.env.LLM_MAX_TOKENS || String(DEFAULT_LLM_MAX_TOKENS), 10),
      temperature: Number.parseFloat(process.env.LLM_TEMPERATURE || String(DEFAULT_LLM_TEMPERATURE)),
    },

    cors: {
      origin: process.env.CORS_ORIGIN || DEFAULT_CORS_ORIGIN,
    },

    auth: {
      enabled: parseBoolean(process.env.AUTH_ENABLED, process.env.NODE_ENV === 'production'),
      apiKeys: parseStringArray(resolvedAuthApiKeys),
      adminApiKey: resolvedAuthAdminApiKey.trim(),
      publicSessionsEnabled: parseBoolean(process.env.AUTH_PUBLIC_SESSIONS_ENABLED, false),
      publicSessionSecret: resolvedPublicSessionSecret,
      publicSessionCookieName: (process.env.AUTH_PUBLIC_SESSION_COOKIE_NAME || 'argus_public_session').trim(),
      publicSessionTtlDays: parseNonNegativeInteger(process.env.AUTH_PUBLIC_SESSION_TTL_DAYS, 30),
    },

    http: {
      trustedProxyHops: parseNonNegativeInteger(process.env.TRUST_PROXY_HOPS, 0),
    },

    rateLimit: {
      enabled: parseBoolean(process.env.RATE_LIMIT_ENABLED, true),
      windowMs: Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS || String(DEFAULT_RATE_LIMIT_WINDOW_MS), 10),
      maxRequests: Number.parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || String(DEFAULT_RATE_LIMIT_MAX_REQUESTS), 10),
      backend: process.env.RATE_LIMIT_BACKEND || DEFAULT_RATE_LIMIT_BACKEND,
      storeFilePath: process.env.RATE_LIMIT_STORE_FILE || DEFAULT_RATE_LIMIT_STORE_FILE,
      redisUrl: resolvedRateLimitRedisUrl,
    },

    embedding: {
      enabled: parseBoolean(process.env.EMBEDDING_ENABLED, DEFAULT_EMBEDDING_ENABLED),
      provider: (process.env.EMBEDDING_PROVIDER || 'api').trim(),
      model: (process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL).trim(),
      localModel: (process.env.EMBEDDING_LOCAL_MODEL || 'Xenova/multilingual-e5-small').trim(),
      apiBase: (process.env.EMBEDDING_API_BASE || '').trim(),
      apiKey: resolveEnvValue(process.env, 'EMBEDDING_API_KEY') || '',
      dimensions: parseNonNegativeInteger(process.env.EMBEDDING_DIMENSIONS, DEFAULT_EMBEDDING_DIMENSIONS),
    },

    storage: {
      driver: process.env.STORAGE_DRIVER || DEFAULT_STORAGE_DRIVER,
      dataFilePath: process.env.STORAGE_DATA_FILE || DEFAULT_STORAGE_DATA_FILE,
      dbFilePath: process.env.STORAGE_DB_FILE || DEFAULT_STORAGE_DB_FILE,
      memoryDbFilePath: process.env.STORAGE_MEMORY_DB_FILE || DEFAULT_STORAGE_MEMORY_DB_FILE,
      postgresUrl: resolvedStoragePostgresUrl,
    },

    soul: {
      configPath: (process.env.SOUL_CONFIG_PATH || '').trim(),
    },

    settings: {
      encryptionSecret: resolveEnvValue(process.env, 'SETTINGS_ENCRYPTION_SECRET') || '',
    },

    tools: {
      enabled: parseBoolean(process.env.TOOLS_ENABLED, true),
      safetyPolicy: (process.env.TOOLS_SAFETY_POLICY || 'permissive').trim().toLowerCase(),
      blockedNames: (process.env.TOOLS_BLOCKED_NAMES || '').trim(),
      allowedNames: (process.env.TOOLS_ALLOWED_NAMES || '').trim(),
      nativeFunctionCalling: process.env.TOOLS_NATIVE_FUNCTION_CALLING
        ? parseBoolean(process.env.TOOLS_NATIVE_FUNCTION_CALLING, true)
        : undefined,
      webSearch: {
        provider: (process.env.TOOLS_WEB_SEARCH_PROVIDER || 'auto').trim(),
        braveApiKey: resolveEnvValue(process.env, 'TOOLS_WEB_SEARCH_BRAVE_API_KEY') || '',
        tavilyApiKey: resolveEnvValue(process.env, 'TOOLS_WEB_SEARCH_TAVILY_API_KEY') || '',
        jinaApiKey: resolveEnvValue(process.env, 'TOOLS_WEB_SEARCH_JINA_API_KEY') || '',
        searxngUrl: (process.env.TOOLS_WEB_SEARCH_SEARXNG_URL || 'http://localhost:8888').trim(),
      },
      systemRun: {
        enabled: parseBoolean(process.env.TOOLS_SYSTEM_RUN_ENABLED, true),
        timeoutMs: parseNonNegativeInteger(process.env.TOOLS_SYSTEM_RUN_TIMEOUT_MS, 30_000),
        workingDirectory: (process.env.TOOLS_SYSTEM_RUN_WORKING_DIRECTORY || '').trim() || process.cwd(),
      },
      fileOps: {
        allowedRoots: parseStringArray(process.env.TOOLS_FILE_OPS_ALLOWED_ROOTS),
      },
      vision: {
        screenshotDir:
          (process.env.TOOLS_VISION_SCREENSHOT_DIR || '').trim() ||
          path.join(process.cwd(), 'data', 'screenshots'),
      },
      codeExec: {
        enabled: parseBoolean(process.env.TOOLS_CODE_EXEC_ENABLED, true),
        timeoutMs: parseNonNegativeInteger(process.env.TOOLS_CODE_EXEC_TIMEOUT_MS, 30_000),
      },
      notify: {
        telegramBotToken: resolveEnvValue(process.env, 'TOOLS_NOTIFY_TELEGRAM_BOT_TOKEN') || '',
        telegramChatId: (process.env.TOOLS_NOTIFY_TELEGRAM_CHAT_ID || '').trim(),
      },
      audioTranscribe: {
        enabled: parseBoolean(process.env.TOOLS_AUDIO_TRANSCRIBE_ENABLED, true),
        model: (process.env.TOOLS_AUDIO_TRANSCRIBE_MODEL || 'Xenova/whisper-base').trim(),
      },
      sqlQuery: {
        enabled: parseBoolean(process.env.TOOLS_SQL_QUERY_ENABLED, true),
        allowWrite: parseBoolean(process.env.TOOLS_SQL_QUERY_ALLOW_WRITE, false),
      },
      applescript: {
        enabled: parseBoolean(process.env.TOOLS_APPLESCRIPT_ENABLED, true),
        timeoutMs: parseNonNegativeInteger(process.env.TOOLS_APPLESCRIPT_TIMEOUT_MS, 15_000),
      },
      documentGen: {
        enabled: parseBoolean(process.env.TOOLS_DOCUMENT_GEN_ENABLED, true),
        outputDir: (process.env.TOOLS_DOCUMENT_GEN_OUTPUT_DIR || '').trim() ||
          path.join(process.cwd(), 'data', 'documents'),
      },
      email: {
        enabled: parseBoolean(process.env.TOOLS_EMAIL_ENABLED, true),
      },
    },

    hooks: {
      enabled: parseBoolean(process.env.HOOKS_ENABLED, true),
    },

    telegram: {
      enabled: parseBoolean(process.env.TELEGRAM_ENABLED, false),
      botToken: resolveEnvValue(process.env, 'TELEGRAM_BOT_TOKEN') || '',
      allowedUsers: parseStringArray(process.env.TELEGRAM_ALLOWED_USERS).map(Number).filter(Number.isFinite),
      webhookUrl: (process.env.TELEGRAM_WEBHOOK_URL || '').trim(),
      webhookSecret: (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim(),
      progressiveEdit: parseBoolean(process.env.TELEGRAM_PROGRESSIVE_EDIT, false),
      editIntervalMs: parseNonNegativeInteger(process.env.TELEGRAM_EDIT_INTERVAL_MS, 1500),
    },

    telegramClient: {
      enabled: parseBoolean(process.env.TELEGRAM_CLIENT_ENABLED, false),
      apiId: parseNonNegativeInteger(process.env.TELEGRAM_CLIENT_API_ID, 0),
      apiHash: (process.env.TELEGRAM_CLIENT_API_HASH || '').trim(),
    },

    memory: {
      lifecycleIntervalMs: parseNonNegativeInteger(process.env.MEMORY_LIFECYCLE_INTERVAL_MS, 6 * 60 * 60 * 1000),
      qdrant: {
        url: (process.env.MEMORY_QDRANT_URL || '').trim(),
        apiKey: resolveEnvValue(process.env, 'MEMORY_QDRANT_API_KEY') || '',
        collectionName: (process.env.MEMORY_QDRANT_COLLECTION || 'argus_memory').trim(),
        vectorSize: parseNonNegativeInteger(process.env.MEMORY_QDRANT_VECTOR_SIZE, 768),
      },
    },
  };
};
