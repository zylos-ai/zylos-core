import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

/** Read-only Core commands. Each invocation owns a bounded child process. */
export function createCoreCli({ zylosDir, execute = promisify(execFile), env = process.env, now = Date.now } = {}) {
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  async function run(file, argv, reason) {
    try {
      const { stdout } = await execute(file, argv, { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
      let envelope;
      try { envelope = JSON.parse(stdout); }
      catch { return { ok: false, reason, detail: 'non_json', readAt: now() }; }
      if (envelope?.ok !== true) return { ok: false, reason, detail: envelope?.error?.code ?? 'invalid_envelope', readAt: now() };
      return { ok: true, data: envelope.data, readAt: now() };
    } catch (error) {
      return { ok: false, reason, detail: error.code ?? (error.killed ? 'timeout' : 'command_failed'), readAt: now() };
    }
  }
  const runC4Db = (args, reason = 'c4_groups_failed') =>
    run(process.execPath, [path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-db.js'), ...args], reason);
  return { runC4Db };
}
