import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createScheduleRead, scheduleReadResponse } from '../src/lib/workbench/schedule-read.js';
import { createScheduleTz } from '../src/lib/workbench/schedule-tz.js';
import { createGroupSnapshot } from '../src/lib/workbench/group-snapshot.js';
import { scheduleEnv } from './fixtures/schedule-env.js';

// Integration: real read-only SQLite reads of a temporary scheduler.db, real
// scheduler cron/tz/time modules imported by relative path, and the real
// scheduler CLI (child process) only to create the schema. Run for changes to the
// schedule read model, its SQL or the scheduler modules it imports; skip
// rendering-only edits. Isolation: temporary HOME, ZYLOS_DIR, PM2_HOME, short
// TMPDIR and tmux directory from fixtures/schedule-env.js (paths asserted under
// the fixture root and printed); no PM2, tmux, network or live Zylos access.
// process.env.ZYLOS_DIR is pointed at the fixture for tz.js and restored; the
// fixture root is removed in teardown.

const NOW_MS = 1800000000 * 1000;
const NOW = NOW_MS / 1000;
const HOUR = 3600;
const DAY = 86400;
const TZ_URL = new URL('../../scheduler/scripts/tz.js', import.meta.url).href;
const CRON_URL = new URL('../../scheduler/scripts/cron-utils.js', import.meta.url).href;
let importCase = 0;

function useZylosDir(t, dir) {
  const previous = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
  });
}

