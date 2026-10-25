import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveCoreConfigModule } from '../../comm-bridge/scripts/core-config-loader.js';
import { readZylosConfigOrThrow } from '../../comm-bridge/scripts/local-config.js';

export function loadCoreModule(relative) {
  return import(pathToFileURL(path.resolve(path.dirname(resolveCoreConfigModule()), relative)).href);
}

export async function bootstrapScope(env = process.env) {
  const config = readZylosConfigOrThrow();
  const mode = config.session_mode ?? 'single';
  if (!['single', 'multi'].includes(mode)) throw Object.assign(new Error('Invalid session_mode'), { code: 'CONFIG_UNREADABLE' });
  const paths = await loadCoreModule('session-group-paths.js');
  const run = paths.runDirFromEnv(env);
  if ((mode === 'multi' && !run.sessionGroup) || (mode === 'single' && run.sessionGroup)) {
    throw Object.assign(new Error('Session environment does not match session_mode'), { code: 'SCOPE_INVALID' });
  }
  return { ...run, mode, scope: run.sessionGroup ?? '*', root: paths.zylosRoot(env),
    memoryDir: run.sessionGroup ? paths.groupMemoryDir(run.sessionGroup, env) : path.join(paths.zylosRoot(env), 'memory') };
}
