const path = require('node:path');
const crypto = require('node:crypto');
const readlinePromises = require('node:readline/promises');
const {
  backendDir,
  frontendDir,
  backendEnvPath,
  frontendEnvPath,
  backendExampleEnvPath,
  frontendExampleEnvPath,
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT,
  LLM_PROVIDER_OPTIONS,
  LLM_PROVIDER_DEFAULTS,
  ONBOARDING_BACKEND_DEFAULTS,
  ONBOARDING_FRONTEND_DEFAULTS,
} = require('../core/constants');
const {
  ensureDirectoryExists,
  ensureFileExists,
  validateNodeVersion,
  ensureArgusWorkspace,
  readBackendConfig,
  writeEnvFile,
} = require('../core/env');
const { runNpmInstall, checkPortOpen } = require('../core/runtime');
const { isQdrantInstalled, downloadAndExtractQdrant, getQdrantPlatformTriple } = require('../services/qdrant.service');
const {
  logCliHeader,
  logCliFlowStart,
  logCliFlowEnd,
  logKeyValuePanel,
  logPanel,
  logStepList,
  logOnboardingSection,
  printStatus,
} = require('../ui/render');
const { promptValue, promptBoolean, promptChoice } = require('../ui/prompts');

function inferLlmProvider(backendConfig) {
  const configuredProvider = backendConfig.LLM_PROVIDER?.trim().toLowerCase();
  if (configuredProvider && Object.hasOwn(LLM_PROVIDER_DEFAULTS, configuredProvider)) {
    return configuredProvider;
  }

  const apiBase = (backendConfig.LLM_API_BASE || '').toLowerCase();
  if (apiBase.includes('api.openai.com')) {
    return 'openai';
  }

  if (apiBase.includes('api.anthropic.com')) {
    return 'anthropic';
  }

  if (apiBase.includes('generativelanguage.googleapis.com')) {
    return 'google';
  }

  return 'local';
}

function getLlmProviderDefaults(provider) {
  return LLM_PROVIDER_DEFAULTS[provider] || LLM_PROVIDER_DEFAULTS.local;
}

function getLlmProviderOption(provider) {
  return LLM_PROVIDER_OPTIONS.find((option) => option.value === provider) || LLM_PROVIDER_OPTIONS[0];
}

