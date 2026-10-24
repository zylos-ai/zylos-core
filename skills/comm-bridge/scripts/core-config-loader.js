import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function resolveCoreConfigModule({
  env = process.env,
  here = path.dirname(fileURLToPath(import.meta.url)),
  exists = fs.existsSync,
  realpath = fs.realpathSync,
  access = fs.accessSync,
  exec = execFileSync,
} = {}) {
  const configAt = root => path.join(root, 'cli', 'lib', 'config.js');
  const explicit = env.ZYLOS_PACKAGE_ROOT && configAt(env.ZYLOS_PACKAGE_ROOT);
  if (explicit && exists(explicit)) return explicit;
  const source = path.resolve(here, '../../../cli/lib/config.js');
  if (exists(source)) return source;
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    try {
      const executable = path.join(directory, 'zylos');
      access(executable, fs.constants.X_OK);
      const config = configAt(path.resolve(path.dirname(realpath(executable)), '..'));
      if (exists(config)) return config;
    } catch {}
  }
  try {
    const npmRoot = exec('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    const config = npmRoot && configAt(path.join(npmRoot, 'zylos'));
    if (config && exists(config)) return config;
  } catch {}
  throw new Error('Cannot locate the installed zylos-core cli/lib/config.js');
}
export async function loadCoreConfig() {
  const module = await import(pathToFileURL(resolveCoreConfigModule()).href);
  for (const name of ['readZylosConfigStrict', 'readZylosConfigOrThrow', 'readSessionMode', 'updateZylosConfigLocked', 'writeSessionModeAtCutover']) {
    if (typeof module[name] !== 'function') {
      throw new Error(`Installed zylos-core config module is missing ${name}`);
    }
  }
  return module;
}
