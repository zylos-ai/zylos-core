import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { seedV1, oldRows, snapshot } from './helpers/c4-v2-fixtures.js';

test('DM-55 historical v1 over-bound checkpoint survives migration and reports exact IB-62 facts without writes', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db, { extensions: true });
  const max = db.prepare('SELECT MAX(id) AS id FROM conversations').get().id;
  const last = db.prepare('SELECT id FROM checkpoints ORDER BY id DESC LIMIT 1').get().id;
  db.prepare('UPDATE checkpoints SET end_conversation_id=? WHERE id=?').run(max + 1000, last);
  const historical = oldRows(db);
  guardDatabase(db, owner);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.deepEqual(oldRows(db), historical, 'migration must not clamp historical end or rewrite old fields');
  const store = createStore(db), before = snapshot(db), changes = db.prepare('SELECT total_changes() AS n').get().n;
  db.pragma('query_only = ON');
  const expected = [{ checkpointId: last, end: max + 1000, maxConversationId: max, affected: { B: max + 1000, coverageAll: max + 1000 }, repairRequired: true }];
  for (let i = 0; i < 3; i++) assert.deepEqual(store.auditCheckpoints(), expected);
  assert.equal(db.prepare('SELECT total_changes() AS n').get().n, changes);
  assert.deepEqual(snapshot(db), before);
  assert.equal(db.inTransaction, false);
});
test('DM-55 healthy migrated historical database audits empty and preserves initial NULL end', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); seedV1(db);
  const historical = oldRows(db); guardDatabase(db, owner); db.pragma('query_only = ON');
  assert.deepEqual(createStore(db).auditCheckpoints(), []); assert.deepEqual(oldRows(db), historical);
});
test('IB-62 audit distinguishes latest baseline from global maximum coverage across multiple bad rows', t => {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  db.prepare("INSERT INTO conversations(id,direction,channel,content,status) VALUES(7,'out','foo','x','delivered')").run();
  db.prepare("INSERT INTO checkpoints(id,summary,end_conversation_id,session_group,no_content) VALUES(100,'old',2000,'*',0),(101,'last',1000,'*',0)").run();
  const before = snapshot(db); db.pragma('query_only = ON');
  assert.deepEqual(createStore(db).auditCheckpoints(), [
    { checkpointId: 100, end: 2000, maxConversationId: 7, affected: { B: 1000, coverageAll: 2000 }, repairRequired: true },
    { checkpointId: 101, end: 1000, maxConversationId: 7, affected: { B: 1000, coverageAll: 2000 }, repairRequired: true },
  ]);
  assert.deepEqual(snapshot(db), before);
});
