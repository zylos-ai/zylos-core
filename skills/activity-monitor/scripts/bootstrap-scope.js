import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';

export function loadCoreModule(relative) {
  return import(pathToFileURL(path.resolve(path.dirname(resolveCoreConfigModule()), relative)).href);
}

export async function bootstrapScope(env = process.env) {
  const paths = await loadCoreModule('session-group-paths.js');
  const run = paths.runDirFromEnv(env);
  return { ...run, scope: run.sessionGroup ?? '*', root: paths.zylosRoot(env),
    memoryDir: run.sessionGroup ? paths.groupMemoryDir(run.sessionGroup, env) : path.join(paths.zylosRoot(env), 'memory') };
}
