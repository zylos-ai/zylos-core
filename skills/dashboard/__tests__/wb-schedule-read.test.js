import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createScheduleRead, scheduleReadResponse, nextRuns, readTaskNames } from '../src/lib/workbench/schedule-read.js';
import { createScheduleTz, localToOffsetIso } from '../src/lib/workbench/schedule-tz.js';
import { createGroupSnapshot } from '../src/lib/workbench/group-snapshot.js';
import { createGroupsApi } from '../src/lib/workbench/groups-api.js';
import { migrateSchema } from '../../scheduler/scripts/migrations.js';
import { createCronIterator } from '../../scheduler/scripts/cron-utils.js';
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

// Reads go through the real route adapter, so the query is parsed exactly as for HTTP.
const list = (reader, query = {}) => scheduleReadResponse(reader, '/api/schedules', new URLSearchParams(query));
const runs = (reader, id, query = {}) => scheduleReadResponse(reader, `/api/schedules/${encodeURIComponent(id)}/history`, new URLSearchParams(query));
const SECTION = { pending: 0, running: 0, failed: 1, paused: 2, completed: 3 };

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
  const page = await list(f.reader(), { limit: '100' });
  assert.equal(page.available, true);
  assert.equal(page.tz, 'Asia/Singapore');
  assert.equal(page.items.length, 97);
  assert.equal(page.nextCursor, null);
  assert.deepEqual(page.counts, { all: 97, enabled: 26, paused: 8, failed: 22, completed: 41 });
  const active = page.items.filter(task => task.status !== 'completed');
  const counts = type => active.filter(task => task.type === type).length;
  assert.deepEqual([counts('recurring'), counts('interval'), counts('one-time')], [16, 2, 38]);
  const recent = rows.filter(row => row.executed_at >= NOW - 7 * DAY);
  const success = recent.filter(row => row.status === 'success').length;
  const bad = recent.filter(row => row.status === 'failed').length;
  assert.deepEqual(page.kpi, {
    enabled: 26, paused: 8, running: 5, next24h: 12 + 24 + 10, partialPreview: false,
    runs7d: recent.length, bad7d: bad, successRate7d: success / (success + bad),
  });
  assert.equal(bad, 3);
  const byId = new Map(page.items.map(task => [task.id, task]));
  const completed = (await f.reader().detail(ids.completed)).task;
  assert.equal(completed.status, 'completed');
  assert.equal(page.items.at(-1).status, 'completed');
  const failedRecurring = page.items.filter(task => task.type === 'recurring' && task.status === 'failed');
  assert.equal(failedRecurring.length, 2);
  assert.equal(failedRecurring.every(task => task.reenable === false), true);
  const history = byId.get(ids.recurring).recent;
  assert.equal(history.length, 12);
  assert.deepEqual(history.map(run => run.executedAt), Array.from({ length: 12 }, (_, i) => NOW - (12 - i) * DAY / 3));
  const failed = byId.get(ids.failedNoError);
  assert.equal(failed.recent.at(-1).error, null);
  assert.equal(failed.recent.at(-1).duration, 7000);
  assert.equal(failed.showLastError, true);
  assert.equal(failed.lastError, 'Missed execution window');
  assert.equal(failed.reenable, true);
  assert.equal(byId.get(ids.timedOut).showLastError, false);
  assert.equal(byId.get(ids.timedOut).lastError, null);
  assert.equal(byId.get(ids.recovered).showLastError, false);
  assert.equal(byId.get(ids.recovered).lastError, null);
  assert.equal(completed.showLastError, false);
  assert.equal(page.items.filter(task => task.showLastError).length, 1);
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
  assert.deepEqual(await scheduleReadResponse(empty, '/api/schedules', new URLSearchParams()), { available: false, items: [], nextCursor: null });
  fs.writeFileSync(missing.dbPath, 'not a database file');
  await assert.rejects(scheduleReadResponse(empty, '/api/schedules', new URLSearchParams()),
    error => error.statusCode === 503 && error.code === 'unavailable');
  await assert.rejects(scheduleReadResponse(empty, '/api/schedules/task-1/history', new URLSearchParams()),
    error => error.statusCode === 503 && error.code === 'unavailable');

  const f = fixture(t);
  const broken = f.task({ type: 'recurring', cron_expression: 'not a cron' });
  const good = f.task({ type: 'recurring', cron_expression: '0 8 * * *' });
  const interval = f.task({ type: 'interval', interval_seconds: HOUR, next_run_at: NOW + 60 });
  const page = await list(f.reader());
  const byId = new Map(page.items.map(task => [task.id, task]));
  assert.deepEqual(byId.get(broken.id).nextRuns, { unavailable: true, reason: 'cron_preview_unavailable' });
  assert.equal(byId.get(good.id).nextRuns.runs.length, 5);
  assert.equal(byId.get(interval.id).nextRuns.in24h.length, 24);
  assert.equal(page.kpi.partialPreview, true);
  assert.equal(page.kpi.next24h, 1 + 24);

  const absent = path.join(f.root, 'absent', 'cron-utils.js');
  const noCron = await list(f.reader({ cronModule: new URL(`file://${absent}`).href }));
  for (const task of noCron.items.filter(item => item.type === 'recurring')) {
    assert.deepEqual(task.nextRuns, { unavailable: true, reason: 'cron_preview_unavailable' });
  }
  assert.equal(noCron.items.find(item => item.id === interval.id).nextRuns.runs.length, 5);
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
  const page = await list(mismatch);
  assert.equal(page.tz, null);
  assert.equal(Object.hasOwn(page, 'tzReason'), false);
  assert.equal(page.daily7d.tz, 'UTC');
  assert.equal(page.daily7d.utcFallback, true);
  assert.deepEqual(page.daily7d.days.find(day => day.date === '2027-01-14'), { date: '2027-01-14', success: 1, timeout: 0, failed: 0 });
  assert.deepEqual(await mismatch.preview({ kind: 'at', value: '2027-02-01T09:30' }), { valid: false, error: 'tz_unavailable' });

  // Without ZYLOS_DIR the scheduler reads <home>/zylos; it must be this installation.
  const elsewhere = path.join(f.root, 'elsewhere-home');
  fs.mkdirSync(path.join(elsewhere, 'zylos'), { recursive: true });
  assert.deepEqual(await createScheduleTz({ zylosDir: f.zylosDir, env: {}, home: elsewhere,
    tzModule: `${TZ_URL}?case=${++importCase}` })(), { tz: null, reason: 'tz_unavailable' });
  assert.deepEqual(await createScheduleTz({ zylosDir: f.zylosDir, env: {}, home: f.home,
    tzModule: `${TZ_URL}?case=${++importCase}` })(), { tz: 'Asia/Singapore' });

  fs.writeFileSync(path.join(f.zylosDir, '.env'), 'TZ=Not/AZone\n');
  const invalid = await list(f.reader());
  assert.equal(invalid.tz, null);
  assert.equal(invalid.daily7d.utcFallback, true);
});

