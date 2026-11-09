import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import Database from '../../../skills/comm-bridge/scripts/sqlite-driver.js';
import * as schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import { createStore } from '../../../skills/comm-bridge/scripts/c4-v2-store.js';
import { createGroupDeletion } from '../group-delete.js';
import { runGroupDeletionCli } from '../group-delete-cli.js';
import { submit } from '../am-sock-client.js';

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
      const audit = store.beginGroupDeletion(request.sessionGroup, { operationId: request.operationId, actor: request.actor, runId: 'run-one', preview: request.preview, cutoffId: request.cutoffId, generationId: request.generationId, targetKey: request.targetKey });
      if (ready) store.recordRunEnd(request.sessionGroup, { runId: audit.runId, reason: 'delete' });
      return { kind: 'accepted', sent: true, reply: { ok: true } };
    }, ...options.service });
  t.after(() => service.close());
  const rawDelete = service.delete;
  service.delete = (target, options = {}) => {
    const group = typeof target === 'string' ? target : target.sessionGroup;
    const targetKey = JSON.stringify(group ? ['group', group] : ['draft', 'dashboard', target.draftLocalId]);
    const known = options.operationId && store.getGroupDeletionAudit(options.operationId);
    const confirmation = known ? {} : { ...store.getDeletionPreviewBoundary(targetKey), targetKey };
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
  assert.equal(f.cleanups(), 1);
});

test('a draining conversation remains fenced and retry resumes its original audit', async t => {
  const f = fixture(t, { ready: false }), group = 'telegram:one';
  f.insert(1, group, 'in', 'delivered');
  const first = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: 'first-request' });
  assert.equal(first.pending, true); assert.equal(first.reason, 'draining');
  assert.equal(f.store.getDrainFence(group).reason, 'delete'); assert.equal(f.cleanups(), 0);
  f.ready(true);
  const second = await f.service.delete(group, { confirmed: true, actor: 'owner', operationId: first.operationId });
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
  const preview = JSON.parse(output);
  output = '';
  assert.equal(await runGroupDeletionCli(['--group', group, '--yes', '--json', '--actor', 'owner', '--operation-id', preview.operationId, '--cutoff-id', String(preview.cutoffId), '--generation-id', JSON.stringify(preview.generationId), '--target-key', preview.targetKey], { io, create: () => f.service }), 0);
  assert.equal(JSON.parse(output).pending, false); assert.equal(errors, '');
});

test('CLI JSON preserves participant HTTP error status for the Dashboard bridge', async () => {
  for (const status of [404, 503]) {
    let output = '';
    const service = { async preview() { return { ok: true }; }, async delete() { throw Object.assign(new Error('participant unavailable'), { code: 'participant_unavailable', status }); }, close() {} };
    assert.equal(await runGroupDeletionCli(['--group', 'telegram:one', '--yes', '--json'], {
      create: () => service, io: { stdout: { write: text => { output += text; } }, stderr: { write() {} } },
    }), 1);
    assert.equal(JSON.parse(output).error.status, status);
  }
});

