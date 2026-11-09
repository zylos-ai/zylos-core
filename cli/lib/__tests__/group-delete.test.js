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
import { runGroupDeletionCli } from '../group-delete-cli.js';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'group-delete-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), instance = path.join(home, 'zylos');
  fs.mkdirSync(instance, { recursive: true });
  const db = new Database(':memory:'); guardDatabase(db, schema);
  const store = createStore(db, { readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
  t.after(() => db.close());
  let ready = options.ready ?? true, usageReady = options.usageReady ?? true, cleanups = 0;
  const participant = {
    resolveTarget: target => target.draftLocalId ? { localId: target.draftLocalId, sessionGroup: null, draft: true } : { ...target, draft: false },
    preview: () => ({ attachments: 2, files: 0 }),
    finalizeTranscripts() { if (!usageReady) throw Object.assign(new Error('waiting'), { code: 'group_delete_usage_pending' }); },
    cleanup({ removeGroupSources }) { cleanups++; removeGroupSources?.(); return { attachments: 2, files: 0 }; }, close() {},
  };
  const service = createGroupDeletion({ zylosDir: instance, homeDir: home, database: db, store,
    participant: options.noDashboard ? undefined : participant, waitMs: 0,
    requestStop: async request => {
      const audit = store.beginGroupDeletion(request.sessionGroup, { operationId: request.operationId, actor: request.actor, runId: 'run-one', preview: request.preview });
      if (ready) store.recordRunEnd(request.sessionGroup, { runId: audit.runId, reason: 'delete' });
      return { kind: 'accepted', sent: true, reply: { ok: true } };
    }, ...options.service });
  t.after(() => service.close());
  const insert = (id, group, direction, status) => {
    db.prepare('INSERT INTO conversations(id,session_group,direction,channel,endpoint_id,content,status) VALUES(?,?,?,?,?,?,?)')
      .run(id, group, direction, 'telegram', 'fixture', `body-${id}`, status);
    db.prepare('INSERT INTO group_heads(session_group,head_id) VALUES(?,?) ON CONFLICT(session_group) DO UPDATE SET head_id=excluded.head_id').run(group, id);
  };
  return { root, home, instance, db, store, service, participant, insert,
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
  assert.equal(result.counts.attachments, 2); assert.equal(result.counts.files, 3);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE session_group=?').get(group).n, 1);
  assert.equal(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(group).head_id, 3);
  assert.equal(fs.existsSync(memory), false);
  for (const id of [1, 2]) assert.equal(fs.existsSync(path.join(f.instance, 'comm-bridge/attachments', `conv-${id}`)), false);
  for (const id of [3, 4]) assert.equal(fs.existsSync(path.join(f.instance, 'comm-bridge/attachments', `conv-${id}/message.txt`)), true);
  assert.equal(f.store.getGroupDeletionAudit(result.operationId).status, 'done');
  assert.equal(f.store.getDrainFence(group), null);
  // A retried response from the completed generation must not delete a new one.
  f.insert(5, group, 'in', 'delivered');
  const again = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'confirmed-one' });
  assert.equal(again.pending, false); assert.equal(f.db.prepare('SELECT 1 FROM conversations WHERE id=5').get() !== undefined, true);
  assert.equal(f.cleanups(), 1);
});

test('a draining conversation remains fenced and retry resumes its original audit', async t => {
  const f = fixture(t, { ready: false }), group = 'telegram:one';
  f.insert(1, group, 'in', 'delivered');
  const first = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'first-request' });
  assert.equal(first.pending, true); assert.equal(first.reason, 'draining');
  assert.equal(f.store.getDrainFence(group).reason, 'delete'); assert.equal(f.cleanups(), 0);
  f.ready(true);
  const second = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'second-request' });
  assert.equal(second.operationId, first.operationId); assert.equal(second.pending, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM group_deletion_audit').get().n, 1);
});

