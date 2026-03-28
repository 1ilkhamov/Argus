const fs = require('node:fs');
const { DEFAULT_FRONTEND_PORT, backendEnvPath, frontendEnvPath } = require('../core/constants');
const {
  backendDir,
  frontendDir,
  ensureDirectoryExists,
  validateNodeVersion,
  hasInstalledDependencies,
  getConfiguredBackendPort,
} = require('../core/env');
const { checkPortOpen, spawnManagedProcess } = require('../core/runtime');
const { isQdrantInstalled, spawnQdrantProcess, waitForQdrantReady, QDRANT_PORT } = require('../services/qdrant.service');
const { fail, printStatus, logCliHeader, logCliFlowStart, logKeyValuePanel, logPanel, logCliFlowEnd } = require('../ui/render');

async function runStart() {
  validateNodeVersion();
  ensureDirectoryExists(backendDir);
  ensureDirectoryExists(frontendDir);

  if (!fs.existsSync(backendEnvPath) || !fs.existsSync(frontendEnvPath)) {
    fail('Missing .env files. Run `argus-one onboard` first.');
  }

  if (!hasInstalledDependencies(backendDir) || !hasInstalledDependencies(frontendDir)) {
    fail('Missing dependencies. Run `argus-one onboard` first.');
  }

  const backendPort = getConfiguredBackendPort();
  const backendRunning = await checkPortOpen(backendPort);
  const frontendRunning = await checkPortOpen(DEFAULT_FRONTEND_PORT);
  const qdrantRunning = await checkPortOpen(QDRANT_PORT);
  const children = [];

  logCliHeader('🚀', 'Argus Start', 'Launch the backend and frontend together from the project root.');
  logCliFlowStart('Argus start');

  if (qdrantRunning) {
    printStatus('qdrant', 'ready', `already running on port ${QDRANT_PORT}`);
  } else if (isQdrantInstalled()) {
    const qdrantChild = spawnQdrantProcess();
    children.push(qdrantChild);
    const ready = await waitForQdrantReady();
    if (!ready) {
      printStatus('qdrant', 'warning', 'failed to start within 15s — backend will run without vector search');
    }
  } else {
    printStatus('qdrant', 'skipped', 'binary not found — run argus-one onboard to install');
  }

  if (backendRunning) {
    printStatus('backend', 'ready', `already running on http://localhost:${backendPort}`);
  } else {
    children.push(spawnManagedProcess('backend', backendDir, 'start:dev'));
  }

  if (frontendRunning) {
    printStatus('frontend', 'ready', `already running on http://localhost:${DEFAULT_FRONTEND_PORT}`);
  } else {
    children.push(spawnManagedProcess('frontend', frontendDir, 'dev'));
  }

  if (backendRunning && frontendRunning) {
    logKeyValuePanel(
      'Workspace status',
      [
        { label: 'qdrant', value: qdrantRunning ? `http://localhost:${QDRANT_PORT}` : 'not running' },
        { label: 'frontend', value: `http://localhost:${DEFAULT_FRONTEND_PORT}` },
        { label: 'backend', value: `http://localhost:${backendPort}` },
      ],
      { tone: 'green', continueRail: false },
    );
    logCliFlowEnd('green');
    return;
  }

  logKeyValuePanel(
    'Launch targets',
    [
      { label: 'qdrant', value: `http://localhost:${QDRANT_PORT}` },
      { label: 'frontend', value: `http://localhost:${DEFAULT_FRONTEND_PORT}` },
      { label: 'backend', value: `http://localhost:${backendPort}` },
    ],
    { tone: 'cyan' },
  );
  logPanel(
    'Session notes',
    [
      'Keep this terminal open while the dev servers are running.',
      'Press Ctrl+C here when you want Argus to shut both local processes down.',
    ],
    { tone: 'yellow', continueRail: false },
  );
  logCliFlowEnd();

  const shutdown = () => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGINT');
      }
    }
  };

  process.on('SIGINT', () => {
    shutdown();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    shutdown();
    process.exit(0);
  });

  try {
    await Promise.all(
      children.map(
        (child) =>
          new Promise((resolve, reject) => {
            child.once('exit', (code) => {
              if (code && code !== 0) {
                reject(new Error(`Process exited with code ${code}`));
                return;
              }

              resolve();
            });

            child.once('error', reject);
          }),
      ),
    );
  } catch (error) {
    shutdown();
    throw error;
  }
}

module.exports = {
  runStart,
};
