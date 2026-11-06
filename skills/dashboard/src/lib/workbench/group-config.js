import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const unknown = message => ({ ok: false, unknown: true, error: { code: 'RESULT_UNKNOWN', message } });
function parse(stdout) {
  try {
    const value = JSON.parse(stdout);
    return typeof value?.ok === 'boolean' ? value : null;
  } catch { return null; }
}

/** Configuration writes are submitted once; the caller owns the one readback. */
export function createGroupConfig({ zylosDir, execute = promisify(execFile), env = process.env } = {}) {
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  async function command(args) {
    try {
      const { stdout } = await execute('zylos', args, { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
      return parse(stdout) ?? unknown('Core returned no result envelope');
    } catch (error) {
      return parse(error.stdout) ?? unknown(error.message ?? 'Core command failed');
    }
  }
  async function get(key) {
    const runtime = await command(['group', 'runtime', 'get', '--group', key, '--json']);
    if (!runtime.ok) return { runtime, model: null };
    if (typeof runtime.data?.resolved?.runtime !== 'string') {
      return { runtime: unknown('Core returned no resolved runtime'), model: null };
    }
    const model = await command(['group', 'model', 'get', '--group', key,
      '--runtime', runtime.data.resolved.runtime, '--json']);
    return { runtime, model };
  }
  async function submit(key, change) {
    if (change?.kind === 'runtime') {
      const args = change.value === 'inherit'
        ? ['group', 'runtime', 'reset', '--group', key, '--json']
        : ['group', 'runtime', 'set', '--group', key, '--runtime', change.value, '--json'];
      if (typeof change.value !== 'string' || !change.value) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'A runtime is required' } };
      }
      return command(args);
    }
    if (change?.kind === 'model') {
      if (typeof change.runtime !== 'string' || !change.runtime || (!change.reset &&
          (typeof change.model !== 'string' || !change.model.trim() || typeof change.effort !== 'string' || !change.effort.trim()))) {
        return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'A runtime and a complete model/effort pair are required' } };
      }
      const args = change.reset
        ? ['group', 'model', 'reset', '--group', key, '--runtime', change.runtime, '--json']
        : ['group', 'model', 'set', '--group', key, '--runtime', change.runtime,
          '--model', change.model, '--effort', change.effort, '--json'];
      return command(args);
    }
    return { ok: false, error: { code: 'INVALID_ARGUMENT', message: 'Submit one runtime or model change' } };
  }
  return { get, submit };
}
