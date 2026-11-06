import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { Store } from '../src/lib/store.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { createRuns } from '../src/lib/workbench/runs.js';
import { createGroupBacklog } from '../src/lib/workbench/group-backlog.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-runs-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  const cleanup = [];
  t.after(() => { for (const close of cleanup.reverse()) close(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let seq = 0;
  const event = (runId, day, eventType, metadata = {}, runtime = 'claude', group = 'telegram:a') => {
    const id = `event-${++seq}`;
    const result = store.insertEvent({
      id, ingest_id: id, timestamp: `2026-10-${String(day).padStart(2, '0')}T12:00:00.000Z`,
      runtime, run_id: runId, session_group: group, event_type: eventType, category: 'lifecycle', metadata,
    });
    assert.equal(result.inserted, true, 'the fixture event must be stored');
    return result;
  };
  return { root, store, event, addCleanup: close => cleanup.push(close) };
}

// Integration boundary: imported-event SQLite aggregation and real Store only.
// Run for run grouping/pagination/end reasons; skip rendering-only edits. The
// official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; private DB only,
// no tmux/network/children. Teardown closes Store before removing owned files.
test('run pages keep whole-group totals and unattributed events while using start boundaries', async t => {
  const f = fixture(t);
  for (let day = 1; day <= 5; day++) f.event(`run-${day}`, day, 'session_start');
  f.event('run-1', 2, 'reclaim_done', { reason: 'ttl' });
  f.event('run-2', 3, 'rotate_done', {}, 'codex');
  f.event('run-3', 4, 'crash_detected');
  f.event('run-4', 5, 'post_tool_use');
  f.event('run-5', 6, 'rotate_done', { oldSessionId: 'previous-session' });
  for (let i = 0; i < 10; i++) f.event(null, 1, 'stop');
  f.event('elsewhere', 10, 'session_start', {}, 'claude', 'telegram:b');
  const runs = createRuns({ store: f.store,
    getSnapshot: async () => ({ rows: [{ sessionGroup: 'telegram:a', live: { runId: 'run-5' } }] }) });
  const first = await runs('telegram:a');
  assert.deepEqual(first.runs.map(row => [row.runId, row.endReason, row.n]),
    [['run-5', 'running', 2], ['run-4', 'unknown', 2], ['run-3', 'crash', 2]]);
  assert.deepEqual([first.totalRuns, first.totalEvents, first.unattributed], [5, 10, 10]);
  const second = await runs('telegram:a', { before: first.runs[2].startAt });
  assert.deepEqual(second.runs.map(row => [row.runId, row.endReason]), [['run-2', 'rotate'], ['run-1', 'ttl']]);
  assert.deepEqual([second.totalRuns, second.totalEvents, second.unattributed], [5, 10, 10]);
  assert.deepEqual((await runs('telegram:older')).runs, []);
});

test('session rotation never hides a preceding run-ending event and the latest actual ending wins', async t => {
  const f = fixture(t);
  f.event('ended', 1, 'session_start');
  f.event('ended', 2, 'reclaim_done', { reason: 'evict' });
  f.event('ended', 3, 'rotate_done', { oldSessionId: 'old' });
  const runs = createRuns({ store: f.store });
  assert.equal((await runs('telegram:a')).runs[0].endReason, 'evict');
  f.event('ended', 4, 'crash_detected');
  assert.equal((await runs('telegram:a')).runs[0].endReason, 'crash');
  await assert.rejects(runs('telegram:a', { before: 'not-a-time' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(runs('telegram:a', { limit: 0 }), { code: 'INVALID_ARGUMENT' });
});

// Integration boundary: single-mode NULL attribution in the same real event
// store as group runs. Run when single/group routing changes; UI-only edits can
// skip. The official runner and fixture own all paths; no live processes/DBs.
test('single view reads only ungrouped runs while multi Origin keeps its own history', async t => {
  const f = fixture(t);
  f.event('single-old', 1, 'session_start', {}, 'claude', null);
  f.event('single-old', 2, 'reclaim_done', { reason: 'ttl' }, 'claude', null);
  f.event('single-current', 3, 'session_start', {}, 'claude', null);
  f.event(null, 1, 'stop', {}, 'claude', null);
  f.event('origin-current', 4, 'session_start', {}, 'claude', 'origin');
  f.event('another-group', 5, 'session_start');
  let snapshot = { view: 'single', rows: [{ sessionGroup: null, live: { runId: 'single-current' } }] };
  const runs = createRuns({ store: f.store, getSnapshot: async () => snapshot });
  const first = await runs('origin', { limit: 1 });
  assert.deepEqual(first.runs.map(row => [row.runId, row.endReason]), [['single-current', 'running']]);
  assert.deepEqual([first.totalRuns, first.totalEvents, first.unattributed], [2, 3, 1]);
  const second = await runs('origin', { before: first.runs[0].startAt, limit: 1 });
  assert.deepEqual(second.runs.map(row => [row.runId, row.endReason]), [['single-old', 'ttl']]);
  assert.deepEqual([second.totalRuns, second.totalEvents, second.unattributed], [2, 3, 1]);
  snapshot = { view: 'multi', rows: [{ sessionGroup: 'origin', live: { runId: 'origin-current' } }] };
  const origin = await runs('origin');
  assert.deepEqual(origin.runs.map(row => [row.runId, row.endReason]), [['origin-current', 'running']]);
  assert.deepEqual([origin.totalRuns, origin.totalEvents, origin.unattributed], [1, 1, 0]);
});

// Integration boundary: a real read-only C4Reader over a private SQLite DB. Run
// for message projection/range queries; skip UI-only changes. The official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR; no subprocess/tmux/network. Close
// reader and fixture writer before removing the owned root.
test('group messages expose direction and time without content or internal traffic', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'comm-bridge'));
  const db = new Database(path.join(f.root, 'comm-bridge/c4.db'));
  db.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT, direction TEXT, channel TEXT, timestamp TEXT, content TEXT)');
  const put = db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)');
  put.run(1, 'telegram:a', 'in', 'telegram', '2026-10-01 12:00:00', 'private original body');
  put.run(2, 'telegram:a', 'out', 'telegram', '2026-10-02 12:00:00', 'private response body');
  put.run(3, 'telegram:a', 'in', 'internal', '2026-10-02 12:00:00', 'private internal');
  put.run(4, 'telegram:b', 'in', 'telegram', '2026-10-02 12:00:00', 'private other group');
  const reader = new C4Reader(f.root);
  f.addCleanup(() => { reader.close(); db.close(); });
  const rows = reader.getGroupMessages('telegram:a', { since: '2026-10-01T00:00:00Z', until: '2026-10-03T00:00:00Z' });
  assert.deepEqual(rows.map(row => row.id), [1, 2]);
  assert.deepEqual(Object.keys(rows[0]), ['id', 'direction', 'channel', 'timestamp']);
  assert.doesNotMatch(JSON.stringify(rows), /private|content/);
  assert.equal(reader.getGroupMessages('telegram:a', { since: '2026-10-02T00:00:00Z', until: '2026-10-03T00:00:00Z' }).length, 1);
  assert.throws(() => reader._open().prepare('DELETE FROM conversations').run(), /readonly/i);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 4);
});

