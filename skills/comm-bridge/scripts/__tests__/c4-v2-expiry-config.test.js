import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
import { createStore } from '../c4-v2-store.js';
const NOW = 1800000000;
const getRow = (db, id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
function readPendingAge(value) {
  const env = { ...process.env };
  delete env.C4_PENDING_MAX_AGE_SECONDS;
  // Deliberately independent: pending must not consume orphan recovery config.
  env.C4_RECOVER_MAX_AGE_SECONDS = '999';
  if (value !== undefined) env.C4_PENDING_MAX_AGE_SECONDS = value;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { PENDING_MAX_AGE_SECONDS, RECOVER_MAX_AGE_SECONDS } from ${JSON.stringify(new URL('../c4-config.js', import.meta.url).href)}; process.stdout.write(JSON.stringify({pending:PENDING_MAX_AGE_SECONDS,recover:RECOVER_MAX_AGE_SECONDS}));`], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
test('pending age env is imported fresh: positive integers override and invalid values default independently', () => {
  for (const [value, expected] of [[undefined,1800], ['1',1], ['1801',1801], ['3600',3600], ['',1800], [' ',1800], ['0',1800], ['-1',1800], ['1.5',1800], ['NaN',1800], ['Infinity',1800], ['nope',1800], ['9007199254740992',1800]]) {
    assert.deepEqual(readPendingAge(value), { pending: expected, recover: 999 }, `env=${String(value)}`);
  }
});
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
  const { runId } = peer.beginModeTransition('single', 'multi'); peer.setDrainFence('*'); peer.absorbForTransition(runId);
  const absorbed = getRow(db, next.id); assert.equal(absorbed.status, 'switch_absorbed');
  assert.equal(s.expirePending(next.id, 1800), false); assert.deepEqual(getRow(db, next.id), absorbed);
});
test('expiry SQL failure propagates and rolls back without an apparent miss', t => {
  const { store: s, db } = fixture(t, { now: () => NOW * 1000 });
  const r = s.insertConversation('in', 'chat', 'e', 'old');
  db.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(NOW - 1801, r.id);
  const before = getRow(db, r.id);
  db.exec("CREATE TRIGGER reject_expiry BEFORE UPDATE ON conversations BEGIN SELECT RAISE(ABORT,'expiry failed'); END");
  assert.throws(() => s.expirePending(r.id, 1800), { code: 'DB_WRITE_FAILED', persisted: [] });
  assert.deepEqual(getRow(db, r.id), before);
});
