import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { readPoolCapacity } from '../../../cli/lib/session-pool-config.js';
import { collectStatus } from '../../../cli/lib/status-view.js';
import { C4Reader } from '../src/lib/c4-reader.js';
import { readPool, poolPositions } from '../src/lib/workbench/pool-capacity.js';
import { createGroupSnapshot } from '../src/lib/workbench/group-snapshot.js';

const NOW = 1800000000000;
const freshRecord = patch => ({ v: 1, k: 3, computedAt: NOW, source: 'auto',
  memory: { source: 'cgroup', limitBytes: 4 * 1024 ** 3, usedBytes: 2 * 1024 ** 3, reserveBytes: 0.5 * 1024 ** 3 },
  model: { state: 'default', slopeBytes: 0.5 * 1024 ** 3, windowDays: 7, buckets: 0 }, ...patch });
const pending = (sessionGroup, priority, id, extra = {}) => ({ sessionGroup,
  pending: { count: 1, oldestAt: NOW - 5000, head: { priority, id } }, running: { count: 0 }, fence: null, ...extra });

function fixture(t, { record = freshRecord(), slots = [], groups = [], queues = [], globalFence = null, events = [],
  mode = 'multi', sample = { ready: 10, starting: 20, reclaiming: 30, waiting: 40 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pool-'));
  fs.mkdirSync(path.join(root, 'comm-bridge'));
  fs.mkdirSync(path.join(root, 'activity-monitor'));
  fs.mkdirSync(path.join(root, '.zylos'));
  fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ session_pool_size: 3 }));
  const file = path.join(root, 'activity-monitor/pool-capacity.json');
  let writes = 0;
  function publish(value) {
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    fs.utimesSync(file, NOW / 1000 + ++writes, NOW / 1000 + writes);
  }
  if (record !== null) publish(record);
  const db = new Database(path.join(root, 'comm-bridge/c4.db'));
  db.exec(`CREATE TABLE slot_occupancy (session_group TEXT PRIMARY KEY, run_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('running','held')), held_until INTEGER, created_at INTEGER NOT NULL)`);
  const insert = db.prepare('INSERT INTO slot_occupancy VALUES (?,?,?,?,?)');
  for (const slot of slots) insert.run(slot.group, 'run-' + slot.group, slot.state ?? 'running', slot.until ?? null, NOW / 1000 - 10);
  const reader = new C4Reader(root);
  t.after(() => { reader.close(); db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  let clock = NOW, calls = 0, occupancyCalls = 0;
  const originalOccupancy = reader.listSlotOccupancy.bind(reader);
  reader.listSlotOccupancy = now => { occupancyCalls++; return originalOccupancy(now); };
  const readMode = () => {
    if (mode === 'unreadable') throw new Error('Mode unavailable');
    return { mode };
  };
  const live = new Map(groups.map(group => [group.sessionGroup, group]));
  const sessionReader = {
    readSessionState: async key => {
      const group = live.get(key), present = ['running', 'starting'].includes(group?.presence);
      return { identity: { present, ready: group?.presence === 'running', runtime: present ? 'claude' : null,
        runId: present ? 'live-' + key : null, createdAt: NOW / 1000 - 10,
        launchConfig: present ? { runtime: 'claude', mode: 'default' } : null },
      status: present ? { valid: true, sampledAt: clock, value: { state: 'idle' } } : { valid: false }, usage: { valid: false } };
    },
    readAccountUsage: async () => null,
  };
  const loadCoreModule = async name => {
    if (name === 'session-pool-config.js') return { readPoolCapacity: options => {
      calls++;
      return readPoolCapacity({ ...options, env: { HOME: root, ZYLOS_DIR: root } });
    } };
    if (name === 'config.js') return { readSessionMode: readMode };
    if (name === 'session-state-reader.js') return sessionReader;
    if (name === 'status-view.js') return { collectStatus: options => collectStatus({ ...options,
      mode: readMode, list: () => groups, resolveRoot: () => root,
      configIssue: () => null, facts: async () => ({ originNeed: null }), health: () => ({ missing: true }), now: () => clock }) };
    throw new Error('Unexpected Core module: ' + name);
  };
  const service = createGroupSnapshot({ zylosDir: root, c4Reader: reader, loadCoreModule, now: () => clock,
    cli: { runC4Db: async args => ({ ok: true, readAt: clock, data: args[0] === 'groups'
      ? { groups: [], hasOlder: false } : { groups: queues, globalFence } }),
    readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) },
    store: { latestEventByType: () => ({ metadata: sample }), queryEvents: filter => events.filter(event => filter.types.includes(event.event_type)) } });
  return { root, db, reader, file, sample, loadCoreModule, service, publish, calls: () => calls,
    occupancyCalls: () => occupancyCalls,
    advance: ms => { clock += ms; }, read: () => readPool({ mode, now: clock, sample, c4Reader: reader, loadCoreModule }) };
}

