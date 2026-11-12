import fs from 'node:fs';
import path from 'node:path';
import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import { cronText } from '../../../public/js/wb/cron-text.js';
import { dateKey, localToOffsetIso } from './schedule-tz.js';

const CRON_MODULE = new URL('../../../../scheduler/scripts/cron-utils.js', import.meta.url).href;
const TIME_MODULE = new URL('../../../../scheduler/scripts/time-utils.js', import.meta.url).href;
const ENABLED = new Set(['pending', 'running']);
const BAD = new Set(['failed']);
const DAY = 86400;
const PREVIEW_RUNS = 3;
const MAX_RUNS = 2000;

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
export function nextRuns(task, n, from, tz, cronUtils, { until = null } = {}) {
  if (!ENABLED.has(task.status)) return [];
  if (task.type === 'recurring') {
    if (!cronUtils) return { unavailable: true, reason: 'cron_preview_unavailable' };
    try {
      const iterator = cronUtils.createCronIterator(task.cron_expression, tz, new Date(from * 1000));
      // Dense minute rules use one parsed boundary, then epoch-minute arithmetic.
      // Check local minutes for steps that do not divide the hour or cross an
      // offset change; this preserves the rule across half-hour DST changes too.
      const fields = String(task.cron_expression).trim().split(/\s+/);
      if (fields.length === 5 && fields.slice(1).every(field => field === '*') &&
        /^(?:\*|\*\/[1-9]\d*|0-59)$/.test(fields[0])) {
        const first = iterator.next();
        const step = fields[0].startsWith('*/') ? Number(fields[0].slice(2)) : 1;
        if (step === 1) return runSeries(first, 60, n, until);
        const minute = new Intl.DateTimeFormat('en-US', { timeZone: tz, minute: 'numeric', numberingSystem: 'latn' });
        const runs = [];
        const limit = until === null ? n : MAX_RUNS;
        for (let at = first; runs.length < limit; at += 60) {
          if (Number(minute.format(new Date(at * 1000))) % step !== 0) continue;
          runs.push(at);
          if (until !== null && runs.length >= n && at > until) return runs;
        }
        if (until !== null) runs.truncated = true;
        return runs;
      }
      const runs = [];
      const limit = until === null ? n : MAX_RUNS;
      for (let index = 0; index < limit; index++) {
        const at = iterator.next();
        runs.push(at);
        if (until !== null && runs.length >= n && at > until) return runs;
      }
      if (until !== null) runs.truncated = true;
      return runs;
    } catch {
      return { unavailable: true, reason: 'cron_preview_unavailable' };
    }
  }
  if (task.type === 'interval') {
    if (!(task.interval_seconds > 0) || task.next_run_at == null) return [];
    const step = task.interval_seconds;
    // Old anchors are advanced arithmetically, without walking past executions.
    const start = task.next_run_at > from ? task.next_run_at
      : task.next_run_at + (Math.floor((from - task.next_run_at) / step) + 1) * step;
    return runSeries(start, step, n, until);
  }
  return task.next_run_at == null ? [] : [task.next_run_at];
}

function runSeries(start, step, n, until) {
  const required = until === null ? n : Math.max(n, Math.floor((until - start) / step) + 2);
  const runs = Array.from({ length: Math.min(required, MAX_RUNS) }, (_, k) => start + k * step);
  if (required > MAX_RUNS) runs.truncated = true;
  return runs;
}

