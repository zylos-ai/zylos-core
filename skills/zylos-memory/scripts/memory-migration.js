#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMainModule } from './is-main-module.js';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

const core = await import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'memory-migration.js')).href);
export const { backupState, createMigration, runCli } = core;

if (isMainModule(import.meta.url)) await runCli();