test('local form times convert with the offset in effect at that moment', () => {
  // US daylight saving starts at 02:00 on 2027-03-14.
  assert.deepEqual(localToOffsetIso('2027-03-14T05:00', 'America/New_York'),
    { iso: '2027-03-14T05:00:00-04:00', epoch: Date.parse('2027-03-14T09:00:00Z') / 1000 });
  assert.deepEqual(localToOffsetIso('2027-03-14T01:30', 'America/New_York'),
    { iso: '2027-03-14T01:30:00-05:00', epoch: Date.parse('2027-03-14T06:30:00Z') / 1000 });
  assert.deepEqual(localToOffsetIso('2027-11-07T12:00', 'America/New_York'),
    { iso: '2027-11-07T12:00:00-05:00', epoch: Date.parse('2027-11-07T17:00:00Z') / 1000 });
  assert.equal(localToOffsetIso('2027-03-14 05:00', 'America/New_York'), null);
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

test('execution history pages with a signed cursor by time and id without repeats or gaps', async t => {
  const f = fixture(t);
  const task = f.task({});
  const other = f.task({});
  const ids = [];
  for (let i = 0; i < 120; i++) ids.push(f.run(task.id, { executed_at: NOW - DAY + Math.floor(i / 2) * 60, status: 'success' }));
  f.run(other.id, { executed_at: NOW - HOUR, status: 'success' });
  const reader = f.reader();
  const first = await runs(reader, task.id);
  assert.deepEqual(Object.keys(first).sort(), ['items', 'nextCursor']);
  const second = await runs(reader, task.id, { cursor: first.nextCursor });
  // A run recorded between page reads must not shift the next page.
  const late = f.run(task.id, { executed_at: NOW, status: 'started' });
  const third = await runs(reader, task.id, { cursor: second.nextCursor });
  assert.deepEqual([first.items.length, second.items.length, third.items.length], [50, 50, 20]);
  assert.equal(third.nextCursor, null);
  const seen = [...first.items, ...second.items, ...third.items].map(row => row.id);
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual([...seen].sort((a, b) => a - b), ids.map(Number));
  assert.equal(seen.includes(Number(late)), false);
  // executed_at DESC, id DESC: equal start times are ordered by id, also across the page boundary.
  const all = [...first.items, ...second.items, ...third.items];
  assert.ok(all.every((row, index) => index === 0 || row.executedAt < all[index - 1].executedAt ||
    (row.executedAt === all[index - 1].executedAt && row.id < all[index - 1].id)));
  assert.equal((await runs(reader, task.id, { limit: '100' })).items.length, 100);
  for (const [query, param] of [[{ limit: '0' }, 'limit'], [{ limit: '101' }, 'limit'], [{ limit: '2.5' }, 'limit'],
    [{ before: String(NOW), beforeId: '3' }, 'before'], [new URLSearchParams('limit=5&limit=6'), 'limit']]) {
    await assert.rejects(runs(reader, task.id, query), error => error.statusCode === 400 && error.code === 'invalid_parameter' && error.param === param);
  }
  // A cursor belongs to one task's history.
  for (const cursor of ['bad', first.nextCursor.replace(/.$/, c => c === 'A' ? 'B' : 'A')]) {
    await assert.rejects(runs(reader, task.id, { cursor }), error => error.statusCode === 400 && error.code === 'invalid_cursor');
  }
  await assert.rejects(runs(reader, other.id, { cursor: first.nextCursor }), error => error.code === 'invalid_cursor');
  await assert.rejects(runs(reader, 'absent-task'), error => error.statusCode === 404 && error.code === 'not_found');
});

test('target groups follow the dispatch rule using the group snapshot without namespace lookups', async t => {
  const f = fixture(t);
  const grouped = f.task({ session_component: 'telegram', session_group_name: 'dm-1001', reply_channel: 'telegram', reply_endpoint: '1001' });
  const whole = f.task({ reply_channel: 'telegram', reply_endpoint: '1001' });
  const origin = f.task({});
  const unknown = f.task({ session_component: 'lark', session_group_name: 'ops' });
  const calls = [];
  const sessionObservations = {
    reader: { readAccountUsage: async () => null },
    get: async () => ({ mode: 'multi', group: 'origin', observations: new Map() }),
    peek: () => null,
  };
  const snapshot = createGroupSnapshot({ zylosDir: f.zylosDir, now: () => NOW_MS, sessionObservations,
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
      return { collectStatus: async () => ({ view: 'multi', origin: { presence: 'not_running' }, groups: [], groupListError: null, runtimeHealth: {} }) };
    },
  });
  const names = new Map([['telegram:dm-1001', { displayName: 'Customer DM' }]]);
  const page = await list(f.reader({ getSnapshot: () => snapshot.getSnapshot(), displayNames: { listAll: () => names } }));
  const byId = new Map(page.items.map(task => [task.id, task]));
  assert.deepEqual(byId.get(grouped.id).target, { kind: 'group', sessionGroup: 'telegram:dm-1001', componentName: 'telegram', displayName: 'Customer DM' });
  assert.deepEqual(byId.get(grouped.id).reply, { channel: 'telegram', endpoint: '1001' });
  assert.deepEqual(byId.get(whole.id).target, { kind: 'group', sessionGroup: 'telegram', componentName: 'telegram', displayName: null });
  assert.deepEqual(byId.get(origin.id).target, { kind: 'origin' });
  assert.equal(byId.get(origin.id).reply, null);
  assert.deepEqual(byId.get(unknown.id).target, { kind: 'raw', text: 'lark:ops' });
  assert.ok(calls.length > 0);
  assert.equal(calls.filter(args => args.includes('namespace')).length, 0);

  const withoutTelegram = await list(f.reader({ getSnapshot: async () => ({ rows: [] }) }));
  assert.deepEqual(withoutTelegram.items.find(task => task.id === grouped.id).target, { kind: 'raw', text: 'telegram:dm-1001' });
  assert.deepEqual(withoutTelegram.items.find(task => task.id === whole.id).target, { kind: 'raw', text: 'telegram' });
  const failing = await list(f.reader({ getSnapshot: async () => { throw Error('snapshot failed'); } }));
  assert.deepEqual(failing.items.find(task => task.id === grouped.id).target, { kind: 'raw', text: 'telegram:dm-1001' });
});

test('the target filter selects exactly the tasks whose delivery target is that group, before paging', async t => {
  const f = fixture(t);
  // Namespaces differ from component names, and only the first row of a component decides its namespace.
  const rows = [
    { sessionGroup: 'tg:dm-5', c4: { componentName: 'telegram' } }, { sessionGroup: 'other:dm-6', c4: { componentName: 'telegram' } },
    { sessionGroup: 'lk', c4: { componentName: 'lark' } }, { sessionGroup: 'tg:ops', c4: { componentName: 'tgbot' } },
  ];
  let failSnapshot = false;
  const getSnapshot = async () => { if (failSnapshot) throw Error('snapshot failed'); return { rows }; };
  const variants = [
    { session_component: 'telegram', session_group_name: 'dm-1' }, { session_component: 'telegram', session_group_name: 'dm-2' },
    { session_component: 'telegram' }, { reply_channel: 'telegram', reply_endpoint: '1' }, { reply_channel: 'lark' },
    { session_component: 'lark', session_group_name: 'ops' }, {}, { session_component: 'mystery', session_group_name: 'a' },
    { session_component: 'telegram', session_group_name: 'dm-1', reply_channel: 'lark' }, { session_component: 'tgbot', reply_channel: 'telegram' },
  ];
  for (let i = 0; i < 180; i++) {
    f.task({ ...variants[i % variants.length], status: ['pending', 'failed', 'paused', 'completed'][i % 4], updated_at: NOW - i });
  }
  // Group X: twenty tasks that sort after the third page of the whole list.
  const x = Array.from({ length: 20 }, (_, i) => f.task({ session_component: 'telegram', session_group_name: 'dm-x', status: 'completed',
    updated_at: NOW - 10000 - i }).id);
  const reader = f.reader({ getSnapshot });
  const walk = async query => {
    const items = [];
    let cursor = null;
    do {
      const page = await list(reader, { ...query, ...(cursor ? { cursor } : {}) });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  };
  const all = await walk({});
  assert.equal(all.length, 200);
  assert.ok(x.every(id => all.findIndex(task => task.id === id) >= 150));
  // The rows' own resolved targets, from deliveryTarget, are the reference for every filter.
  const resolved = task => task.target.kind === 'origin' ? 'origin' : task.target.kind === 'group' ? task.target.sessionGroup : null;
  const targets = ['origin', 'tg', 'tg:dm-1', 'tg:dm-2', 'tg:dm-x', 'lk', 'lk:ops', 'tg:ops', 'other', 'other:dm-6', 'mystery:a', 'absent'];
  assert.ok(new Set(all.map(resolved)).size >= 7);
  for (const target of targets) {
    const expected = all.filter(task => resolved(task) === target).map(task => task.id);
    assert.deepEqual((await walk({ target, limit: '7' })).map(task => task.id), expected, target);
    assert.equal((await list(reader, { target, include: 'total' })).total, expected.length, target);
  }
  // S6: selecting group X shows only its tasks from the first page on.
  const first = await list(reader, { target: 'tg:dm-x', limit: '8' });
  assert.deepEqual(first.items.map(task => task.id), x.slice(0, 8));
  assert.deepEqual((await walk({ target: 'tg:dm-x', limit: '8' })).map(task => task.id), x);
  assert.deepEqual((await list(reader, { target: 'tg:dm-x', status: 'completed', q: 'Task' })).items.length, 20);
  assert.equal((await list(reader, { target: 'tg:dm-x', status: 'enabled' })).items.length, 0);
  await assert.rejects(list(reader, { target: 'tg:dm-1', limit: '8', cursor: first.nextCursor }), error => error.code === 'invalid_cursor');
  await assert.rejects(list(reader, { target: '' }), error => error.code === 'invalid_parameter' && error.param === 'target');
  failSnapshot = true;
  await assert.rejects(list(reader, { target: 'tg' }), error => error.statusCode === 503 && error.code === 'unavailable');
  assert.equal((await list(reader, { target: 'origin', include: 'total' })).total, all.filter(task => resolved(task) === 'origin').length);
});

// Real scheduler SQLite -> snapshot -> group search/detail boundary. Run for
// task-name, catalog or group projection changes; skip rendering-only edits.
// The isolated schedule fixture above owns HOME/ZYLOS_DIR/PM2_HOME/TMPDIR,
// database and its bounded schema CLI child; no live PM2/tmux/network is used.
test('a group whose last message came from the scheduler is labelled with the task name; the id stays out of the label', async t => {
  const f = fixture(t);
  const named = f.task({ name: 'watch-dispatched-cards' });
  const blank = f.task({ name: '  ' });
  assert.deepEqual(readTaskNames(f.zylosDir, [named.id, blank.id, 'task-gone', named.id]), new Map([[named.id, 'watch-dispatched-cards']]));
  assert.deepEqual(readTaskNames(path.join(f.root, 'elsewhere'), [named.id]), new Map(), 'no scheduler database: no names');
  const preview = (taskId, message) => ({ timestamp: NOW_MS, channel: 'scheduler', endpoint: null, message,
    text: `[Scheduled Task: ${taskId} #4] ${message}`, messageSource: { kind: 'scheduled_task', taskId } });
  // Search includes older catalog entries even when they have no running session.
  const older = { sessionGroup: 'scheduler:old', componentName: 'scheduler', lastActivityAt: NOW_MS - 30 * 86400000, preview: preview(named.id, 'older run') };
  const groups = [
    older,
    { sessionGroup: 'scheduler:a', componentName: 'scheduler', lastActivityAt: NOW_MS, preview: preview(named.id, 'check the new cards') },
    { sessionGroup: 'scheduler:b', componentName: 'scheduler', lastActivityAt: NOW_MS, preview: preview('task-gone', 'nightly digest') },
    { sessionGroup: 'lark:oc_1', componentName: 'lark', lastActivityAt: NOW_MS, preview: { timestamp: NOW_MS, channel: 'lark', endpoint: 'oc_1',
      message: 'Review ready', text: '[Review bot] Review ready for 01a1c33d-7d4e-7a1b-9c2d-0123456789ab', messageSource: { kind: 'header' } } },
  ];
  const sessionObservations = {
    reader: { readAccountUsage: async () => null },
    get: async () => ({ mode: 'multi', group: 'origin', observations: new Map() }),
    peek: () => null,
  };
  const snapshot = createGroupSnapshot({ zylosDir: f.zylosDir, now: () => NOW_MS, sessionObservations,
    store: { latestEventByType: () => null, queryEvents: () => [] },
    cli: {
      runC4Db: async args => ({ ok: true, readAt: NOW_MS, data:
        args[0] === 'groups' ? { groups, hasOlder: false } : { groups: [], globalFence: null } }),
      readOverrides: async () => ({ ok: true, readAt: NOW_MS, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }),
    },
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode: 'multi' }) };
      return { collectStatus: async () => ({ view: 'multi', origin: { presence: 'not_running' }, groups: [], groupListError: null, runtimeHealth: {} }) };
    },
  });
  const rows = new Map((await snapshot.getSnapshot()).rows.map(row => [row.sessionGroup, row.preview]));
  assert.equal(rows.get('scheduler:a').text, 'watch-dispatched-cards');
  assert.deepEqual(rows.get('scheduler:a').source, { kind: 'scheduled_task' });
  assert.equal(rows.get('scheduler:b').text, 'nightly digest', 'a task the scheduler no longer has keeps the prompt line');
  assert.deepEqual(rows.get('scheduler:b').source, { kind: 'scheduled_task' });
  assert.equal(rows.get('lark:oc_1').text, 'Review ready');
  assert.deepEqual(rows.get('lark:oc_1').source, { kind: 'channel' });
  const api = createGroupsApi({ workbench: snapshot });
  const found = (await api.list(new URLSearchParams('q=scheduler:old'))).items.find(row => row.id === 'scheduler:old');
  assert.equal(Object.hasOwn(found, 'state'), false, 'search finds an older group without a running session');
  assert.deepEqual(Object.keys(found).sort(), ['channel', 'displayName', 'flags', 'id', 'lastActivityAt', 'modelOverridden', 'runtimeOverridden']);
  const detail = await api.detail(found.id);
  assert.equal(detail.preview.text, 'watch-dispatched-cards', 'detail names the task for the older group');
  assert.deepEqual(detail.preview.source, { kind: 'scheduled_task' });
  assert.equal(JSON.stringify(found).includes(named.id), false, 'search does not expose the scheduler task id');
  for (const key of ['scheduler:a', 'scheduler:b', 'scheduler:old', 'lark:oc_1']) {
    const value = rows.get(key);
    assert.equal(Object.hasOwn(value, 'messageSource'), false);
    assert.equal(Object.hasOwn(value.source, 'taskId'), false);
    assert.equal(Object.hasOwn(value, 'raw'), false, 'the stored message is read per group, not polled');
  }
});

