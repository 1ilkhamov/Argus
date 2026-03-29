const fs = require('node:fs');
const { DEFAULT_FRONTEND_PORT, backendEnvPath, frontendEnvPath } = require('../core/constants');
const {
  backendDir,
  frontendDir,
  ensureDirectoryExists,
  validateNodeVersion,
  ensureArgusWorkspace,
  hasInstalledDependencies,
  getConfiguredBackendPort,
  readBackendConfig,
} = require('../core/env');
const { checkPortOpen, fetchJson } = require('../core/runtime');
const { isQdrantInstalled, QDRANT_PORT } = require('../services/qdrant.service');
const { logCliHeader, logCliFlowStart, logStatusPanel, logStepList, logCliFlowEnd } = require('../ui/render');

async function runDoctor() {
  validateNodeVersion();
  ensureArgusWorkspace();
  ensureDirectoryExists(backendDir);
  ensureDirectoryExists(frontendDir);

  const backendEnvExists = fs.existsSync(backendEnvPath);
  const frontendEnvExists = fs.existsSync(frontendEnvPath);
  const backendDeps = hasInstalledDependencies(backendDir);
  const frontendDeps = hasInstalledDependencies(frontendDir);
  const backendPort = getConfiguredBackendPort();
  const backendRunning = await checkPortOpen(backendPort);
  const frontendRunning = await checkPortOpen(DEFAULT_FRONTEND_PORT);
  const qdrantBinary = isQdrantInstalled();
  const qdrantRunning = await checkPortOpen(QDRANT_PORT);

  logCliHeader('🩺', 'Argus Doctor', 'Check local readiness, service state, and live runtime reachability.');
  logCliFlowStart('Argus doctor');
  logStatusPanel(
    'Workspace readiness',
    [
      { label: 'node', status: 'ok', detail: process.versions.node },
      { label: 'backend/.env', status: backendEnvExists ? 'ok' : 'missing' },
      { label: 'frontend/.env', status: frontendEnvExists ? 'ok' : 'missing' },
      { label: 'backend dependencies', status: backendDeps ? 'ok' : 'missing' },
      { label: 'frontend dependencies', status: frontendDeps ? 'ok' : 'missing' },
      { label: 'qdrant binary', status: qdrantBinary ? 'ok' : 'missing' },
    ],
    { tone: 'cyan' },
  );
  logStatusPanel(
    'Local services',
    [
      { label: `backend port ${backendPort}`, status: backendRunning ? 'listening' : 'not running' },
      { label: `frontend port ${DEFAULT_FRONTEND_PORT}`, status: frontendRunning ? 'listening' : 'not running' },
      { label: `qdrant port ${QDRANT_PORT}`, status: qdrantRunning ? 'listening' : 'not running' },
    ],
    { tone: backendRunning || frontendRunning ? 'green' : 'yellow' },
  );

  const liveChecks = [];
  if (backendRunning) {
    const health = await fetchJson(`http://localhost:${backendPort}/api/health`);
    const detail =
      health.ok && health.body && typeof health.body === 'object'
        ? `status=${health.body.status}`
        : `http ${health.status}`;
    liveChecks.push({ label: 'backend health', status: health.ok ? 'ok' : 'error', detail });
  }

  if (frontendRunning) {
    const frontendResponse = await fetchJson(`http://localhost:${DEFAULT_FRONTEND_PORT}`);
    liveChecks.push({
      label: 'frontend http',
      status: frontendResponse.ok ? 'ok' : 'error',
      detail: `http ${frontendResponse.status}`,
    });
  }

  if (qdrantRunning) {
    const qdrantHealth = await fetchJson(`http://localhost:${QDRANT_PORT}/readyz`);
    liveChecks.push({
      label: 'qdrant readiness',
      status: qdrantHealth.ok ? 'ok' : 'error',
      detail: qdrantHealth.ok ? 'ready' : `http ${qdrantHealth.status}`,
    });
  }

  if (liveChecks.length > 0) {
    logStatusPanel('Live endpoints', liveChecks, { tone: 'green' });
  }

  const configWarnings = [];
  if (backendEnvExists) {
    let cfg;
    try { cfg = readBackendConfig(); } catch { cfg = {}; }
    if (cfg.AUTH_ENABLED === 'true' && !cfg.AUTH_ADMIN_API_KEY) {
      configWarnings.push('AUTH_ADMIN_API_KEY is not set — admin endpoints (settings, memory management) will be inaccessible.');
    }
    if (cfg.AUTH_ENABLED === 'true' && !cfg.SETTINGS_ENCRYPTION_SECRET) {
      configWarnings.push('SETTINGS_ENCRYPTION_SECRET is not set — sensitive settings values will use a default encryption key.');
    }
    if (cfg.QDRANT_URL && !cfg.MEMORY_QDRANT_URL) {
      configWarnings.push('QDRANT_URL is set but the backend expects MEMORY_QDRANT_URL — rename the variable in backend/.env.');
    }
  }
  if (configWarnings.length > 0) {
    logStepList('Configuration warnings', configWarnings, { tone: 'yellow', continueRail: true });
  }

  const nextSteps = [];
  if (!backendEnvExists || !frontendEnvExists) {
    nextSteps.push('Run argus-one onboard to create the missing env files.');
  }
  if (!backendDeps || !frontendDeps) {
    nextSteps.push('Install missing dependencies with argus-one onboard or npm install.');
  }
  if (!qdrantBinary) {
    nextSteps.push('Run argus-one onboard to download the Qdrant binary for vector search.');
  }
  if (!backendRunning || !frontendRunning) {
    nextSteps.push('Run argus-one start to launch the local workspace.');
  }
  if (nextSteps.length === 0) {
    nextSteps.push(`Open http://localhost:${DEFAULT_FRONTEND_PORT} if you want to jump back into the app.`);
  }

  logStepList('Recommended next steps', nextSteps, {
    tone: nextSteps.length === 1 && backendRunning && frontendRunning ? 'green' : 'yellow',
    continueRail: false,
  });
  logCliFlowEnd();
}

module.exports = {
  runDoctor,
};