function fixture(t, options) {
  const f = scheduleEnv(t, options);
  useZylosDir(t, f.zylosDir);
  assert.equal(f.agent(['list']).ok, undefined);
  const db = f.open();
  let seq = 0;
  const task = fields => {
    const row = {
      id: `task-${String(++seq).padStart(3, '0')}`, name: `Task ${seq}`, prompt: `Do item ${seq}. Then more.`,
      type: 'one-time', cron_expression: null, interval_seconds: null, timezone: 'Asia/Singapore',
      next_run_at: NOW + DAY * 3, last_run_at: null, priority: 3, status: 'pending', require_idle: 0,
      miss_threshold: 300, reply_channel: null, reply_endpoint: null, created_at: NOW - DAY * 20,
      updated_at: NOW - DAY, last_error: null, failed_at: null, session_component: null, session_group_name: null,
      ...fields,
    };
    const keys = Object.keys(row);
    db.prepare(`INSERT INTO tasks (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
    return row;
  };
  const run = (taskId, fields) => db.prepare(`INSERT INTO task_history (task_id, executed_at, completed_at, status, duration_ms, error)
    VALUES (?, ?, ?, ?, ?, ?)`).run(taskId, fields.executed_at, fields.completed_at ?? null, fields.status,
    fields.duration_ms ?? null, fields.error ?? null).lastInsertRowid;
  const reader = (extra = {}) => createScheduleRead({
    zylosDir: f.zylosDir, now: () => NOW_MS,
    scheduleTz: createScheduleTz({ zylosDir: f.zylosDir, tzModule: `${TZ_URL}?case=${++importCase}` }),
    ...extra,
  });
  return { ...f, db, task, run, reader };
}

function populate(f) {
  const ids = {};
  for (let i = 0; i < 17; i++) {
    const status = i < 10 ? 'pending' : i < 12 ? 'running' : i < 14 ? 'paused' : i < 16 ? 'failed' : 'completed';
    const row = f.task({ type: 'recurring', cron_expression: '0 8 * * *', status, next_run_at: NOW + HOUR });
    if (i === 0) ids.recurring = row.id;
  }
  f.task({ type: 'interval', interval_seconds: HOUR, next_run_at: NOW + 600 });
  f.task({ type: 'interval', interval_seconds: HOUR, status: 'paused' });
  for (let i = 0; i < 78; i++) {
    const status = i < 40 ? 'completed' : i < 60 ? 'failed' : i < 70 ? 'pending' : i < 75 ? 'paused' : 'running';
    const row = f.task({ status, next_run_at: status === 'pending' ? NOW + (i - 59) * HOUR : NOW - 60,
      last_error: status === 'failed' ? 'Missed execution window' : null });
    if (i === 0) ids.completed = row.id;
    if (i === 40) ids.failedNoError = row.id;
    if (i === 41) ids.timedOut = row.id;
    if (i === 42) ids.recovered = row.id;
  }
  const rows = [];
  const add = (taskId, fields) => {
    rows.push({ taskId, ...fields });
    return f.run(taskId, fields);
  };
  for (let k = 15; k >= 1; k--) add(ids.recurring, { executed_at: NOW - k * DAY / 3, completed_at: NOW - k * DAY / 3 + 4, status: 'success', duration_ms: 4000 });
  add(ids.failedNoError, { executed_at: NOW - 5 * HOUR, completed_at: NOW - 5 * HOUR + 7, status: 'failed' });
  add(ids.failedNoError, { executed_at: NOW - 9 * DAY, completed_at: NOW - 9 * DAY + 2, status: 'failed' });
  f.db.prepare("UPDATE tasks SET last_error='Task timed out' WHERE id=?").run(ids.timedOut);
  add(ids.timedOut, { executed_at: NOW - 3 * HOUR, completed_at: NOW - 2 * HOUR, status: 'timeout', duration_ms: HOUR * 1000, error: 'TASK_TIMEOUT' });
  f.db.prepare("UPDATE tasks SET last_error='old failure' WHERE id=?").run(ids.recovered);
  add(ids.recovered, { executed_at: NOW - 2 * DAY, completed_at: NOW - 2 * DAY + 1, status: 'failed' });
  add(ids.recovered, { executed_at: NOW - DAY, completed_at: NOW - DAY + 1, status: 'success', duration_ms: 1000 });
  add(ids.completed, { executed_at: NOW - 9 * HOUR, completed_at: NOW - 9 * HOUR + 3, status: 'failed' });
  add(ids.completed, { executed_at: NOW - 60, status: 'started' });
  return { ids, rows };
}

test('schedule read reports counts, sections, recent results and last error from the database', async t => {
  const f = fixture(t);
  const { ids, rows } = populate(f);
  const page = await f.reader().read();
  assert.equal(page.available, true);
  assert.equal(page.tz, 'Asia/Singapore');
  assert.equal(page.tasks.length, 97);
  const counts = type => page.tasks.filter(task => task.type === type).length;
  assert.deepEqual([counts('recurring'), counts('interval'), counts('one-time')], [17, 2, 78]);
  const recent = rows.filter(row => row.executed_at >= NOW - 7 * DAY);
  const success = recent.filter(row => row.status === 'success').length;
  const bad = recent.filter(row => ['failed', 'timeout'].includes(row.status)).length;
  assert.deepEqual(page.kpi, {
    enabled: 26, paused: 8, running: 5, next24h: 12 + 24 + 10, partialPreview: false,
    runs7d: recent.length, bad7d: bad, successRate7d: success / (success + bad),
  });
  assert.equal(bad, 4);
  const byId = new Map(page.tasks.map(task => [task.id, task]));
  assert.equal(byId.get(ids.completed).status, 'completed');
  assert.equal(page.tasks.filter(task => task.status === 'completed' && task.type === 'one-time').length, 40);
  const history = byId.get(ids.recurring).recent;
  assert.equal(history.length, 12);
  assert.deepEqual(history.map(run => run.executedAt), Array.from({ length: 12 }, (_, i) => NOW - (12 - i) * DAY / 3));
  const failed = byId.get(ids.failedNoError);
  assert.equal(failed.recent.at(-1).error, null);
  assert.equal(failed.recent.at(-1).duration, 7000);
  assert.equal(failed.showLastError, true);
  assert.equal(failed.lastError, 'Missed execution window');
  assert.equal(failed.reenable, true);
  assert.equal(byId.get(ids.timedOut).showLastError, true);
  assert.equal(byId.get(ids.timedOut).lastError, 'Task timed out');
  assert.equal(byId.get(ids.recovered).showLastError, false);
  assert.equal(byId.get(ids.recovered).lastError, null);
  assert.equal(byId.get(ids.completed).showLastError, false);
  assert.equal(page.tasks.filter(task => task.showLastError).length, 2);
  assert.equal(page.daily7d.tz, 'Asia/Singapore');
  assert.equal(page.daily7d.utcFallback, false);
  assert.equal(page.daily7d.days.length, 7);
  // 23:00 UTC on the previous day is 07:00 the same day in Singapore.
  const today = page.daily7d.days.at(-1);
  assert.equal(today.date, '2027-01-15');
  assert.deepEqual({ ...today, date: undefined }, { date: undefined, success: 2, timeout: 1, failed: 2 });
});

test('schedule read failure paths: missing file, non-SQLite file, bad cron and missing cron module', async t => {
  const missing = scheduleEnv(t);
  useZylosDir(t, missing.zylosDir);
  const empty = createScheduleRead({ zylosDir: missing.zylosDir, now: () => NOW_MS,
    scheduleTz: createScheduleTz({ zylosDir: missing.zylosDir, tzModule: `${TZ_URL}?case=${++importCase}` }) });
  assert.deepEqual(await scheduleReadResponse(empty, '/api/workbench/schedule', new URLSearchParams()), { available: false, tasks: [] });
  fs.writeFileSync(missing.dbPath, 'not a database file');
  await assert.rejects(scheduleReadResponse(empty, '/api/workbench/schedule', new URLSearchParams()),
    error => error.statusCode === 503 && error.code === 'scheduler_unreadable');
  await assert.rejects(scheduleReadResponse(empty, '/api/workbench/schedule/task-1/history', new URLSearchParams()),
    error => error.statusCode === 503 && error.code === 'scheduler_unreadable');

  const f = fixture(t);
  const broken = f.task({ type: 'recurring', cron_expression: 'not a cron' });
  const good = f.task({ type: 'recurring', cron_expression: '0 8 * * *' });
  const interval = f.task({ type: 'interval', interval_seconds: HOUR, next_run_at: NOW + 60 });
  const page = await f.reader().read();
  const byId = new Map(page.tasks.map(task => [task.id, task]));
  assert.deepEqual(byId.get(broken.id).nextRuns, { unavailable: true, reason: 'cron_preview_unavailable' });
  assert.equal(byId.get(good.id).nextRuns.runs.length, 5);
  assert.equal(byId.get(interval.id).nextRuns.in24h.length, 24);
  assert.equal(page.kpi.partialPreview, true);
  assert.equal(page.kpi.next24h, 1 + 24);

  const absent = path.join(f.root, 'absent', 'cron-utils.js');
  const noCron = await f.reader({ cronModule: new URL(`file://${absent}`).href }).read();
  for (const task of noCron.tasks.filter(item => item.type === 'recurring')) {
    assert.deepEqual(task.nextRuns, { unavailable: true, reason: 'cron_preview_unavailable' });
  }
  assert.equal(noCron.tasks.find(item => item.id === interval.id).nextRuns.runs.length, 5);
  const preview = await f.reader({ cronModule: new URL(`file://${absent}`).href }).preview({ kind: 'cron', value: '0 8 * * *' });
  assert.deepEqual(preview, { valid: null, error: 'cron_preview_unavailable' });
});

test('schedule time zone comes from the same installation .env or is reported unknown', async t => {
  const f = fixture(t);
  f.run(f.task({}).id, { executed_at: NOW - 9 * HOUR, completed_at: NOW - 9 * HOUR + 1, status: 'success' });
  const atSingapore = await f.reader().preview({ kind: 'at', value: '2027-02-01T09:30' });
  assert.deepEqual(atSingapore, { valid: true, runs: [Date.parse('2027-02-01T01:30:00Z') / 1000], iso: '2027-02-01T09:30:00+08:00' });

  const other = path.join(f.root, 'other');
  fs.mkdirSync(other);
  const mismatch = f.reader({ scheduleTz: createScheduleTz({ zylosDir: f.zylosDir, env: { ZYLOS_DIR: other },
    tzModule: `${TZ_URL}?case=${++importCase}` }) });
  const page = await mismatch.read();
  assert.equal(page.tz, null);
  assert.equal(page.tzReason, 'tz_unavailable');
  assert.equal(page.daily7d.tz, 'UTC');
  assert.equal(page.daily7d.utcFallback, true);
  assert.deepEqual(page.daily7d.days.find(day => day.date === '2027-01-14'), { date: '2027-01-14', success: 1, timeout: 0, failed: 0 });
  assert.deepEqual(await mismatch.preview({ kind: 'at', value: '2027-02-01T09:30' }), { valid: false, error: 'tz_unavailable' });

  fs.writeFileSync(path.join(f.zylosDir, '.env'), 'TZ=Not/AZone\n');
  const invalid = await f.reader().read();
  assert.equal(invalid.tz, null);
  assert.equal(invalid.tzReason, 'tz_unavailable');
});

test('schedule preview validates cron, interval and re-enable times', async t => {
  const f = fixture(t);
  const reader = f.reader();
  assert.deepEqual(await reader.preview({ kind: 'cron', value: 'nope' }), { valid: false, error: 'invalid_cron' });
  const cron = await reader.preview({ kind: 'cron', value: '0 8 * * *' });
  assert.equal(cron.valid, true);
  assert.equal(cron.text, '每天 08:00');
  assert.deepEqual(cron.runs, [1, 2, 3].map(k => Date.parse('2027-01-15T00:00:00Z') / 1000 + k * DAY));
  assert.deepEqual(await reader.preview({ kind: 'every', value: '90m' }), { valid: true, runs: [1, 2, 3].map(k => NOW + k * 5400) });
  assert.deepEqual(await reader.preview({ kind: 'every', value: 'abc' }), { valid: false, error: 'invalid_duration' });
  assert.deepEqual(await reader.preview({ kind: 'at', value: '2027-01-15T15:00', reenable: true }), { valid: false, error: 'reschedule_not_future' });
  assert.equal((await reader.preview({ kind: 'at', value: '2027-01-15T17:00', reenable: true })).valid, true);
  assert.deepEqual(await reader.preview({ kind: 'at', value: '2027-02-30T09:00' }), { valid: false, error: 'invalid_time' });
  await assert.rejects(reader.preview({ kind: 'in', value: '1h' }), error => error.statusCode === 400);
});

test('execution history pages by time and id without repeats or gaps', async t => {
  const f = fixture(t);
  const task = f.task({});
  const ids = [];
  for (let i = 0; i < 65; i++) ids.push(f.run(task.id, { executed_at: NOW - DAY + Math.floor(i / 2) * 60, status: 'success' }));
  const reader = f.reader();
  const page = query => scheduleReadResponse(reader, `/api/workbench/schedule/${task.id}/history`, new URLSearchParams(query));
  const first = await page({ limit: '30' });
  const second = await page({ limit: '30', before: String(first.next.before), beforeId: String(first.next.beforeId) });
  // A run recorded between page reads must not shift the next page.
  const late = f.run(task.id, { executed_at: NOW, status: 'started' });
  const third = await page({ limit: '30', before: String(second.next.before), beforeId: String(second.next.beforeId) });
  assert.deepEqual([first.rows.length, second.rows.length, third.rows.length], [30, 30, 5]);
  assert.equal(third.next, null);
  const seen = [...first.rows, ...second.rows, ...third.rows].map(row => row.id);
  assert.equal(new Set(seen).size, 65);
  assert.deepEqual([...seen].sort((a, b) => a - b), ids.map(Number));
  assert.equal(seen.includes(Number(late)), false);
  const tied = first.rows.filter(row => row.executedAt === first.rows[0].executedAt);
  assert.ok(tied.length >= 1 && tied.every((row, index) => index === 0 || row.id < tied[index - 1].id));
  assert.equal((await page({})).rows.length, 30);
  for (const query of [{ limit: '0' }, { limit: '201' }, { limit: '2.5' }]) {
    await assert.rejects(page(query), error => error.statusCode === 400 && error.code === 'invalid_limit');
  }
  for (const query of [{ before: String(NOW) }, { beforeId: '3' }, { before: 'x', beforeId: '1' }]) {
    await assert.rejects(page(query), error => error.statusCode === 400 && error.code === 'invalid_cursor');
  }
});

test('target groups follow the dispatch rule using the group snapshot without namespace lookups', async t => {
  const f = fixture(t);
  const grouped = f.task({ session_component: 'telegram', session_group_name: 'dm-1001', reply_channel: 'telegram', reply_endpoint: '1001' });
  const whole = f.task({ reply_channel: 'telegram', reply_endpoint: '1001' });
  const origin = f.task({});
  const unknown = f.task({ session_component: 'lark', session_group_name: 'ops' });
  const calls = [];
  const snapshot = createGroupSnapshot({ zylosDir: f.zylosDir, now: () => NOW_MS,
    store: { latestEventByType: () => null, queryEvents: () => [] },
    cli: {
      runC4Db: async args => {
        calls.push(args);
        return { ok: true, readAt: NOW_MS, data: args[0] === 'groups'
          ? { groups: [{ sessionGroup: 'telegram:dm-5', componentName: 'telegram', lastActivityAt: NOW_MS }], hasOlder: false }
          : { groups: [], globalFence: null } };
      },
      readOverrides: async keys => {
        calls.push(['overrides', ...keys]);
        return { ok: true, readAt: NOW_MS, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } };
      },
    },
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi' }) };
      if (name === 'session-state-reader.js') return { readAccountUsage: async () => null, readSessionState: async () => null };
      return { collectStatus: async () => ({ view: 'multi', origin: { presence: 'not_running' }, groups: [], groupListError: null, runtimeHealth: {} }) };
    },
  });
  const names = new Map([['telegram:dm-1001', { displayName: 'Customer DM' }]]);
  const page = await f.reader({ getSnapshot: () => snapshot.getSnapshot(), displayNames: { listAll: () => names } }).read();
  const byId = new Map(page.tasks.map(task => [task.id, task]));
  assert.deepEqual(byId.get(grouped.id).target, { kind: 'group', sessionGroup: 'telegram:dm-1001', componentName: 'telegram', displayName: 'Customer DM' });
  assert.deepEqual(byId.get(grouped.id).reply, { channel: 'telegram', endpoint: '1001' });
  assert.deepEqual(byId.get(whole.id).target, { kind: 'group', sessionGroup: 'telegram', componentName: 'telegram', displayName: null });
  assert.deepEqual(byId.get(origin.id).target, { kind: 'origin' });
  assert.equal(byId.get(origin.id).reply, null);
  assert.deepEqual(byId.get(unknown.id).target, { kind: 'raw', text: 'lark:ops' });
  assert.ok(calls.length > 0);
  assert.equal(calls.filter(args => args.includes('namespace')).length, 0);

  const withoutTelegram = await f.reader({ getSnapshot: async () => ({ rows: [] }) }).read();
  assert.deepEqual(withoutTelegram.tasks.find(task => task.id === grouped.id).target, { kind: 'raw', text: 'telegram:dm-1001' });
  assert.deepEqual(withoutTelegram.tasks.find(task => task.id === whole.id).target, { kind: 'raw', text: 'telegram' });
  const failing = await f.reader({ getSnapshot: async () => { throw Error('snapshot failed'); } }).read();
  assert.deepEqual(failing.tasks.find(task => task.id === grouped.id).target, { kind: 'raw', text: 'telegram:dm-1001' });
});
