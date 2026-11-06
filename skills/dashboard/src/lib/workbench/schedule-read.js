import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { cronText } from '../../../public/js/wb/cron-text.js';
import { dateKey, localToOffsetIso } from './schedule-tz.js';

const CRON_MODULE = new URL('../../../../scheduler/scripts/cron-utils.js', import.meta.url).href;
const TIME_MODULE = new URL('../../../../scheduler/scripts/time-utils.js', import.meta.url).href;
const ENABLED = new Set(['pending', 'running']);
const BAD = new Set(['failed', 'timeout']);
const DAY = 86400;
const PREVIEW_RUNS = 3;
const MAX_RUNS = 200;

const httpError = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });

function duration(row) {
  if (row.duration_ms != null) return row.duration_ms;
  return row.completed_at != null ? (row.completed_at - row.executed_at) * 1000 : null;
}

function historyRow(row) {
  return {
    id: row.id,
    status: row.status,
    executedAt: row.executed_at,
    completedAt: row.completed_at,
    duration: duration(row),
    error: row.error ?? null,
  };
}

async function importOrNull(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

/**
 * Upcoming runs of one task. A task whose cron cannot be evaluated is marked
 * unavailable without affecting the others.
 */
export function nextRuns(task, n, from, tz, cronUtils) {
  if (!ENABLED.has(task.status)) return [];
  if (task.type === 'recurring') {
    if (!cronUtils) return { unavailable: true, reason: 'cron_preview_unavailable' };
    try {
      const runs = [];
      let at = from;
      for (let index = 0; index < n; index++) {
        at = cronUtils.getNextRun(task.cron_expression, tz, new Date(at * 1000));
        runs.push(at);
      }
      return runs;
    } catch {
      return { unavailable: true, reason: 'cron_preview_unavailable' };
    }
  }
  if (task.type === 'interval') {
    if (!(task.interval_seconds > 0) || task.next_run_at == null) return [];
    return Array.from({ length: n }, (_, k) => task.next_run_at + k * task.interval_seconds);
  }
  return task.next_run_at == null ? [] : [task.next_run_at];
}

function openDb(dbFile) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    db.pragma('busy_timeout = 3000');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Task delivery target, resolved with the same rule the scheduler uses to dispatch. */
export function deliveryTarget(task, snapshotRows, names = new Map()) {
  const component = task.session_component ?? task.reply_channel ?? null;
  const name = task.session_component != null ? task.session_group_name ?? null : null;
  const reply = task.reply_channel ? { channel: task.reply_channel, endpoint: task.reply_endpoint ?? null } : null;
  if (component === null) return { target: { kind: 'origin' }, reply };
  const row = snapshotRows?.find(item => item.c4?.componentName === component && item.sessionGroup);
  if (!row) return { target: { kind: 'raw', text: name === null ? component : `${component}:${name}` }, reply };
  const colon = row.sessionGroup.indexOf(':');
  const namespace = colon < 0 ? row.sessionGroup : row.sessionGroup.slice(0, colon);
  const sessionGroup = name === null ? namespace : `${namespace}:${name}`;
  return {
    target: { kind: 'group', sessionGroup, componentName: component,
      displayName: names.get(sessionGroup)?.displayName ?? null },
    reply,
  };
}

export function createScheduleRead({ zylosDir, scheduleTz, getSnapshot = async () => null,
  displayNames = { listAll: () => new Map() }, now = Date.now,
  cronModule = CRON_MODULE, timeModule = TIME_MODULE } = {}) {
  const dbFile = path.join(zylosDir, 'scheduler', 'scheduler.db');

  async function delivery(tasks) {
    if (!tasks.some(task => task.session_component != null || task.reply_channel)) {
      return task => deliveryTarget(task, []);
    }
    let rows = [];
    let names = new Map();
    try {
      rows = (await getSnapshot())?.rows ?? [];
    } catch {
      rows = [];
    }
    try {
      names = displayNames.listAll();
    } catch {
      names = new Map();
    }
    return task => deliveryTarget(task, rows, names);
  }

  async function read(at = now()) {
    if (!fs.existsSync(dbFile)) return { available: false, tasks: [] };
    const nowSec = Math.floor(at / 1000);
    let tasks, recent, week;
    let db;
    try {
      db = openDb(dbFile);
      tasks = db.prepare('SELECT * FROM tasks').all();
      recent = db.prepare(`SELECT * FROM (
          SELECT id, task_id, status, executed_at, completed_at, duration_ms, error,
            ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY executed_at DESC, id DESC) AS rn
          FROM task_history) WHERE rn <= 12`).all();
      week = db.prepare('SELECT status, executed_at FROM task_history WHERE executed_at >= ?').all(nowSec - 8 * DAY);
    } catch {
      throw httpError(503, 'scheduler_unreadable');
    } finally {
      db?.close();
    }
    const zone = await scheduleTz();
    const tz = zone.tz ?? 'UTC';
    const cronUtils = tasks.some(task => task.type === 'recurring') ? await importOrNull(cronModule) : null;
    const byTask = new Map();
    for (const row of recent) {
      const list = byTask.get(row.task_id) ?? [];
      list.push(historyRow(row));
      byTask.set(row.task_id, list);
    }
    const resolve = await delivery(tasks);
    const kpi = { enabled: 0, paused: 0, running: 0, next24h: 0, partialPreview: false, runs7d: 0, bad7d: 0, successRate7d: null };
    const out = [];
    for (const task of tasks) {
      const history = (byTask.get(task.id) ?? []).reverse();
      const latest = history.at(-1);
      const showLastError = Boolean(latest && BAD.has(latest.status));
      const upcoming = nextRuns(task, MAX_RUNS, nowSec, tz, cronUtils);
      const unavailable = !Array.isArray(upcoming);
      const runs = unavailable ? [] : upcoming.filter(time => time > nowSec);
      const in24h = runs.filter(time => time <= nowSec + DAY);
      if (ENABLED.has(task.status)) {
        kpi.enabled++;
        if (unavailable) kpi.partialPreview = true;
        else kpi.next24h += in24h.length;
      }
      if (task.status === 'paused') kpi.paused++;
      if (task.status === 'running') kpi.running++;
      const { target, reply } = resolve(task);
      out.push({
        id: task.id,
        name: task.name,
        prompt: task.prompt,
        type: task.type,
        status: task.status,
        cron: task.cron_expression ?? null,
        intervalSeconds: task.interval_seconds ?? null,
        nextRunAt: task.next_run_at ?? null,
        lastRunAt: task.last_run_at ?? null,
        updatedAt: task.updated_at ?? null,
        priority: task.priority,
        requireIdle: Boolean(task.require_idle),
        missThreshold: task.miss_threshold,
        showLastError,
        lastError: showLastError ? task.last_error ?? null : null,
        recent: history,
        nextRuns: unavailable ? upcoming : { runs: runs.slice(0, 5), in24h },
        target,
        reply,
        reenable: task.status === 'failed' && task.type === 'one-time',
      });
    }
    const days = [];
    for (let back = 6; back >= 0; back--) {
      const date = dateKey(nowSec - back * DAY, tz);
      if (!days.some(day => day.date === date)) days.push({ date, success: 0, timeout: 0, failed: 0 });
    }
    let success = 0;
    for (const row of week) {
      if (row.executed_at >= nowSec - 7 * DAY) {
        kpi.runs7d++;
        if (BAD.has(row.status)) kpi.bad7d++;
        if (row.status === 'success') success++;
      }
      const day = days.find(item => item.date === dateKey(row.executed_at, tz));
      if (day && ['success', 'timeout', 'failed'].includes(row.status)) day[row.status]++;
    }
    kpi.successRate7d = success + kpi.bad7d === 0 ? null : success / (success + kpi.bad7d);
    return {
      available: true,
      readAt: at,
      tz: zone.tz,
      ...(zone.tz ? {} : { tzReason: zone.reason }),
      kpi,
      daily7d: { tz, utcFallback: !zone.tz, days },
      tasks: out,
    };
  }

  function history(id, { before = null, beforeId = null, limit = null } = {}) {
    const size = limit === null ? 30 : /^\d+$/.test(limit) ? Number(limit) : NaN;
    if (!Number.isInteger(size) || size < 1 || size > 200) throw httpError(400, 'invalid_limit');
    if ((before === null) !== (beforeId === null) ||
      (before !== null && (!/^\d+$/.test(before) || !/^\d+$/.test(beforeId)))) {
      throw httpError(400, 'invalid_cursor');
    }
    if (!fs.existsSync(dbFile)) return { rows: [], next: null };
    let rows;
    let db;
    try {
      db = openDb(dbFile);
      const cursor = before === null ? '' : 'AND (executed_at < ? OR (executed_at = ? AND id < ?))';
      const params = before === null ? [id, size + 1] : [id, Number(before), Number(before), Number(beforeId), size + 1];
      rows = db.prepare(`SELECT id, status, executed_at, completed_at, duration_ms, error FROM task_history
        WHERE task_id = ? ${cursor} ORDER BY executed_at DESC, id DESC LIMIT ?`).all(...params);
    } catch {
      throw httpError(503, 'scheduler_unreadable');
    } finally {
      db?.close();
    }
    const next = rows.length > size ? { before: rows[size - 1].executed_at, beforeId: rows[size - 1].id } : null;
    return { rows: rows.slice(0, size).map(historyRow), next };
  }

  async function preview({ kind, value, reenable = false, locale = 'zh' }, at = now()) {
    const nowSec = Math.floor(at / 1000);
    if (kind === 'cron') {
      const cronUtils = await importOrNull(cronModule);
      if (!cronUtils) return { valid: null, error: 'cron_preview_unavailable' };
      if (!cronUtils.isValidCron(value)) return { valid: false, error: 'invalid_cron' };
      const zone = await scheduleTz();
      const runs = nextRuns({ status: 'pending', type: 'recurring', cron_expression: value }, PREVIEW_RUNS, nowSec, zone.tz ?? 'UTC', cronUtils);
      if (!Array.isArray(runs)) return { valid: null, error: 'cron_preview_unavailable' };
      return { valid: true, runs, text: cronText(value, locale), ...(zone.tz ? {} : { tzReason: zone.reason }) };
    }
    if (kind === 'every') {
      const { parseDuration } = await import(timeModule);
      const seconds = parseDuration(String(value ?? ''));
      if (!seconds) return { valid: false, error: 'invalid_duration' };
      return { valid: true, runs: Array.from({ length: PREVIEW_RUNS }, (_, k) => nowSec + (k + 1) * seconds) };
    }
    if (kind === 'at') {
      const zone = await scheduleTz();
      if (!zone.tz) return { valid: false, error: 'tz_unavailable' };
      const parsed = localToOffsetIso(value, zone.tz);
      if (!parsed) return { valid: false, error: 'invalid_time' };
      if (reenable && parsed.epoch <= nowSec) return { valid: false, error: 'reschedule_not_future' };
      return { valid: true, runs: [parsed.epoch], iso: parsed.iso };
    }
    throw httpError(400, 'invalid_preview');
  }

  return { read, history, preview };
}

/** GET routes of the schedule page; authentication is owned by the API gate. */
export async function scheduleReadResponse(reader, pathname, searchParams) {
  if (pathname === '/api/workbench/schedule') return reader.read();
  if (pathname === '/api/workbench/schedule/preview') {
    return reader.preview({
      kind: searchParams.get('kind'),
      value: searchParams.get('value') ?? '',
      reenable: searchParams.get('reenable') === '1',
      locale: searchParams.get('locale') === 'en' ? 'en' : 'zh',
    });
  }
  const route = pathname.match(/^\/api\/workbench\/schedule\/([^/]+)\/history$/);
  if (!route) return undefined;
  let id;
  try {
    id = decodeURIComponent(route[1]);
  } catch {
    throw httpError(400, 'invalid_task');
  }
  return reader.history(id, {
    before: searchParams.get('before'),
    beforeId: searchParams.get('beforeId'),
    limit: searchParams.get('limit'),
  });
}
