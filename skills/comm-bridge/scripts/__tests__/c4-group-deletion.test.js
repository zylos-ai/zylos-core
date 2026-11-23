import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import * as owner from '../c4-schema.js';
import { guardDatabase, migrateDatabase } from '../sqlite-schema.js';
import { createStore } from '../c4-v2-store.js';
import { migrateToV2 } from '../c4-migrations-v2.js';
import { seedV1 } from './helpers/c4-v2-fixtures.js';

function fixture(t, db = new Database(':memory:')) {
  guardDatabase(db, owner);
  t.after(() => { if (db.open) db.close(); });
  const dependencies = { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) };
  const store = createStore(db, dependencies);
  // Existing state-machine cases confirm the current snapshot at admission.
  // Boundary-specific cases supply the earlier snapshot explicitly.
  const beginGroup = store.beginGroupDeletion, beginDraft = store.beginDraftDeletion;
  store.beginGroupDeletion = (group, options) => {
    const targetKey = JSON.stringify(['group', group]);
    return beginGroup(group, { ...store.getDeletionPreviewBoundary(targetKey), ...options });
  };
  store.beginDraftDeletion = (localId, options) => {
    let namespace = db.prepare("SELECT namespace FROM channel_namespaces WHERE component_name='dashboard'").get()?.namespace;
    if (!namespace) { namespace = 'dashboard'; db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES('dashboard','dashboard')").run(); }
    const targetKey = JSON.stringify(['draft', namespace, localId]);
    return beginDraft(localId, { ...store.getDeletionPreviewBoundary(targetKey), targetKey, ...options });
  };
  return { db, store };
}
const options = { operationId: 'delete-test', actor: 'password:owner', runId: 'old-run', preview: { messages: 2, attachments: 1, files: 3 } };
const binding = runId => JSON.stringify({ expectedRunId: runId, tmuxTarget: { serverGeneration: 'g', sessionId: '$0', paneId: '%0' } });

test('deletion admission preserves pending inputs and fences input and control claims', t => {
  const { db, store: s } = fixture(t);
  const before = s.insertConversation('in', 'telegram', 'room', 'queued before');
  const terminal = s.insertConversation('out', 'telegram', 'room', 'old reply');
  const control = s.insertControl('new pending', { sessionGroup: 'telegram', appendAckSuffix: false });
  const op = s.beginGroupDeletion('telegram', options);
  const after = s.insertConversation('in', 'telegram', 'room', 'queued during');
  assert.equal(s.claimConversation(before.id), false);
  assert.equal(s.claimConversation(after.id), false);
  assert.equal(s.claimControl(control.id), false);
  assert.equal(s.listDeletionMessages('telegram', { operationId: op.operationId }).length, 1);
  assert.equal(s.listDeletionMessages('telegram', { operationId: op.operationId })[0].id, terminal.id);
  assert.equal(db.prepare("SELECT operation_id,actor FROM drain_fences WHERE session_group='telegram'").get().actor, options.actor);
  assert.throws(() => s.beginModeTransition('multi', 'single'), { code: 'DELETION_IN_PROGRESS' });
  assert.throws(() => s.beginGroupDeletion('telegram', { ...options, operationId: 'second' }), { code: 'DELETION_OWNERSHIP_MISMATCH' });
});

