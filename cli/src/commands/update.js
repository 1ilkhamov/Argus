const { spawnSync } = require('node:child_process');
const { repoRoot, workspaceRootDetected } = require('../core/constants');
const { fail, logCliHeader, logCliFlowStart, logCliFlowEnd, logPanel, logStepList, printStatus } = require('../ui/render');

function runGitCommand(args, cwd) {
  return spawnSync('git', args, { cwd, stdio: 'pipe', encoding: 'utf8' });
}

function runUpdate() {
  if (!workspaceRootDetected) {
    fail('Argus workspace not found. Run this command from the Argus repo root or one of its subdirectories.');
  }

  const gitCheck = spawnSync('git', ['--version'], { stdio: 'pipe' });
  if (gitCheck.status !== 0) {
    fail('git is required but not found. Install git from https://git-scm.com and try again.');
  }

  logCliHeader('🔄', 'Argus Update', 'Pull the latest changes from the remote repository.');
  logCliFlowStart('Argus update');

  const statusResult = runGitCommand(['status', '--porcelain'], repoRoot);
  if (statusResult.status !== 0) {
    fail('Could not check git status. Make sure the workspace is a valid git repository.');
  }

  const hasLocalChanges = (statusResult.stdout || '').trim().length > 0;
  if (hasLocalChanges) {
    printStatus('workspace', 'warning', 'uncommitted local changes — they will not be overwritten');
  }

  printStatus('git pull', 'starting', repoRoot);

  const pullResult = runGitCommand(['pull', '--ff-only'], repoRoot);

  if (pullResult.status !== 0) {
    const stderr = (pullResult.stderr || '').trim();
    if (stderr.includes('diverged') || stderr.includes('not possible to fast-forward')) {
      fail('Cannot fast-forward. Your local branch has diverged from the remote. Resolve manually with git.');
    }

    fail(`git pull failed: ${stderr || 'unknown error'}`);
  }

  const output = (pullResult.stdout || '').trim();
  const alreadyUpToDate = /already up.to.date/i.test(output);

  if (alreadyUpToDate) {
    printStatus('workspace', 'ready', 'already up to date');
    logPanel(
      'No updates',
      ['Argus is already at the latest version.'],
      { tone: 'green', continueRail: false },
    );
    logCliFlowEnd();
    return;
  }

  printStatus('workspace', 'written', 'updated successfully');

  logPanel(
    'Update complete',
    ['New changes have been pulled from the remote repository.'],
    { tone: 'green' },
  );

  logStepList(
    'Recommended next steps',
    [
      'argus-one onboard   (reinstall dependencies if needed)',
      'argus-one start',
    ],
    { tone: 'cyan', continueRail: false },
  );

  logCliFlowEnd();
}

module.exports = { runUpdate };
