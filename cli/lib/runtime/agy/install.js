import path from 'node:path';
import { execSync, execFileSync } from 'node:child_process';
import { ZYLOS_DIR } from '../../config.js';
import { readLaunchDotenv } from '../session-command.js';
import { probeVersion as probe } from '../shared/identity.js';

const disableAutoUpdate = env => ({ ...env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' });
const profiles = {
  doctor: { timeout: 10000, parse: stdout => stdout.trim().split('\n')[0], prepareEnv: disableAutoUpdate },
  dashboard: { timeout: 5000, parse: stdout => stdout.trim().match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\b/)?.[0] ?? null },
};

export const installNotice = 'The Antigravity installer added ~/.local/bin to PATH in your existing shell startup files (such as ~/.bashrc and ~/.profile) and removed any "alias agy=" or "alias antigravity=" lines from them.';

export function agyCliEnv(root, env) {
  const dotenv = readLaunchDotenv(root);
  const result = disableAutoUpdate(env);
  const proxy = Object.hasOwn(dotenv, 'HTTPS_PROXY') ? dotenv.HTTPS_PROXY : env.HTTPS_PROXY;
  if (proxy) result.HTTPS_PROXY = proxy;
  else delete result.HTTPS_PROXY;
  return result;
}

export function probeVersion(identity, options) {
  return probe(identity, profiles, options);
}

export async function install(identity, { root = ZYLOS_DIR, exec = { execSync, execFileSync } } = {}) {
  const env = agyCliEnv(root, process.env);
  try {
    exec.execSync('curl -fsSL https://antigravity.google/cli/install.sh | bash', {
      stdio: 'pipe', timeout: 600000, env,
    });
  } catch (error) {
    if (error.code === 'ETIMEDOUT' || error.signal) {
      throw new Error(`Antigravity installation did not finish within 10 minutes. If this machine needs a proxy, set HTTPS_PROXY in ${path.join(root, '.env')} and retry.`);
    }
    return false;
  }
  const executable = identity.findExecutable();
  if (executable === null) return false;
  try {
    exec.execFileSync(executable, ['--version'], { stdio: 'pipe', timeout: 10000, env });
    return true;
  } catch {
    return false;
  }
}
