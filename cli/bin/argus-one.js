#!/usr/bin/env node

const { runCli } = require('../src');

runCli().then(
  (exitCode) => {
    process.exit(exitCode ?? 0);
  },
  (error) => {
    const message = error instanceof Error ? error.message : 'Argus CLI failed';
    process.stderr.write(`${message}\n`);
    process.exit(1);
  },
);
