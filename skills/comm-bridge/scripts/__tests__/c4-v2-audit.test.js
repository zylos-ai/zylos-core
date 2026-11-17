import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase, migrateDatabase } from '../sqlite-schema.js';
// Existing layouts are migrated only by the explicit upgrade path, with the
// options ordinary openers used before they became check-only.
const migrateExisting = (db, candidate) => migrateDatabase(db, candidate, { allowNew: candidate.supportsNewDatabase === true, strict: false });

import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';

test('historical v1 over-bound checkpoint survives migration and reports exact facts without writes', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db, { extensions: true });
  const max = db.prepare('SELECT MAX(id) AS id FROM conversations').get().id;
  const last = db.prepare('SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1').get().id;
  // The fixture replaced its original rows, so ids up to this one were assigned.
  const assigned = db.prepare("SELECT seq FROM sqlite_sequence WHERE name='conversations'").get().seq;
  assert.ok(assigned > max && assigned < max + 1000);
  db.prepare('UPDATE checkpoints SET end_conversation_id=? WHERE id=?').run(max + 1000, last);
  const historical = oldRows(db);
  migrateExisting(db, owner);
  assert.equal(db.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
  assert.deepEqual(oldRows(db), historical, 'migration must not clamp historical end or rewrite old fields');
  const store = createStore(db), before = snapshot(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
  db.pragma('query_only = ON');
  const expected = [{ checkpointId: last, end: max + 1000, maxConversationId: max, maxAssignedConversationId: assigned, affected: { B: max + 1000, coverageAll: max + 1000 }, repairRequired: true }];
  for (let i = 0; i < 3; i++) assert.deepEqual(store.auditCheckpoints(), expected);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.inTransaction, false);
});
test('healthy migrated historical database audits empty and preserves initial NULL end', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db);
  const historical = oldRows(db); migrateExisting(db, owner); db.pragma('query_only = ON');
  assert.deepEqual(createStore(db).auditCheckpoints(), []); assert.deepEqual(oldRows(db), historical);
});
test('audit distinguishes latest baseline from global maximum coverage across multiple bad rows', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  db.prepare("INSERT INTO conversations(id,direction,channel,content,status) VALUES(7,'out','foo','x','delivered')").run();
  db.prepare("INSERT INTO checkpoints(id,summary,end_conversation_id,session_group,no_content) VALUES(100,'old',2000,'*',0),(101,'last',1000,'*',0)").run();
  const before = snapshot(db); db.pragma('query_only = ON');
  assert.deepEqual(createStore(db).auditCheckpoints(), [
    { checkpointId: 100, end: 2000, maxConversationId: 7, maxAssignedConversationId: 7, affected: { B: 1000, coverageAll: 2000 }, repairRequired: true },
    { checkpointId: 101, end: 1000, maxConversationId: 7, maxAssignedConversationId: 7, affected: { B: 1000, coverageAll: 2000 }, repairRequired: true },
  ]);
  assert.deepEqual(snapshot(db), before);
});

// The real group-deletion path removes the newest messages while the global
// checkpoint still ends on them.
function deletedTail(t) {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  const store = createStore(db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  const kept = store.insertConversation('out', 'other', 'room', 'kept');
  const tail = store.insertConversation('out', 'telegram', 'room', 'deleted tail');
  store.createCheckpoint('*', tail.id, 'all history');
  const checkpointId = db.prepare("SELECT id FROM checkpoints WHERE session_group='*' ORDER BY id DESC LIMIT 1").get().id;
  const operationId = 'delete-tail', boundary = store.getDeletionPreviewBoundary(JSON.stringify(['group', 'telegram']));
  store.beginGroupDeletion('telegram', { ...boundary, operationId, actor: 'password:owner', preview: { messages: 1 } });
  store.finalizeGroupDeletion('telegram', { operationId });
  assert.equal(db.prepare('SELECT MAX(id) AS id FROM conversations').get().id, kept.id);
  return { db, store, kept, tail, checkpointId };
}
test('checkpoint ending on ids removed by group deletion needs no repair', t => {
  const { db, store, tail, checkpointId } = deletedTail(t);
  assert.equal(db.prepare('SELECT end_conversation_id AS n FROM checkpoints WHERE id=?').get(checkpointId).n, tail.id);
  const before = snapshot(db); db.pragma('query_only = ON');
  assert.deepEqual(store.auditCheckpoints(), []);
  assert.deepEqual(snapshot(db), before);
});
test('checkpoint ending past every id ever assigned still needs repair after group deletion', t => {
  const { db, store, kept, tail, checkpointId: id } = deletedTail(t);
  db.prepare('UPDATE checkpoints SET end_conversation_id=? WHERE id=?').run(tail.id + 1, id);
  db.pragma('query_only = ON');
  assert.deepEqual(store.auditCheckpoints(), [{ checkpointId: id, end: tail.id + 1, maxConversationId: kept.id, maxAssignedConversationId: tail.id,
    affected: { B: tail.id + 1, coverageAll: tail.id + 1 }, repairRequired: true }]);
});