test('upcoming cron runs parse once and stop after five runs and the full day', () => {
  for (const [expression, expected] of [['0 8 * * *', 5], ['0 * * * *', 25], ['* * * * *', 1441]]) {
    let parsed = 0, advanced = 0;
    const cron = { createCronIterator(...args) {
      parsed++;
      const interval = createCronIterator(...args);
      return { next() { advanced++; return interval.next(); } };
    } };
    const runs = nextRuns({ status: 'pending', type: 'recurring', cron_expression: expression }, 5, NOW, 'UTC', cron, { until: NOW + DAY });
    assert.equal(parsed, 1);
    assert.equal(advanced, expression === '* * * * *' ? 1 : expected);
    assert.equal(runs.length, expected);
    assert.ok(runs.at(-1) > NOW + DAY);
    assert.equal(runs.truncated, undefined);
    if (expression === '* * * * *') assert.equal(runs.filter(at => at <= NOW + DAY).length, 1440);
  }
  const capped = nextRuns({ status: 'pending', type: 'recurring', cron_expression: '* * * * * *' }, 5, NOW, 'UTC', { createCronIterator }, { until: NOW + DAY });
  assert.equal(capped.length, 2000);
  assert.equal(capped.truncated, true);
  const interval = nextRuns({ status: 'pending', type: 'interval', interval_seconds: 60, next_run_at: NOW - DAY * 100 },
    5, NOW, 'UTC', null, { until: NOW + DAY });
  assert.equal(interval[0], NOW + 60);
  assert.equal(interval.length, 1441);
  assert.equal(interval.filter(at => at <= NOW + DAY).length, 1440);
  const daily = nextRuns({ status: 'pending', type: 'interval', interval_seconds: DAY, next_run_at: NOW + DAY },
    5, NOW, 'UTC', null, { until: NOW + DAY });
  assert.equal(daily.length, 5);
});