// Integration boundary: NULL message attribution in a private read-only C4 DB.
// Run when message scope/range SQL changes; rendering-only edits can skip.
// Teardown closes both connections before removing the isolated fixture root.
test('single messages retain NULL scope and never include Origin or other groups', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'comm-bridge'));
  const db = new Database(path.join(f.root, 'comm-bridge/c4.db'));
  db.exec('CREATE TABLE conversations(id INTEGER PRIMARY KEY, session_group TEXT, direction TEXT, channel TEXT, timestamp TEXT, content TEXT)');
  const put = db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?,?)');
  put.run(1, null, 'in', 'telegram', '2026-10-01 12:00:00', 'private single body');
  put.run(2, null, 'out', 'telegram', '2026-10-02 12:00:00', 'private single reply');
  put.run(3, null, 'in', 'internal', '2026-10-02 12:00:00', 'private internal');
  put.run(4, 'origin', 'in', 'telegram', '2026-10-02 12:00:00', 'private Origin');
  put.run(5, 'telegram:a', 'in', 'telegram', '2026-10-02 12:00:00', 'private group');
  put.run(6, null, 'in', 'telegram', '2026-10-04 12:00:00', 'private outside range');
  const reader = new C4Reader(f.root);
  f.addCleanup(() => { reader.close(); db.close(); });
  const range = { since: '2026-10-01T00:00:00Z', until: '2026-10-03T00:00:00Z' };
  const rows = reader.getGroupMessages(null, range);
  assert.deepEqual(rows.map(row => row.id), [1, 2]);
  for (const row of rows) assert.deepEqual(Object.keys(row), ['id', 'direction', 'channel', 'timestamp']);
  assert.doesNotMatch(JSON.stringify(rows), /private|content/);
  assert.deepEqual(reader.getGroupMessages('origin', range).map(row => row.id), [4]);
  assert.throws(() => reader.getGroupMessages(null, { since: 'invalid' }), { code: 'INVALID_ARGUMENT', statusCode: 400 });
});

