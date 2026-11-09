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
  return { db, store: createStore(db, dependencies) };
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
  assert.equal(s.beginGroupDeletion('telegram', { ...options, operationId: 'second' }).operationId, op.operationId);
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
  const countsEstimated = s.markDeletionCleanup(options.operationId);
  assert.equal(countsEstimated, false);
  const audit = s.finalizeGroupDeletion('telegram', { operationId: options.operationId, countsEstimated,
    counts: { messages: 90, attachments: 3, files: 9 }, cleanup: () => ({ attachments: 0, files: 0 }) });
  assert.equal(audit.status, 'done'); assert.equal(audit.counts.messages, 2);
  assert.equal(audit.counts.attachments, 0); assert.equal(audit.counts.files, 0); assert.equal(audit.countsEstimated, false);
  assert.equal(s.getDrainFence('telegram'), null);
  assert.equal(db.prepare("SELECT count(*) AS n FROM slot_occupancy WHERE session_group='telegram'").get().n, 0);
  assert.equal(db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get('telegram').head_id, pending.id);
  assert.equal(s.claimConversation(pending.id), true);
  assert.equal(s.claimControl(unbound.id), true);
  assert.equal(db.prepare('SELECT content FROM conversations WHERE id=?').get(other.id).content, 'not this group');
  assert.equal(db.prepare("SELECT count(*) AS n FROM control_queue WHERE session_group='telegram'").get().n, 1);
  const recreated = s.insertConversation('out', 'telegram', 'room', 'new generation');
  assert.equal(s.beginGroupDeletion('telegram', options).status, 'done');
  assert.equal(s.finalizeGroupDeletion('telegram', { operationId: options.operationId }).status, 'done');
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
  s.finalizeGroupDeletion('dashboard:empty', { operationId: op.operationId });
  assert.equal(db.prepare('SELECT count(*) AS n FROM group_heads').get().n, 0);
});

test('draft deletion shares the audit without inventing a group and refuses a new message', t => {
  const { db, store: s } = fixture(t);
  const op = s.beginDraftDeletion('draft-id', options);
  assert.equal(op.sessionGroup, null); assert.equal(op.draftLocalId, 'draft-id');
  assert.equal(s.listDrainFences().length, 0);
  assert.equal(s.finalizeDraftDeletion('draft-id', { operationId: op.operationId, cleanup: () => ({ files: 1 }) }).counts.files, 1);
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

test('ending constraint rebuild retains user rows with cascading foreign keys', t => {
  const db = new Database(':memory:'); t.after(() => db.close());
  seedV1(db); migrateToV2(db); db.pragma('user_version=2'); db.pragma('foreign_keys=ON');
  db.exec(`INSERT INTO run_endings(session_group,run_id,reason,ended_at) VALUES('telegram','old','ttl',1);
    CREATE TABLE local_ending_notes(id INTEGER PRIMARY KEY,session_group TEXT REFERENCES run_endings(session_group) ON DELETE CASCADE,note TEXT);
    INSERT INTO local_ending_notes VALUES(1,'telegram','retained user note');`);
  migrateDatabase(db, owner, { allowExtraTables: true, allowExtraColumns: true });
  assert.equal(db.pragma('user_version', { simple: true }), owner.SUPPORTED_SCHEMA_VERSION);
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.prepare('SELECT note FROM local_ending_notes WHERE id=1').get().note, 'retained user note');
  assert.equal(db.prepare('PRAGMA foreign_key_check').get(), undefined);
  // Restored enforcement still owns normal post-migration cascade behavior.
  db.prepare('DELETE FROM run_endings WHERE session_group=?').run('telegram');
  assert.equal(db.prepare('SELECT count(*) AS n FROM local_ending_notes').get().n, 0);
});


test('a reopened database resumes one audit and keeps fenced-era input for the next generation', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delete-reopen-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'c4.db');
  const first = fixture(t, new Database(file));
  first.store.insertConversation('out', 'telegram', 'room', 'old');
  first.store.beginGroupDeletion('telegram', options);
  const later = first.store.insertConversation('in', 'telegram', 'room', 'queued during deletion');
  assert.equal(first.store.markDeletionCleanup(options.operationId), false);
  first.db.close();
  const next = fixture(t, new Database(file));
  assert.equal(next.store.getActiveDeletion('telegram').operationId, options.operationId);
  assert.equal(next.store.claimConversation(later.id), false);
  const countsEstimated = next.store.markDeletionCleanup(options.operationId);
  assert.equal(countsEstimated, true);
  const result = next.store.finalizeGroupDeletion('telegram', { operationId: options.operationId, countsEstimated });
  assert.equal(result.counts.attachments, 0); assert.equal(result.counts.files, 0); assert.equal(result.countsEstimated, true);
  assert.equal(next.db.prepare('SELECT count(*) AS n FROM group_deletion_audit').get().n, 1);
  assert.equal(next.store.claimConversation(later.id), true);
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
  const { store: s } = fixture(t);
  s.insertConversation('out', 'telegram', 'room', 'old');
  s.beginGroupDeletion('telegram', { ...options, preview: { messages: 900, attachments: 40, files: 80 } });
  assert.equal(s.getGroupDeletionAudit(options.operationId).countsEstimated, false);
  assert.equal(s.markDeletionCleanup(options.operationId), false);
  assert.throws(() => s.finalizeGroupDeletion('telegram', { operationId: options.operationId, cleanup() { throw new Error('interrupted after unlink'); } }), { code: 'DB_WRITE_FAILED' });
  assert.equal(s.getGroupDeletionAudit(options.operationId).countsEstimated, true);
  assert.equal(s.getGroupDeletionAudit(options.operationId).counts.files, 0);
  const estimated = s.markDeletionCleanup(options.operationId);
  const done = s.finalizeGroupDeletion('telegram', { operationId: options.operationId, countsEstimated: estimated, cleanup: () => ({ attachments: 0, files: 2 }) });
  assert.equal(done.countsEstimated, true); assert.equal(done.counts.messages, 1); assert.equal(done.counts.attachments, 0); assert.equal(done.counts.files, 2);
  assert.equal(s.finalizeGroupDeletion('telegram', { operationId: options.operationId }).countsEstimated, true);
  assert.throws(() => s.markDeletionCleanup(options.operationId), { code: 'DELETION_OWNERSHIP_MISMATCH' });
});

test('draft counts report current cleanup only and retain uncertainty across an interruption', t => {
  const { store: s } = fixture(t);
  s.beginDraftDeletion('draft-id', { ...options, preview: { attachments: 100, files: 200 } });
  assert.equal(s.markDeletionCleanup(options.operationId), false);
  assert.throws(() => s.finalizeDraftDeletion('draft-id', { operationId: options.operationId, cleanup() { throw new Error('interrupted'); } }), { code: 'DB_WRITE_FAILED' });
  const estimated = s.markDeletionCleanup(options.operationId);
  const done = s.finalizeDraftDeletion('draft-id', { operationId: options.operationId, countsEstimated: estimated,
    counts: { messages: 99, attachments: 100, files: 200 }, cleanup: () => ({ attachments: 0, files: 1 }) });
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
