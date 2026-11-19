import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export function createUpgradeCli({ id, identity, timeoutMs, killSignal, prepareEnv, timeoutIsOutcome = false }) {
  return async function upgradeCli({ root, env = process.env, execFile = execute } = {}) {
    try {
      const executable = identity.findExecutable(env) ?? id;
      const options = { timeout: timeoutMs };
      if (killSignal) options.killSignal = killSignal;
      options.env = prepareEnv ? prepareEnv(root, env) : env;
      const { stdout, stderr } = await execFile(executable, ['update'], options);
      return { ok: true, outcome: 'updated', output: ((stdout || '') + (stderr || '')).trim() };
    } catch (error) {
      if (timeoutIsOutcome && (error.killed || error.code === 'ETIMEDOUT')) {
        return { ok: false, outcome: 'timeout', timeoutMs };
      }
      return { ok: false, outcome: 'failed', error: error.stderr || error.stdout || error.message };
    }
  };
}
