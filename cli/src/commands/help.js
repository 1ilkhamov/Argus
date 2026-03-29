const { logCliHeader, logCliFlowStart, logStepList, logCommandList, logCliFlowEnd } = require('../ui/render');

function runHelp() {
  logCliHeader('✨', 'Argus CLI', 'A polished local setup, readiness, and launch assistant for your workspace.');
  logCliFlowStart('Argus overview');
  logStepList(
    'Quick start on a new machine',
    [
      'npm install -g argus-one',
      'argus-one init',
      'cd Argus',
      'argus-one onboard',
      'argus-one start',
    ],
    { tone: 'green' },
  );
  logStepList(
    'Repo development workflow',
    [
      'npm install',
      'npm run onboard',
      'npm run doctor',
      'npm run start',
    ],
    { tone: 'cyan' },
  );
  logCommandList(
    'Commands',
    [
      { name: 'argus-one init', description: 'Clone the Argus repository into a new workspace on this machine' },
      { name: 'argus-one onboard', description: 'Prepare env files, dependencies, and local runtime defaults' },
      { name: 'argus-one doctor', description: 'Check readiness, service status, and live endpoints' },
      { name: 'argus-one start', description: 'Launch backend and frontend together from the current Argus workspace' },
      { name: 'argus-one --help', description: 'Show the CLI overview and common command flow' },
    ],
    { tone: 'cyan', continueRail: false },
  );
  logCliFlowEnd();
}

module.exports = {
  runHelp,
};