test('finalization deletes terminal group data, releases capacity and retains queued work and unrelated groups', t => {
  const { db, store: s } = fixture(t);
  const finished = s.insertConversation('in', 'telegram', 'room', 'finished');
  s.claimConversation(finished.id); s.markDelivered(finished.id, { sessionId: 'sid' });
  s.insertConversation('out', 'telegram', 'room', 'reply');
  const other = s.insertConversation('out', 'other', 'room', 'not this group');
  s.beginGroupDeletion('telegram', options);
  const pending = s.insertConversation('in', 'telegram', 'room', 'keep');
  const unbound = s.insertControl('keep new control', { sessionGroup: 'telegram', appendAckSuffix: false });
  s.insertControl('old control', { sessionGroup: 'telegram', targetBinding: binding('old-run'), appendAckSuffix: false });
  db.exec("INSERT INTO slot_occupancy VALUES('telegram','old-run','held',9999999999,1)");
  s.markDeletionCleanup(options.operationId);
  const audit = s.finalizeGroupDeletion('telegram', { operationId: options.operationId,
    counts: { messages: 90, attachments: 3, files: 9 }, cleanup: () => ({ attachments: 0, files: 0 }) });
  assert.equal(audit.status, 'done'); assert.equal(audit.counts.messages, 2);
  assert.equal(audit.retainedMessages, 1); assert.equal(audit.groupDataRetained, true);
  assert.equal(audit.counts.attachments, 0); assert.equal(audit.counts.files, 0); assert.equal(audit.countsEstimated, false);
  assert.equal(s.getDrainFence('telegram'), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM slot_occupancy WHERE session_group='telegram'").get().n, 1);
  assert.equal(db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get('telegram').head_id, pending.id);
  assert.equal(s.claimConversation(pending.id), true);
  assert.equal(s.claimControl(unbound.id), true);
  assert.equal(db.prepare('SELECT content FROM conversations WHERE id=?').get(other.id).content, 'not this group');
  assert.equal(db.prepare("SELECT count(*) AS n FROM control_queue WHERE session_group='telegram'").get().n, 2);
  const recreated = s.insertConversation('out', 'telegram', 'room', 'new generation');
  assert.equal(s.beginGroupDeletion('telegram', options).status, 'done');
  const retried = s.finalizeGroupDeletion('telegram', { operationId: options.operationId });
  assert.equal(retried.status, 'done'); assert.equal(retried.retainedMessages, 1); assert.equal(retried.groupDataRetained, true);
  assert.ok(db.prepare('SELECT 1 FROM conversations WHERE id=?').get(recreated.id));
});

test('failed cleanup leaves the same audit and fence for retry without reopening claims', t => {
  const { db, store: s } = fixture(t);
  s.insertConversation('out', 'telegram', 'room', 'old');
  s.beginGroupDeletion('telegram', options);
  assert.throws(() => s.finalizeGroupDeletion('telegram', { operationId: options.operationId, cleanup() { throw new Error('storage unavailable'); } }), { code: 'DB_WRITE_FAILED' });
  assert.equal(s.getActiveDeletion('telegram').operationId, options.operationId);
  assert.equal(s.getGroupDeletionAudit(options.operationId).status, 'started');
  assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
  assert.throws(() => s.clearDrainFence('telegram'), { code: 'FENCE_MISMATCH' });
  assert.equal(s.finalizeGroupDeletion('telegram', { operationId: options.operationId }).status, 'done');
});

test('origin, mode transition, ownership changes and in-flight work reject deletion', t => {
  const { db, store: s } = fixture(t);
  assert.throws(() => s.beginGroupDeletion('origin', options), { code: 'ORIGIN_DELETE_FORBIDDEN' });
  const transition = s.beginModeTransition('multi', 'single');
  assert.throws(() => s.beginGroupDeletion('telegram', options), { code: 'TRANSITION_OPEN' });
  db.prepare('DELETE FROM mode_transitions WHERE run_id=?').run(transition.runId);
  const row = s.insertConversation('in', 'telegram', 'room', 'running'); s.claimConversation(row.id);
  s.beginGroupDeletion('telegram', options);
  assert.throws(() => s.finalizeGroupDeletion('telegram', { operationId: options.operationId }), { code: 'DELETION_INFLIGHT' });
  s.markDelivered(row.id);
  const control = s.insertControl('running old control', { sessionGroup: 'telegram', appendAckSuffix: false });
  db.prepare("UPDATE control_queue SET status='running' WHERE id=?").run(control.id);
  assert.throws(() => s.finalizeGroupDeletion('telegram', { operationId: options.operationId }), { code: 'DELETION_INFLIGHT' });
  assert.throws(() => s.finalizeGroupDeletion('telegram', { operationId: 'wrong' }), { code: 'DELETION_OWNERSHIP_MISMATCH' });
});

test('migration chain reaches deletion schema from historical layouts with user extensions intact', t => {
  for (const historical of ['c4-v0.1.0.sql', 'c4-v0.9.0-v1.sql']) {
    const db = new Database(':memory:'); t.after(() => { if (db.open) db.close(); });
    db.exec(fs.readFileSync(new URL(`./fixtures/migration-history/${historical}`, import.meta.url), 'utf8'));
    db.exec("CREATE TABLE local_notes(value TEXT); INSERT INTO local_notes VALUES('keep'); ALTER TABLE conversations ADD COLUMN local_tag TEXT");
    migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true });
    assert.equal(db.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
    assert.ok(db.prepare('PRAGMA table_info(group_deletion_audit)').all().some(row => row.name === 'retained_messages'));
    assert.equal(db.prepare('SELECT value FROM local_notes').get().value, 'keep');
    assert.ok(db.prepare('PRAGMA table_info(conversations)').all().some(row => row.name === 'local_tag'));
    migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true }); assert.equal(db.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
  }
});

