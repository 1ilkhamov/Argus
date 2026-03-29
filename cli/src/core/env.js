const fs = require('node:fs');
const path = require('node:path');
const {
  backendDir,
  frontendDir,
  backendEnvPath,
  frontendEnvPath,
  backendExampleEnvPath,
  frontendExampleEnvPath,
  MIN_NODE_MAJOR,
  DEFAULT_BACKEND_PORT,
  workspaceSearchStart,
  workspaceRootDetected,
} = require('./constants');
const { fail } = require('../ui/render');

function ensureDirectoryExists(directoryPath) {
  if (!fs.existsSync(directoryPath)) {
    fail(`Missing required directory: ${directoryPath}`);
  }
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    fail(`Missing required file: ${filePath}`);
  }
}

function getNodeMajorVersion() {
  return Number.parseInt(process.versions.node.split('.')[0], 10);
}

function validateNodeVersion() {
  const currentMajor = getNodeMajorVersion();

  if (Number.isNaN(currentMajor) || currentMajor < MIN_NODE_MAJOR) {
    fail(`Argus requires Node.js >= ${MIN_NODE_MAJOR}. Current version: ${process.versions.node}`);
  }
}

function ensureArgusWorkspace() {
  if (workspaceRootDetected) {
    return;
  }

  fail(
    `Argus workspace not found from ${workspaceSearchStart}. Run this command from the Argus repo root or one of its subdirectories.`,
  );
}

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const result = {};

  for (const line of content.split(/\r?\n/)) {
    if (!line || line.trim().length === 0 || line.trim().startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1);
    result[key] = value;
  }

  return result;
}

function formatEnvValue(key, value) {
  return String(value).replace(/\r?\n+/g, ',').trim();
}

function writeEnvFile(filePath, sections) {
  const lines = [];

  for (const section of sections) {
    lines.push(`# ${section.title}`);
    for (const entry of section.entries) {
      if (entry.value === undefined || entry.value === null) {
        continue;
      }

      lines.push(`${entry.key}=${formatEnvValue(entry.key, entry.value)}`);
    }
    lines.push('');
  }

  fs.writeFileSync(filePath, `${lines.join('\n').trimEnd()}\n`, 'utf8');
}

function hasInstalledDependencies(directoryPath) {
  const nodeModulesPath = path.join(directoryPath, 'node_modules');

  if (!fs.existsSync(nodeModulesPath)) {
    return false;
  }

  return fs.readdirSync(nodeModulesPath).length > 0;
}

function readBackendConfig() {
  return parseEnvFile(backendEnvPath);
}

function readFrontendConfig() {
  return parseEnvFile(frontendEnvPath);
}

function getConfiguredBackendPort() {
  const backendConfig = readBackendConfig();
  return Number.parseInt(backendConfig.PORT || String(DEFAULT_BACKEND_PORT), 10) || DEFAULT_BACKEND_PORT;
}

module.exports = {
  fs,
  backendDir,
  frontendDir,
  backendEnvPath,
  frontendEnvPath,
  backendExampleEnvPath,
  frontendExampleEnvPath,
  ensureDirectoryExists,
  ensureFileExists,
  validateNodeVersion,
  ensureArgusWorkspace,
  parseEnvFile,
  writeEnvFile,
  formatEnvValue,
  hasInstalledDependencies,
  readBackendConfig,
  readFrontendConfig,
  getConfiguredBackendPort,
};
