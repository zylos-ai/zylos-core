import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

function candidatePaths() {
  if (process.env.ZYLOS_PACKAGE_ROOT) {
    return [path.join(process.env.ZYLOS_PACKAGE_ROOT, 'cli', 'lib', 'config.js')];
  }
  const candidates = [];
  const here = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(path.resolve(here, '../../../cli/lib/config.js'));
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    if (npmRoot) candidates.push(path.join(npmRoot, 'zylos', 'cli', 'lib', 'config.js'));
  } catch {}
  return candidates;
}
export function resolveCoreConfigModule() {
  const configPath = candidatePaths().find(candidate => fs.existsSync(candidate));
  if (!configPath) {
    throw new Error('Cannot locate the installed zylos-core cli/lib/config.js');
  }
  return configPath;
}
export async function loadCoreConfig() {
  const module = await import(pathToFileURL(resolveCoreConfigModule()).href);
  for (const name of ['readZylosConfigStrict', 'readSessionMode', 'updateZylosConfigLocked', 'writeSessionModeAtCutover']) {
    if (typeof module[name] !== 'function') {
      throw new Error(`Installed zylos-core config module is missing ${name}`);
    }
  }
  return module;
}
