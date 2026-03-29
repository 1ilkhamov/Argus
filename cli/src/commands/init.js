const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const { logCliHeader, logCliFlowStart, logCliFlowEnd, logStepList, logPanel, printStatus, fail, log } = require('../ui/render');

const ARGUS_REPO_URL = 'https://github.com/1ilkhamov/Argus.git';
const DEFAULT_DIR = 'Argus';

async function runInit(options = {}) {
  const targetDir = options.dir || DEFAULT_DIR;
  const targetPath = path.resolve(process.cwd(), targetDir);

  logCliHeader('🚀', 'Argus Init', 'Clone and set up a new Argus workspace on this machine.');
  logCliFlowStart('Setup');

  if (existsSync(targetPath)) {
    fail(`Directory already exists: ${targetPath}\nRemove it or choose a different name with: argus-one init --dir <name>`);
  }

  const gitCheck = spawnSync('git', ['--version'], { stdio: 'pipe' });
  if (gitCheck.status !== 0) {
    fail('git is required but not found. Install git and try again.');
  }

  printStatus('git', 'starting', `cloning into ${targetDir}/`);

  const cloneResult = spawnSync('git', ['clone', ARGUS_REPO_URL, targetPath], {
    stdio: 'inherit',
    env: process.env,
  });

  if (cloneResult.status !== 0) {
    fail('git clone failed. Check your internet connection and try again.');
  }

  printStatus('clone', 'written', targetDir);

  log('');

  logPanel(
    'Workspace ready',
    [
      `Argus was cloned into: ${targetPath}`,
      '',
      'Run the following commands to get started:',
    ],
    { tone: 'green' },
  );

  logStepList(
    'Next steps',
    [
      `cd ${targetDir}`,
      'argus-one onboard',
      'argus-one doctor',
      'argus-one start',
    ],
    { tone: 'green', continueRail: false },
  );

  logCliFlowEnd();
}

module.exports = { runInit };