test('every status pages in section order with signed cursors while counts, timeline and week totals stay global', async t => {
  const f = fixture(t);
  f.task({ type: 'recurring', cron_expression: '* * * * *', next_run_at: NOW + 60 });
  f.task({ type: 'recurring', cron_expression: '0 8 * * *', next_run_at: NOW + 60 });
  // 60 active tasks with tied next-run and update times, so ids break the ties inside each section.
  for (let i = 0; i < 58; i++) {
    const status = ['pending', 'running', 'failed', 'paused'][i % 4];
    f.task({ status, next_run_at: NOW + 600 * (Math.floor(i / 8) + 1), updated_at: NOW - Math.floor(i / 6) });
  }
  const completed = [];
  for (let i = 0; i < 120; i++) {
    const task = f.task({ status: 'completed', updated_at: NOW - Math.floor(i / 2), name: `Done ${i} HiddenNeedle%_ ÄWord`,
      prompt: '😀'.repeat(250) + ' BodyOnlyWord' });
    completed.push(task);
    f.run(task.id, { executed_at: NOW - HOUR, completed_at: NOW - HOUR + 1, status: i % 2 ? 'success' : 'failed' });
  }
  const rows = f.db.prepare('SELECT id, status, next_run_at, updated_at FROM tasks').all();
  const key = row => SECTION[row.status] === 0 ? row.next_run_at : -row.updated_at;
  const expected = rows.sort((a, b) => SECTION[a.status] - SECTION[b.status] || key(a) - key(b) || (a.id < b.id ? -1 : 1));
  const reader = f.reader();
  const walk = async (query = {}) => {
    const pages = [];
    let cursor = null;
    do {
      const page = await list(reader, { ...query, ...(cursor ? { cursor } : {}) });
      pages.push(page);
      cursor = page.nextCursor;
      assert.ok(pages.length <= 10);
    } while (cursor);
    return pages;
  };
  const pages = await walk({ include: 'total' });
  assert.deepEqual(pages.map(page => page.items.length), [50, 50, 50, 30]);
  assert.equal(pages[0].total, 180);
  const seen = pages.flatMap(page => page.items.map(task => task.id));
  assert.deepEqual(seen, expected.map(row => row.id));
  const first = pages[0];
  for (const page of pages) {
    assert.deepEqual(page.counts, { all: 180, enabled: 32, paused: 14, failed: 14, completed: 120 });
    assert.deepEqual(page.kpi, first.kpi);
    assert.deepEqual(page.daily7d, first.daily7d);
    assert.deepEqual(page.timelineTasks, first.timelineTasks);
  }
  assert.equal(first.kpi.runs7d, 120);
  assert.equal(first.kpi.enabled, 32);
  // The lane covers every enabled task with a run in the next 24 hours, with only the fields it draws.
  assert.equal(first.timelineTasks.length, 32);
  assert.deepEqual(Object.keys(first.timelineTasks[0]).sort(), ['id', 'name', 'nextRuns', 'priority']);
  assert.equal(first.timelineTasks.find(task => task.nextRuns.in24h.length === 1440)?.nextRuns.in24h[0], NOW + 60);
  const last = pages.at(-1).items.at(-1);
  assert.equal(Array.from(last.promptSummary).length, 200);
  assert.equal(last.promptTruncated, true);
  assert.equal(Object.hasOwn(last, 'prompt'), false);
  // Recent results are read only for the rows of each page.
  assert.ok(pages[0].items.every(task => task.status === 'completed' || task.recent.length === 0));
  assert.equal(pages.at(-1).items.every(task => task.recent.length === 1), true);

  // A row added before the cursor does not shift the following pages.
  const enabledFirst = await list(reader, { status: 'enabled', limit: '20' });
  const early = f.task({ next_run_at: NOW + 1 });
  const enabledRest = await walk({ status: 'enabled', limit: '20', cursor: enabledFirst.nextCursor });
  const enabledSeen = [...enabledFirst.items, ...enabledRest.flatMap(page => page.items)].map(task => task.id);
  assert.deepEqual(enabledSeen, expected.filter(row => SECTION[row.status] === 0).map(row => row.id));
  assert.equal(enabledSeen.includes(early.id), false);
  assert.equal((await list(reader, { status: 'enabled' })).items[0].id, early.id);
  for (const status of ['paused', 'failed']) {
    assert.deepEqual((await list(reader, { status })).items.map(task => task.id), expected.filter(row => row.status === status).map(row => row.id));
  }
  const done = await walk({ status: 'completed' });
  assert.deepEqual(done.map(page => page.items.length), [50, 50, 20]);
  assert.deepEqual(done.flatMap(page => page.items.map(task => task.id)), expected.filter(row => row.status === 'completed').map(row => row.id));

  // q matches the name only, case-insensitively and with literal %, _ and Unicode.
  assert.equal((await list(reader, { q: 'BodyOnlyWord' })).items.length, 0);
  assert.equal((await list(reader, { q: 'hiddenneedle%_', include: 'total' })).total, 120);
  assert.equal((await list(reader, { q: '  äword  ', limit: '7' })).items.length, 7);
  assert.equal((await list(reader, { q: 'Done 11 ' })).items[0].id, completed[11].id);
  assert.equal((await list(reader, { q: '' })).items.length, 50);
  // A cursor is bound to its filters and q.
  const searched = await list(reader, { q: 'needle', limit: '3' });
  await assert.rejects(list(reader, { q: 'needl', limit: '3', cursor: searched.nextCursor }), error => error.code === 'invalid_cursor');
  await assert.rejects(list(reader, { status: 'completed', cursor: pages[0].nextCursor }), error => error.code === 'invalid_cursor');
  for (const [query, param] of [[{ status: 'unknown' }, 'status'], [{ limit: '101' }, 'limit'], [{ limit: '0' }, 'limit'],
    [{ q: 'x'.repeat(65) }, 'q'], [{ include: 'count' }, 'include'], [{ sort: 'name' }, 'sort'],
    [new URLSearchParams('status=paused&status=failed'), 'status']]) {
    await assert.rejects(list(reader, query), error => error.statusCode === 400 && error.code === 'invalid_parameter' && error.param === param);
  }
  for (const cursor of ['bad', Buffer.from(JSON.stringify(['wrong', 2])).toString('base64url')]) {
    await assert.rejects(list(reader, { cursor }), error => error.statusCode === 400 && error.code === 'invalid_cursor');
  }
  const detail = await scheduleReadResponse(reader, `/api/schedules/${completed[0].id}`, new URLSearchParams());
  assert.equal(detail.task.prompt, completed[0].prompt);
  assert.equal(detail.task.promptTruncated, false);
  await assert.rejects(reader.detail('absent'), error => error.statusCode === 404 && error.code === 'task_not_found');
});

