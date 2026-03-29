const fs = require('node:fs');
const path = require('node:path');

function isArgusWorkspaceRoot(directoryPath) {
  return [
    path.join(directoryPath, 'package.json'),
    path.join(directoryPath, 'backend', 'package.json'),
    path.join(directoryPath, 'frontend', 'package.json'),
    path.join(directoryPath, 'backend', '.env.example'),
    path.join(directoryPath, 'frontend', '.env.example'),
  ].every((candidatePath) => fs.existsSync(candidatePath));
}

function findArgusWorkspaceRoot(startDir) {
  let currentDir = path.resolve(startDir);

  while (true) {
    if (isArgusWorkspaceRoot(currentDir)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }

    currentDir = parentDir;
  }
}

const workspaceSearchStart = process.cwd();
const detectedWorkspaceRoot = findArgusWorkspaceRoot(workspaceSearchStart);
const workspaceRootDetected = detectedWorkspaceRoot !== null;
const repoRoot = detectedWorkspaceRoot || workspaceSearchStart;
const backendDir = path.join(repoRoot, 'backend');
const frontendDir = path.join(repoRoot, 'frontend');
const backendEnvPath = path.join(backendDir, '.env');
const frontendEnvPath = path.join(frontendDir, '.env');
const backendExampleEnvPath = path.join(backendDir, '.env.example');
const frontendExampleEnvPath = path.join(frontendDir, '.env.example');
const MIN_NODE_MAJOR = 22;
const DEFAULT_BACKEND_PORT = 2901;
const DEFAULT_FRONTEND_PORT = 2101;
const DEFAULT_QDRANT_PORT = 6333;
const DEFAULT_NODE_ENV = 'development';
const LLM_PROVIDER_OPTIONS = [
  {
    value: 'local',
    label: 'Local',
    description: 'Local or self-hosted endpoint',
  },
  {
    value: 'openai',
    label: 'OpenAI',
    description: 'OpenAI API',
  },
  {
    value: 'anthropic',
    label: 'Anthropic',
    description: 'Anthropic Messages API',
  },
  {
    value: 'google',
    label: 'Google',
    description: 'Google Gemini API',
  },
];
const LLM_PROVIDER_DEFAULTS = {
  local: {
    apiBase: 'http://localhost:8317/v1',
    model: 'local-model',
  },
  openai: {
    apiBase: 'https://api.openai.com/v1',
    model: 'gpt-5-mini',
  },
  anthropic: {
    apiBase: 'https://api.anthropic.com/v1',
    model: 'claude-sonnet-4-6',
  },
  google: {
    apiBase: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-2.5-flash',
  },
};
const ONBOARDING_BACKEND_DEFAULTS = {
  NODE_ENV: DEFAULT_NODE_ENV,
  LLM_MAX_TOKENS: '4096',
  LLM_TEMPERATURE: '0.7',
  AUTH_ENABLED: 'false',
  AUTH_API_KEYS: '',
  RATE_LIMIT_ENABLED: 'true',
  RATE_LIMIT_WINDOW_MS: '60000',
  RATE_LIMIT_MAX_REQUESTS: '60',
  RATE_LIMIT_BACKEND: 'sqlite',
  RATE_LIMIT_STORE_FILE: 'data/rate-limit.db',
  STORAGE_DRIVER: 'sqlite',
  STORAGE_DATA_FILE: 'data/chat-store.json',
  STORAGE_DB_FILE: 'data/chat.db',
  MEMORY_QDRANT_URL: 'http://localhost:6333',
  MEMORY_QDRANT_COLLECTION: 'argus_memory',
  MEMORY_QDRANT_VECTOR_SIZE: '768',
};
const ONBOARDING_FRONTEND_DEFAULTS = {
  VITE_API_BASE: '/api',
  API_KEY: '',
  VITE_DEV_PROXY_TARGET: `http://localhost:${DEFAULT_BACKEND_PORT}`,
};
const ANSI = {
  reset: '\x1B[0m',
  bold: '\x1B[1m',
  dim: '\x1B[2m',
  red: '\x1B[31m',
  yellow: '\x1B[33m',
  cyan: '\x1B[36m',
  brightCyan: '\x1B[96m',
  gray: '\x1B[90m',
  green: '\x1B[32m',
};

module.exports = {
  repoRoot,
  workspaceSearchStart,
  workspaceRootDetected,
  backendDir,
  frontendDir,
  backendEnvPath,
  frontendEnvPath,
  backendExampleEnvPath,
  frontendExampleEnvPath,
  isArgusWorkspaceRoot,
  findArgusWorkspaceRoot,
  MIN_NODE_MAJOR,
  DEFAULT_BACKEND_PORT,
  DEFAULT_FRONTEND_PORT,
  DEFAULT_QDRANT_PORT,
  DEFAULT_NODE_ENV,
  LLM_PROVIDER_OPTIONS,
  LLM_PROVIDER_DEFAULTS,
  ONBOARDING_BACKEND_DEFAULTS,
  ONBOARDING_FRONTEND_DEFAULTS,
  ANSI,
};
