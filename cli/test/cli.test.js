const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const env = require('../src/core/env');
const runtime = require('../src/core/runtime');
const ui = require('../src/ui/render');
const help = require('../src/commands/help');
const doctorCommand = require('../src/commands/doctor');
const onboardCommand = require('../src/commands/onboard');
const startCommand = require('../src/commands/start');
const qdrantService = require('../src/services/qdrant.service');
const {
  DEFAULT_FRONTEND_PORT,
  backendDir,
  frontendDir,
} = require('../src/core/constants');

function requireFresh(modulePath) {
  const resolved = require.resolve(modulePath);
  delete require.cache[resolved];
  return require(resolved);
}

test('runCli shows help when no command is provided', async (t) => {
  let helpCalls = 0;
  t.mock.method(help, 'runHelp', () => {
    helpCalls += 1;
  });

  const { runCli } = requireFresh('../src/index');
  const exitCode = await runCli([]);

  assert.equal(exitCode, 0);
  assert.equal(helpCalls, 1);
});

test('runCli forwards flags to onboard', async (t) => {
  let onboardOptions;
  t.mock.method(onboardCommand, 'runOnboard', async (options) => {
    onboardOptions = options;
  });

  const { runCli } = requireFresh('../src/index');
  const exitCode = await runCli(['onboard', '--advanced', '--ci']);

  assert.equal(exitCode, 0);
  assert.deepEqual(Array.from(onboardOptions.flags), ['--advanced', '--ci']);
});

test('runCli dispatches doctor and start commands', async (t) => {
  let doctorCalls = 0;
  let startCalls = 0;
  t.mock.method(doctorCommand, 'runDoctor', async () => {
    doctorCalls += 1;
  });
  t.mock.method(startCommand, 'runStart', async () => {
    startCalls += 1;
  });

  const { runCli } = requireFresh('../src/index');

  assert.equal(await runCli(['doctor']), 0);
  assert.equal(await runCli(['start']), 0);
  assert.equal(doctorCalls, 1);
  assert.equal(startCalls, 1);
});

test('runCli returns 1 and reports unknown commands', async (t) => {
  let failureMessage;
  t.mock.method(ui, 'fail', (message) => {
    failureMessage = message;
  });

  const { runCli } = requireFresh('../src/index');
  const exitCode = await runCli(['unknown']);

  assert.equal(exitCode, 1);
  assert.equal(failureMessage, 'Unknown command: unknown\nRun argus-one --help to see available commands.');
});

test('runDoctor recommends onboarding and start when env files, dependencies, and services are missing', async (t) => {
  t.mock.method(env, 'validateNodeVersion', () => {});
  const ensuredDirectories = [];
  t.mock.method(env, 'ensureDirectoryExists', (directoryPath) => {
    ensuredDirectories.push(directoryPath);
  });
  t.mock.method(env, 'hasInstalledDependencies', () => false);
  t.mock.method(env, 'getConfiguredBackendPort', () => 2901);
  t.mock.method(fs, 'existsSync', () => false);
  const checkedPorts = [];
  t.mock.method(runtime, 'checkPortOpen', async (port) => {
    checkedPorts.push(port);
    return false;
  });
  t.mock.method(runtime, 'fetchJson', async () => ({ ok: false, status: 0, body: 'not called' }));
  t.mock.method(ui, 'logCliHeader', () => {});
  t.mock.method(ui, 'logCliFlowStart', () => {});
  t.mock.method(ui, 'logStatusPanel', () => {});
  let recommendedSteps;
  t.mock.method(ui, 'logStepList', (title, steps) => {
    if (title === 'Recommended next steps') {
      recommendedSteps = steps;
    }
  });
  t.mock.method(ui, 'logCliFlowEnd', () => {});

  const { runDoctor } = requireFresh('../src/commands/doctor');
  await runDoctor();

  assert.deepEqual(ensuredDirectories, [backendDir, frontendDir]);
  assert.deepEqual(checkedPorts, [2901, DEFAULT_FRONTEND_PORT, qdrantService.QDRANT_PORT]);
  assert.deepEqual(recommendedSteps, [
    'Run argus-one onboard to create the missing env files.',
    'Install missing dependencies with argus-one onboard or npm install.',
    'Run argus-one onboard to download the Qdrant binary for vector search.',
    'Run argus-one start to launch the local workspace.',
  ]);
});

