#!/usr/bin/env node
import { isMainModule } from './is-main-module.js';
import { createConfigHandler, parseConfigArgs, runConfigCli } from './c4-config-handler.js';
export const createModelConfigHandler = dependencies => {
  const handle = createConfigHandler(dependencies);
  return async request => await handle('model', request);
};
export const parseModelConfigArgs = argv => parseConfigArgs('model', argv);
if (isMainModule(import.meta.url)) process.exitCode = await runConfigCli('model', process.argv.slice(2));
