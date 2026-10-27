#!/usr/bin/env node
import { isMainModule } from './is-main-module.js';
import { createConfigHandler, parseConfigArgs, runConfigCli } from './c4-config-handler.js';
export const createRuntimeConfigHandler = dependencies => {
  const handle = createConfigHandler(dependencies);
  return async request => await handle('runtime', request);
};
export const parseRuntimeConfigArgs = argv => parseConfigArgs('runtime', argv);
if (isMainModule(import.meta.url)) process.exitCode = await runConfigCli('runtime', process.argv.slice(2));