test('unfinished final usage import retains data and its deletion fence', async t => {
  const f = fixture(t, { usageReady: false }), group = 'telegram:one'; f.insert(1, group, 'in', 'delivered');
  const first = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'usage-op' });
  assert.equal(first.pending, true); assert.equal(first.reason, 'usage_pending'); assert.equal(f.cleanups(), 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  f.usageReady(true);
  assert.equal((await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: first.operationId })).pending, false);
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

test('Core deletion does not need an installed Dashboard when no Dashboard database exists', async t => {
  const f = fixture(t, { noDashboard: true }), group = 'telegram:one'; f.insert(1, group, 'out', 'delivered');
  const result = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'core-only' });
  assert.equal(result.pending, false); assert.equal(result.counts.messages, 1);
});

test('CLI preview never mutates and confirmed CLI calls the same Core deletion function', async t => {
  const f = fixture(t), group = 'telegram:one'; f.insert(1, group, 'in', 'delivered');
  let output = '', errors = '';
  const io = { stdout: { write(text) { output += text; } }, stderr: { write(text) { errors += text; } } };
  assert.equal(await runGroupDeletionCli(['--group', group, '--json'], { io, create: () => f.service }), 0);
  assert.equal(JSON.parse(output).messages, 1); assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 1);
  output = '';
  assert.equal(await runGroupDeletionCli(['--group', group, '--yes', '--json', '--actor', 'owner', '--operation-id', 'cli-op'], { io, create: () => f.service }), 0);
  assert.equal(JSON.parse(output).pending, false); assert.equal(errors, '');
});

test('a completed bound draft retry acknowledges its original operation after registration removal', async t => {
  const f = fixture(t), group = 'chatlocal:reborn';
  f.db.prepare("INSERT INTO channel_namespaces(namespace,component_name) VALUES ('chatlocal','dashboard')").run();
  f.insert(1, group, 'in', 'delivered');
  await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'bound-draft-op' });
  f.insert(2, group, 'in', 'delivered');
  const result = await f.service.delete({ draftLocalId: 'reborn' }, { confirmed: true, actor: 'owner', operationId: 'bound-draft-op' });
  assert.equal(result.pending, false);
  assert.equal(f.cleanups(), 1);
  assert.ok(f.db.prepare('SELECT 1 FROM conversations WHERE id=2').get());
  await assert.rejects(f.service.delete({ draftLocalId: 'another' }, {
    confirmed: true, actor: 'owner', operationId: 'bound-draft-op',
  }), { code: 'DELETION_OWNERSHIP_MISMATCH' });
});

test('draft retry labels only its observed cleanup counts after media removal and an outer rollback', async t => {
  const f = fixture(t);
  const file = path.join(f.root, 'private-media.txt'); fs.writeFileSync(file, 'private draft attachment');
  let removed = false;
  f.participant.preview = () => ({ attachments: removed ? 0 : 1, files: removed ? 0 : 1 });
  f.participant.cleanup = () => {
    if (!removed) { fs.unlinkSync(file); removed = true; throw new Error('Stopped after removing private media'); }
    return { attachments: 0, files: 0 };
  };
  await assert.rejects(f.service.delete({ draftLocalId: 'private-draft' }, {
    confirmed: true, actor: 'owner', operationId: 'draft-retry-counts',
  }));
  assert.equal(f.store.getGroupDeletionAudit('draft-retry-counts').status, 'started');
  const result = await f.service.delete({ draftLocalId: 'private-draft' }, {
    confirmed: true, actor: 'owner', operationId: 'draft-retry-counts',
  });
  assert.equal(result.pending, false);
  assert.equal(result.counts.attachments, 0);
  assert.equal(result.counts.files, 0);
  assert.equal(result.countsEstimated, true);
  assert.equal(fs.existsSync(file), false);
  let output = '';
  assert.equal(await runGroupDeletionCli(['--draft-local-id', 'private-draft', '--yes', '--operation-id', 'draft-retry-counts'], {
    create: () => f.service, io: { stdout: { write: text => { output += text; } }, stderr: { write() {} } },
  }), 0);
  assert.match(output, /Counts are estimates/);
});
