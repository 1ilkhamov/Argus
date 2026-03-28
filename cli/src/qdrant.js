const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const os = require('node:os');

const { repoRoot } = require('./constants');
const { printStatus, logError, formatStatusLine } = require('./ui');

const QDRANT_VERSION = '1.13.2';
const QDRANT_PORT = 6333;
const QDRANT_GRPC_PORT = 6334;
const QDRANT_BIN_DIR = path.join(repoRoot, 'bin');
const QDRANT_BIN_PATH = path.join(QDRANT_BIN_DIR, 'qdrant');
const QDRANT_STORAGE_DIR = path.join(repoRoot, 'backend', 'data', 'qdrant-storage');

function getQdrantPlatformTriple() {
  const platform = os.platform();
  const arch = os.arch();

  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
  };

  const key = `${platform}-${arch}`;
  return triples[key] || null;
}

function getQdrantDownloadUrl(version) {
  const triple = getQdrantPlatformTriple();
  if (!triple) {
    return null;
  }

  return `https://github.com/qdrant/qdrant/releases/download/v${version}/qdrant-${triple}.tar.gz`;
}

function isQdrantInstalled() {
  return fs.existsSync(QDRANT_BIN_PATH);
}

async function downloadAndExtractQdrant(version = QDRANT_VERSION) {
  const url = getQdrantDownloadUrl(version);
  if (!url) {
    const platform = os.platform();
    const arch = os.arch();
    throw new Error(`Unsupported platform: ${platform}-${arch}. Qdrant supports darwin/linux on x64/arm64.`);
  }

  if (!fs.existsSync(QDRANT_BIN_DIR)) {
    fs.mkdirSync(QDRANT_BIN_DIR, { recursive: true });
  }

  printStatus('qdrant', 'downloading', `v${version} for ${os.platform()}-${os.arch()}`);

  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`Failed to download Qdrant: HTTP ${response.status} from ${url}`);
  }

  const tmpPath = path.join(QDRANT_BIN_DIR, `qdrant-${version}.tar.gz`);

  try {
    const fileStream = fs.createWriteStream(tmpPath);
    await pipeline(response.body, fileStream);

    await extractTarGz(tmpPath, QDRANT_BIN_DIR);

    fs.chmodSync(QDRANT_BIN_PATH, 0o755);
    printStatus('qdrant', 'installed', `v${version} → bin/qdrant`);
  } finally {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  }
}

async function extractTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['xzf', archivePath, '-C', destDir, 'qdrant'], {
      stdio: 'pipe',
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });

    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`tar extraction failed (code ${code}): ${stderr.trim()}`));
      }
    });

    child.on('error', reject);
  });
}

function spawnQdrantProcess() {
  if (!isQdrantInstalled()) {
    throw new Error('Qdrant binary not found. Run `argus-one onboard` first.');
  }

  if (!fs.existsSync(QDRANT_STORAGE_DIR)) {
    fs.mkdirSync(QDRANT_STORAGE_DIR, { recursive: true });
  }

  printStatus('qdrant', 'starting', `port ${QDRANT_PORT}`);

  const child = spawn(QDRANT_BIN_PATH, [], {
    cwd: QDRANT_STORAGE_DIR,
    stdio: 'pipe',
    env: {
      ...process.env,
      QDRANT__SERVICE__HTTP_PORT: String(QDRANT_PORT),
      QDRANT__SERVICE__GRPC_PORT: String(QDRANT_GRPC_PORT),
      QDRANT__STORAGE__STORAGE_PATH: path.join(QDRANT_STORAGE_DIR, 'storage'),
      QDRANT__STORAGE__SNAPSHOTS_PATH: path.join(QDRANT_STORAGE_DIR, 'snapshots'),
      QDRANT__LOG_LEVEL: 'WARN',
    },
  });

  child.on('error', (error) => {
    logError(`  ${formatStatusLine('qdrant', 'error', error.message, 24)}`);
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text && text.includes('ERROR')) {
      logError(`  qdrant: ${text.slice(0, 200)}`);
    }
  });

  return child;
}

async function waitForQdrantReady(port = QDRANT_PORT, timeoutMs = 15000) {
  const start = Date.now();
  const url = `http://localhost:${port}/readyz`;

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        printStatus('qdrant', 'ready', `listening on port ${port}`);
        return true;
      }
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }

  return false;
}

module.exports = {
  QDRANT_VERSION,
  QDRANT_PORT,
  QDRANT_BIN_PATH,
  QDRANT_STORAGE_DIR,
  isQdrantInstalled,
  downloadAndExtractQdrant,
  getQdrantPlatformTriple,
  spawnQdrantProcess,
  waitForQdrantReady,
};
