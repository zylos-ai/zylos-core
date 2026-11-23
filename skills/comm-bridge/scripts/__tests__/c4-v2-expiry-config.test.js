import { seedHistoricalAbsorption } from './fixtures/historical-absorption.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
const NOW = 1800000000;
const getRow = (db, id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
test('expiry uniformly covers internal, system, NULL endpoint and legacy empty-group pending', t => {
  const { store: s, db } = fixture(t, { now: () => NOW * 1000 });
  s.insertConversation('in', 'chat', 'e', 'seed');
  const internal = s.insertInternalMessage('origin', 'chat', 'internal work').inRow;
  const system = s.insertConversation('in', 'system', null, 'system work');
  const noReply = s.insertConversation('in', 'chat', null, 'no reply');
  const legacy = s.insertConversation('in', 'chat', 'e', 'legacy');
  db.prepare("UPDATE conversations SET session_group='' WHERE id=?").run(legacy.id);
  for (const r of [internal, system, noReply, legacy]) {
    db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch'),retry_count=1 WHERE id=?").run(NOW - 1801, r.id);
    const before = getRow(db, r.id);
    assert.equal(s.expirePending(r.id, 1800), true);
    assert.deepEqual(getRow(db, r.id), { ...before, status: 'failed', delivery_action: 'pending_expired' });
    assert.equal(s.expirePending(r.id, 1800), false);
  }
});
test('stale selected pending cannot expire after a second connection claims or absorbs it', t => {
  const { store: s, db, filename, dependencies } = fixture(t, { now: () => NOW * 1000 }, true);
  const other = new Database(filename); t.after(() => other.close()); const peer = createStore(other, dependencies);
  const first = s.insertConversation('in', 'chat', 'e', 'claimed');
  db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(NOW - 1801, first.id);
  assert.equal(s.getNextPending().id, first.id);
  assert.equal(peer.claimConversation(first.id), true);
  const claimed = getRow(db, first.id); assert.equal(s.expirePending(first.id, 1800), false); assert.deepEqual(getRow(db, first.id), claimed);
  peer.markDelivered(first.id, { sessionId: 'actual' });
  const next = s.insertConversation('in', 'chat', 'e', 'absorbed');
  db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(NOW - 1801, next.id);
  assert.equal(s.getNextPending().id, next.id);
  const { runId } = peer.beginModeTransition('single', 'multi'); peer.setDrainFence('*'); seedHistoricalAbsorption(db, runId, [next.id]);
  const absorbed = getRow(db, next.id); assert.equal(absorbed.status, 'switch_absorbed');
  assert.equal(s.expirePending(next.id, 1800), false); assert.deepEqual(getRow(db, next.id), absorbed);
});
