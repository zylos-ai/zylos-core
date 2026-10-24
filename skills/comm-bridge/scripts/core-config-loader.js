import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function configInRoot(root, validatePackage = true) {
  try {
    if (validatePackage && JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).name !== 'zylos') {
      return undefined;
    }
    const configPath = path.join(root, 'cli', 'lib', 'config.js');
    return fs.statSync(configPath).isFile() ? configPath : undefined;
  } catch {
    return undefined;
  }
}

function configOnPath() {
  for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    const executable = path.resolve(directory || '.', 'zylos');
    try {
      if (!fs.statSync(executable).isFile()) continue;
      fs.accessSync(executable, fs.constants.X_OK);
    } catch {
      continue;
    }
    try {
      const realExecutable = fs.realpathSync(executable);
      return configInRoot(path.resolve(path.dirname(realExecutable), '..'));
    } catch {
      return undefined;
    }
  }
}

export function resolveCoreConfigModule() {
  if (process.env.ZYLOS_PACKAGE_ROOT) {
    const explicit = configInRoot(process.env.ZYLOS_PACKAGE_ROOT, false);
    if (explicit) return explicit;
    throw new Error('Cannot locate the installed zylos-core cli/lib/config.js at ZYLOS_PACKAGE_ROOT');
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const development = configInRoot(path.resolve(here, '../../..'));
  if (development) return development;
  const installed = configOnPath();
  if (installed) return installed;
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    const fallback = npmRoot && configInRoot(path.join(npmRoot, 'zylos'));
    if (fallback) return fallback;
  } catch {}
  throw new Error('Cannot locate the installed zylos-core cli/lib/config.js');
}
let coreConfigPromise;

export async function loadCoreConfig() {
  if (!coreConfigPromise) {
    coreConfigPromise = (async () => {
      const module = await import(pathToFileURL(resolveCoreConfigModule()).href);
      for (const name of ['readZylosConfigStrict', 'readZylosConfigOrThrow', 'readSessionMode', 'updateZylosConfigLocked', 'writeSessionModeAtCutover']) {
        if (typeof module[name] !== 'function') {
          throw new Error(`Installed zylos-core config module is missing ${name}`);
        }
      }
      return module;
    })().catch(error => {
      coreConfigPromise = undefined;
      throw error;
    });
  }
  return coreConfigPromise;
}
