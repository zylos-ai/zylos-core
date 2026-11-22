import fs from 'node:fs';
import path from 'node:path';
import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import { cronText } from '../../../public/js/wb/cron-text.js';
import { dateKey, localToOffsetIso } from './schedule-tz.js';
import { cachedDateTimeFormat } from '../date-format-cache.js';
import { listFailure, parseListQuery } from '../list-query.js';

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
        const minute = cachedDateTimeFormat('en-US', { timeZone: tz, minute: 'numeric', numberingSystem: 'latn' });
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

// Status filters of the list; `enabled` covers both waiting and currently running tasks.
const STATUS_WHERE = {
  all: '1 = 1',
  enabled: "status IN ('pending', 'running')",
  paused: "status = 'paused'",
  failed: "status = 'failed'",
  completed: "status = 'completed'",
};
// The list's one order: by section (enabled, failed, paused, completed), then enabled tasks by next run
// ascending and the other sections by last update descending, then id. The whole key ascends, so it is the
// keyset position (section, key, id) and a later page only continues the current section or opens a new one.
const SECTION_RANK = "CASE WHEN status IN ('pending', 'running') THEN 0 WHEN status = 'failed' THEN 1 WHEN status = 'paused' THEN 2 ELSE 3 END";
const SECTION_KEY = `CASE WHEN status IN ('pending', 'running') THEN COALESCE(next_run_at, 0) ELSE -COALESCE(updated_at, 0) END`;
const RECENT_RUNS = 12;

const targetFilter = value => value.length > 0 && value.length <= 512 ? value : undefined;

/** The task list query (list API standard): status and target filters, name search, signed keyset cursor. */
export function scheduleListQuery(searchParams) {
  return parseListQuery('schedules', searchParams, {
    filters: { status: Object.keys(STATUS_WHERE), target: targetFilter }, q: true, include: ['total'],
  });
}

/**
 * The SQL condition selecting tasks whose delivery target (see deliveryTarget) is `target`: a session-group ID,
 * or `origin`. deliveryTarget maps a task's component to the namespace of the first snapshot row of that
 * component; this inverts it, so a group matches tasks of the components that map to its namespace, by
 * session_component and session_group_name, or, for a bare namespace, by reply_channel when session_component
 * is empty. Origin is a task with neither. `columns` lists the task table's columns, which older schemas lack.
 */
export function targetCondition(target, snapshotRows, columns) {
  const session = columns.has('session_component');
  const reply = columns.has('reply_channel');
  const noSession = session ? 'session_component IS NULL' : '1 = 1';
  if (target === 'origin') return { sql: `(${noSession} AND ${reply ? 'reply_channel IS NULL' : '1 = 1'})`, params: [] };
  const colon = target.indexOf(':');
  const namespace = colon < 0 ? target : target.slice(0, colon);
  const name = colon < 0 ? null : target.slice(colon + 1);
  const owners = new Map();
  for (const row of snapshotRows ?? []) {
    const component = row.c4?.componentName;
    if (component == null || !row.sessionGroup || owners.has(component)) continue;
    const split = row.sessionGroup.indexOf(':');
    owners.set(component, split < 0 ? row.sessionGroup : row.sessionGroup.slice(0, split));
  }
  const components = [...owners].filter(([, owner]) => owner === namespace).map(([component]) => component);
  const list = components.map(() => '?').join(', ');
  const parts = [], params = [];
  if (components.length && session) {
    parts.push(`(session_component IN (${list}) AND session_group_name ${name === null ? 'IS NULL' : '= ?'})`);
    params.push(...components, ...(name === null ? [] : [name]));
  }
  if (components.length && reply && name === null) {
    parts.push(`(${noSession} AND reply_channel IN (${list}))`);
    params.push(...components);
  }
  return parts.length ? { sql: `(${parts.join(' OR ')})`, params } : { sql: '0 = 1', params: [] };
}

