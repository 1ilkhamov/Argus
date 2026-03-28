const net = require('node:net');
const { spawn, spawnSync } = require('node:child_process');
const { hasInstalledDependencies } = require('./env');
const { printStatus, fail, logError, formatStatusLine } = require('../ui/render');

function runNpmInstall(directoryPath, label) {
  if (hasInstalledDependencies(directoryPath)) {
    printStatus(label, 'skipped', 'dependencies already present');
    return;
  }

  printStatus(label, 'starting', 'npm install');

  const result = spawnSync('npm', ['install'], {
    cwd: directoryPath,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    fail(`${label}: npm install failed`);
  }

  printStatus(label, 'written', 'dependencies installed');
}

function checkPortOpen(port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();

    socket.setTimeout(500);

    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });

    const handleFailure = () => {
      socket.destroy();
      resolve(false);
    };

    socket.once('timeout', handleFailure);
    socket.once('error', handleFailure);
    socket.connect(port, '127.0.0.1');
  });
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(2000),
    });

    const contentType = response.headers.get('content-type') || '';
    const body = contentType.includes('application/json') ? await response.json() : await response.text();

    return {
      ok: response.ok,
      status: response.status,
      body,
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      body: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function spawnManagedProcess(name, cwd, npmScript) {
  printStatus(name, 'starting', `npm run ${npmScript}`);

  const child = spawn('npm', ['run', npmScript], {
    cwd,
    stdio: 'inherit',
    env: process.env,
  });

  child.on('error', (error) => {
    logError(`  ${formatStatusLine(name, 'error', error.message, 24)}`);
  });

  return child;
}

module.exports = {
  runNpmInstall,
  checkPortOpen,
  fetchJson,
  spawnManagedProcess,
};
