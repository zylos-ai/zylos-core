#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { createConfigHandler, parseConfigArgs, runConfigCli } from './c4-config-handler.js';
export const createModelConfigHandler = dependencies => {
  const handle = createConfigHandler(dependencies);
  return request => handle('model', request);
};
export const parseModelConfigArgs = argv => parseConfigArgs('model', argv);
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await runConfigCli('model', process.argv.slice(2));
