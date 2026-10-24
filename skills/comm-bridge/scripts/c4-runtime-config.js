#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createConfigHandler, parseConfigArgs, runConfigCli } from './c4-config-handler.js';
export const createRuntimeConfigHandler = dependencies => {
  const handle = createConfigHandler(dependencies);
  return async request => await handle('runtime', request);
};
export const parseRuntimeConfigArgs = argv => parseConfigArgs('runtime', argv);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runConfigCli('runtime', process.argv.slice(2));
