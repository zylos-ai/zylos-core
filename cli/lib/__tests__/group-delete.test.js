import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../../../skills/comm-bridge/scripts/sqlite-driver.js';
import * as schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import { createStore } from '../../../skills/comm-bridge/scripts/c4-v2-store.js';
import { createGroupDeletion } from '../group-delete.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), instance = path.join(home, 'zylos');
  fs.mkdirSync(instance, { recursive: true });
  const db = new Database(':memory:'); guardDatabase(db, schema);
  const store = createStore(db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  t.after(() => db.close());
  db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES('dashboard','dashboard')").run();
  let ready = options.ready ?? true, usageReady = options.usageReady ?? true, cleanups = 0;
  const participant = {
    resolveTarget: target => target.draftLocalId ? { localId: target.draftLocalId, namespace: 'dashboard', sessionGroup: null, draft: true } : { ...target, draft: false },
    preview: () => ({ attachments: 2, files: 0 }),
    finalizeTranscripts() { if (!usageReady) throw Object.assign(new Error('waiting'), { code: 'group_delete_usage_pending' }); },
    cleanup({ removeGroupSources, onFilePhase }) { cleanups++; onFilePhase?.(); removeGroupSources?.(); return { attachments: 2, files: 0 }; }, close() {},
  };
  const service = createGroupDeletion({ zylosDir: instance, homeDir: home, database: db, store,
    participant: options.noDashboard ? undefined : participant, waitMs: 100,
    requestStop: async request => {
      const audit = store.beginGroupDeletion(request.sessionGroup, { operationId: request.operationId, actor: request.actor, runId: 'run-one', preview: request.preview, cutoffId: request.cutoffId });
      if (ready) store.recordRunEnd(request.sessionGroup, { runId: audit.runId, reason: 'delete' });
      return { kind: 'accepted', sent: true, reply: { ok: true } };
    }, ...options.service });
  t.after(() => service.close());
  const rawDelete = service.delete;
  service.delete = (target, options = {}) => {
    const group = typeof target === 'string' ? target : target.sessionGroup;
    const targetKey = JSON.stringify(group ? ['group', group] : ['draft', 'dashboard', target.draftLocalId]);
    const known = options.operationId && store.getGroupDeletionAudit(options.operationId);
    const confirmation = known ? {} : { ...store.getDeletionPreviewBoundary(targetKey) };
    return rawDelete(target, { ...confirmation, ...options });
  };
  const insert = (id, group, direction, status) => {
    db.prepare('INSERT INTO conversations(id,session_group,direction,channel,endpoint_id,content,status) VALUES(?,?,?,?,?,?,?)')
      .run(id, group, direction, 'telegram', 'fixture', `body-${id}`, status);
    db.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET head_id=excluded.head_id').run(group, id);
  };
  return { root, home, instance, db, store, service, rawDelete, participant, insert,
    ready: value => { ready = value; }, usageReady: value => { usageReady = value; }, cleanups: () => cleanups };
}

test('Origin and unconfirmed deletion reject before admission or cleanup', async t => {
  const f = fixture(t);
  await assert.rejects(f.service.preview('origin'), { code: 'ORIGIN_DELETE_FORBIDDEN' });
  await assert.rejects(f.service.delete('telegram:one', { actor: 'owner' }), { code: 'CONFIRMATION_REQUIRED' });
  assert.equal(f.cleanups(), 0); assert.equal(f.store.listDrainFences().length, 0);
});