// Integration boundary: Core's real capacity reader, a private SQLite occupancy
// table, and real snapshot/wait/attention reducers. Run for capacity, occupancy,
// queue-order or snapshot wiring changes; skip unrelated UI-only changes. The
// official runner isolates HOME/ZYLOS_DIR; each fixture adds its own files/DB.
// Core observations/CLI are injected; no sockets, PM2, tmux or child processes.
// Mode boundary: run for mode/capacity routing changes, skip unrelated UI edits;
// owned fixture files and DB only, with counters around both capacity readers.
for (const mode of ['single', 'unreadable']) for (const hasSample of [true, false]) {
  test(`${mode} snapshot preserves sampled pool display without reading capacity or occupancy${hasSample ? '' : ' when no sample exists'}`, async t => {
    const sample = hasSample ? { ready: 10, starting: 20, reclaiming: 30, waiting: 40 } : null;
    const f = fixture(t, { mode, sample, record: freshRecord({ k: 17 }), slots: [{ group: 'occupied' }] });
    const snapshot = await f.service.getSnapshot();
    assert.equal(snapshot.mode, mode);
    assert.equal(f.calls(), 0);
    assert.equal(f.occupancyCalls(), 0);
    assert.deepEqual(snapshot.instance.pool, hasSample
      ? { ...sample, capacity: null, used: 30 }
      : { ready: null, starting: null, reclaiming: null, waiting: null, capacity: null, used: null });
    assert.equal(snapshot.attention.reminders.some(reminder => reminder.kind === 'pool_full'), false);
  });
}

test('snapshot joins real capacity and occupancy into inbound positions and one full reminder without writes', async t => {
  const f = fixture(t, { slots: [{ group: 'used-a' }, { group: 'used-b' }, { group: 'used-c' }],
    queues: [pending('c', 2, 2), pending('origin', 0, 1), pending('b', 1, 9)] });
  const observer = new Database(path.join(f.root, 'comm-bridge/c4.db'), { readonly: true });
  t.after(() => observer.close());
  const beforeVersion = observer.pragma('data_version', { simple: true }), beforeFile = fs.readFileSync(f.file);
  const snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.instance.pool.capacity, 3);
  assert.equal(snapshot.instance.pool.used, 3);
  assert.equal(snapshot.instance.pool.waiting, 40);
  assert.equal(snapshot.instance.pool.capacityRecord.source, 'auto');
  assert.equal(snapshot.instance.pool.capacityRecord.fresh, true);
  assert.equal(Object.hasOwn(snapshot.instance.pool, 'occupancy'), false);
  assert.deepEqual(snapshot.rows.find(row => row.sessionGroup === 'b').wait, { kind: 'pool_wait', position: 1 });
  assert.deepEqual(snapshot.rows.find(row => row.sessionGroup === 'c').wait, { kind: 'pool_wait', position: 2 });
  assert.notEqual(snapshot.rows.find(row => row.sessionGroup === 'origin').wait?.kind, 'pool_wait');
  assert.deepEqual(snapshot.attention.reminders, [{ kind: 'pool_full', waiting: 2 }]);
  assert.equal(observer.pragma('data_version', { simple: true }), beforeVersion);
  assert.equal(fs.readFileSync(f.file).equals(beforeFile), true);
  assert.equal(f.calls(), 1);
  assert.equal(f.occupancyCalls(), 1);
  await f.service.getSnapshot();
  assert.equal(f.calls(), 1);
  f.advance(2001); await f.service.getSnapshot();
  assert.equal(f.calls(), 2);
});

