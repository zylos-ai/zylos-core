import fs from 'node:fs/promises';
import path from 'node:path';
import { parseSessionGroup } from '../../../../comm-bridge/scripts/c4-session-group.js';
import { listFailure, parseListQuery } from '../list-query.js';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const known = value => Number.isSafeInteger(value) && value >= 0;
const configurationModule = () => import('../../../../activity-monitor/scripts/supervisor-configuration.js');
const budgetModule = () => import('../../../../zylos-memory/scripts/memory-budget.js');

function timestampMillis(value) {
  if (typeof value !== 'string' || !value) return NaN;
  // C4 timestamps are UTC even when their SQLite text omits the offset.
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value);
}

/** Reads `read(key)` for every key, four at a time, in key order; a failed read is null. */
async function readEach(keys, read) {
  const values = new Array(keys.length);
  let cursor = 0;
  async function next() {
    while (cursor < keys.length) {
      const index = cursor++;
      try { values[index] = await read(keys[index]); } catch { values[index] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, keys.length) }, next));
  return values;
}

/**
 * The supplied group reader owns the only per-group backlog cache, shared with details. Every group row,
 * Origin's own included, compares its own unsummarized count with the group threshold. The cross-group
 * Origin Sync backlog is a separate field, read only in multi mode.
 */
export function createMemoryBacklog({ zylosDir, getSnapshot, groupBacklog, originBacklog = null,
  readConfig = async () => JSON.parse(await fs.readFile(path.join(zylosDir, '.zylos', 'config.json'), 'utf8')),
  loadConfiguration = configurationModule, loadBudgets = budgetModule,
  env = process.env, now = Date.now } = {}) {
  async function thresholds() {
    try {
      const { parseSupervisorConfiguration } = await loadConfiguration();
      let config;
      try { config = await readConfig(); } catch { config = {}; }
      return parseSupervisorConfiguration(config, env);
    } catch { return null; }
  }
  async function budgets() {
    try {
      const { BUDGETS, WARN_THRESHOLDS, measureMemoryText } = await loadBudgets();
      const checks = {};
      for (const file of ['identity.md', 'references.md']) {
        try {
          checks[file] = measureMemoryText(file, await fs.readFile(path.join(zylosDir, 'memory', file), 'utf8'));
        } catch { checks[file] = null; }
      }
      return { limits: { ...BUDGETS }, warnings: { ...WARN_THRESHOLDS }, checks };
    } catch { return null; }
  }
  return async function getMemoryBacklog(at = now()) {
    const [snapshot, config, limits] = await Promise.all([getSnapshot(at), thresholds(), budgets()]);
    const rows = new Map(snapshot.rows.filter(row => row.sessionGroup !== null).map(row => [row.sessionGroup, row]));
    const keys = [...rows.keys()];
    const threshold = positive(config?.syncThreshold);
    const backlogs = readEach(keys, groupBacklog);
    async function readGroups() {
      return (await backlogs).map((read, index) => {
        const sessionGroup = keys[index], row = rows.get(sessionGroup);
        const backlog = read ?? { count: null, firstAt: null, syncing: null, reason: 'backlog_failed' };
        const firstAt = backlog.firstAt ?? null, firstMillis = timestampMillis(firstAt);
        return {
          sessionGroup, displayName: row.name?.displayName ?? null,
          c4: { componentName: row.c4?.componentName ?? null },
          count: backlog.count ?? null, firstAt,
          aged: parseSessionGroup(sessionGroup) !== null && Number.isFinite(firstMillis) && at - firstMillis > SIX_HOURS_MS,
          syncing: backlog.syncing ?? null,
          threshold,
          ...(backlog.reason ? { reason: backlog.reason } : {}),
        };
      });
    }
    async function readOrigin() {
      if (snapshot.view !== 'multi' || !originBacklog) return undefined;
      let backlog;
      try { backlog = await originBacklog(); }
      catch { backlog = { count: null, pendingSummaries: null, firstAt: null, syncing: null, reason: 'origin_backlog_failed' }; }
      const firstAt = backlog.firstAt ?? null, firstMillis = timestampMillis(firstAt);
      return {
        count: backlog.count ?? null, pendingSummaries: backlog.pendingSummaries ?? null, firstAt,
        aged: Number.isFinite(firstMillis) && at - firstMillis > SIX_HOURS_MS,
        syncing: backlog.syncing ?? null, threshold: positive(config?.originSyncThreshold),
        ...(backlog.reason ? { reason: backlog.reason } : {}),
      };
    }
    const [originSync, groups] = await Promise.all([readOrigin(), readGroups()]);
    return { groups, ...(originSync ? { originSync } : {}), hasOlder: snapshot.hasOlder, budgets: limits };
  };
}