const cursorPosition = position => Array.isArray(position) && position.length === 3 && Number.isSafeInteger(position[0]) &&
  Number.isFinite(position[1]) && typeof position[2] === 'string';

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

  async function read(at = now(), query = scheduleListQuery(new URLSearchParams())) {
    const status = query.filters.status ?? 'all';
    const withTotal = query.include.has('total');
    if (query.after !== null && !cursorPosition(query.after)) throw listFailure(400, 'invalid_cursor', 'The cursor is no longer valid; reload the first page');
    if (!fs.existsSync(dbFile)) return { available: false, items: [], nextCursor: null, ...(withTotal ? { total: 0 } : {}) };
    const target = query.filters.target ?? null;
    let snapshotRows = [];
    if (target !== null && target !== 'origin') {
      try {
        snapshotRows = (await getSnapshot())?.rows ?? [];
      } catch {
        throw listFailure(503, 'unavailable', 'The session group snapshot cannot be read');
      }
    }
    const nowSec = Math.floor(at / 1000);
    let enabledTasks, page, total, recent, week, statusRows;
    let db;
    try {
      db = openDb(dbFile);
      // Keep the page, counts and history on one SQLite snapshot while tasks finish.
      db.exec('BEGIN');
      // The next-24-hours lane and its KPI span every enabled task, whichever page is shown.
      enabledTasks = db.prepare(`SELECT id, name, priority, status, type, cron_expression, interval_seconds, next_run_at
        FROM tasks WHERE ${STATUS_WHERE.enabled}`).all();
      statusRows = db.prepare('SELECT status, count(*) AS count FROM tasks GROUP BY status').all();
      // q matches the task name only, with Unicode lowercase and literal %, _ and backslashes.
      if (query.q) {
        const needle = query.q.toLowerCase();
        db.function('schedule_name_match', value => Number(String(value ?? '').toLowerCase().includes(needle)));
      }
      const byTarget = target === null ? null
        : targetCondition(target, snapshotRows, new Set(db.pragma('table_info(tasks)').map(column => column.name)));
      const where = `${STATUS_WHERE[status]}${query.q ? ' AND schedule_name_match(name)' : ''}${byTarget ? ` AND ${byTarget.sql}` : ''}`;
      const whereParams = byTarget?.params ?? [];
      const after = query.after ? 'WHERE (section_rank, section_key, id) > (?, ?, ?)' : '';
      page = db.prepare(`SELECT * FROM (SELECT *, ${SECTION_RANK} AS section_rank, ${SECTION_KEY} AS section_key
        FROM tasks WHERE ${where}) ${after} ORDER BY section_rank, section_key, id LIMIT ?`)
        .all(...whereParams, ...(query.after ?? []), query.limit + 1);
      if (withTotal) total = db.prepare(`SELECT count(*) AS count FROM tasks WHERE ${where}`).get(...whereParams).count;
      // Recent results only for the rows of this page.
      const pageIds = page.slice(0, query.limit).map(task => task.id);
      const latest = db.prepare(`SELECT id, task_id, status, executed_at, completed_at, duration_ms, error FROM task_history
        WHERE task_id = ? ORDER BY executed_at DESC, id DESC LIMIT ${RECENT_RUNS}`);
      recent = pageIds.flatMap(id => latest.all(id));
      week = db.prepare('SELECT status, executed_at FROM task_history WHERE executed_at >= ?').all(nowSec - 8 * DAY);
      db.exec('COMMIT');
    } catch {
      throw listFailure(503, 'unavailable', 'The scheduler database cannot be read');
    } finally {
      db?.close();
    }
    const more = page.length > query.limit;
    page = page.slice(0, query.limit);
    const zone = await scheduleTz();
    const tz = zone.tz ?? 'UTC';
    const cronUtils = [...enabledTasks, ...page].some(task => task.type === 'recurring') ? await importOrNull(cronModule) : null;
    const byTask = new Map();
    for (const row of recent) {
      const list = byTask.get(row.task_id) ?? [];
      list.push(historyRow(row));
      byTask.set(row.task_id, list);
    }
    const resolve = await delivery(page);
    const counts = { all: 0, enabled: 0, paused: 0, failed: 0, completed: 0 };
    const kpi = { enabled: 0, paused: 0, running: 0, next24h: 0, partialPreview: false, runs7d: 0, bad7d: 0, successRate7d: null };
    for (const row of statusRows) {
      counts.all += row.count;
      if (ENABLED.has(row.status)) counts.enabled += row.count;
      if (['paused', 'failed', 'completed'].includes(row.status)) counts[row.status] += row.count;
      if (row.status === 'running') kpi.running = row.count;
    }
    kpi.enabled = counts.enabled;
    kpi.paused = counts.paused;
    const timelineTasks = [];
    for (const task of enabledTasks) {
      const upcoming = nextRuns(task, 5, nowSec, tz, cronUtils, { until: nowSec + DAY });
      if (!Array.isArray(upcoming) || upcoming.truncated) kpi.partialPreview = true;
      const in24h = Array.isArray(upcoming) ? upcoming.filter(time => time > nowSec && time <= nowSec + DAY) : [];
      kpi.next24h += in24h.length;
      if (in24h.length) timelineTasks.push({ id: task.id, name: task.name, priority: task.priority, nextRuns: { in24h } });
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
      const date = dateKey(row.executed_at, tz);
      const day = days.find(item => item.date === date);
      if (day && ['success', 'timeout', 'failed'].includes(row.status)) day[row.status]++;
    }
    kpi.successRate7d = success + kpi.bad7d === 0 ? null : success / (success + kpi.bad7d);
    const last = page.at(-1);
    return {
      items: page.map(task => serializeTask(task, (byTask.get(task.id) ?? []).slice().reverse(), nowSec, tz, cronUtils, resolve)),
      nextCursor: more ? query.nextCursor([last.section_rank, last.section_key, last.id]) : null,
      ...(withTotal ? { total } : {}),
      available: true,
      readAt: at,
      tz: zone.tz,
      kpi,
      daily7d: { tz, utcFallback: !zone.tz, days },
      timelineTasks,
      counts,
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

  function history(id, query) {
    if (query.after !== null && !(Array.isArray(query.after) && query.after.length === 2 &&
      query.after.every(Number.isSafeInteger))) throw listFailure(400, 'invalid_cursor', 'The cursor is no longer valid; reload the first page');
    if (!fs.existsSync(dbFile)) throw listFailure(404, 'not_found', 'The task does not exist');
    let task, rows;
    let db;
    try {
      db = openDb(dbFile);
      db.exec('BEGIN');
      task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
      const after = query.after ? 'AND (executed_at < ? OR (executed_at = ? AND id < ?))' : '';
      const params = query.after ? [query.after[0], query.after[0], query.after[1]] : [];
      rows = task ? db.prepare(`SELECT id, status, executed_at, completed_at, duration_ms, error FROM task_history
        WHERE task_id = ? ${after} ORDER BY executed_at DESC, id DESC LIMIT ?`).all(id, ...params, query.limit + 1) : [];
      db.exec('COMMIT');
    } catch {
      throw listFailure(503, 'unavailable', 'The scheduler database cannot be read');
    } finally {
      db?.close();
    }
    if (!task) throw listFailure(404, 'not_found', 'The task does not exist');
    const last = rows.length > query.limit ? rows[query.limit - 1] : null;
    return { items: rows.slice(0, query.limit).map(historyRow), nextCursor: last ? query.nextCursor([last.executed_at, last.id]) : null };
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
  if (pathname === '/api/schedules') return reader.read(undefined, scheduleListQuery(searchParams));
  if (pathname === '/api/schedules/preview') {
    const preview = await reader.preview({
      kind: searchParams.get('kind'),
      value: searchParams.get('value') ?? '',
      reenable: searchParams.get('reenable') === '1',
      locale: searchParams.get('locale') === 'en' ? 'en' : 'zh',
    });
    if (preview.valid !== true) throw httpError(preview.valid === null || preview.error === 'tz_unavailable' ? 503 : 400, preview.error || 'preview_unavailable');
    return preview;
  }
  const route = pathname.match(/^\/api\/schedules\/([^/]+)(\/history)?$/);
  if (!route) return undefined;
  let id;
  try {
    id = decodeURIComponent(route[1]);
  } catch {
    throw httpError(400, 'invalid_task');
  }
  if (!route[2]) return reader.detail(id);
  // One collection per task: a cursor issued for another task's history is rejected.
  return reader.history(id, parseListQuery(`schedules/${id}/history`, searchParams));
}