test('a completed bound draft retry acknowledges its original operation after registration removal', async t => {
  const f = fixture(t), group = 'chatlocal:reborn';
  f.db.prepare("UPDATE channel_namespaces SET namespace='chatlocal' WHERE component_name='dashboard'").run();
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
  f.participant.cleanup = ({ onFilePhase }) => {
    onFilePhase();
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


test('changed Core ownership fails before file cleanup and a repaired retry keeps exact counts', async t => {
  let replace = true;
  const group = 'telegram:one';
  const f = fixture(t, { service: { onStage(stage) {
    if (stage !== 'usage_imported' || !replace) return;
    fs.renameSync(memory, saved);
    fs.symlinkSync(saved, memory);
    replace = false;
  } } });
  f.insert(1, group, 'in', 'delivered');
  const memory = path.join(f.instance, 'memory/session-groups', group);
  const saved = path.join(f.root, 'retained-memory');
  fs.mkdirSync(memory, { recursive: true });
  fs.writeFileSync(path.join(memory, 'state.md'), 'keep until cleanup');
  const options = { confirmed: true, actor: 'owner', operationId: 'changed-ownership' };
  await assert.rejects(f.service.delete(group, options), cause =>
    cause.code === 'DB_WRITE_FAILED' && cause.cause?.code === 'GROUP_DELETE_PATH_INVALID');
  assert.equal(f.cleanups(), 0);
  assert.equal(fs.readFileSync(path.join(saved, 'state.md'), 'utf8'), 'keep until cleanup');
  const attempt = f.db.prepare('SELECT cleanup_attempts,counts_estimated FROM group_deletion_audit WHERE operation_id=?').get(options.operationId);
  assert.equal(attempt.cleanup_attempts, 0);
  assert.equal(attempt.counts_estimated, 0);
  fs.unlinkSync(memory);
  fs.renameSync(saved, memory);
  const result = await f.service.delete(group, options);
  assert.equal(result.pending, false);
  assert.equal(result.countsEstimated, false);
  assert.equal(result.counts.files, 1);
  assert.equal(f.cleanups(), 1);
});


test('the default deletion budget includes admission and waits until twenty seconds before pending', async t => {
  let clock = 1000, slept = 0;
  const f = fixture(t, { ready: false, service: { waitMs: undefined, now: () => clock,
    sleep: async ms => { clock += ms; slept += ms; },
    requestStop: async (request, options) => {
      assert.equal(options.deadlineAt, 11000);
      clock += 9000;
      f.store.beginGroupDeletion(request.sessionGroup, { operationId: request.operationId, actor: request.actor, runId: 'run-one', cutoffId: request.cutoffId, generationId: request.generationId, targetKey: request.targetKey });
      return { kind: 'accepted', sent: true, reply: { ok: true } };
    },
  } });
  f.insert(1, 'telegram:one', 'out', 'delivered');
  const result = await f.service.delete('telegram:one', { confirmed: true, actor: 'owner', operationId: 'budget-op' });
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'draining');
  assert.equal(clock, 21000);
  assert.equal(slept, 11000);
  assert.equal(f.cleanups(), 0);
  assert.equal(f.store.getActiveDeletion('telegram:one').operationId, 'budget-op');
});

test('an exhausted admission budget does not begin another drain or transcript wait', async t => {
  let clock = 0;
  const f = fixture(t, { service: { waitMs: undefined, now: () => clock,
    requestStop: async (request, options) => {
      assert.equal(options.deadlineAt, 10000);
      f.store.beginGroupDeletion(request.sessionGroup, { operationId: request.operationId, actor: request.actor, runId: 'run-one', cutoffId: request.cutoffId, generationId: request.generationId, targetKey: request.targetKey });
      clock = 20000;
      return { kind: 'accepted', sent: true, reply: { ok: true } };
    }, sleep: async () => assert.fail('No further wait after the total deadline'),
  } });
  const result = await f.service.delete('telegram:one', { confirmed: true, actor: 'owner', operationId: 'exhausted-op' });
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'draining');
  assert.equal(f.cleanups(), 0);
});

test('preview time reduces the admission deadline to the original deletion budget', async t => {
  let clock = 0;
  const f = fixture(t, { ready: false, service: { waitMs: undefined, now: () => clock,
    sleep: async ms => { clock += ms; },
    requestStop: async (request, options) => {
      assert.equal(clock, 12000);
      assert.equal(options.deadlineAt, 20000);
      f.store.beginGroupDeletion(request.sessionGroup, { operationId: request.operationId, actor: request.actor, runId: 'run-one', cutoffId: request.cutoffId, generationId: request.generationId, targetKey: request.targetKey });
      return { kind: 'accepted', sent: true, reply: { ok: true } };
    },
  } });
  f.participant.preview = () => { clock += 12000; return { attachments: 0, files: 0 }; };
  const result = await f.service.delete('telegram:one', { confirmed: true, actor: 'owner', operationId: 'preview-budget' });
  assert.equal(result.reason, 'draining');
  assert.equal(clock, 20000);
  assert.equal(f.cleanups(), 0);
});

test('an expired preview budget still gives supervisor submission a minimum connection window', async t => {
  let clock = 0, connections = 0, submissions = 0;
  const f = fixture(t, { ready: false, service: { waitMs: undefined, now: () => clock,
    sleep: async () => assert.fail('No drain wait after an exhausted total budget'),
    requestStop: (request, options) => {
      assert.equal(clock, 25000);
      assert.equal(options.deadlineAt, 26000);
      return submit(request, { ...options, now: () => clock, connect() {
        connections++;
        const socket = new EventEmitter();
        socket.destroy = () => {};
        socket.write = (line, callback) => {
          const sent = JSON.parse(line);
          submissions++;
          f.store.beginGroupDeletion(sent.sessionGroup, { operationId: sent.operationId, actor: sent.actor, runId: 'run-one', cutoffId: sent.cutoffId, generationId: sent.generationId, targetKey: sent.targetKey });
          callback();
          socket.emit('data', Buffer.from(JSON.stringify({ version: 1, type: sent.type, requestId: sent.requestId,
            ok: true, result: 'accepted', operationId: sent.operationId, runId: 'run-one' }) + '\n'));
        };
        queueMicrotask(() => socket.emit('connect'));
        return socket;
      } });
    },
  } });
  f.participant.preview = () => { clock += 25000; return { attachments: 0, files: 0 }; };
  const result = await f.service.delete('telegram:one', { confirmed: true, actor: 'owner', operationId: 'expired-preview' });
  assert.equal(connections, 1);
  assert.equal(submissions, 1);
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'draining');
  assert.equal(f.store.getActiveDeletion('telegram:one').operationId, 'expired-preview');
  assert.equal(f.cleanups(), 0);
});

