import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../../comm-bridge/scripts/core-config-loader.js';

let coreDirectory;

/** Resolve modules from the same Core package as the configuration loader. */
export function loadCoreModule(relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
    throw new TypeError('Invalid core module path');
  }
  return import(pathToFileURL(path.join((coreDirectory ??= path.dirname(resolveCoreConfigModule())), relative)).href);
}
