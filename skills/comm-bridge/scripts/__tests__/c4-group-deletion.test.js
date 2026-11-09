import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

test('absent groups are fenced and delete endings never request automatic continuation', t => {
  const { db, store: s } = fixture(t);
  const op = s.beginGroupDeletion('dashboard:empty', { ...options, runId: null });
  const fence = s.getDrainFence('dashboard:empty');
  assert.equal(fence.runId, op.operationId);
  s.recordRunEnd('dashboard:empty', { runId: fence.runId, reason: 'delete', clearFence: true });
  assert.equal(s.listPendingContinuations().length, 0);
  assert.equal(s.getDrainFence('dashboard:empty').reason, 'delete');
  const done = s.finalizeGroupDeletion('dashboard:empty', { operationId: op.operationId });
  assert.equal(done.retainedMessages, 0); assert.equal(done.groupDataRetained, false);
  assert.equal(db.prepare('SELECT count(*) AS n FROM group_heads').get().n, 0);
});

test('draft deletion shares the audit without inventing a group and refuses a new message', t => {
  const { db, store: s } = fixture(t);
  const op = s.beginDraftDeletion('draft-id', options);
  assert.equal(op.sessionGroup, null); assert.equal(op.draftLocalId, 'draft-id');
  assert.equal(s.listDrainFences().length, 0);
  const done = s.finalizeDraftDeletion('draft-id', { operationId: op.operationId, cleanup: () => ({ files: 1 }) });
  assert.equal(done.counts.files, 1); assert.equal(done.retainedMessages, 0); assert.equal(done.groupDataRetained, false);
  const next = s.beginDraftDeletion('new-id', { ...options, operationId: 'next' });
  s.insertConversation('in', 'dashboard', 'new-id', 'new message', { groupName: 'new-id' });
  assert.throws(() => s.finalizeDraftDeletion('new-id', { operationId: next.operationId }), { code: 'DRAFT_BECAME_ACTIVE' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM group_deletion_audit').get().n, 2);
});

test('migration chain reaches deletion schema from historical layouts with user extensions intact', t => {
  for (const historical of ['c4-v0.1.0.sql', 'c4-v0.9.0-v1.sql']) {
    const db = new Database(':memory:'); t.after(() => { if (db.open) db.close(); });
    db.exec(fs.readFileSync(new URL(`./fixtures/migration-history/${historical}`, import.meta.url), 'utf8'));
    db.exec("CREATE TABLE local_notes(value TEXT); INSERT INTO local_notes VALUES('keep'); ALTER TABLE conversations ADD COLUMN local_tag TEXT");
    migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true });
    assert.equal(db.pragma('user_version', { simple: true }), 3);
    assert.ok(db.prepare('PRAGMA table_info(group_deletion_audit)').all().some(row => row.name === 'retained_messages'));
    assert.equal(db.prepare('SELECT value FROM local_notes').get().value, 'keep');
    assert.ok(db.prepare('PRAGMA table_info(conversations)').all().some(row => row.name === 'local_tag'));
    migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true }); assert.equal(db.pragma('user_version', { simple: true }), 3);
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

for (const foreignKeys of [0, 1]) test(`ending constraint rebuild refuses referencing foreign keys with enforcement ${foreignKeys}`, t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedV1(db); migrateToV2(db); db.pragma('user_version=2'); db.pragma(`foreign_keys=${foreignKeys}`);
  db.exec(`INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('telegram','old','ttl',1);
    CREATE TABLE local_ending_notes(id INTEGER PRIMARY KEY,session_group TEXT REFERENCES RUN_ENDINGS(session_group) ON DELETE CASCADE,note TEXT);
    INSERT INTO local_ending_notes VALUES(1,'telegram','retained user note');`);
  assert.throws(() => migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true }), /table "local_ending_notes" has a foreign key referencing run_endings/);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal(db.pragma('foreign_keys', { simple: true }), foreignKeys);
  assert.equal(db.prepare('SELECT note FROM local_ending_notes WHERE id=1').get().note, 'retained user note');
  assert.equal(db.prepare('SELECT run_id FROM run_endings').get().run_id, 'old');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='group_deletion_audit'").get(), undefined);
});