test('deletion keeps pending input and its head while removing only the owned conversation files', async t => {
  const f = fixture(t), group = 'telegram:one';
  f.insert(1, group, 'in', 'delivered'); f.insert(2, group, 'out', 'delivered');
  f.insert(3, group, 'in', 'pending'); f.insert(4, 'telegram:two', 'in', 'delivered');
  for (const id of [1, 2, 3, 4]) {
    const dir = path.join(f.instance, 'comm-bridge/attachments', `conv-${id}`);
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'message.txt'), `private-${id}`);
  }
  const memory = path.join(f.instance, 'memory/session-groups', group);
  fs.mkdirSync(memory, { recursive: true }); fs.writeFileSync(path.join(memory, 'state.md'), 'group memory');
  const result = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'confirmed-one' });
  assert.equal(result.pending, false); assert.equal(result.counts.messages, 2);
  assert.equal(result.retainedMessages, 1); assert.equal(result.groupDataRetained, true);
  assert.equal(result.counts.attachments, 2); assert.equal(result.counts.files, 2);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE session_group=?').get(group).n, 1);
  assert.equal(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(group).head_id, 3);
  assert.equal(fs.existsSync(memory), true);
  for (const id of [1, 2]) assert.equal(fs.existsSync(path.join(f.instance, 'comm-bridge/attachments', `conv-${id}`)), false);
  for (const id of [3, 4]) assert.equal(fs.existsSync(path.join(f.instance, 'comm-bridge/attachments', `conv-${id}/message.txt`)), true);
  assert.equal(f.store.getGroupDeletionAudit(result.operationId).status, 'done');
  assert.equal(f.store.getDrainFence(group), null);
  // A retried response from the completed generation must not delete a new one.
  f.insert(5, group, 'in', 'delivered');
  const again = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'confirmed-one' });
  assert.equal(again.pending, false); assert.equal(f.db.prepare('SELECT 1 FROM conversations WHERE id=5').get() !== undefined, true);
  assert.equal(again.retainedMessages, 1); assert.equal(again.groupDataRetained, true);
  assert.equal(f.cleanups(), 1);
});

test('a failure after unlink rolls back Core rows and a stateless retry finishes without counting twice', async t => {
  let fail = true;
  const f = fixture(t, { service: { onStage(stage) { if (stage === 'files_removed' && fail) throw Object.assign(new Error('fixture failure'), { code: 'FIXTURE_STOP' }); } } });
  const group = 'telegram:one'; f.insert(1, group, 'in', 'delivered');
  const dir = path.join(f.instance, 'memory/session-groups', group); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'state.md'), 'owned');
  await assert.rejects(f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'retry-op' }));
  assert.equal(fs.existsSync(dir), false); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  assert.equal(f.store.getActiveDeletion(group).operationId, 'retry-op');
  fail = false;
  const result = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'retry-op' });
  assert.equal(result.counts.files, 0); assert.equal(result.counts.messages, 1); assert.equal(result.pending, false);
  assert.equal(result.countsEstimated, true);
});

test('deletion refuses an aliased group-memory owner without touching its target', async t => {
  const f = fixture(t), group = 'telegram:one'; f.insert(1, group, 'in', 'delivered');
  const other = path.join(f.root, 'other'); fs.mkdirSync(other); fs.writeFileSync(path.join(other, 'state.md'), 'keep');
  const memory = path.join(f.instance, 'memory'); fs.symlinkSync(other, memory);
  await assert.rejects(f.service.preview(group), { code: 'GROUP_DELETE_PATH_INVALID' });
  assert.equal(fs.readFileSync(path.join(other, 'state.md'), 'utf8'), 'keep');
});



test('confirmed cutoffs preserve later delivered messages and reject another preview after deletion', async t => {
  const f = fixture(t), group = 'telegram:one';
  f.insert(1, group, 'in', 'delivered');
  const first = await f.service.preview(group), second = await f.service.preview(group);
  assert.equal(first.cutoffId, 1);
  assert.notEqual(first.operationId, second.operationId);
  const memory = path.join(f.instance, 'memory/session-groups', group);
  fs.mkdirSync(memory, { recursive: true }); fs.writeFileSync(path.join(memory, 'state.md'), 'keep later context');
  const overflow = path.join(f.instance, 'comm-bridge/attachments/conv-2');
  fs.mkdirSync(overflow, { recursive: true }); fs.writeFileSync(path.join(overflow, 'message.txt'), 'later overflow');
  f.insert(2, group, 'in', 'delivered');
  const later = f.db.prepare('SELECT * FROM conversations WHERE id=2').get();
  const result = await f.rawDelete(group, { ...first, confirmed: true, actor: 'owner' });
  assert.equal(result.counts.messages, 1);
  assert.equal(result.retainedMessages, 1); assert.equal(result.groupDataRetained, true);
  assert.deepEqual(f.db.prepare('SELECT * FROM conversations WHERE id=2').get(), later);
  assert.equal(fs.readFileSync(path.join(memory, 'state.md'), 'utf8'), 'keep later context');
  assert.equal(fs.readFileSync(path.join(overflow, 'message.txt'), 'utf8'), 'later overflow');
  const before = f.db.prepare('SELECT count(*) AS n FROM group_deletion_audit').get().n;
  // No new audit/fence or cleanup is allowed for a different tab's old epoch.
  await assert.rejects(f.rawDelete(group, { ...second, confirmed: true, actor: 'owner' }), { code: 'DELETION_PREVIEW_STALE' });
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM group_deletion_audit').get().n, before);
  assert.equal(f.store.getDrainFence(group), null); assert.equal(f.cleanups(), 1);
  assert.deepEqual(f.db.prepare('SELECT * FROM conversations WHERE id=2').get(), later);
  assert.equal((await f.rawDelete(group, { operationId: first.operationId, confirmed: true, actor: 'owner' })).pending, false);
  assert.deepEqual(f.db.prepare('SELECT * FROM conversations WHERE id=2').get(), later);
  const fresh = await f.service.preview(group);
  assert.equal(fresh.cutoffId, 2);
  assert.equal((await f.rawDelete(group, { ...fresh, confirmed: true, actor: 'owner' })).counts.messages, 1);
});