/** A group with nothing pending and nothing to report: the page folds these. */
export const quietBacklog = row => row.count === 0 && !row.aged && row.syncing === false && !row.reason;

// The one backlog order: long-waiting groups first, then groups that need a look before quiet ones, then the
// pending count (unknown after known), the oldest pending message (unknown last) and the session-group ID.
function orderKey(row) {
  const first = timestampMillis(row.firstAt);
  return [row.aged ? 0 : 1, quietBacklog(row) ? 1 : 0, known(row.count) ? -row.count : 1, Number.isFinite(first) ? first : null, row.sessionGroup];
}
function compareKeys(a, b) {
  for (let index = 0; index < a.length; index++) {
    const x = a[index], y = b[index];
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    return x < y ? -1 : 1;
  }
  return 0;
}
const orderPosition = position => Array.isArray(position) && position.length === 5
  && [0, 1].includes(position[0]) && [0, 1].includes(position[1]) && Number.isSafeInteger(position[2])
  && (position[3] === null || Number.isFinite(position[3])) && typeof position[4] === 'string';

/** What the page says about all groups, whatever is loaded or searched. `threshold` is the one most groups share. */
function backlogSummary(groups) {
  const tally = new Map();
  for (const row of groups) if (positive(row.threshold)) tally.set(row.threshold, (tally.get(row.threshold) ?? 0) + 1);
  return {
    groups: groups.length,
    waiting: groups.filter(row => known(row.count) && row.count > 0).length,
    aged: groups.filter(row => row.aged).length,
    syncing: groups.filter(row => row.syncing === true).length,
    unknown: groups.filter(row => row.count == null || row.syncing === null).length,
    quiet: groups.filter(quietBacklog).length,
    threshold: [...tally].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null,
  };
}

/** The backlog list's query (`q`, `limit`, `cursor`, `include=total`), checked before any group is read. */
export function parseBacklogQuery(searchParams) {
  const query = parseListQuery('memory-backlog', searchParams, { q: true, include: ['total'] });
  if (query.after !== null && !orderPosition(query.after)) throw listFailure(400, 'invalid_cursor', 'The cursor is no longer valid; reload the first page');
  return query;
}

/**
 * One page of the backlog under the list API standard. Every group is read and ordered in memory (the group
 * reader's 30-second cache is shared with group details and the memory tree), then `q` (session-group ID or
 * display name) selects and the cursor pages. Origin Sync, budgets, `hasOlder` and the summary are page fields.
 */
export function memoryBacklogPage(value, query) {
  const needle = query.q?.toLowerCase() ?? null;
  const ordered = value.groups.map(row => ({ row, key: orderKey(row) })).sort((a, b) => compareKeys(a.key, b.key));
  const matched = needle ? ordered.filter(({ row }) => row.sessionGroup.toLowerCase().includes(needle)
    || (row.displayName ?? '').toLowerCase().includes(needle)) : ordered;
  const start = query.after === null ? 0 : matched.findIndex(({ key }) => compareKeys(key, query.after) > 0);
  const rest = start < 0 ? [] : matched.slice(start);
  const page = rest.slice(0, query.limit);
  return {
    items: page.map(({ row }) => row),
    nextCursor: rest.length > query.limit ? query.nextCursor(page.at(-1).key) : null,
    ...(query.include.has('total') ? { total: matched.length } : {}),
    summary: backlogSummary(value.groups),
    ...(value.originSync ? { originSync: value.originSync } : {}),
    hasOlder: value.hasOlder, budgets: value.budgets,
  };
}

/**
 * GET /api/memory/backlog: the query is checked before any group is read, and a backlog that cannot be read is
 * the standard 503 `unavailable`.
 */
export async function readBacklogPage(read, searchParams) {
  const query = parseBacklogQuery(searchParams);
  let value;
  try { value = await read(); } catch { throw listFailure(503, 'unavailable', 'The memory backlog cannot be read'); }
  return memoryBacklogPage(value, query);
}

/** Pending count and syncing state for each session group of the memory tree, from the same group reader. */
export async function treeBacklog(keys, groupBacklog) {
  return (await readEach(keys, groupBacklog)).map(read => read ? { count: known(read.count) ? read.count : null, syncing: read.syncing ?? null } : null);
}
