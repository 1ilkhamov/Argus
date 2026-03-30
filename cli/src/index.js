const { fail } = require('./ui/render');
const { runHelp } = require('./commands/help');
const { runDoctor } = require('./commands/doctor');
const { runStart } = require('./commands/start');
const { runOnboard } = require('./commands/onboard');
const { runInit } = require('./commands/init');
const { runUpdate } = require('./commands/update');

async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0];
  const flags = new Set(argv.slice(1));

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    runHelp();
    return 0;
  }

  if (command === 'init') {
    const dirFlag = argv.find((a) => a.startsWith('--dir='));
    const dir = dirFlag ? dirFlag.slice('--dir='.length) : undefined;
    await runInit({ dir });
    return 0;
  }

  if (command === 'onboard') {
    await runOnboard({ flags });
    return 0;
  }

  if (command === 'doctor') {
    await runDoctor();
    return 0;
  }

  if (command === 'start') {
    await runStart();
    return 0;
  }

  if (command === 'update') {
    runUpdate();
    return 0;
  }

  fail(`Unknown command: ${command}\nRun argus-one --help to see available commands.`);
  return 1;
}

module.exports = {
  runCli,
};