test('runDoctor includes live endpoint checks when services are already running', async (t) => {
  t.mock.method(env, 'validateNodeVersion', () => {});
  t.mock.method(env, 'ensureDirectoryExists', () => {});
  t.mock.method(env, 'hasInstalledDependencies', () => true);
  t.mock.method(env, 'getConfiguredBackendPort', () => 2901);
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(runtime, 'checkPortOpen', async () => true);
  const fetchUrls = [];
  t.mock.method(runtime, 'fetchJson', async (url) => {
    fetchUrls.push(url);
    if (url.endsWith('/api/health')) {
      return { ok: true, status: 200, body: { status: 'ok' } };
    }
    return { ok: true, status: 200, body: '<html></html>' };
  });
  t.mock.method(ui, 'logCliHeader', () => {});
  t.mock.method(ui, 'logCliFlowStart', () => {});
  let liveChecks;
  t.mock.method(ui, 'logStatusPanel', (title, rows) => {
    if (title === 'Live endpoints') {
      liveChecks = rows;
    }
  });
  t.mock.method(ui, 'logStepList', () => {});
  t.mock.method(ui, 'logCliFlowEnd', () => {});

  const { runDoctor } = requireFresh('../src/commands/doctor');
  await runDoctor();

  assert.deepEqual(fetchUrls, [
    'http://localhost:2901/api/health',
    `http://localhost:${DEFAULT_FRONTEND_PORT}`,
    `http://localhost:${qdrantService.QDRANT_PORT}/readyz`,
  ]);
  assert.deepEqual(liveChecks, [
    { label: 'backend health', status: 'ok', detail: 'status=ok' },
    { label: 'frontend http', status: 'ok', detail: 'http 200' },
    { label: 'qdrant readiness', status: 'ok', detail: 'ready' },
  ]);
});

test('runStart fails fast when env files are missing', async (t) => {
  t.mock.method(env, 'validateNodeVersion', () => {});
  t.mock.method(env, 'ensureDirectoryExists', () => {});
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(ui, 'fail', (message) => {
    throw new Error(message);
  });

  const { runStart } = requireFresh('../src/commands/start');

  await assert.rejects(() => runStart(), /Missing \.env files\. Run `argus-one onboard` first\./);
});

test('runStart skips spawning processes when backend and frontend are already running', async (t) => {
  t.mock.method(env, 'validateNodeVersion', () => {});
  t.mock.method(env, 'ensureDirectoryExists', () => {});
  t.mock.method(env, 'hasInstalledDependencies', () => true);
  t.mock.method(env, 'getConfiguredBackendPort', () => 2901);
  t.mock.method(fs, 'existsSync', () => true);
  t.mock.method(runtime, 'checkPortOpen', async () => true);
  let spawnCalls = 0;
  t.mock.method(runtime, 'spawnManagedProcess', () => {
    spawnCalls += 1;
    return { killed: false, kill() {}, once() {} };
  });
  const statusLines = [];
  t.mock.method(ui, 'printStatus', (label, status, detail) => {
    statusLines.push({ label, status, detail });
  });
  t.mock.method(ui, 'logCliHeader', () => {});
  t.mock.method(ui, 'logCliFlowStart', () => {});
  t.mock.method(ui, 'logKeyValuePanel', () => {});
  t.mock.method(ui, 'logPanel', () => {});
  t.mock.method(ui, 'logCliFlowEnd', () => {});

  const { runStart } = requireFresh('../src/commands/start');
  await runStart();

  assert.equal(spawnCalls, 0);
  assert.deepEqual(statusLines, [
    { label: 'qdrant', status: 'ready', detail: `already running on port ${qdrantService.QDRANT_PORT}` },
    { label: 'backend', status: 'ready', detail: 'already running on http://localhost:2901' },
    { label: 'frontend', status: 'ready', detail: `already running on http://localhost:${DEFAULT_FRONTEND_PORT}` },
  ]);
});
