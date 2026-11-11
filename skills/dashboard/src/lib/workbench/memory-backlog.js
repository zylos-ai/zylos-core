import fs from 'node:fs/promises';
import path from 'node:path';

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const configurationModule = () => import('../../../../activity-monitor/scripts/supervisor-configuration.js');
const budgetModule = () => import('../../../../zylos-memory/scripts/shared.js');

function timestampMillis(value) {
  if (typeof value !== 'string' || !value) return NaN;
  // C4 timestamps are UTC even when their SQLite text omits the offset.
  return Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?$/.test(value)
    ? `${value.replace(' ', 'T')}Z` : value);
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
      const { BUDGETS, WARN_THRESHOLDS } = await loadBudgets();
      return { limits: { ...BUDGETS }, warnings: { ...WARN_THRESHOLDS } };
    } catch { return null; }
  }
  return async function getMemoryBacklog(at = now()) {
    const [snapshot, config, limits] = await Promise.all([getSnapshot(at), thresholds(), budgets()]);
    const rows = new Map(snapshot.rows.filter(row => row.sessionGroup !== null).map(row => [row.sessionGroup, row]));
    const keys = [...rows.keys()];
    const groups = new Array(keys.length);
    let cursor = 0;
    async function readNext() {
      while (cursor < keys.length) {
        const index = cursor++, sessionGroup = keys[index], row = rows.get(sessionGroup);
        let backlog;
        try { backlog = await groupBacklog(sessionGroup); }
        catch { backlog = { count: null, firstAt: null, syncing: null, reason: 'backlog_failed' }; }
        const firstAt = backlog.firstAt ?? null, firstMillis = timestampMillis(firstAt);
        const threshold = config?.syncThreshold;
        groups[index] = {
          sessionGroup, displayName: row.name?.displayName ?? null,
          c4: { componentName: row.c4?.componentName ?? null },
          count: backlog.count ?? null, firstAt,
          aged: Number.isFinite(firstMillis) && at - firstMillis > SIX_HOURS_MS,
          syncing: backlog.syncing ?? null,
          threshold: positive(threshold),
          ...(backlog.reason ? { reason: backlog.reason } : {}),
        };
      }
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
    const [originSync] = await Promise.all([readOrigin(), ...Array.from({ length: Math.min(4, keys.length) }, readNext)]);
    return { groups, ...(originSync ? { originSync } : {}), hasOlder: snapshot.hasOlder, budgets: limits };
  };
}
