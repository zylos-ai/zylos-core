import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

const core = await import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), 'memory-lock.js')).href);
export const { withMemoryLock } = core;