test('transcript import shares the original deadline and never starts cleanup after it expires', async t => {
  let clock = 500;
  const f = fixture(t, { service: { waitMs: undefined, now: () => clock,
    onStage(stage) { if (stage === 'stopped') clock += 19000; },
  } });
  f.participant.finalizeTranscripts = ({ deadlineAt, now }) => {
    assert.equal(deadlineAt, 20500);
    assert.equal(now(), 19500);
    clock += 1000;
  };
  const result = await f.service.delete('telegram:one', { confirmed: true, actor: 'owner', operationId: 'import-budget-op' });
  assert.equal(result.pending, true);
  assert.equal(result.reason, 'usage_pending');
  assert.equal(f.cleanups(), 0);
  assert.equal(f.db.prepare('SELECT cleanup_attempts FROM group_deletion_audit').get().cleanup_attempts, 0);
});

test('confirmed cutoffs preserve later delivered messages and reject another preview after deletion', async t => {
  const f = fixture(t), group = 'telegram:one';
  f.insert(1, group, 'in', 'delivered');
  const first = await f.service.preview(group), second = await f.service.preview(group);
  assert.equal(first.cutoffId, 1); assert.equal(first.generationId, null);
  assert.notEqual(first.operationId, second.operationId);
  const memory = path.join(f.instance, 'memory/session-groups', group);
  fs.mkdirSync(memory, { recursive: true }); fs.writeFileSync(path.join(memory, 'state.md'), 'keep later context');
  const overflow = path.join(f.instance, 'comm-bridge/attachments/conv-2');
  fs.mkdirSync(overflow, { recursive: true }); fs.writeFileSync(path.join(overflow, 'message.txt'), 'later overflow');
  f.insert(2, group, 'in', 'delivered');
  const later = f.db.prepare('SELECT * FROM conversations WHERE id=2').get();
  const result = await f.rawDelete(group, { ...first, confirmed: true, actor: 'owner' });
  assert.equal(result.counts.messages, 1);
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
  assert.equal(fresh.generationId, first.operationId); assert.equal(fresh.cutoffId, 2);
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

test('CLI forwards an explicitly confirmed cutoff and a JSON null generation', async () => {
  let called, output = '';
  const targetKey = JSON.stringify(['group', 'telegram:one']);
  const service = { async delete(target, options) { called = { target, options }; return { ok: true, pending: true, operationId: 'confirmed' }; }, close() {} };
  const code = await runGroupDeletionCli(['--group', 'telegram:one', '--yes', '--json', '--operation-id', 'confirmed',
    '--cutoff-id', '9', '--generation-id', 'null', '--target-key', targetKey], { create: () => service,
    io: { stdout: { write: text => { output += text; } }, stderr: { write() {} } } });
  assert.equal(code, 0); assert.equal(called.options.cutoffId, 9); assert.equal(called.options.generationId, null);
  assert.equal(called.options.targetKey, targetKey); assert.equal(JSON.parse(output).operationId, 'confirmed');
});

test('a confirmed draft cannot silently become an active group before deletion', async t => {
  const f = fixture(t), target = { draftLocalId: 'promoted' };
  const preview = await f.service.preview(target);
  f.insert(1, 'dashboard:promoted', 'in', 'delivered');
  f.participant.resolveTarget = () => ({ localId: 'promoted', sessionGroup: 'dashboard:promoted', namespace: 'dashboard', draft: false });
  const before = f.db.prepare('SELECT * FROM conversations WHERE id=1').get();
  await assert.rejects(f.rawDelete(target, { ...preview, confirmed: true, actor: 'owner' }), { code: 'DRAFT_BECAME_ACTIVE' });
  assert.equal(f.cleanups(), 0); assert.equal(f.store.listDrainFences().length, 0);
  assert.deepEqual(f.db.prepare('SELECT * FROM conversations WHERE id=1').get(), before);
});


test('a draft route cannot acknowledge an unrelated completed group with the same local suffix', async t => {
  const f = fixture(t), group = 'telegram:shared'; f.insert(1, group, 'out', 'delivered');
  const preview = await f.service.preview(group);
  await f.rawDelete(group, { ...preview, confirmed: true, actor: 'owner' });
  await assert.rejects(f.rawDelete({ draftLocalId: 'shared' }, { operationId: preview.operationId, confirmed: true, actor: 'owner' }), { code: 'DELETION_OWNERSHIP_MISMATCH' });
  assert.equal(f.cleanups(), 1);
});

test('a cutoff above the current group maximum rejects before admission without changing data', async t => {
  let admissions = 0;
  const f = fixture(t, { service: { requestStop: async () => { admissions++; throw new Error('unexpected admission'); } } });
  const group = 'telegram:one';
  f.insert(1, group, 'in', 'delivered');
  const preview = await f.service.preview(group);
  f.insert(2, group, 'out', 'delivered');
  f.insert(10, 'telegram:other', 'out', 'delivered');
  const directory = path.join(f.instance, 'memory/session-groups', group);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'state.md');
  fs.writeFileSync(file, 'unchanged group state');
  const before = f.db.serialize();
  for (const cutoffId of [3, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(f.rawDelete(group, { ...preview, cutoffId, confirmed: true, actor: 'owner' }), { code: 'DELETION_PREVIEW_STALE' });
    assert.equal(f.db.serialize().equals(before), true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'unchanged group state');
  }
  assert.equal(admissions, 0);
  assert.equal(f.cleanups(), 0);
});

test('preview counts pending messages through its cutoff that finish before confirmation', async t => {
  const f = fixture(t), group = 'telegram:one';
  f.insert(1, group, 'out', 'delivered');
  f.insert(2, group, 'in', 'pending');
  const preview = await f.service.preview(group);
  assert.equal(preview.cutoffId, 2);
  assert.equal(preview.messages, 2);
  f.db.prepare("UPDATE conversations SET status='delivered' WHERE id=2").run();
  const result = await f.rawDelete(group, { ...preview, confirmed: true, actor: 'owner' });
  assert.equal(result.counts.messages, 2);
  assert.equal(f.store.getGroupDeletionAudit(preview.operationId).preview.messages, 2);
});