test('backlog has one shared thirty-second per-group cache for count and lock status', async () => {
  let clock = 1000, countCalls = 0, lockCalls = 0;
  const backlog = createGroupBacklog({ zylosDir: '/isolated/instance', now: () => clock,
    env: { HOME: '/isolated', ZYLOS_SESSION_GROUP: 'unrelated', ZYLOS_RUN_ID: 'unrelated-run' },
    runC4Db: async args => { countCalls++; assert.deepEqual(args, ['unsummarized', '--group', 'telegram:a', '--json']); return { ok: true, data: { count: 3, firstAt: 100 } }; },
    execute: async (file, argv, options) => {
      lockCalls++;
      assert.equal(file, process.execPath);
      assert.equal(argv[0], '/isolated/instance/.claude/skills/zylos-memory/scripts/sync-lock.js');
      assert.deepEqual(argv.slice(1), ['status', '--group', 'telegram:a', '--json']);
      assert.equal(options.env.ZYLOS_SESSION_GROUP, undefined);
      assert.equal(options.env.ZYLOS_RUN_ID, undefined);
      assert.equal(options.env.ZYLOS_DIR, '/isolated/instance');
      assert.equal(options.timeout, 15000); assert.equal(options.maxBuffer, 1024 * 1024);
      return { stdout: JSON.stringify({ sync: { held: true } }) };
    } });
  assert.deepEqual(await backlog('telegram:a'), { count: 3, firstAt: 100, syncing: true });
  clock += 29999; await backlog('telegram:a');
  assert.deepEqual([countCalls, lockCalls], [1, 1]);
  clock += 101; await backlog('telegram:a');
  assert.deepEqual([countCalls, lockCalls], [2, 2]);
});

test('backlog count and lock failures remain independent and Origin uses its own lock', async () => {
  let countFailed = false, lockFailed = true;
  const backlog = () => createGroupBacklog({ zylosDir: '/isolated/instance',
    runC4Db: async () => countFailed ? { ok: false } : { ok: true, data: { count: 3, firstAt: 100 } },
    execute: async () => {
      if (lockFailed) throw new Error('lock unavailable');
      return { stdout: JSON.stringify({ sync: { held: false }, origin: { held: true } }) };
    } });
  assert.deepEqual(await backlog()('origin'), { count: 3, firstAt: 100, syncing: null, reason: 'backlog_failed' });
  countFailed = true; lockFailed = false;
  assert.deepEqual(await backlog()('origin'), { count: null, firstAt: null, reason: 'backlog_failed', syncing: true });
});