test('fresh deletion requires its preview boundary and an active retry cannot widen it', async t => {
  const f = fixture(t, { ready: false }), group = 'telegram:one'; f.insert(1, group, 'out', 'delivered');
  await assert.rejects(f.rawDelete(group, { confirmed: true, actor: 'owner', operationId: 'no-preview' }), { code: 'DELETION_CONFIRMATION_REQUIRED' });
  const preview = await f.service.preview(group);
  const first = await f.rawDelete(group, { ...preview, confirmed: true, actor: 'owner' });
  f.insert(2, group, 'out', 'delivered');
  const retryPreview = await f.service.preview(group);
  assert.equal(retryPreview.operationId, preview.operationId); assert.equal(retryPreview.cutoffId, 1);
  await assert.rejects(f.rawDelete(group, { ...preview, cutoffId: 2, confirmed: true, actor: 'owner' }), { code: 'DELETION_OWNERSHIP_MISMATCH' });
  await assert.rejects(f.rawDelete(group, { ...preview, operationId: 'another-op', confirmed: true, actor: 'owner' }), { code: 'DELETION_OWNERSHIP_MISMATCH' });
  f.ready(true);
  assert.equal((await f.rawDelete(group, { operationId: first.operationId, confirmed: true, actor: 'owner' })).counts.messages, 1);
  assert.ok(f.db.prepare('SELECT 1 FROM conversations WHERE id=2').get());
});




test('conversation cleanup counts nested links without deleting their external destinations', async t => {
  const f = fixture(t), group = 'telegram:one';
  f.insert(1, group, 'in', 'delivered');
  const memory = path.join(f.instance, 'memory/session-groups', group);
  const outside = path.join(f.root, 'outside-file');
  fs.mkdirSync(memory, { recursive: true }); fs.writeFileSync(outside, 'must remain');
  fs.writeFileSync(path.join(memory, 'state.md'), 'owned');
  fs.symlinkSync(outside, path.join(memory, 'linked'));
  const preview = await f.service.preview(group);
  assert.equal(preview.files, 2);
  const result = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'nested-link-cleanup' });
  assert.equal(result.pending, false); assert.equal(result.counts.files, 2);
  assert.equal(fs.existsSync(memory), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'must remain');
});

// Root bypasses chmod access checks; the shared helper's permission test
// runs a real unprivileged child for that environment. This caller case uses
// the current unprivileged account and its actual permission boundary.
test('unreadable conversation memory prevents deletion of every source file',
  { skip: process.getuid?.() === 0 ? 'Caller permission check requires an unprivileged account; shared helper covers root via a child' : false }, async t => {
  const f = fixture(t), group = 'telegram:one'; f.insert(1, group, 'in', 'delivered');
  const memory = path.join(f.instance, 'memory/session-groups', group);
  const locked = path.join(memory, 'locked');
  fs.mkdirSync(locked, { recursive: true });
  fs.writeFileSync(path.join(memory, 'visible'), 'keep visible');
  fs.writeFileSync(path.join(locked, 'hidden'), 'keep hidden');
  fs.chmodSync(locked, 0);
  try {
    await assert.rejects(f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'unreadable-cleanup' }), error => ['EACCES', 'EPERM'].includes(error.code));
  } finally { fs.chmodSync(locked, 0o700); }
  assert.equal(fs.readFileSync(path.join(memory, 'visible'), 'utf8'), 'keep visible');
  assert.equal(fs.readFileSync(path.join(locked, 'hidden'), 'utf8'), 'keep hidden');
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
});