test('capped high frequency previews are explicitly partial without hiding healthy tasks', async t => {
  const f = fixture(t);
  const capped = f.task({ type: 'recurring', cron_expression: '* * * * * *' });
  const good = f.task({ type: 'recurring', cron_expression: '0 8 * * *' });
  const page = await list(f.reader());
  assert.equal(page.items.find(task => task.id === capped.id).nextRuns.truncated, true);
  assert.equal(page.items.find(task => task.id === capped.id).nextRuns.in24h.length, 2000);
  assert.equal(page.items.find(task => task.id === good.id).nextRuns.runs.length, 5);
  assert.equal(page.kpi.partialPreview, true);
  assert.equal(page.kpi.next24h, 2001);
});


test('arithmetic minute boundaries match the real parser through daylight saving transitions', () => {
  for (const from of ['2027-03-14T06:58:37Z', '2027-11-07T05:58:37Z']) {
    const start = Date.parse(from) / 1000;
    const iterator = createCronIterator('* * * * *', 'America/New_York', new Date(start * 1000));
    const actual = nextRuns({ status: 'pending', type: 'recurring', cron_expression: '* * * * *' }, 5,
      start, 'America/New_York', { createCronIterator }, { until: start + DAY });
    assert.equal(actual.length, 1441);
    for (const run of actual) assert.equal(run, iterator.next());
  }
});


