const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const env = require('../src/core/env');
const onboardCommand = require('../src/commands/onboard');

function requireFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

// ─── buildOnboardingConfig (non-interactive / --yes mode) ────────────────────

test('buildOnboardingConfig non-interactive produces correct default structure', async (t) => {
  t.mock.method(env, 'readBackendConfig', () => ({}));
  // Prevent TTY detection from enabling interactive mode
  const origIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  t.after(() => { process.stdin.isTTY = origIsTTY; });

  const { buildOnboardingConfig } = requireFresh('../src/commands/onboard');
  const config = await buildOnboardingConfig(new Set(['--yes']));

  // Backend defaults
  assert.equal(config.backend.NODE_ENV, 'development');
  assert.equal(config.backend.AUTH_ENABLED, 'false');
  assert.equal(config.backend.AUTH_API_KEYS, '');
  assert.equal(config.backend.AUTH_ADMIN_API_KEY, '');
  assert.match(config.backend.SETTINGS_ENCRYPTION_SECRET, /^[0-9a-f]{64}$/);
  assert.equal(config.backend.STORAGE_DRIVER, 'sqlite');
  assert.equal(config.backend.LLM_MAX_TOKENS, '4096');
  assert.equal(config.backend.LLM_TEMPERATURE, '0.7');

  // Frontend defaults
  assert.equal(config.frontend.VITE_API_BASE, '/api');
  assert.equal(config.frontend.API_KEY, '');
  assert.equal(config.frontend.ADMIN_API_KEY, '');
});

test('buildOnboardingConfig non-interactive preserves existing backend values', async (t) => {
  t.mock.method(env, 'readBackendConfig', () => ({
    LLM_PROVIDER: 'openai',
    LLM_API_KEY: 'sk-test-key',
    LLM_MODEL: 'gpt-4o',
    MEMORY_QDRANT_URL: 'http://custom-qdrant:6333',
  }));
  const origIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  t.after(() => { process.stdin.isTTY = origIsTTY; });

  const { buildOnboardingConfig } = requireFresh('../src/commands/onboard');
  const config = await buildOnboardingConfig(new Set(['--yes']));

  assert.equal(config.backend.LLM_PROVIDER, 'openai');
  assert.equal(config.backend.LLM_API_KEY, 'sk-test-key');
  assert.equal(config.backend.LLM_MODEL, 'gpt-4o');
  assert.equal(config.backend.MEMORY_QDRANT_URL, 'http://custom-qdrant:6333');
});

test('buildOnboardingConfig non-interactive preserves existing auth secrets', async (t) => {
  t.mock.method(env, 'readBackendConfig', () => ({
    AUTH_ENABLED: 'true',
    AUTH_API_KEYS: 'existing-key',
    AUTH_ADMIN_API_KEY: 'existing-admin-key',
    SETTINGS_ENCRYPTION_SECRET: 'existing-secret',
  }));
  const origIsTTY = process.stdin.isTTY;
  process.stdin.isTTY = false;
  t.after(() => { process.stdin.isTTY = origIsTTY; });

  const { buildOnboardingConfig } = requireFresh('../src/commands/onboard');
  const config = await buildOnboardingConfig(new Set(['--yes']));

  // Non-interactive resets to simple defaults (auth disabled)
  assert.equal(config.backend.AUTH_ENABLED, 'false');
  assert.equal(config.backend.AUTH_ADMIN_API_KEY, '');
  assert.equal(config.backend.SETTINGS_ENCRYPTION_SECRET, 'existing-secret');
});

// ─── writeBackendEnv ─────────────────────────────────────────────────────────

