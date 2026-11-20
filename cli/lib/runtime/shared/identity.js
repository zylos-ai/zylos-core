import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimeExecutable } from '../session-command.js';

const execute = promisify(execFile);

export function createIdentity(id) {
  return Object.freeze({
    findExecutable(env = process.env) {
      try {
        return runtimeExecutable(id, env);
      } catch (error) {
        if (error.code === 'RUNTIME_NOT_INSTALLED') return null;
        throw error;
      }
    },
  });
}

export async function probeVersion(identity, profiles, { profile, env = process.env, execFile = execute } = {}) {
  if (!Object.hasOwn(profiles, profile)) throw new TypeError('Unknown version probe profile');
  const executable = identity.findExecutable(env);
  if (executable === null) return { installed: false, version: null, probeFailed: false };

  const { timeout, parse, prepareEnv } = profiles[profile];
  try {
    const { stdout } = await execFile(executable, ['--version'], {
      encoding: 'utf8', timeout, env: prepareEnv ? prepareEnv(env) : env, stdio: 'pipe',
    });
    return { installed: true, version: parse(stdout), probeFailed: false };
  } catch {
    return { installed: true, version: null, probeFailed: true };
  }
}