// Integration boundaries/isolation are the same as the read cases above; these
// add old-schema and cross-page search/ordering coverage for read model edits.
test('summary reads work with the original scheduler schema without session columns', async t => {
  const f = scheduleEnv(t, { link: false });
  const db = f.open();
  migrateSchema(db);
  assert.equal(db.pragma('table_info(tasks)').some(column => column.name === 'session_component'), false);
  db.prepare(`INSERT INTO tasks (id, name, prompt, type, next_run_at, created_at, updated_at)
    VALUES ('old-task', 'Original schema', ?, 'one-time', ?, ?, ?)`).run('😀'.repeat(230), NOW + 60, NOW, NOW);
  const reader = createScheduleRead({ zylosDir: f.zylosDir, now: () => NOW_MS, scheduleTz: async () => ({ tz: 'UTC' }) });
  const page = await list(reader);
  assert.equal(page.available, true);
  assert.equal(page.kpi.enabled, 1);
  assert.equal(page.items[0].promptSummary, '😀'.repeat(200));
  assert.equal(page.items[0].promptTruncated, true);
  assert.equal(Object.hasOwn(page.items[0], 'prompt'), false);
  assert.deepEqual(page.timelineTasks.map(task => task.id), ['old-task']);
  assert.deepEqual(page.items[0].target, { kind: 'origin' });
  assert.equal((await reader.detail('old-task')).task.prompt, '😀'.repeat(230));
  assert.deepEqual((await list(reader, { target: 'origin' })).items.map(task => task.id), ['old-task']);
  assert.equal((await list(reader, { target: 'telegram' })).items.length, 0);
});

