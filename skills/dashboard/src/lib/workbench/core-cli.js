import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { validKey } from './display-names.js';

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
    const data = { baseline: null, runtime: [], model: [] };
    let after = null;
    do {
      const result = await run('zylos', ['group', 'overrides', ...(after === null ? [] : ['--after', after]), '--json'], 'override_list_failed');
      if (!result.ok) return result;
      if (!Array.isArray(result.data?.runtime)
          || result.data.runtime.some(row => !row || typeof row.sessionGroup !== 'string' || typeof row.runtime !== 'string')
          || (result.data.nextAfter != null &&
          (typeof result.data.nextAfter !== 'string' || (after !== null && result.data.nextAfter <= after)))) {
        return { ok: false, reason: 'override_list_failed', detail: 'invalid_envelope', readAt: now() };
      }
      data.runtime.push(...result.data.runtime);
      after = result.data.nextAfter ?? null;
    } while (after !== null);
    const keys = [...new Set([...groups.filter(validKey), ...data.runtime.map(row => row.sessionGroup), 'origin'])];
    for (let i = 0; i < keys.length; i += 500) {
      const result = await run('zylos', ['group', 'overrides', ...keys.slice(i, i + 500).flatMap(group => ['--group', group]), '--json'], 'override_list_failed');
      if (!result.ok) return result;
      if (!result.data?.baseline || !Array.isArray(result.data.model)) {
        return { ok: false, reason: 'override_list_failed', detail: 'invalid_envelope', readAt: now() };
      }
      data.baseline ??= result.data.baseline;
      data.model.push(...result.data.model);
    }
    return { ok: true, data, readAt: now() };
  }
  return { runC4Db, readOverrides };
}