function getFirstApiKey(value) {
  return (value || '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .find((item) => item.length > 0) || '';
}

function validatePositiveInteger(label) {
  return (value) => {
    if (!/^\d+$/.test(value)) {
      return `${label} must be a positive integer.`;
    }

    if (Number.parseInt(value, 10) <= 0) {
      return `${label} must be a positive integer.`;
    }

    return '';
  };
}

function validateFloatRange(label, minimum, maximum) {
  return (value) => {
    if (!/^\d+(\.\d+)?$/.test(value)) {
      return `${label} must be a valid number.`;
    }

    const parsed = Number.parseFloat(value);
    if (parsed < minimum || parsed > maximum) {
      return `${label} must be between ${minimum} and ${maximum}.`;
    }

    return '';
  };
}

function validateRequiredValue(label) {
  return (value) => {
    if (!value.trim()) {
      return `${label} must not be empty.`;
    }

    return '';
  };
}

function normalizeOnboardingValue(value, fallback, options = {}) {
  const normalized = (value || '').trim();
  if (!normalized) {
    return fallback;
  }

  if (typeof options.validate === 'function') {
    const validationError = options.validate(normalized);
    if (validationError) {
      return fallback;
    }
  }

  return normalized;
}

function normalizeChoiceValue(value, fallback, allowedValues) {
  const normalized = (value || '').trim().toLowerCase();
  if (!normalized || !allowedValues.includes(normalized)) {
    return fallback;
  }

  return normalized;
}

function resetManagedRuntimeDefaults(result) {
  result.backend.NODE_ENV = ONBOARDING_BACKEND_DEFAULTS.NODE_ENV;
  result.backend.CORS_ORIGIN = `http://localhost:${DEFAULT_FRONTEND_PORT}`;
  result.backend.LLM_API_KEY_FILE = '';
  result.backend.RATE_LIMIT_ENABLED = ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_ENABLED;
  result.backend.RATE_LIMIT_WINDOW_MS = ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_WINDOW_MS;
  result.backend.RATE_LIMIT_MAX_REQUESTS = ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_MAX_REQUESTS;
  result.backend.RATE_LIMIT_BACKEND = ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_BACKEND;
  result.backend.RATE_LIMIT_STORE_FILE = ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_STORE_FILE;
  result.backend.RATE_LIMIT_REDIS_URL = '';
  result.backend.STORAGE_DRIVER = ONBOARDING_BACKEND_DEFAULTS.STORAGE_DRIVER;
  result.backend.STORAGE_DATA_FILE = ONBOARDING_BACKEND_DEFAULTS.STORAGE_DATA_FILE;
  result.backend.STORAGE_DB_FILE = ONBOARDING_BACKEND_DEFAULTS.STORAGE_DB_FILE;
  result.backend.STORAGE_POSTGRES_URL = '';
  result.frontend.VITE_API_BASE = ONBOARDING_FRONTEND_DEFAULTS.VITE_API_BASE;
  result.frontend.VITE_DEV_PROXY_TARGET = ONBOARDING_FRONTEND_DEFAULTS.VITE_DEV_PROXY_TARGET;
}

function generateSecureKey(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function resetSimpleOnboardingDefaults(result) {
  result.backend.LLM_MAX_TOKENS = ONBOARDING_BACKEND_DEFAULTS.LLM_MAX_TOKENS;
  result.backend.LLM_TEMPERATURE = ONBOARDING_BACKEND_DEFAULTS.LLM_TEMPERATURE;
  result.backend.AUTH_ENABLED = ONBOARDING_BACKEND_DEFAULTS.AUTH_ENABLED;
  result.backend.AUTH_API_KEYS = ONBOARDING_BACKEND_DEFAULTS.AUTH_API_KEYS;
  result.backend.AUTH_ADMIN_API_KEY = '';
  // Preserve existing encryption secret so previously encrypted settings remain readable
  if (!result.backend.SETTINGS_ENCRYPTION_SECRET) {
    result.backend.SETTINGS_ENCRYPTION_SECRET = generateSecureKey();
  }
  result.backend.LLM_API_KEY_FILE = '';
  result.backend.AUTH_API_KEYS_FILE = '';
  result.frontend.API_KEY = ONBOARDING_FRONTEND_DEFAULTS.API_KEY;
  result.frontend.ADMIN_API_KEY = '';
}

function shouldResetLlmApiKey(previousProvider, nextProvider, apiKey) {
  const normalizedApiKey = (apiKey || '').trim();
  if (previousProvider === nextProvider || !normalizedApiKey) {
    return false;
  }

  return isPlaceholderLlmApiKey(normalizedApiKey);
}

function isPlaceholderLlmApiKey(apiKey) {
  const normalizedApiKey = (apiKey || '').trim();
  if (!normalizedApiKey) {
    return false;
  }

  return normalizedApiKey === 'your-api-key';
}

function getLlmApiKeyPromptLabel(provider) {
  if (provider === 'local') {
    return 'API key for local endpoint (optional)';
  }

  return `API key for ${getLlmProviderOption(provider).label}`;
}

function getLlmApiKeyPromptDefault(provider, apiKey) {
  if (isPlaceholderLlmApiKey(apiKey)) {
    return '';
  }

  return apiKey;
}

function getLlmApiBasePromptLabel(provider) {
  if (provider === 'local') {
    return 'LLM API base URL for local endpoint';
  }

  return 'LLM API base URL';
}

function getLlmModelPromptLabel(provider) {
  return `Model for ${getLlmProviderOption(provider).label}`;
}

function validateUrl(label) {
  return (value) => {
    const normalized = (value || '').trim();
    if (!normalized) {
      return `${label} must not be empty.`;
    }

    try {
      const parsedUrl = new URL(normalized);
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return `${label} must start with http:// or https://.`;
      }
    } catch {
      return `${label} must be a valid URL.`;
    }

    return '';
  };
}

function validateLlmApiKey(provider) {
  return (value) => {
    const normalized = (value || '').trim();
    if (!normalized) {
      return '';
    }

    if (isPlaceholderLlmApiKey(normalized)) {
      return provider === 'local'
        ? 'Leave the API key empty instead of using a legacy placeholder.'
        : 'Use a real API key instead of a placeholder value.';
    }

    return '';
  };
}

function isInteractive(flags = new Set()) {
  return process.stdin.isTTY && process.stdout.isTTY && !flags.has('--yes');
}

function writeBackendEnv(config) {
  // Preserve extra keys from existing .env that aren't managed by onboard
  const existingConfig = readBackendConfig();
  const managedKeys = new Set();
  const sections = [
    {
      title: 'Server',
      entries: [
        { key: 'PORT', value: config.PORT },
        { key: 'NODE_ENV', value: config.NODE_ENV },
      ],
    },
    {
      title: 'LLM',
      entries: [
        { key: 'LLM_PROVIDER', value: config.LLM_PROVIDER },
        { key: 'LLM_API_BASE', value: config.LLM_API_BASE },
        { key: 'LLM_API_KEY', value: config.LLM_API_KEY },
        { key: 'LLM_API_KEY_FILE', value: config.LLM_API_KEY_FILE },
        { key: 'LLM_MODEL', value: config.LLM_MODEL },
        { key: 'LLM_MAX_TOKENS', value: config.LLM_MAX_TOKENS },
        { key: 'LLM_TEMPERATURE', value: config.LLM_TEMPERATURE },
      ],
    },
    {
      title: 'CORS',
      entries: [{ key: 'CORS_ORIGIN', value: config.CORS_ORIGIN }],
    },
    {
      title: 'Auth',
      entries: [
        { key: 'AUTH_ENABLED', value: config.AUTH_ENABLED },
        { key: 'AUTH_API_KEYS', value: config.AUTH_API_KEYS },
        { key: 'AUTH_API_KEYS_FILE', value: config.AUTH_API_KEYS_FILE },
        { key: 'AUTH_ADMIN_API_KEY', value: config.AUTH_ADMIN_API_KEY },
      ],
    },
    {
      title: 'Settings',
      entries: [
        { key: 'SETTINGS_ENCRYPTION_SECRET', value: config.SETTINGS_ENCRYPTION_SECRET },
      ],
    },
    {
      title: 'Rate limiting',
      entries: [
        { key: 'RATE_LIMIT_ENABLED', value: config.RATE_LIMIT_ENABLED },
        { key: 'RATE_LIMIT_WINDOW_MS', value: config.RATE_LIMIT_WINDOW_MS },
        { key: 'RATE_LIMIT_MAX_REQUESTS', value: config.RATE_LIMIT_MAX_REQUESTS },
        { key: 'RATE_LIMIT_BACKEND', value: config.RATE_LIMIT_BACKEND },
        { key: 'RATE_LIMIT_STORE_FILE', value: config.RATE_LIMIT_STORE_FILE },
        { key: 'RATE_LIMIT_REDIS_URL', value: config.RATE_LIMIT_REDIS_URL },
      ],
    },
    {
      title: 'Storage',
      entries: [
        { key: 'STORAGE_DRIVER', value: config.STORAGE_DRIVER },
        { key: 'STORAGE_DATA_FILE', value: config.STORAGE_DATA_FILE },
        { key: 'STORAGE_DB_FILE', value: config.STORAGE_DB_FILE },
        { key: 'STORAGE_POSTGRES_URL', value: config.STORAGE_POSTGRES_URL },
      ],
    },
    {
      title: 'Memory (Qdrant vector store)',
      entries: [
        { key: 'MEMORY_QDRANT_URL', value: config.MEMORY_QDRANT_URL },
        { key: 'MEMORY_QDRANT_COLLECTION', value: config.MEMORY_QDRANT_COLLECTION },
        { key: 'MEMORY_QDRANT_VECTOR_SIZE', value: config.MEMORY_QDRANT_VECTOR_SIZE },
      ],
    },
  ];

  // Collect all managed keys
  for (const section of sections) {
    for (const entry of section.entries) {
      managedKeys.add(entry.key);
    }
  }

  // Append extra keys from existing .env that onboard doesn't manage
  const extraEntries = [];
  for (const [key, value] of Object.entries(existingConfig)) {
    if (!managedKeys.has(key)) {
      extraEntries.push({ key, value });
    }
  }

  if (extraEntries.length > 0) {
    sections.push({ title: 'Custom (preserved from previous config)', entries: extraEntries });
  }

  writeEnvFile(backendEnvPath, sections);
}

function writeFrontendEnv(config) {
  writeEnvFile(frontendEnvPath, [
    {
      title: 'Frontend',
      entries: [
        { key: 'VITE_API_BASE', value: config.VITE_API_BASE },
        { key: 'API_KEY', value: config.API_KEY },
        { key: 'ADMIN_API_KEY', value: config.ADMIN_API_KEY },
        { key: 'VITE_DEV_PROXY_TARGET', value: config.VITE_DEV_PROXY_TARGET },
      ],
    },
  ]);
}

async function buildOnboardingConfig(flags = new Set()) {
  const backendConfig = readBackendConfig();
  const interactive = isInteractive(flags);
  const inferredLlmProvider = inferLlmProvider(backendConfig);
  const inferredLlmDefaults = getLlmProviderDefaults(inferredLlmProvider);

  const result = {
    backend: {
      PORT: String(DEFAULT_BACKEND_PORT),
      NODE_ENV: ONBOARDING_BACKEND_DEFAULTS.NODE_ENV,
      LLM_PROVIDER: normalizeChoiceValue(
        backendConfig.LLM_PROVIDER,
        inferredLlmProvider,
        Object.keys(LLM_PROVIDER_DEFAULTS),
      ),
      LLM_API_BASE: backendConfig.LLM_API_BASE || inferredLlmDefaults.apiBase,
      LLM_API_KEY: backendConfig.LLM_API_KEY || '',
      LLM_API_KEY_FILE: backendConfig.LLM_API_KEY_FILE,
      LLM_MODEL: backendConfig.LLM_MODEL || inferredLlmDefaults.model,
      LLM_MAX_TOKENS: normalizeOnboardingValue(
        backendConfig.LLM_MAX_TOKENS,
        ONBOARDING_BACKEND_DEFAULTS.LLM_MAX_TOKENS,
        { validate: validatePositiveInteger('LLM max tokens') },
      ),
      LLM_TEMPERATURE: normalizeOnboardingValue(
        backendConfig.LLM_TEMPERATURE,
        ONBOARDING_BACKEND_DEFAULTS.LLM_TEMPERATURE,
        { validate: validateFloatRange('LLM temperature', 0, 2) },
      ),
      CORS_ORIGIN: `http://localhost:${DEFAULT_FRONTEND_PORT}`,
      AUTH_ENABLED: normalizeChoiceValue(
        backendConfig.AUTH_ENABLED,
        ONBOARDING_BACKEND_DEFAULTS.AUTH_ENABLED,
        ['true', 'false'],
      ),
      AUTH_API_KEYS: backendConfig.AUTH_API_KEYS || ONBOARDING_BACKEND_DEFAULTS.AUTH_API_KEYS,
      AUTH_ADMIN_API_KEY: backendConfig.AUTH_ADMIN_API_KEY || '',
      SETTINGS_ENCRYPTION_SECRET: backendConfig.SETTINGS_ENCRYPTION_SECRET || '',
      AUTH_API_KEYS_FILE: backendConfig.AUTH_API_KEYS_FILE,
      RATE_LIMIT_ENABLED: ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_ENABLED,
      RATE_LIMIT_WINDOW_MS: ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_WINDOW_MS,
      RATE_LIMIT_MAX_REQUESTS: ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_MAX_REQUESTS,
      RATE_LIMIT_BACKEND: ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_BACKEND,
      RATE_LIMIT_STORE_FILE: ONBOARDING_BACKEND_DEFAULTS.RATE_LIMIT_STORE_FILE,
      RATE_LIMIT_REDIS_URL: backendConfig.RATE_LIMIT_REDIS_URL,
      STORAGE_DRIVER: ONBOARDING_BACKEND_DEFAULTS.STORAGE_DRIVER,
      STORAGE_DATA_FILE: ONBOARDING_BACKEND_DEFAULTS.STORAGE_DATA_FILE,
      STORAGE_DB_FILE: ONBOARDING_BACKEND_DEFAULTS.STORAGE_DB_FILE,
      STORAGE_POSTGRES_URL: backendConfig.STORAGE_POSTGRES_URL,
      MEMORY_QDRANT_URL: backendConfig.MEMORY_QDRANT_URL || ONBOARDING_BACKEND_DEFAULTS.MEMORY_QDRANT_URL,
      MEMORY_QDRANT_COLLECTION: backendConfig.MEMORY_QDRANT_COLLECTION || ONBOARDING_BACKEND_DEFAULTS.MEMORY_QDRANT_COLLECTION,
      MEMORY_QDRANT_VECTOR_SIZE: backendConfig.MEMORY_QDRANT_VECTOR_SIZE || ONBOARDING_BACKEND_DEFAULTS.MEMORY_QDRANT_VECTOR_SIZE,
    },
    frontend: {
      VITE_API_BASE: ONBOARDING_FRONTEND_DEFAULTS.VITE_API_BASE,
      API_KEY: ONBOARDING_FRONTEND_DEFAULTS.API_KEY,
      ADMIN_API_KEY: '',
      VITE_DEV_PROXY_TARGET: ONBOARDING_FRONTEND_DEFAULTS.VITE_DEV_PROXY_TARGET,
    },
  };

  resetManagedRuntimeDefaults(result);

  if (!interactive) {
    resetSimpleOnboardingDefaults(result);
    return result;
  }

  const rl = readlinePromises.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    logOnboardingSection('✨ Welcome to Argus setup', 'A few polished steps and your local workspace will be ready.');

    logOnboardingSection('Step 1 · Pick your LLM provider', 'Choose the provider or local endpoint you want Argus to talk to.', {
      continueRail: false,
    });

    const previousLlmProvider = result.backend.LLM_PROVIDER;
    result.backend.LLM_PROVIDER = await promptChoice(
      rl,
      'LLM provider',
      LLM_PROVIDER_OPTIONS,
      result.backend.LLM_PROVIDER,
    );
    const previousLlmDefaults = getLlmProviderDefaults(previousLlmProvider);
    const selectedLlmDefaults = getLlmProviderDefaults(result.backend.LLM_PROVIDER);
    const didSwitchLlmProvider = previousLlmProvider !== result.backend.LLM_PROVIDER;

    if (didSwitchLlmProvider || !result.backend.LLM_API_BASE || result.backend.LLM_API_BASE === previousLlmDefaults.apiBase) {
      result.backend.LLM_API_BASE = selectedLlmDefaults.apiBase;
    }

    if (didSwitchLlmProvider || !result.backend.LLM_MODEL || result.backend.LLM_MODEL === previousLlmDefaults.model) {
      result.backend.LLM_MODEL = selectedLlmDefaults.model;
    }

    if (didSwitchLlmProvider || shouldResetLlmApiKey(previousLlmProvider, result.backend.LLM_PROVIDER, result.backend.LLM_API_KEY)) {
      result.backend.LLM_API_KEY = '';
    }

    logOnboardingSection(
      'Step 2 · Configure the model connection',
      'Set the provider credentials and the model you want to use by default.',
      { continueRail: false },
    );

    if (result.backend.LLM_PROVIDER === 'local') {
      result.backend.LLM_API_BASE = await promptValue(
        rl,
        getLlmApiBasePromptLabel(result.backend.LLM_PROVIDER),
        result.backend.LLM_API_BASE,
        {
          hint: 'Enter the full base URL exposed by your local or self-hosted endpoint.',
          validate: validateUrl('LLM API base URL'),
          validationHint: 'http://localhost:1234/v1',
        },
      );
    }

    result.backend.LLM_API_KEY = await promptValue(
      rl,
      getLlmApiKeyPromptLabel(result.backend.LLM_PROVIDER),
      getLlmApiKeyPromptDefault(result.backend.LLM_PROVIDER, result.backend.LLM_API_KEY),
      {
        hint:
          result.backend.LLM_PROVIDER === 'local'
            ? 'Leave this empty if your local endpoint does not require a key.'
            : 'Paste the API key for the provider you selected.',
        allowEmpty: result.backend.LLM_PROVIDER === 'local',
        validate: validateLlmApiKey(result.backend.LLM_PROVIDER),
      },
    );
    result.backend.LLM_API_KEY_FILE = '';
    result.backend.LLM_MODEL = await promptValue(
      rl,
      getLlmModelPromptLabel(result.backend.LLM_PROVIDER),
      result.backend.LLM_MODEL,
      {
        hint:
          result.backend.LLM_PROVIDER === 'local'
            ? 'Use the exact model name exposed by your local endpoint.'
            : 'You can keep the suggested default or enter any model ID your account can access.',
      },
    );

    logOnboardingSection(
      'Step 3 · Final touches',
      'You can keep the fast default path or open the advanced runtime settings.',
      { continueRail: false },
    );

    const configureAdvancedSettings = await promptBoolean(rl, 'Configure advanced settings', false, {
      trueDescription: 'Tune model limits and local auth settings',
      falseDescription: 'Keep the clean default setup',
    });
    if (configureAdvancedSettings) {
      logOnboardingSection(
        'Advanced settings',
        'These options are optional. Most local setups work well with the suggested defaults.',
        { continueRail: false },
      );

      result.backend.LLM_MAX_TOKENS = await promptValue(
        rl,
        'LLM max tokens',
        result.backend.LLM_MAX_TOKENS,
        {
          validate: validatePositiveInteger('LLM max tokens'),
          hint: 'Maximum output tokens used for completions.',
          validationHint: 'positive integer',
        },
      );
      result.backend.LLM_TEMPERATURE = await promptValue(
        rl,
        'LLM temperature',
        result.backend.LLM_TEMPERATURE,
        {
          validate: validateFloatRange('LLM temperature', 0, 2),
          hint: 'Lower is more deterministic. Higher is more creative.',
          validationHint: 'number from 0 to 2',
        },
      );

      const authEnabled = await promptBoolean(
        rl,
        'Enable backend API key auth in local dev',
        result.backend.AUTH_ENABLED === 'true',
        {
          trueDescription: 'Protect local backend requests with an API key',
          falseDescription: 'Skip local backend auth for faster development',
        },
      );
      result.backend.AUTH_ENABLED = authEnabled ? 'true' : 'false';

      if (authEnabled) {
        result.backend.AUTH_API_KEYS = await promptValue(
          rl,
          'Backend API key(s)',
          result.backend.AUTH_API_KEYS,
          {
            validate: validateRequiredValue('Backend API key(s)'),
            hint: 'Use one key or multiple keys separated by commas or new lines.',
            validationHint: 'non-empty value',
          },
        );
        result.backend.AUTH_API_KEYS_FILE = '';
        result.frontend.API_KEY = getFirstApiKey(result.backend.AUTH_API_KEYS);

        // Auto-generate admin API key and encryption secret if not already set
        if (!result.backend.AUTH_ADMIN_API_KEY) {
          result.backend.AUTH_ADMIN_API_KEY = generateSecureKey();
        }
        if (!result.backend.SETTINGS_ENCRYPTION_SECRET) {
          result.backend.SETTINGS_ENCRYPTION_SECRET = generateSecureKey();
        }
        result.frontend.ADMIN_API_KEY = result.backend.AUTH_ADMIN_API_KEY;
      } else {
        result.backend.AUTH_API_KEYS = '';
        result.backend.AUTH_ADMIN_API_KEY = '';
        // Preserve existing encryption secret so previously encrypted settings remain readable
        if (!result.backend.SETTINGS_ENCRYPTION_SECRET) {
          result.backend.SETTINGS_ENCRYPTION_SECRET = generateSecureKey();
        }
        result.backend.AUTH_API_KEYS_FILE = '';
        result.frontend.API_KEY = '';
        result.frontend.ADMIN_API_KEY = '';
      }
    } else {
      resetSimpleOnboardingDefaults(result);
    }
  } finally {
    rl.close();
  }

  return result;
}