// Integration: real status presence and slot ownership feed snapshot ranking. Run
// for candidate filtering changes; skip UI-only work. Uses only the owned fixture.
test('unexpired owners, present and activating groups do not consume inbound positions, and pure continuation stays unranked', async t => {
  const f = fixture(t, { slots: [{ group: 'held', state: 'held', until: NOW / 1000 + 120 }, { group: 'running-owner' }, { group: 'other' }],
    groups: [{ sessionGroup: 'present', presence: 'running' }, { sessionGroup: 'activating', presence: 'starting' },
      { sessionGroup: 'continuation', presence: 'not_running' }],
    queues: [pending('held', 0, 1), pending('running-owner', 0, 2), pending('present', 0, 3), pending('activating', 0, 4),
      pending('fenced', 0, 5, { fence: { reason: 'upgrade', createdAt: NOW / 1000 } }), pending('b', 1, 11), pending('c', 1, 12)] });
  const snapshot = await f.service.getSnapshot(), get = key => snapshot.rows.find(row => row.sessionGroup === key);
  assert.equal(snapshot.instance.pool.used, 3);
  assert.deepEqual(get('b').wait, { kind: 'pool_wait', position: 1 });
  assert.deepEqual(get('c').wait, { kind: 'pool_wait', position: 2 });
  for (const key of ['held', 'running-owner']) assert.deepEqual(get(key).wait, { kind: 'unknown', reason: 'no_rule' });
  assert.equal(get('activating').wait.kind, 'starting');
  assert.equal(get('fenced').wait.kind, 'fenced');
  assert.equal(get('continuation').wait, null);
});

// Integration: queue fence joins snapshot waiting and attention. Run for fence
// or pool-wait wiring changes; skip UI-only work. No external resources.
test('global fence prevents all pool waits and full reminder even with full occupancy', async t => {
  const f = fixture(t, { slots: [{ group: 'a' }, { group: 'b' }, { group: 'c' }], queues: [pending('waiting', 1, 2)],
    globalFence: { reason: 'mode_switch', createdAt: NOW / 1000 } });
  const snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.rows.find(row => row.sessionGroup === 'waiting').wait.kind, 'fenced');
  assert.equal(snapshot.attention.reminders.length, 0);
});

// Integration: real readonly SQL and snapshot cover expiry boundaries. Run for
// occupancy queries/time-unit changes; skip UI-only work. Private fixture DB only.
test('occupancy counts running and only held rows strictly beyond the current second', async t => {
  const f = fixture(t, { slots: [{ group: 'a' }, { group: 'b', state: 'held', until: NOW / 1000 + 1 },
    { group: 'expired', state: 'held', until: NOW / 1000 - 1 }, { group: 'boundary', state: 'held', until: NOW / 1000 }],
    queues: [pending('waiting', 1, 2)] });
  assert.deepEqual(f.reader.listSlotOccupancy(NOW).map(row => row.sessionGroup), ['a', 'b']);
  const snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.instance.pool.used, 2);
  assert.equal(snapshot.rows.find(row => row.sessionGroup === 'waiting').wait.reason, 'no_rule');
  assert.equal(snapshot.attention.reminders.length, 0);
});

// Integration: Core rereads fixture publication without a Dashboard cache. Run
// for limit/occupancy wiring changes; skip UI-only work. Private files/DB only.
test('shrinking capacity reports occupancy above the limit without clamping', async t => {
  const f = fixture(t, { record: freshRecord({ k: 4 }), slots: ['a', 'b', 'c', 'd'].map(group => ({ group })) });
  assert.equal((await f.read()).capacity, 4);
  f.publish(freshRecord({ k: 3 }));
  const pool = await f.read();
  assert.equal(pool.capacity, 3); assert.equal(pool.used, 4);
});

// Integration: real Core freshness/baseline selection with preserved publication fields.
// Run for capacity adapter changes; skip UI-only work. Private files/DB only.
test('stale records use Core effective limit while preserving publication source and explanation', async t => {
  const record = freshRecord({ k: 6, computedAt: NOW - 90000, kMemory: 3 });
  const f = fixture(t, { record });
  const pool = await f.read();
  assert.equal(pool.capacity, 3); assert.equal(pool.capacityRecord.valid, true); assert.equal(pool.capacityRecord.fresh, false);
  assert.equal(pool.capacityRecord.source, 'auto'); assert.deepEqual(pool.capacityRecord.memory, record.memory);
  assert.equal(pool.capacityRecord.kMemory, 3);
});

