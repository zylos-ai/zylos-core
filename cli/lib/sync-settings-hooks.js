#!/usr/bin/env node
import { main } from './sync-runtime-hooks.js';

main().catch(error => {
  console.error(`Settings hooks: ${error.code || 'ERROR'}: ${error.message}`);
  process.exitCode = 1;
});
