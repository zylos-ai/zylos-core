#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
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

function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) process.exitCode = await runCli();