test('ending constraint rebuild leaves unrelated invalid foreign key data and enforcement unchanged', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedV1(db); migrateToV2(db); db.pragma('user_version=2'); db.pragma('foreign_keys=OFF');
  db.exec(`CREATE TABLE local_parents(id INTEGER PRIMARY KEY);
    CREATE TABLE local_children(parent_id INTEGER REFERENCES local_parents(id));
    INSERT INTO local_children VALUES(99);`);
  db.pragma('foreign_keys=ON');
  migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true });
  assert.equal(db.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.prepare('SELECT parent_id FROM local_children').get().parent_id, 99);
});

test('ending constraint rebuild refuses a user extension that references the same ending table', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedV1(db); migrateToV2(db); db.pragma('user_version=2'); db.pragma('foreign_keys=ON');
  db.exec(`ALTER TABLE run_endings ADD COLUMN previous_group TEXT REFERENCES run_endings(session_group);
    INSERT INTO run_endings(session_group,run_id,reason,ended_at,previous_group) VALUES('telegram','old','ttl',1,'telegram');`);
  assert.throws(() => migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true }), /table "run_endings" has a foreign key referencing run_endings/);
  assert.equal(db.pragma('user_version', { simple: true }), 2);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.prepare('SELECT run_id,previous_group FROM run_endings').get().run_id, 'old');
  assert.equal(db.prepare('SELECT previous_group FROM run_endings').get().previous_group, 'telegram');
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='group_deletion_audit'").get(), undefined);
});

test('a reopened database resumes one audit and keeps fenced-era input for the next generation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-reopen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'c4.db');
  const first = fixture(t, new Database(file));
  first.store.insertConversation('out', 'telegram', 'room', 'old');
  first.store.beginGroupDeletion('telegram', options);
  const later = first.store.insertConversation('in', 'telegram', 'room', 'queued during deletion');
  first.store.markDeletionCleanup(options.operationId);
  first.db.close();
  const next = fixture(t, new Database(file));
  assert.equal(next.store.getActiveDeletion('telegram').operationId, options.operationId);
  assert.equal(next.store.claimConversation(later.id), false);
  next.store.markDeletionCleanup(options.operationId);
  const result = next.store.finalizeGroupDeletion('telegram', { operationId: options.operationId });
  assert.equal(result.counts.attachments, 0); assert.equal(result.counts.files, 0); assert.equal(result.countsEstimated, true);
  assert.equal(next.db.prepare('SELECT count(*) AS n FROM group_deletion_audit').get().n, 1);
  assert.equal(next.store.claimConversation(later.id), true);
  next.db.close();
  const completed = fixture(t, new Database(file));
  completed.store.insertConversation('out', 'telegram', 'room', 'new after completion');
  const receipt = completed.store.finalizeGroupDeletion('telegram', { operationId: options.operationId });
  assert.equal(receipt.retainedMessages, 1); assert.equal(receipt.groupDataRetained, true);
});

test('draft checks use the Dashboard registered namespace rather than a same-name channel', t => {
  const { store: s } = fixture(t);
  s.registerChannelNamespace('other', 'dashboard');
  s.registerChannelNamespace('dashboard', 'dashboard-2');
  s.insertConversation('in', 'other', 'room', 'other channel', { groupName: 'same-id' });
  const draft = s.beginDraftDeletion('same-id', options);
  assert.equal(draft.draftLocalId, 'same-id');
  s.insertConversation('in', 'dashboard', 'room', 'real Dashboard', { groupName: 'same-id' });
  assert.throws(() => s.finalizeDraftDeletion('same-id', { operationId: draft.operationId }), { code: 'DRAFT_BECAME_ACTIVE' });
});

test('draft finalization rejects a mode transition that started after deletion began', t => {
  const { store: s } = fixture(t);
  const draft = s.beginDraftDeletion('draft-id', options);
  s.beginModeTransition('multi', 'single');
  let cleaned = false;
  assert.throws(() => s.finalizeDraftDeletion('draft-id', { operationId: draft.operationId, cleanup: () => { cleaned = true; } }), { code: 'TRANSITION_OPEN' });
  assert.equal(cleaned, false); assert.equal(s.getGroupDeletionAudit(draft.operationId).status, 'started');
});