async function runOnboard({ flags = new Set() } = {}) {
  validateNodeVersion();
  ensureArgusWorkspace();
  ensureDirectoryExists(backendDir);
  ensureDirectoryExists(frontendDir);
  ensureFileExists(path.join(backendDir, 'package.json'));
  ensureFileExists(path.join(frontendDir, 'package.json'));
  ensureFileExists(backendExampleEnvPath);
  ensureFileExists(frontendExampleEnvPath);

  logCliHeader('✨', 'Argus setup', 'Prepare your local workspace with a guided and polished configuration flow.');
  logCliFlowStart('Argus setup');

  const config = await buildOnboardingConfig(flags);

  writeBackendEnv(config.backend);
  printStatus('backend/.env', 'written', 'refreshed local runtime config');

  writeFrontendEnv(config.frontend);
  printStatus('frontend/.env', 'written', 'refreshed local app config');

  runNpmInstall(backendDir, 'backend');
  runNpmInstall(frontendDir, 'frontend');

  if (getQdrantPlatformTriple()) {
    if (isQdrantInstalled()) {
      printStatus('qdrant', 'skipped', 'binary already present');
    } else {
      try {
        await downloadAndExtractQdrant();
      } catch (error) {
        printStatus('qdrant', 'warning', error instanceof Error ? error.message : 'download failed');
      }
    }
  } else {
    printStatus('qdrant', 'skipped', `unsupported platform (${process.platform}-${process.arch})`);
  }

  const backendPortBusy = await checkPortOpen(Number.parseInt(config.backend.PORT, 10));
  const frontendPortBusy = await checkPortOpen(DEFAULT_FRONTEND_PORT);

  logCliHeader('✅', 'Setup complete', 'Your local Argus workspace is ready for the next step.');
  logKeyValuePanel(
    'Configuration',
    [
      { label: 'backend port', value: config.backend.PORT },
      { label: 'frontend url', value: `http://localhost:${DEFAULT_FRONTEND_PORT}` },
      { label: 'llm provider', value: config.backend.LLM_PROVIDER },
      { label: 'llm base', value: config.backend.LLM_API_BASE },
      { label: 'auth enabled', value: config.backend.AUTH_ENABLED },
    ],
    { tone: 'green' },
  );

  if (backendPortBusy || frontendPortBusy) {
    logPanel(
      'Runtime note',
      [
        backendPortBusy ? `Port ${config.backend.PORT} is already in use.` : null,
        frontendPortBusy ? `Port ${DEFAULT_FRONTEND_PORT} is already in use.` : null,
      ],
      { tone: 'yellow' },
    );
  }
  logStepList(
    'Next steps',
    [
      'Run argus-one doctor',
      'Run argus-one start',
      `Open http://localhost:${DEFAULT_FRONTEND_PORT}`,
    ],
    { tone: 'cyan', continueRail: false },
  );
  logCliFlowEnd();
}

module.exports = {
  runOnboard,
  // Exported for testing
  buildOnboardingConfig,
  writeBackendEnv,
  writeFrontendEnv,
};
