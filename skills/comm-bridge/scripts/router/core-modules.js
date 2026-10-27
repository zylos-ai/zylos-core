import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../core-config-loader.js';

let coreDirectory;

/** Use the same installed Core package as the C4 database. */
export function loadCoreModule(relative) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw new TypeError('Invalid core module path');
  return import(pathToFileURL(path.join((coreDirectory ??= path.dirname(resolveCoreConfigModule())), relative)).href);
}