test('minute rules match real zoned cron runs and only eligible rules use arithmetic', () => {
  const cases = [
    ['*/1 * * * *', 'UTC', '2027-01-15T00:00:37Z'],
    ['*/2 * * * *', 'UTC', '2027-01-15T00:00:37Z'],
    ['*/5 * * * *', 'UTC', '2027-01-15T00:00:37Z'],
    ['0-59 * * * *', 'UTC', '2027-01-15T00:00:37Z'],
    ['*/7 * * * *', 'America/New_York', '2027-11-07T05:58:37Z'],
    ['*/7 * * * *', 'Australia/Lord_Howe', '2027-10-02T15:28:37Z'],
    ['*/5 1 * * *', 'UTC', '2027-01-15T00:00:37Z', false],
    ['0-59/2 * * * *', 'UTC', '2027-01-15T00:00:37Z', false],
    ['*/7 * * * *', 'Asia/Kolkata', '2027-01-15T00:00:37Z'],
  ];
  for (const [expression, tz, from, arithmetic = true] of cases) {
    const start = Date.parse(from) / 1000;
    let parsed = 0, advanced = 0;
    const cron = { createCronIterator(...args) {
      parsed++;
      const interval = createCronIterator(...args);
      return { next() { advanced++; return interval.next(); } };
    } };
    const actual = nextRuns({ status: 'pending', type: 'recurring', cron_expression: expression }, 5,
      start, tz, cron, { until: start + DAY });
    assert.equal(parsed, 1);
    assert.equal(advanced, arithmetic ? 1 : actual.length);
    if (expression === '0-59/2 * * * *') assert.equal(actual.length, 721);
    assert.ok(actual.length >= 5);
    assert.ok(actual.at(-1) > start + DAY);
    const reference = createCronIterator(expression, tz, new Date(start * 1000));
    for (const run of actual) assert.equal(run, reference.next(), `${expression} ${tz}`);
  }
});


