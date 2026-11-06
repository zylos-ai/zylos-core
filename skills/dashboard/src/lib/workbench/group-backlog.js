import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createCoreCli } from './core-cli.js';

/** The shared per-group backlog cache; memory pages use this same reader. */
export function createGroupBacklog({ zylosDir, runC4Db,
  getSnapshot = async () => ({}), execute = promisify(execFile), env = process.env, now = Date.now } = {}) {
  const cache = new Map();
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  delete childEnv.ZYLOS_RUN_ID;
  const readBacklog = runC4Db ?? createCoreCli({ zylosDir, execute, env: childEnv, now }).runC4Db;
  return async function groupBacklog(key) {
    let scope = key;
    if (key === 'origin') {
      try { if ((await getSnapshot())?.view === 'single') scope = null; }
      catch { /* An unreadable view retains the explicitly requested group. */ }
    }
    for (const [cachedScope, entry] of cache) {
      if (now() - entry.at >= 30000) cache.delete(cachedScope);
    }
    const groupArgs = scope === null ? [] : ['--group', scope];
    const saved = cache.get(scope);
    if (saved && now() - saved.at < 30000) return saved.value;
    let result;
    try { result = await readBacklog(['unsummarized', ...groupArgs, '--json'], 'backlog_failed'); }
    catch { result = { ok: false }; }
    const value = result.ok && Number.isSafeInteger(result.data?.count) && result.data.count >= 0
      ? { count: result.data.count, firstAt: result.data.firstAt ?? null }
      : { count: null, firstAt: null, reason: 'backlog_failed' };
    value.syncing = null;
    try {
      const script = path.join(zylosDir, '.claude', 'skills', 'zylos-memory', 'scripts', 'sync-lock.js');
      const { stdout } = await execute(process.execPath, [script, 'status', ...groupArgs, '--json'],
        { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
      const state = JSON.parse(stdout), held = scope === 'origin' ? state.origin?.held : state.sync?.held;
      if (typeof held === 'boolean') value.syncing = held;
      else value.reason ??= 'backlog_failed';
    } catch { value.reason ??= 'backlog_failed'; }
    cache.set(scope, { at: now(), value });
    return value;
  };
}
