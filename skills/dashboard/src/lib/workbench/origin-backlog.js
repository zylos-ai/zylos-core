import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createCoreCli } from './core-cli.js';

const CACHE_MS = 30000;
// C4 timestamps are UTC even when their SQLite text omits the offset.
const millis = value => typeof value !== 'string' || !value ? NaN
  : Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value);

/**
 * The machine-wide backlog waiting for Origin's cross-group sync: the same source the Supervisor reads
 * (`c4-db.js origin-sync backlog`), and the Origin Sync lock (`origin.held` of Origin's sync-lock status).
 * The oldest time is the earliest raw message or unread summary, as the Supervisor computes it.
 */
export function createOriginBacklog({ zylosDir, runC4Db, execute = promisify(execFile), env = process.env, now = Date.now } = {}) {
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  delete childEnv.ZYLOS_RUN_ID;
  const readBacklog = runC4Db ?? createCoreCli({ zylosDir, execute, env: childEnv, now }).runC4Db;
  let saved = null;
  return async function originBacklog() {
    if (saved && now() - saved.at < CACHE_MS) return saved.value;
    let result;
    try { result = await readBacklog(['origin-sync', 'backlog', '--json'], 'origin_backlog_failed'); }
    catch { result = { ok: false }; }
    const data = result.ok ? result.data : null;
    const groups = Array.isArray(data?.groups) ? data.groups : null;
    const counted = value => Number.isSafeInteger(value) && value >= 0;
    let value;
    if (groups && counted(data.total) && groups.every(group => counted(group?.pendingCheckpoints))) {
      let firstAt = null, first = Infinity;
      for (const group of groups) {
        for (const time of [group.firstAt, group.firstCheckpointAt]) {
          const at = millis(time);
          if (Number.isFinite(at) && at < first) { first = at; firstAt = time; }
        }
      }
      value = { count: data.total, pendingSummaries: groups.reduce((sum, group) => sum + group.pendingCheckpoints, 0), firstAt };
    } else value = { count: null, pendingSummaries: null, firstAt: null, reason: 'origin_backlog_failed' };
    value.syncing = null;
    try {
      const script = path.join(zylosDir, '.claude', 'skills', 'zylos-memory', 'scripts', 'sync-lock.js');
      const { stdout } = await execute(process.execPath, [script, 'status', '--group', 'origin', '--json'],
        { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
      const held = JSON.parse(stdout).origin?.held;
      if (typeof held === 'boolean') value.syncing = held;
      else value.reason ??= 'origin_backlog_failed';
    } catch { value.reason ??= 'origin_backlog_failed'; }
    saved = { at: now(), value };
    return value;
  };
}
