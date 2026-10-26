#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

const core = await import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'memory-migration.js')).href);
export const { backupState, createMigration, runCli } = core;

if (process.argv[1] === fileURLToPath(import.meta.url)) await runCli();
