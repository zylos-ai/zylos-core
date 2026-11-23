import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';

const binding = { expectedRunId: 'old-run', tmuxTarget: {
  serverGeneration: 'generation-1', sessionId: '$1', paneId: '%1',
} };
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
