#!/usr/bin/env node
import { main } from '../src/cli.js';
import { fail } from '../src/ui.js';

main()
  .then((code) => {
    process.exitCode = code ?? 0;
  })
  .catch((error) => {
    fail(error?.message || String(error));
    if (process.env.SESSIONVAULT_DEBUG) console.error(error);
    process.exitCode = 1;
  });