// Integration: real Core missing/invalid record fallback with private baseline.
// Run for record validity/adapter changes; skip UI-only work. Private files/DB only.
for (const [label, record] of [['missing', null], ['invalid JSON', '{'], ['invalid record', { v: 1, k: 0, computedAt: NOW, source: 'fallback' }]]) {
  test('Core baseline supplies capacity for ' + label, async t => {
    const f = fixture(t, { record });
    const pool = await f.read();
    assert.equal(pool.capacity, 3); assert.equal(pool.capacityRecord.valid, false); assert.equal(pool.capacityRecord.fresh, false);
  });
}

// Integration: actual publication field mapping through the capacity adapter.
// Run for source/explanation changes; skip unrelated UI work. Private files/DB.
test('fresh fixed and fallback explanations are carried only from the publication', async t => {
  const f = fixture(t, { record: freshRecord({ source: 'fixed', k: 6, kMemory: 3 }) });
  const fixed = await f.read();
  assert.equal(fixed.capacity, 6); assert.equal(fixed.capacityRecord.source, 'fixed'); assert.equal(fixed.capacityRecord.kMemory, 3);
  f.publish(freshRecord({ source: 'fallback', k: 1, reason: 'memory_unreadable', memory: null, model: null }));
  const fallback = await f.read();
  assert.equal(fallback.capacity, 1); assert.equal(fallback.capacityRecord.fresh, true); assert.equal(fallback.capacityRecord.source, 'fallback');
  assert.equal(fallback.capacityRecord.memory, null);
});

// Integration: repeated reads cross Core freshness without publication changes.
// Run for adapter caching changes; skip UI-only work. Private files/DB only.
test('capacity is reevaluated for freshness without a Dashboard cache', async t => {
  const f = fixture(t, { record: freshRecord({ k: 6 }) });
  assert.equal((await f.read()).capacity, 6);
  f.advance(60001);
  const pool = await f.read();
  assert.equal(pool.capacity, 3); assert.equal(pool.capacityRecord.fresh, false); assert.equal(f.calls(), 2);
});

// Integration: missing private table fails through real reader to snapshot and
// attention, preserving startup-failure priority. Run for occupancy error paths;
// skip UI-only work. The DROP affects only this test-owned database.
test('unreadable occupancy is unknown and startup failure still wins without full reminder', async t => {
  const f = fixture(t, { queues: [pending('waiting', 1, 1), pending('failed', 1, 2)],
    events: [{ session_group: 'failed', event_type: 'activate_failed', timestamp: NOW, metadata: { reason: 'ready_timeout' } }] });
  f.db.exec('DROP TABLE slot_occupancy');
  const snapshot = await f.service.getSnapshot();
  assert.equal(snapshot.instance.pool.used, null);
  assert.equal(snapshot.instance.pool.reason, 'pool_occupancy_unreadable');
  assert.equal(snapshot.rows.find(row => row.sessionGroup === 'waiting').wait.reason, 'pool_occupancy_unreadable');
  assert.equal(snapshot.rows.find(row => row.sessionGroup === 'failed').wait.kind, 'start_failed');
  assert.equal(snapshot.attention.reminders.length, 0);
});

test('snapshot ranking uses priority before id and excludes only observed queue ineligibility', () => {
  const row = (key, priority, id, patch = {}) => ({ sessionGroup: key, queue: pending(key, priority, id),
    presence: 'not_running', fence: null, ...patch });
  const rows = [row('later-id', 1, 5), row('later-priority', 2, 1), row('first', 1, 4),
    row('origin', 0, 1), row('unknown', 0, 1, { queue: { known: false } }),
    row('owner', 0, 1), row('starting', 0, 1, { presence: 'starting' }),
    row('fence', 0, 1, { fence: { reason: 'auth' } })];
  assert.deepEqual([...poolPositions(rows, [{ sessionGroup: 'owner', state: 'held' }])],
    [['first', 1], ['later-id', 2], ['later-priority', 3]]);
});
