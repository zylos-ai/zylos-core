#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createConfigHandler, parseConfigArgs, runConfigCli } from './c4-config-handler.js';
export const createModelConfigHandler = dependencies => {
  const handle = createConfigHandler(dependencies);
  return async request => await handle('model', request);
};
export const parseModelConfigArgs = argv => parseConfigArgs('model', argv);
function isMainModule() {
  try { return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
}
if (isMainModule()) process.exitCode = await runConfigCli('model', process.argv.slice(2));