test('legacy timeouts stay in history but do not become delivery failures or lower delivery rate', async t => {
  const f = fixture(t);
  const legacy = f.task({ type: 'interval', interval_seconds: 1800, last_error: 'Task timed out' });
  f.run(legacy.id, { executed_at: NOW - 100, status: 'timeout', error: 'TASK_TIMEOUT', completed_at: NOW - 50 });
  const reader = f.reader();
  const onlyTimeouts = await list(reader);
  assert.equal(onlyTimeouts.kpi.bad7d, 0);
  assert.equal(onlyTimeouts.kpi.successRate7d, null);
  assert.equal(onlyTimeouts.daily7d.days.at(-1).timeout, 1);
  assert.equal(onlyTimeouts.items[0].showLastError, false);
  assert.equal(onlyTimeouts.items[0].lastError, null);
  const legacyRuns = await runs(reader, legacy.id);
  assert.equal(legacyRuns.items[0].status, 'timeout');
  assert.equal(legacyRuns.items[0].error, 'TASK_TIMEOUT');
  const delivered = f.task({ status: 'completed' });
  f.run(delivered.id, { executed_at: NOW - 90, status: 'success', completed_at: NOW - 89 });
  const rejected = f.task({ last_error: 'RECEIVE_FAILED' });
  f.run(rejected.id, { executed_at: NOW - 80, status: 'failed', completed_at: NOW - 79, error: 'RECEIVE_FAILED' });
  const uncertain = f.task({ status: 'running', last_error: 'RECEIVE_RESULT_UNKNOWN' });
  f.run(uncertain.id, { executed_at: NOW - 70, status: 'started', error: 'RECEIVE_RESULT_UNKNOWN' });
  const mixed = await list(reader);
  assert.equal(mixed.kpi.bad7d, 1);
  assert.equal(mixed.kpi.successRate7d, 0.5);
  assert.equal(mixed.kpi.running, 1);
  assert.equal(mixed.items.find(task => task.id === rejected.id).showLastError, true);
  assert.equal(mixed.items.find(task => task.id === uncertain.id).showLastError, false);
});