function listOptions({ status = 'all', q = '', cursor = null, limit = null } = {}) {
  status ??= 'all';
  q = String(q ?? '').trim();
  if (!['all', 'enabled', 'paused', 'failed', 'completed'].includes(status)) throw httpError(400, 'invalid_status');
  const size = limit === null ? 30 : /^\d+$/.test(String(limit)) ? Number(limit) : NaN;
  if (!Number.isInteger(size) || size < 1 || size > 100) throw httpError(400, 'invalid_limit');
  let before = null;
  if (cursor !== null) {
    try {
      if (!(status === 'completed' || status === 'all' && q) || typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw Error();
      before = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (!Array.isArray(before) || before.length !== 2 || !Number.isSafeInteger(before[0]) ||
        typeof before[1] !== 'string' || !before[1].length || before[1].length > 512) throw Error();
    } catch {
      throw httpError(400, 'invalid_cursor');
    }
  }
  return { status, q, before, size };
}

function serializeTask(task, history, nowSec, tz, cronUtils, resolve, fullPrompt = false) {
  const latest = history.at(-1);
  const showLastError = Boolean(latest && BAD.has(latest.status));
  const upcoming = nextRuns(task, 5, nowSec, tz, cronUtils, { until: nowSec + DAY });
  const unavailable = !Array.isArray(upcoming);
  const runs = unavailable ? [] : upcoming.filter(time => time > nowSec);
  const { target, reply } = resolve(task);
  const characters = fullPrompt ? null : Array.from(String(task.prompt ?? ''));
  return {
    id: task.id, name: task.name,
    ...(fullPrompt ? { prompt: task.prompt, promptTruncated: false }
      : { promptSummary: characters.slice(0, 200).join(''), promptTruncated: characters.length > 200 }),
    type: task.type, status: task.status, cron: task.cron_expression ?? null,
    intervalSeconds: task.interval_seconds ?? null, nextRunAt: task.next_run_at ?? null,
    lastRunAt: task.last_run_at ?? null, updatedAt: task.updated_at ?? null,
    priority: task.priority, requireIdle: Boolean(task.require_idle), missThreshold: task.miss_threshold,
    showLastError, lastError: showLastError ? task.last_error ?? null : null, recent: history,
    nextRuns: unavailable ? upcoming : { runs: runs.slice(0, 5), in24h: runs.filter(time => time <= nowSec + DAY),
      ...(upcoming.truncated ? { truncated: true } : {}) },
    target, reply, reenable: task.status === 'failed' && task.type === 'one-time',
  };
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

/**
 * The names of scheduler tasks, by id, for labelling what they sent. Read-only; a missing or unreadable scheduler
 * database, or a task without a name, leaves the id out, so a reader falls back to the prompt's first line.
 */
export function readTaskNames(zylosDir, ids) {
  const wanted = [...new Set(ids)].filter(id => typeof id === 'string').slice(0, 500);
  const dbFile = path.join(zylosDir, 'scheduler', 'scheduler.db');
  if (!wanted.length || !fs.existsSync(dbFile)) return new Map();
  let db;
  try {
    db = openDb(dbFile);
    const rows = db.prepare(`SELECT id, name FROM tasks WHERE id IN (${wanted.map(() => '?').join(',')})`).all(...wanted);
    return new Map(rows.filter(row => typeof row.name === 'string' && row.name.trim()).map(row => [row.id, row.name]));
  } catch {
    return new Map();
  } finally {
    db?.close();
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

  async function read(at = now(), options = {}) {
    const { status, q, before, size } = listOptions(options);
    if (!fs.existsSync(dbFile)) return { available: false, tasks: [] };
    const nowSec = Math.floor(at / 1000);
    let tasks, listed, recent, week, statusRows, nextCursor = null;
    let db;
    try {
      db = openDb(dbFile);
      // Keep the list, counts and history on one SQLite snapshot while tasks finish.
      db.exec('BEGIN');
      // The overview always spans active tasks; a completed page or search never
      // changes the KPI or timeline. SELECT * also supports older task schemas.
      tasks = db.prepare("SELECT * FROM tasks WHERE status != 'completed'").all();
      statusRows = db.prepare('SELECT status, count(*) AS count FROM tasks GROUP BY status').all();
      // Preserve the former browser search, including Unicode lowercase and
      // literal %, _ and backslashes, against full prompt bodies.
      const match = q ? 'AND (schedule_search(name) OR schedule_search(prompt) OR schedule_search(id))' : '';
      if (q) {
        const needle = q.toLowerCase();
        db.function('schedule_search', value => Number(String(value ?? '').toLowerCase().includes(needle)));
      }
      listed = status === 'completed' ? [] : q
        ? db.prepare(`SELECT * FROM tasks WHERE status != 'completed' ${match}`).all() : tasks;
      if (status === 'completed' || status === 'all' && q) {
        const cursor = before ? 'AND (COALESCE(updated_at, 0) < ? OR (COALESCE(updated_at, 0) = ? AND id < ?))' : '';
        const params = before ? [before[0], before[0], before[1], size + 1] : [size + 1];
        let completed = db.prepare(`SELECT * FROM tasks WHERE status = 'completed' ${match} ${cursor}
          ORDER BY COALESCE(updated_at, 0) DESC, id DESC LIMIT ?`).all(...params);
        if (completed.length > size) {
          const last = completed[size - 1];
          nextCursor = Buffer.from(JSON.stringify([last.updated_at ?? 0, last.id])).toString('base64url');
          completed = completed.slice(0, size);
        }
        listed = [...listed, ...completed];
      }
      const visibleIds = [...new Set([...tasks, ...listed].map(task => task.id))];
      recent = visibleIds.length ? db.prepare(`SELECT * FROM (
          SELECT id, task_id, status, executed_at, completed_at, duration_ms, error,
            ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY executed_at DESC, id DESC) AS rn
          FROM task_history WHERE task_id IN (${visibleIds.map(() => '?').join(',')})) WHERE rn <= 12`).all(...visibleIds) : [];
      week = db.prepare('SELECT status, executed_at FROM task_history WHERE executed_at >= ?').all(nowSec - 8 * DAY);
      db.exec('COMMIT');
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
    const resolve = await delivery([...tasks, ...listed]);
    const kpi = { enabled: 0, paused: 0, running: 0, next24h: 0, partialPreview: false, runs7d: 0, bad7d: 0, successRate7d: null };
    const counts = { all: 0, enabled: 0, paused: 0, failed: 0, completed: 0 };
    for (const row of statusRows) {
      counts.all += row.count;
      if (ENABLED.has(row.status)) counts.enabled += row.count;
      if (['paused', 'failed', 'completed'].includes(row.status)) counts[row.status] += row.count;
    }
    const out = new Map();
    for (const task of [...tasks, ...listed]) {
      if (out.has(task.id)) continue;
      const item = serializeTask(task, (byTask.get(task.id) ?? []).slice().reverse(), nowSec, tz, cronUtils, resolve);
      out.set(task.id, item);
      if (ENABLED.has(task.status)) {
        kpi.enabled++;
        if (item.nextRuns.unavailable || item.nextRuns.truncated) kpi.partialPreview = true;
        kpi.next24h += item.nextRuns.in24h?.length ?? 0;
      }
      if (task.status === 'paused') kpi.paused++;
      if (task.status === 'running') kpi.running++;
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
      tasks: listed.map(task => out.get(task.id)),
      ...(listed.length === tasks.length && listed.every((task, index) => task.id === tasks[index].id) ? {}
        : { timelineTasks: tasks.map(task => out.get(task.id)) }),
      counts,
      nextCursor,
    };
  }

  async function detail(id, at = now()) {
    if (!fs.existsSync(dbFile)) throw httpError(404, 'task_not_found');
    let db, task, recent;
    try {
      db = openDb(dbFile);
      db.exec('BEGIN');
      task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      recent = task ? db.prepare(`SELECT id, status, executed_at, completed_at, duration_ms, error
        FROM task_history WHERE task_id = ? ORDER BY executed_at DESC, id DESC LIMIT 12`).all(id) : [];
      db.exec('COMMIT');
    } catch {
      throw httpError(503, 'scheduler_unreadable');
    } finally {
      db?.close();
    }
    if (!task) throw httpError(404, 'task_not_found');
    const zone = await scheduleTz();
    const cronUtils = task.type === 'recurring' ? await importOrNull(cronModule) : null;
    const resolve = await delivery([task]);
    return { task: serializeTask(task, recent.reverse().map(historyRow), Math.floor(at / 1000), zone.tz ?? 'UTC', cronUtils, resolve, true) };
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

  return { read, detail, history, preview };
}

/** GET routes of the schedule page; authentication is owned by the API gate. */
export async function scheduleReadResponse(reader, pathname, searchParams) {
  if (pathname === '/api/workbench/schedule') return reader.read(undefined, {
    status: searchParams.get('status'), q: searchParams.get('q'), cursor: searchParams.get('cursor'), limit: searchParams.get('limit'),
  });
  if (pathname === '/api/workbench/schedule/preview') {
    return reader.preview({
      kind: searchParams.get('kind'),
      value: searchParams.get('value') ?? '',
      reenable: searchParams.get('reenable') === '1',
      locale: searchParams.get('locale') === 'en' ? 'en' : 'zh',
    });
  }
  const route = pathname.match(/^\/api\/workbench\/schedule\/([^/]+)(\/history)?$/);
  if (!route) return undefined;
  let id;
  try {
    id = decodeURIComponent(route[1]);
  } catch {
    throw httpError(400, 'invalid_task');
  }
  if (!route[2]) return reader.detail(id);
  return reader.history(id, {
    before: searchParams.get('before'),
    beforeId: searchParams.get('beforeId'),
    limit: searchParams.get('limit'),
  });
}
