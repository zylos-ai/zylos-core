import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';
import { enqueueStartupPrompt } from '../../../activity-monitor/scripts/session-start-prompt.js';

const binding = { expectedRunId: 'old-run', tmuxTarget: {
  serverGeneration: 'generation-1', sessionId: '$1', paneId: '%1',
} };
const empty = () => ({ inbound: { count: 0, oldestAt: null }, controls: { count: 0, oldestAt: null }, continuation: { pending: false, oldestAt: null } });
function incoming(db, { timestamp = '2026-11-03 10:00:00', direction = 'in', status = 'pending', group = 'origin' } = {}) {
  db.prepare(`INSERT INTO conversations(timestamp,direction,channel,content,status,session_group)
    VALUES(?,?,'system','message',?,?)`).run(timestamp, direction, status, group);
}
function control(store, content, options = {}) {
  return store.insertControl(content, { sessionGroup: 'origin', appendAckSuffix: false, ...options });
}
function createdAt(db, row, at) {
  db.prepare('UPDATE control_queue SET created_at=?,updated_at=? WHERE id=?').run(at, at, row.id);
}

test('empty Origin has no inbound or control need', t => {
  const { store } = fixture(t);
  assert.deepEqual(store.getOriginNeed(1000), empty());
});

test('only pending Origin inbound contributes, including old rows, with UTC Unix seconds', t => {
  const { db, store } = fixture(t);
  incoming(db);
  incoming(db, { timestamp: '2026-11-03 10:00:01' });
  incoming(db, { timestamp: '2026-11-03 09:00:00', status: 'delivered' });
  incoming(db, { timestamp: '2026-11-03 08:00:00', group: 'telegram_other' });
  incoming(db, { timestamp: '2026-11-03 07:00:00', direction: 'out' });
  assert.deepEqual(store.getOriginNeed(2_000_000_000), {
    inbound: { count: 2, oldestAt: Date.parse('2026-11-03T10:00:00Z') / 1000 },
    controls: { count: 0, oldestAt: null },
    continuation: { pending: false, oldestAt: null },
  });
});

test('Origin need scans beyond a bound queue head and counts only ready unbound pending controls', t => {
  const { db, store } = fixture(t);
  const head = control(store, 'bound head', { priority: 0, targetBinding: binding });
  createdAt(db, head, 10);
  const first = control(store, 'ready'); createdAt(db, first, 100);
  const delayed = control(store, 'ready after delay', { availableAt: 200 }); createdAt(db, delayed, 50);
  const future = control(store, 'future', { availableAt: 301 }); createdAt(db, future, 20);
  const running = control(store, 'running'); createdAt(db, running, 30);
  db.prepare("UPDATE control_queue SET status='running' WHERE id=?").run(running.id);
  control(store, 'other group', { sessionGroup: 'telegram_other' });
  // Historical machine-scoped rows do not count as Origin needs.
  db.prepare(`INSERT INTO control_queue(raw_content,content,status,created_at,updated_at)
    VALUES('machine','machine','pending',1,1)`).run();
  assert.equal(store.getNextPendingControl(300, { sessionGroups: ['origin'] }).id, head.id);
  assert.deepEqual(store.getOriginNeed(300).controls, { count: 2, oldestAt: 100 });
  db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(first.id);
  assert.deepEqual(store.getOriginNeed(300).controls, { count: 1, oldestAt: 200 });
  db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(delayed.id);
  assert.deepEqual(store.getOriginNeed(300).controls, { count: 0, oldestAt: null });
  assert.deepEqual(store.getOriginNeed(301).controls, { count: 1, oldestAt: 301 });
});

test('a control starts needing Origin at the later of creation and availability', t => {
  const { db, store } = fixture(t);
  const row = control(store, 'already available', { availableAt: 50 });
  createdAt(db, row, 100);
  assert.deepEqual(store.getOriginNeed(100).controls, { count: 1, oldestAt: 100 });
});

test('only bound controls left by an ended run do not need Origin', t => {
  const { store } = fixture(t);
  control(store, 'old rotation', { targetBinding: binding });
  control(store, 'old exit', { targetBinding: binding });
  assert.deepEqual(store.getOriginNeed(2_000_000_000), empty());
});

for (const migration of [false, true]) {
  test(`unbound ${migration ? 'instruction migration' : 'ordinary'} startup prompt needs Origin`, async t => {
    const { store } = fixture(t, { now: () => 100_000 });
    await enqueueStartupPrompt('startup', {
      onboardingPending: () => false, migrationPending: () => migration,
      scopeReader: async () => ({ sessionGroup: 'origin' }),
      execFile: async (_command, args) => {
        assert.equal(args.includes('--target-run'), false);
        assert.equal(args[args.indexOf('--group') + 1], 'origin');
        const row = control(store, args[args.indexOf('--content') + 1]);
        assert.equal(row.target_binding, null);
        return { stdout: JSON.stringify({ id: row.id }) };
      },
    });
    assert.deepEqual(store.getOriginNeed(100).controls, { count: 1, oldestAt: 100 });
  });
}

test('Origin and global drain fences do not hide need and reads never mutate queued rows', t => {
  const { db, store } = fixture(t, { now: () => 100_000 });
  incoming(db);
  control(store, 'ready');
  const expected = store.getOriginNeed(100);
  store.setDrainFence('origin', { reason: 'ttl', runId: 'run-origin' });
  store.setDrainFence('*');
  const snapshot = () => ({
    conversations: db.prepare('SELECT * FROM conversations ORDER BY id').all(),
    controls: db.prepare('SELECT * FROM control_queue ORDER BY id').all(),
  });
  const before = snapshot();
  db.pragma('query_only=ON');
  assert.deepEqual(store.getOriginNeed(100), expected);
  assert.deepEqual(store.getOriginNeed(), expected);
  assert.deepEqual(snapshot(), before);
});

// Real Store and private memory SQLite, injected clock. Run for Origin need or
// marker changes; skip unrelated delivery. Official runner isolates HOME,
// ZYLOS_DIR/PM2_HOME/short TMPDIR; no tmux/network/children; fixture closes DB.
test('only the pending Origin ending contributes continuation need until cleared', t => {
  const { db, store } = fixture(t, { now: () => 123_000 });
  store.recordRunEnd('other', { runId: 'other-old', reason: 'unexpected' });
  assert.deepEqual(store.getOriginNeed(999), empty());
  store.recordRunEnd('origin', { runId: 'origin-old', reason: 'unexpected' });
  const expected = { ...empty(), continuation: { pending: true, oldestAt: 123 } };
  assert.deepEqual(store.getOriginNeed(999), expected);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM control_queue').get().n, 0);
  assert.deepEqual(store.clearContinuation('origin', { runId: 'origin-old' }), { cleared: false });
  assert.deepEqual(store.getOriginNeed(999), expected);
  assert.deepEqual(store.clearContinuation('origin', { runId: 'origin-new' }), { cleared: true });
  assert.deepEqual(store.getOriginNeed(999), empty());
  store.recordRunEnd('origin', { runId: 'origin-new', reason: 'unexpected' });
  store.recordRunEnd('origin', { runId: 'origin-later', reason: 'ttl' });
  assert.deepEqual(store.getOriginNeed(999), empty());
});
