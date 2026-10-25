import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

/** Resolve the installed Core package using the existing configuration loader. */
export function loadCoreModule(relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new TypeError('Invalid core module path');
  return import(pathToFileURL(path.join(path.dirname(resolveCoreConfigModule()), relative)).href);
}