test('cleanup confidence survives a failed file phase without filling counts from preview', t => {
  const { db, store: s } = fixture(t);
  s.insertConversation('out', 'telegram', 'room', 'old');
  s.beginGroupDeletion('telegram', { ...options, preview: { messages: 900, attachments: 40, files: 80 } });
  assert.equal(s.getGroupDeletionAudit(options.operationId).countsEstimated, false);
  s.markDeletionCleanup(options.operationId);
  assert.throws(() => s.finalizeGroupDeletion('telegram', { operationId: options.operationId, cleanup() { throw new Error('interrupted after unlink'); } }), { code: 'DB_WRITE_FAILED' });
  assert.equal(s.getGroupDeletionAudit(options.operationId).countsEstimated, false);
  assert.equal(db.prepare('SELECT cleanup_attempts FROM group_deletion_audit WHERE operation_id=?').get(options.operationId).cleanup_attempts, 1);
  assert.equal(s.getGroupDeletionAudit(options.operationId).counts.files, 0);
  s.markDeletionCleanup(options.operationId);
  const done = s.finalizeGroupDeletion('telegram', { operationId: options.operationId, cleanup: () => ({ attachments: 0, files: 2 }) });
  assert.equal(done.countsEstimated, true); assert.equal(done.counts.messages, 1); assert.equal(done.counts.attachments, 0); assert.equal(done.counts.files, 2);
  assert.equal(s.finalizeGroupDeletion('telegram', { operationId: options.operationId }).countsEstimated, true);
  assert.throws(() => s.markDeletionCleanup(options.operationId), { code: 'DELETION_OWNERSHIP_MISMATCH' });
});

test('draft counts report current cleanup only and retain uncertainty across an interruption', t => {
  const { store: s } = fixture(t);
  s.beginDraftDeletion('draft-id', { ...options, preview: { attachments: 100, files: 200 } });
  s.markDeletionCleanup(options.operationId);
  assert.throws(() => s.finalizeDraftDeletion('draft-id', { operationId: options.operationId, cleanup() { throw new Error('interrupted'); } }), { code: 'DB_WRITE_FAILED' });
  s.markDeletionCleanup(options.operationId);
  const done = s.finalizeDraftDeletion('draft-id', { operationId: options.operationId, counts: { messages: 99, attachments: 100, files: 200 }, cleanup: () => ({ attachments: 0, files: 1 }) });
  assert.equal(done.countsEstimated, true); assert.equal(done.counts.messages, 0); assert.equal(done.counts.attachments, 0); assert.equal(done.counts.files, 1);
});

test('cleanup confidence marking requires an active owned group or unchanged draft', t => {
  const { db, store: s } = fixture(t);
  assert.throws(() => s.markDeletionCleanup('missing'), { code: 'DELETION_OWNERSHIP_MISMATCH' });
  s.beginGroupDeletion('telegram', options);
  db.prepare("UPDATE drain_fences SET operation_id='foreign' WHERE session_group='telegram'").run();
  assert.throws(() => s.markDeletionCleanup(options.operationId), { code: 'DELETION_OWNERSHIP_MISMATCH' });
  assert.equal(s.getGroupDeletionAudit(options.operationId).countsEstimated, false);
  s.beginDraftDeletion('fresh-draft', { ...options, operationId: 'draft-operation' });
  s.insertConversation('in', 'dashboard', 'fresh-draft', 'new input', { groupName: 'fresh-draft' });
  assert.throws(() => s.markDeletionCleanup('draft-operation'), { code: 'DRAFT_BECAME_ACTIVE' });
  assert.equal(s.getGroupDeletionAudit('draft-operation').countsEstimated, false);
});

