import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { loadCoreModule } from '../core-modules.js';
import { requireGroupReadShape } from './groups-api.js';
import { parseSessionGroup } from '../../../../comm-bridge/scripts/c4-session-group.js';

// Loaded when a status is read, so the Dashboard starts in a package without zylos-memory.
const syncLockModule = () => import('../../../../zylos-memory/scripts/sync-lock.js');
const unreadable = () => ({ count: null, firstAt: null, syncing: null, reason: 'backlog_failed' });

/**
 * The shared per-group backlog reader with its 30-second cache; the memory backlog, group details and the memory
 * tree use it. `groupBacklog(key)` reads one group, `groupBacklog.many(keys)` reads several at once: every count
 * comes from Core's own calculation in one read-only database snapshot, and only a group whose Sync marker file
 * exists asks `sync-lock.js status` whether its Sync is still held.
 */
export function createGroupBacklog({ zylosDir, c4Reader, readConfig, getSnapshot = async () => ({}),
  execute = promisify(execFile), loadPaths = () => loadCoreModule('session-group-paths.js'), loadSyncLock = syncLockModule,
  env = process.env, now = Date.now } = {}) {
  const cache = new Map();
  const childEnv = { ...env, ZYLOS_DIR: zylosDir };
  delete childEnv.ZYLOS_SESSION_GROUP;
  delete childEnv.ZYLOS_RUN_ID;
  const script = path.join(zylosDir, '.claude', 'skills', 'zylos-memory', 'scripts', 'sync-lock.js');
  // Origin in the single view is the whole machine: Core's global range and the global Sync marker.
  async function originScope() {
    try { return (await getSnapshot())?.view === 'single' ? null : 'origin'; }
    catch { return 'origin'; /* An unreadable view retains the explicitly requested group. */ }
  }
  // Without a marker file no Sync can be held; with one, the existing status check decides (stale or old-run markers).
  // A sync-lock module that cannot be loaded leaves the status unknown (the caller marks the group failed).
  async function syncing(scope, runDir) {
    const { markerPath } = await loadSyncLock();
    try {
      fs.accessSync(markerPath(runDir, scope === null ? 'global' : 'group'));
    } catch (error) {
      if (error.code === 'ENOENT') return false;
    }
    const { stdout } = await execute(process.execPath, [script, 'status', ...(scope === null ? [] : ['--group', scope]), '--json'],
      { env: childEnv, timeout: 15000, maxBuffer: 1024 * 1024 });
    // Each group, Origin included, reports its own sync lock; the Origin Sync lock belongs to the cross-group row.
    const held = JSON.parse(stdout).sync?.held;
    if (typeof held !== 'boolean') throw new Error('Unreadable Sync status');
    return held;
  }
  async function many(keys) {
    for (const [scope, entry] of cache) {
      if (now() - entry.at >= 30000) cache.delete(scope);
    }
    const origin = keys.includes('origin') ? await originScope() : 'origin';
    const scopes = keys.map(key => key === 'origin' ? origin : key);
    // Values are kept here as they are found or read, so another call's expiry sweep cannot remove one mid-read.
    const found = new Map([...new Set(scopes)].filter(scope => cache.has(scope)).map(scope => [scope, cache.get(scope).value]));
    const unread = [...new Set(scopes)].filter(scope => !found.has(scope));
    // Historical names cannot enter Core's strict scope/path functions. Their counts use the read-only database;
    // sync markers remain unobservable.
    for (const scope of unread.filter(scope => scope !== null && !parseSessionGroup(scope))) {
      let value;
      try {
        requireGroupReadShape(scope);
        value = { ...c4Reader.getGroupBacklog(scope), syncing: null, reason: 'backlog_failed' };
      } catch { value = unreadable(); }
      cache.set(scope, { at: now(), value }); found.set(scope, value);
    }
    const strict = unread.filter(scope => scope === null || parseSessionGroup(scope));
    if (strict.length) {
      let ranges, paths;
      try { ranges = c4Reader.getUnsummarizedRanges(strict, { readConfig }); } catch { ranges = []; }
      try { paths = await loadPaths(); } catch { paths = null; }
      const values = await eachFour(strict, async (scope, index) => {
        const range = ranges[index];
        const value = range && Number.isSafeInteger(range.count) && range.count >= 0
          ? { count: range.count, firstAt: range.firstAt ?? null, syncing: null }
          : unreadable();
        try { value.syncing = await syncing(scope, paths.groupRunDir(scope ?? 'origin', childEnv)); }
        catch { value.reason ??= 'backlog_failed'; }
        return value;
      });
      strict.forEach((scope, index) => { cache.set(scope, { at: now(), value: values[index] }); found.set(scope, values[index]); });
    }
    return scopes.map(scope => found.get(scope));
  }
  const groupBacklog = async key => (await many([key]))[0];
  groupBacklog.many = many;
  return groupBacklog;
}

/** `read(item, index)` for every item, four at a time, in item order. */
async function eachFour(items, read) {
  const values = new Array(items.length);
  let cursor = 0;
  async function next() {
    while (cursor < items.length) {
      const index = cursor++;
      values[index] = await read(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, next));
  return values;
}