test('single backlog uses global commands and keeps its cache separate from multi Origin', async () => {
  let view = 'single';
  const calls = [];
  const backlog = createGroupBacklog({ zylosDir: '/isolated/instance', getSnapshot: async () => ({ view }),
    env: { HOME: '/isolated/home', ZYLOS_SESSION_GROUP: 'wrong-group', ZYLOS_RUN_ID: 'wrong-run', RETAIN: 'yes' },
    execute: async (file, argv, options) => {
      calls.push({ file, argv, options });
      if (argv[0].endsWith('/c4-db.js')) {
        return { stdout: JSON.stringify({ ok: true, data: { count: argv.includes('--group') ? 2 : 7, firstAt: 100 } }) };
      }
      return { stdout: JSON.stringify({ sync: { held: true }, origin: { held: false } }) };
    } });
  const single = await backlog('origin');
  assert.deepEqual(single, { count: 7, firstAt: 100, syncing: true });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].argv, ['/isolated/instance/.claude/skills/comm-bridge/scripts/c4-db.js', 'unsummarized', '--json']);
  assert.deepEqual(calls[1].argv, ['/isolated/instance/.claude/skills/zylos-memory/scripts/sync-lock.js', 'status', '--json']);
  assert.equal(await backlog('origin'), single);
  assert.equal(calls.length, 2);
  view = 'multi';
  const origin = await backlog('origin');
  assert.deepEqual(origin, { count: 2, firstAt: 100, syncing: false });
  assert.equal(calls.length, 4);
  assert.deepEqual(calls[2].argv.slice(1), ['unsummarized', '--group', 'origin', '--json']);
  assert.deepEqual(calls[3].argv.slice(1), ['status', '--group', 'origin', '--json']);
  view = 'single';
  assert.equal(await backlog('origin'), single);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.file, process.execPath);
    assert.equal(call.options.env.ZYLOS_DIR, '/isolated/instance');
    assert.equal(call.options.env.ZYLOS_SESSION_GROUP, undefined);
    assert.equal(call.options.env.ZYLOS_RUN_ID, undefined);
    assert.equal(call.options.env.RETAIN, 'yes');
    assert.equal(call.options.timeout, 15000);
    assert.equal(call.options.maxBuffer, 1024 * 1024);
  }
});

test('an unavailable backlog view retains the requested Origin scope', async () => {
  const countCalls = [], lockCalls = [];
  const backlog = createGroupBacklog({ zylosDir: '/isolated/instance',
    getSnapshot: async () => { throw new Error('unavailable'); },
    runC4Db: async args => { countCalls.push(args); return { ok: true, data: { count: 2 } }; },
    execute: async (file, argv) => {
      lockCalls.push(argv);
      return { stdout: JSON.stringify({ sync: { held: true }, origin: { held: false } }) };
    } });
  assert.deepEqual(await backlog('origin'), { count: 2, firstAt: null, syncing: false });
  assert.deepEqual(countCalls, [['unsummarized', '--group', 'origin', '--json']]);
  assert.deepEqual(lockCalls[0].slice(1), ['status', '--group', 'origin', '--json']);
});


test('reading another scope discards expired backlog entries permanently', async () => {
  let clock = 1000, calls = 0;
  const backlog = createGroupBacklog({ zylosDir: '/isolated/instance', now: () => clock,
    runC4Db: async () => ({ ok: true, data: { count: ++calls } }),
    execute: async () => ({ stdout: JSON.stringify({ sync: { held: false } }) }) });
  assert.equal((await backlog('telegram:a')).count, 1);
  clock = 31001;
  assert.equal((await backlog('telegram:b')).count, 2);
  // A backwards wall-clock adjustment cannot resurrect an expired entry that
  // was already discarded while another scope was read.
  clock = 1001;
  assert.equal((await backlog('telegram:a')).count, 3);
});