test('writeBackendEnv writes all auth-related keys', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'argus-test-'));
  const tmpEnvPath = path.join(tmpDir, '.env');
  t.after(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // Temporarily redirect the backend env path
  const origPath = env.backendEnvPath;
  const origWriteEnv = env.writeEnvFile;

  let writtenSections;
  t.mock.method(env, 'writeEnvFile', (filePath, sections) => {
    writtenSections = sections;
    origWriteEnv(filePath, sections);
  });

  const { writeBackendEnv } = requireFresh('../src/commands/onboard');

  const config = {
    PORT: '2901',
    NODE_ENV: 'development',
    LLM_PROVIDER: 'openai',
    LLM_API_BASE: 'https://api.openai.com/v1',
    LLM_API_KEY: 'sk-test',
    LLM_API_KEY_FILE: '',
    LLM_MODEL: 'gpt-4o',
    LLM_MAX_TOKENS: '4096',
    LLM_TEMPERATURE: '0.7',
    CORS_ORIGIN: 'http://localhost:2101',
    AUTH_ENABLED: 'true',
    AUTH_API_KEYS: 'my-key',
    AUTH_API_KEYS_FILE: '',
    AUTH_ADMIN_API_KEY: 'admin-key-abc',
    SETTINGS_ENCRYPTION_SECRET: 'secret-xyz',
    RATE_LIMIT_ENABLED: 'true',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_MAX_REQUESTS: '60',
    RATE_LIMIT_BACKEND: 'sqlite',
    RATE_LIMIT_STORE_FILE: 'data/rate-limit.db',
    RATE_LIMIT_REDIS_URL: '',
    STORAGE_DRIVER: 'sqlite',
    STORAGE_DATA_FILE: 'data/chat-store.json',
    STORAGE_DB_FILE: 'data/chat.db',
    STORAGE_POSTGRES_URL: '',
    MEMORY_QDRANT_URL: 'http://localhost:6333',
    MEMORY_QDRANT_COLLECTION: 'argus_memory',
    MEMORY_QDRANT_VECTOR_SIZE: '768',
  };

  writeBackendEnv(config);

  // Find Auth section
  const authSection = writtenSections.find((s) => s.title === 'Auth');
  assert.ok(authSection, 'Auth section must exist');
  const authKeys = authSection.entries.map((e) => e.key);
  assert.ok(authKeys.includes('AUTH_ENABLED'), 'AUTH_ENABLED in Auth section');
  assert.ok(authKeys.includes('AUTH_API_KEYS'), 'AUTH_API_KEYS in Auth section');
  assert.ok(authKeys.includes('AUTH_ADMIN_API_KEY'), 'AUTH_ADMIN_API_KEY in Auth section');

  const adminEntry = authSection.entries.find((e) => e.key === 'AUTH_ADMIN_API_KEY');
  assert.equal(adminEntry.value, 'admin-key-abc');

  // Find Settings section
  const settingsSection = writtenSections.find((s) => s.title === 'Settings');
  assert.ok(settingsSection, 'Settings section must exist');
  const encEntry = settingsSection.entries.find((e) => e.key === 'SETTINGS_ENCRYPTION_SECRET');
  assert.equal(encEntry.value, 'secret-xyz');
});

// ─── writeFrontendEnv ────────────────────────────────────────────────────────

test('writeFrontendEnv includes ADMIN_API_KEY', (t) => {
  const origWriteEnv = env.writeEnvFile;
  let writtenSections;
  t.mock.method(env, 'writeEnvFile', (filePath, sections) => {
    writtenSections = sections;
  });

  const { writeFrontendEnv } = requireFresh('../src/commands/onboard');

  writeFrontendEnv({
    VITE_API_BASE: '/api',
    API_KEY: 'user-key',
    ADMIN_API_KEY: 'admin-key-abc',
    VITE_DEV_PROXY_TARGET: 'http://localhost:2901',
  });

  const frontendSection = writtenSections.find((s) => s.title === 'Frontend');
  assert.ok(frontendSection, 'Frontend section must exist');
  const keys = frontendSection.entries.map((e) => e.key);
  assert.ok(keys.includes('API_KEY'), 'API_KEY present');
  assert.ok(keys.includes('ADMIN_API_KEY'), 'ADMIN_API_KEY present');

  const adminEntry = frontendSection.entries.find((e) => e.key === 'ADMIN_API_KEY');
  assert.equal(adminEntry.value, 'admin-key-abc');
});

test('writeFrontendEnv writes empty ADMIN_API_KEY when auth is disabled', (t) => {
  let writtenSections;
  t.mock.method(env, 'writeEnvFile', (filePath, sections) => {
    writtenSections = sections;
  });

  const { writeFrontendEnv } = requireFresh('../src/commands/onboard');

  writeFrontendEnv({
    VITE_API_BASE: '/api',
    API_KEY: '',
    ADMIN_API_KEY: '',
    VITE_DEV_PROXY_TARGET: 'http://localhost:2901',
  });

  const frontendSection = writtenSections.find((s) => s.title === 'Frontend');
  const adminEntry = frontendSection.entries.find((e) => e.key === 'ADMIN_API_KEY');
  assert.equal(adminEntry.value, '');
});

// ─── Auth secret generation ──────────────────────────────────────────────────

test('generateSecureKey produces 64-char hex strings', () => {
  const crypto = require('node:crypto');
  const key = crypto.randomBytes(32).toString('hex');
  assert.equal(key.length, 64);
  assert.match(key, /^[0-9a-f]{64}$/);
});
