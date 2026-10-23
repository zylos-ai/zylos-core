import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
import { MAX_RETRIES } from '../c4-config.js';
const NOW = 1800000000;
const add = (s, group = 'a', options = {}) => s.insertConversation('in', group, 'e', 'message', options);
const row = (db, id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);

test('IF11 selection uses priority then id, isolates filters, and includes legacy empty scope globally', t => {
  const { store: s, db } = fixture(t);
  const a = add(s, 'a', { priority: 3 }), b = add(s, 'b', { priority: 1 }), c = add(s, 'a', { priority: 1 });
  db.prepare("UPDATE conversations SET timestamp='1999-01-01 00:00:00' WHERE id=?").run(c.id);
  assert.equal(s.getNextPending().id, b.id);
  assert.equal(s.getNextPending({ sessionGroups: ['a'] }).id, c.id);
  assert.equal(s.getNextPending({ sessionGroups: [] }), null);
  assert.throws(() => s.getNextPending({ sessionGroups: [''] }), { code: 'SESSION_GROUP_INVALID' });
  db.prepare("UPDATE conversations SET session_group='',priority=0 WHERE id=?").run(a.id);
  assert.equal(s.getNextPending().id, a.id);
  assert.equal(s.getNextPending({ sessionGroups: ['a'] }).id, c.id);
});
test('DM16/17 two connections: stale selection cannot cross committed group fence or claim twice', t => {
  const { store: a, filename, dependencies, db } = fixture(t, {}, true);
  const other = new Database(filename); t.after(() => other.close()); const b = createStore(other, dependencies);
  const x = add(a), y = add(a, 'b');
  assert.equal(a.getNextPending().id, x.id);
  b.setDrainFence('a', { reason: 'ttl', runId: 'r1' });
  const before = row(db, x.id);
  assert.equal(a.claimConversation(x.id), false); assert.deepEqual(row(db, x.id), before);
  assert.equal(a.getNextPending().id, y.id);
  assert.equal(a.claimConversation(y.id), true); assert.equal(b.claimConversation(y.id), false);
  b.clearDrainFence('a'); assert.equal(a.claimConversation(x.id), true);
});
test('DM18 global fence covers existing, legacy and newly created groups after store reopening', t => {
  const { store: s, filename, dependencies, db } = fixture(t, {}, true);
  const legacy = add(s); db.prepare("UPDATE conversations SET session_group='' WHERE id=?").run(legacy.id);
  s.setDrainFence('*'); const fresh = add(s, 'fresh');
  const other = new Database(filename); t.after(() => other.close()); const reopened = createStore(other, dependencies);
  assert.equal(reopened.getNextPending(), null); assert.deepEqual(reopened.listPendingSessionGroups(), []);
  for (const id of [legacy.id, fresh.id]) assert.equal(reopened.claimConversation(id), false);
});
test('group head scheduling keeps priority and head id paired and excludes nonpending/outbound/empty/fenced rows', t => {
  const { store: s, db } = fixture(t);
  add(s, 'a', { priority: 3 }); const ahead = add(s, 'a', { priority: 1 }); const b = add(s, 'b', { priority: 2 });
  const running = add(s, 'b', { priority: 0 }); s.claimConversation(running.id);
  s.insertConversation('out', 'a', 'e', 'reply', { priority: 0 });
  const legacy = add(s, 'legacy', { priority: 0 }); db.prepare("UPDATE conversations SET session_group='' WHERE id=?").run(legacy.id);
  assert.deepEqual(s.listPendingSessionGroups(), [{ sessionGroup: 'a', headId: ahead.id, headPriority: 1, count: 2 }, { sessionGroup: 'b', headId: b.id, headPriority: 2, count: 1 }]);
  s.setDrainFence('a', { reason: 'evict', runId: 'r' }); assert.equal(s.listPendingSessionGroups()[0].sessionGroup, 'b');
  s.clearDrainFence('a'); assert.equal(s.listPendingSessionGroups().length, 2);
});
test('DM73 pending age uses strict boundary, never retries, never overwrites other states or outbound rows', t => {
  const { store: s, db } = fixture(t, { now: () => NOW * 1000 });
  for (const age of [1799, 1800, 1801]) {
    const item = add(s); db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch'),retry_count=2 WHERE id=?").run(NOW - age, item.id);
    assert.equal(s.expirePending(item.id, 1800), age === 1801);
    assert.equal(row(db, item.id).retry_count, 2);
    assert.equal(row(db, item.id).delivery_action, age === 1801 ? 'pending_expired' : null);
  }
  for (const status of ['running', 'delivered', 'failed', 'switch_absorbed']) {
    const item = add(s); db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch'),status=? WHERE id=?").run(NOW - 1801, status, item.id);
    const before = row(db, item.id); assert.equal(s.expirePending(item.id, 1800), false); assert.deepEqual(row(db, item.id), before);
  }
  const out = s.insertConversation('out', 'a', 'e', 'out');
  db.prepare("UPDATE conversations SET status='pending',timestamp=datetime(?,'unixepoch') WHERE id=?").run(NOW - 1801, out.id);
  assert.equal(s.expirePending(out.id, 1800), false); assert.equal(s.expirePending(99999, 1800), false);
});
test('orphan recovery classifies strict age boundaries, prioritizes age and is repeat-safe', t => {
  const { store: s, db } = fixture(t, { now: () => NOW * 1000 });
  const entries = [1799, 1800, 1801, 10].map(age => {
    const item = add(s); s.claimConversation(item.id);
    db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch'),retry_count=? WHERE id=?").run(NOW - age, age === 1801 || age === 10 ? MAX_RETRIES - 1 : 0, item.id); return item;
  });
  const pending = add(s); db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(NOW - 9999, pending.id);
  const beforePending = row(db, pending.id);
  assert.deepEqual(s.recoverOrphanRunning({ maxAgeSeconds: 1800 }), { requeued: { ids: [entries[0].id, entries[1].id], count: 2 }, ageExpired: { ids: [entries[2].id], count: 1 }, retryExhausted: { ids: [entries[3].id], count: 1 } });
  assert.equal(row(db, entries[2].id).retry_count, MAX_RETRIES - 1); assert.equal(row(db, entries[3].id).retry_count, MAX_RETRIES);
  assert.deepEqual(row(db, pending.id), beforePending);
  assert.deepEqual(s.recoverOrphanRunning({ maxAgeSeconds: 1800 }), { requeued: { ids: [], count: 0 }, ageExpired: { ids: [], count: 0 }, retryExhausted: { ids: [], count: 0 } });
});
test('IF11 failDelivery is one conditional increment and state change; old split mutation trips oracle', t => {
  const { store: s, db } = fixture(t);
  const item = add(s); s.claimConversation(item.id);
  db.exec("CREATE TRIGGER detect_half_failure AFTER UPDATE ON conversations WHEN NEW.retry_count > OLD.retry_count AND NEW.status='running' BEGIN SELECT RAISE(ABORT,'half-updated delivery'); END");
  assert.deepEqual(s.failDelivery(item.id, { maxRetries: 2 }), { changed: true, status: 'pending', retryCount: 1 });
  assert.deepEqual(s.failDelivery(item.id, { maxRetries: 2 }), { changed: false, status: 'pending', retryCount: 1 });
  s.claimConversation(item.id);
  assert.throws(() => db.prepare('UPDATE conversations SET retry_count=retry_count+1 WHERE id=?').run(item.id), /half-updated delivery/);
  assert.equal(row(db, item.id).retry_count, 1);
  assert.deepEqual(s.failDelivery(item.id, { maxRetries: 2 }), { changed: true, status: 'failed', retryCount: 2 });
  assert.equal(s.markDelivered(item.id, { sessionId: 'late' }), false);
  assert.deepEqual(s.failDelivery(99999), { changed: false, status: null, retryCount: null });
});
test('late completion never revives terminal/requeued rows; actual running completion records session only once', t => {
  const { store: s, db } = fixture(t);
  for (const status of ['pending', 'failed', 'switch_absorbed', 'delivered']) {
    const item = add(s); db.prepare('UPDATE conversations SET status=? WHERE id=?').run(status, item.id);
    const before = row(db, item.id); assert.equal(s.markDelivered(item.id, { sessionId: 'late' }), false); assert.deepEqual(row(db, item.id), before);
  }
  const item = add(s); assert.equal(s.claimConversation(item.id), true);
  assert.equal(s.markDelivered(item.id, { sessionId: 'actual' }), true);
  assert.equal(s.markDelivered(item.id, { sessionId: 'late' }), false); assert.equal(row(db, item.id).session_id, 'actual');
});
test('running counts and outbound-after obey group isolation; last activity is latest id even with older timestamp', t => {
  const { store: s, db } = fixture(t);
  const a = add(s), b = add(s, 'b'); s.claimConversation(a.id); s.claimConversation(b.id);
  assert.equal(s.countRunningConversations('a'), 1); assert.equal(s.countGlobalRunningConversations(), 2);
  assert.equal(s.hasOutboundAfter('a', a.id), false); s.insertConversation('out', 'b', 'e', 'other'); assert.equal(s.hasOutboundAfter('a', a.id), false);
  const out = s.insertConversation('out', 'a', 'e', 'reply'); db.prepare("UPDATE conversations SET timestamp='1999-01-01 00:00:00' WHERE id=?").run(out.id);
  assert.equal(s.hasOutboundAfter('a', a.id), true); assert.equal(s.hasOutboundAfter('a', out.id), false);
  assert.deepEqual(s.getLastActivity('a'), { id: out.id, ts: '1999-01-01 00:00:00' }); assert.equal(s.getLastActivity('absent'), null);
});