for (const target of ['group', 'draft']) {
  test(`${target} cleanup cannot clear uncertainty from another caller after its storage commit and Core rollback`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-confidence-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const file = path.join(root, 'c4.db');
    const first = fixture(t, new Database(file)), second = fixture(t, new Database(file));
    const storage = new Database(path.join(root, 'dashboard.db'));
    t.after(() => storage.close());
    storage.exec('CREATE TABLE attachments(id INTEGER PRIMARY KEY); INSERT INTO attachments VALUES(1)');
    const attachment = path.join(root, 'attachment.bin'); fs.writeFileSync(attachment, 'owned content');
    const s = first.store, other = second.store;
    const finalize = (store, values) => target === 'group' ? store.finalizeGroupDeletion('telegram', values) : store.finalizeDraftDeletion('draft-id', values);
    if (target === 'group') {
      s.insertConversation('out', 'telegram', 'room', 'old');
      s.beginGroupDeletion('telegram', options);
    } else s.beginDraftDeletion('draft-id', options);

    // Caller A pauses between its durable mark and final writer transaction.
    s.markDeletionCleanup(options.operationId);
    other.markDeletionCleanup(options.operationId);
    assert.throws(() => finalize(other, { operationId: options.operationId, cleanup() {
      storage.transaction(() => { storage.prepare('DELETE FROM attachments').run(); fs.unlinkSync(attachment); })();
      throw new Error('Core interrupted after Dashboard commit');
    } }), { code: 'DB_WRITE_FAILED' });
    assert.equal(storage.prepare('SELECT count(*) AS n FROM attachments').get().n, 0);
    assert.equal(fs.existsSync(attachment), false);
    assert.equal(s.getGroupDeletionAudit(options.operationId).status, 'started');
    assert.equal(first.db.prepare('SELECT cleanup_attempts FROM group_deletion_audit').get().cleanup_attempts, 2);
    if (target === 'group') {
      assert.equal(s.getDrainFence('telegram').reason, 'delete');
      assert.equal(first.db.prepare('SELECT count(*) AS n FROM conversations').get().n, 1);
    }

    // A resumes after the other attempt removed files and rolled back Core.
    // The durable attempt count prevents confidently reporting zero.
    const done = finalize(s, { operationId: options.operationId,
      cleanup: () => ({ attachments: storage.prepare('DELETE FROM attachments').run().changes, files: Number(fs.existsSync(attachment)) }) });
    assert.equal(done.status, 'done'); assert.equal(done.countsEstimated, true);
    assert.equal(done.counts.attachments, 0); assert.equal(done.counts.files, 0);
    assert.equal(done.counts.messages, target === 'group' ? 1 : 0);
    assert.equal(first.db.prepare('SELECT count(*) AS n FROM group_deletion_audit').get().n, 1);
    if (target === 'group') assert.equal(s.getDrainFence('telegram'), null);
  });
}

test('a retracted pre-file attempt leaves the remaining cleanup count exact', t => {
  const { store: s } = fixture(t);
  s.beginDraftDeletion('draft-id', options);
  s.markDeletionCleanup(options.operationId);
  s.markDeletionCleanup(options.operationId);
  s.retractDeletionCleanup(options.operationId);
  const done = s.finalizeDraftDeletion('draft-id', { operationId: options.operationId,
    cleanup: () => ({ attachments: 1, files: 1 }) });
  assert.equal(done.countsEstimated, false);
  assert.equal(done.counts.attachments, 1);
  s.retractDeletionCleanup(options.operationId);
  assert.equal(s.getGroupDeletionAudit(options.operationId).countsEstimated, false);
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

test('deletion admission rejects a cutoff beyond the group head without changing the database', t => {
  const { db, store: s } = fixture(t), group = 'telegram';
  const old = s.insertConversation('out', group, 'room', 'owned message');
  s.insertConversation('out', 'other', 'room', 'unrelated later message');
  const targetKey = JSON.stringify(['group', group]);
  const snapshot = db.serialize();
  for (const cutoffId of [old.id + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => s.beginGroupDeletion(group, { ...options, cutoffId }),
      { code: 'DELETION_PREVIEW_STALE' });
    assert.equal(db.serialize().equals(snapshot), true, 'every database byte must remain unchanged');
    assert.equal(s.getGroupDeletionAudit(options.operationId), null);
    assert.equal(s.getDrainFence(group), null);
  }
});

test('group deletion derives the target key from the group on the server', t => {
  const { store: s } = fixture(t), group = 'telegram';
  const old = s.insertConversation('out', group, 'room', 'owned message');
  const result = s.beginGroupDeletion(group, { ...options, cutoffId: old.id });
  assert.equal(result.targetKey, JSON.stringify(['group', group]));
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
