#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './is-main-module.js';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

export async function runCli(argv = process.argv.slice(2)) {
  try {
    const core = await import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'read-work-memory.js')).href);
    return await core.runReadWorkMemoryCli(argv);
  } catch (cause) {
    const error = { code: 'READ_FAILED', message: `Memory reader unavailable: ${cause.message}`, persisted: [], parts: ['dependencies'] };
    if (argv.includes('--json')) process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
    else process.stderr.write(`Error [READ_FAILED]: ${error.message}\n`);
    return 1;
  }
}

if (isMainModule(import.meta.url)) process.exitCode = await runCli();
