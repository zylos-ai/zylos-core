import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { fixture } from './c4-v2-test-helpers.js';
const row = (db, id) => db.prepare('SELECT * FROM conversations WHERE id=?').get(id);
const ownership = (r, extra = {}) => ({ sessionGroup: r.session_group, channel: r.channel, endpointId: r.endpoint_id, health: 'rate_limited', reason: 'quota', ...extra });
const failed = (s, endpoint = 'e', action) => s.insertConversation('in', 'chat', endpoint, 'original 中文', { status: 'failed', ...(action === undefined ? {} : { deliveryAction: action }) });

test('NULL action and NULL endpoint permit suppression; repeated id never appends twice', t => {
  const { store: s, db } = fixture(t);
  for (const endpoint of [null, 'e']) {
    const r = failed(s, endpoint); assert.equal(r.delivery_action, null);
    assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r)), true);
    const saved = row(db, r.id);
    assert.equal(saved.content, 'original 中文\n\n[C4] Status notification suppressed by cooldown while health=rate_limited reason=quota.');
    assert.equal(saved.status, 'failed'); assert.equal(saved.delivery_action, 'suppressed');
    assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r)), false); assert.deepEqual(row(db, r.id), saved);
  }
});
test('wrong group, channel or endpoint cannot suppress another owner row, including NULL distinctions', t => {
  const { store: s, db } = fixture(t);
  for (const endpoint of [null, 'e']) {
    const r = failed(s, endpoint); const before = row(db, r.id);
    for (const wrong of [{ sessionGroup: 'other' }, { channel: 'other' }, { endpointId: endpoint === null ? 'e' : null }, { endpointId: 'other' }]) {
      assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r, wrong)), false); assert.deepEqual(row(db, r.id), before);
    }
  }
  assert.equal(s.markStatusNoticeSuppressed(99999, { sessionGroup: 'chat', channel: 'chat', endpointId: null }), false);
});
test('only failed inbound is eligible; auth/pending-expired/suppressed facts are never replaced', t => {
  const { store: s, db } = fixture(t);
  for (const status of ['pending', 'running', 'delivered', 'switch_absorbed']) {
    const r = failed(s); db.prepare('UPDATE conversations SET status=? WHERE id=?').run(status, r.id);
    const before = row(db, r.id); assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r)), false); assert.deepEqual(row(db, r.id), before);
  }
  for (const action of ['auth_rejected', 'pending_expired', 'suppressed']) {
    const r = failed(s, 'e', action); const before = row(db, r.id);
    assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r)), false); assert.deepEqual(row(db, r.id), before);
  }
  const out = s.insertConversation('out', 'chat', 'e', 'out'); db.prepare("UPDATE conversations SET status='failed' WHERE id=?").run(out.id);
  const before = row(db, out.id); assert.equal(s.markStatusNoticeSuppressed(out.id, ownership(out)), false); assert.deepEqual(row(db, out.id), before);
});
test('ordinary failure action can become suppressed with existing default diagnostic values', t => {
  const { store: s, db } = fixture(t);
  const r = failed(s, 'e', 'health_unavailable');
  assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r, { health: undefined, reason: undefined })), true);
  assert.match(row(db, r.id).content, /health=unavailable reason=unavailable\.$/);
});
test('real second-connection write lock yields DB_BUSY, no append, then one successful retry', t => {
  const { store: s, db, filename } = fixture(t, {}, true);
  db.pragma('busy_timeout=10'); const other = new Database(filename); t.after(() => other.close());
  const r = failed(s, null); const before = row(db, r.id);
  other.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => s.markStatusNoticeSuppressed(r.id, ownership(r)), { code: 'DB_BUSY', persisted: [] });
    assert.deepEqual(row(db, r.id), before);
  } finally { other.exec('ROLLBACK'); }
  assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r)), true);
  const saved = row(db, r.id); assert.equal(s.markStatusNoticeSuppressed(r.id, ownership(r)), false); assert.deepEqual(row(db, r.id), saved);
});
test('failure during suppression update rolls back both content append and delivery action', t => {
  const { store: s, db } = fixture(t); const r = failed(s); const before = row(db, r.id);
  db.exec("CREATE TRIGGER reject_suppression AFTER UPDATE ON conversations WHEN NEW.delivery_action='suppressed' BEGIN SELECT RAISE(ABORT,'suppression failed'); END");
  assert.throws(() => s.markStatusNoticeSuppressed(r.id, ownership(r)), { code: 'DB_WRITE_FAILED', persisted: [] });
  assert.deepEqual(row(db, r.id), before);
});
