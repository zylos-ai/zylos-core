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
  const runC4Db = (args, reason = args[0] === 'group-queues' ? 'queue_summary_failed' : 'c4_groups_failed') =>
    run(process.execPath, [path.join(zylosDir, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-db.js'), ...args], reason);
  async function readOverrides(groups) {
    const keys = [...new Set([...groups.filter(group => group !== null), 'origin'])];
    const data = { baseline: null, runtime: [], model: [] };
    for (let i = 0; i < keys.length; i += 500) {
      const result = await run('zylos', ['group', 'overrides', ...keys.slice(i, i + 500).flatMap(group => ['--group', group]), '--json'], 'override_list_failed');
      if (!result.ok) return result;
      data.baseline ??= result.data.baseline;
      data.runtime.push(...result.data.runtime); data.model.push(...result.data.model);
    }
    return { ok: true, data, readAt: now() };
  }
  return { runC4Db, readOverrides };
}