test('ending constraint rebuild preserves user columns, generated columns, indexes, triggers and views', t => {
  const db = new Database(':memory:'); t.after(() => { if (db.open) db.close(); });
  seedV1(db, { extensions: true }); migrateToV2(db); db.pragma('user_version=2');
  db.exec(`ALTER TABLE run_endings ADD COLUMN local_tag TEXT NOT NULL DEFAULT 'extra';
    ALTER TABLE run_endings ADD COLUMN local_upper TEXT GENERATED ALWAYS AS (upper(local_tag)) VIRTUAL;
    INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('telegram','old','ttl',1);
    CREATE INDEX local_ending_idx ON run_endings(local_tag);
    CREATE TABLE local_ending_log(tag TEXT);
    CREATE TRIGGER local_ending_trigger AFTER INSERT ON run_endings BEGIN INSERT INTO local_ending_log VALUES(NEW.local_tag); END;
    CREATE VIEW local_ending_view AS SELECT local_tag,local_upper FROM run_endings;`);
  migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true });
  assert.equal(db.prepare('SELECT local_tag,local_upper FROM local_ending_view').get().local_upper, 'EXTRA');
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_ending_idx'").get());
  db.exec("INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('dashboard:a','new','delete',2)");
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_ending_log').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM run_endings').get().n, 2);
});

test('the final writer enforces a confirmed cutoff and preserves retained group-wide data', t => {
  const { db, store: s } = fixture(t), group = 'telegram';
  const old = s.insertConversation('out', group, 'room', 'confirmed old row');
  const targetKey = JSON.stringify(['group', group]);
  const preview = s.getDeletionPreviewBoundary(targetKey);
  s.insertControl('keep control without a message cutoff', { sessionGroup: group, appendAckSuffix: false });
  db.prepare("UPDATE control_queue SET status='done' WHERE session_group=?").run(group);
  db.prepare("INSERT INTO group_runtime_overrides(session_group,runtime) VALUES(?,'claude')").run(group);
  db.prepare("INSERT INTO slot_occupancy VALUES(?,'old-run','held',9999999999,1)").run(group);
  const later = s.insertConversation('out', group, 'room', 'unconfirmed later row');
  const rowBefore = db.prepare('SELECT * FROM conversations WHERE id=?').get(later.id);
  const controlBefore = db.prepare('SELECT * FROM control_queue WHERE session_group=?').get(group);
  const slotBefore = db.prepare('SELECT * FROM slot_occupancy WHERE session_group=?').get(group);
  s.beginGroupDeletion(group, { ...options, ...preview });
  assert.deepEqual(s.listDeletionMessages(group, { operationId: options.operationId }).map(row => row.id), [old.id]);
  const done = s.finalizeGroupDeletion(group, { operationId: options.operationId });
  assert.equal(done.counts.messages, 1); assert.equal(done.cutoffId, old.id);
  assert.deepEqual(db.prepare('SELECT * FROM conversations WHERE id=?').get(later.id), rowBefore);
  assert.deepEqual(db.prepare('SELECT * FROM control_queue WHERE session_group=?').get(group), controlBefore);
  assert.deepEqual(db.prepare('SELECT * FROM slot_occupancy WHERE session_group=?').get(group), slotBefore);
  assert.equal(db.prepare('SELECT runtime FROM group_runtime_overrides WHERE session_group=?').get(group).runtime, 'claude');
  assert.throws(() => s.beginGroupDeletion(group, { ...options, ...preview, operationId: 'stale-second-preview' }), { code: 'DELETION_PREVIEW_STALE' });
  assert.deepEqual(db.prepare('SELECT * FROM conversations WHERE id=?').get(later.id), rowBefore);
  assert.equal(s.getDeletionPreviewBoundary(targetKey).cutoffId, later.id);
});

test('message identifiers never repeat after deletion or VACUUM', t => {
  const { db, store: s } = fixture(t);
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='conversations'").get().sql;
  assert.match(sql, /\bid\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i);
  const first = s.insertConversation('out', 'telegram', 'room', 'first');
  db.exec('DELETE FROM conversations');
  const second = s.insertConversation('out', 'telegram', 'room', 'second');
  assert.ok(second.id > first.id);
  db.exec('DELETE FROM conversations; VACUUM');
  assert.ok(s.insertConversation('out', 'telegram', 'room', 'third').id > second.id);
});
