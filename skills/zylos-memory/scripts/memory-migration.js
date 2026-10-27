#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

const core = await import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'memory-migration.js')).href);
export const { backupState, createMigration, runCli } = core;

function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) await runCli();
