import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMaintenanceRequests, maintenanceFile, readMaintenanceRun } from '../sync-maintenance.js';
import { readMaintenanceSession } from '../../../skills/activity-monitor/scripts/maintenance-session.js';
import { sendExternal } from '../../../skills/comm-bridge/scripts/c4-send-external.js';
import { sendInternal } from '../../../skills/comm-bridge/scripts/c4-send-internal.js';

// Real shared request files, atomic publication and kernel locks in private roots.
// Run for request ownership/window or exact-run purpose changes; unrelated UI may
// skip. Use the official runner so imports isolate HOME/ZYLOS_DIR/PM2_HOME/TMPDIR.
// No tmux/runtime/socket/network starts. Lock helper children are reaped before
// each awaited mutation returns; t.after removes the fixture only afterward.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-maintenance-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, ZYLOS_DIR: root };
  delete env.ZYLOS_SESSION_GROUP; delete env.ZYLOS_RUN_ID;
  let clock = 1800000000000;
  return { root, env, file: maintenanceFile(env), now: () => clock,
    advance: ms => { clock += ms; }, create: () => createMaintenanceRequests({ env, now: () => clock }) };
}
const request = (sessionGroup, windowMs = 1000) => ({ sessionGroup, reason: 'backlog', windowMs,
  target: { kind: 'group', scope: sessionGroup, checkpointId: null, end: 12 } });

test('queued requests and exact-run claims survive independent store instances and restart', async t => {
  const f = fixture(t), writer = f.create();
  const queued = await writer.queue(request('chat:one'));
  assert.equal(queued.phase, 'queued');
  assert.equal(readMaintenanceRun({ env: { ...f.env, ZYLOS_SESSION_GROUP: 'chat:one', ZYLOS_RUN_ID: 'run-one' } }), null);
  const restarted = f.create(), listed = await restarted.listMaintenanceRequests();
  assert.equal(listed.length, 1); assert.equal(listed[0].id, queued.id);
  const running = await restarted.claimMaintenance('chat:one', 'run-one');
  assert.equal(running.phase, 'running');
  const fresh = f.create().read()[0];
  assert.equal(fresh.id, queued.id); assert.equal(fresh.runId, 'run-one');
  assert.equal(fresh.lastAttemptAt, f.now()); assert.equal(fresh.target.end, 12);
  assert.equal(readMaintenanceRun({ env: f.env, sessionGroup: 'chat:one', runId: 'run-one' }).id, queued.id);
  assert.equal(readMaintenanceRun({ env: f.env, sessionGroup: 'chat:one', runId: 'other-run' }), null);
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
  assert.equal(fs.readdirSync(path.dirname(f.file)).filter(name => name.endsWith('.tmp')).length, 0);
});

test('simultaneous independent claims admit one global maintenance run and finishing retains its slot', async t => {
  const f = fixture(t), first = f.create(), second = f.create();
  await first.queue(request('chat:one')); await second.queue(request('chat:two'));
  const claims = await Promise.all([
    first.claimMaintenance('chat:one', 'run-one'), second.claimMaintenance('chat:two', 'run-two'),
  ]);
  assert.equal(claims.filter(Boolean).length, 1);
  const running = claims.find(Boolean), waiting = running.sessionGroup === 'chat:one' ? 'chat:two' : 'chat:one';
  assert.equal(f.create().read().filter(row => row.phase === 'running').length, 1);
  await first.update(running.sessionGroup, running.runId, { phase: 'finishing', outcome: 'success' });
  assert.equal(await f.create().claimMaintenance(waiting, 'waiting-run'), null);
  assert.equal(readMaintenanceRun({ env: f.env, sessionGroup: running.sessionGroup, runId: running.runId }).phase, 'finishing');
  await second.update(running.sessionGroup, running.runId, { phase: 'complete', finishedAt: f.now() });
  assert.equal((await f.create().claimMaintenance(waiting, 'waiting-run')).phase, 'running');
});

test('the attempt window survives restart and allows another attempt exactly at its boundary', async t => {
  const f = fixture(t), first = f.create();
  const queued = await first.queue(request('chat:one', 1000));
  f.advance(2000);
  assert.equal(await f.create().queue(request('chat:one', 1000)), null, 'queue waiting consumes no extra request');
  await first.claimMaintenance('chat:one', 'run-one');
  await first.update('chat:one', 'run-one', { phase: 'failed', failure: 'no_checkpoint', finishedAt: f.now() });
  f.advance(999);
  assert.equal(await f.create().queue(request('chat:one', 1000)), null);
  f.advance(1);
  const again = await f.create().queue(request('chat:one', 1000));
  assert.equal(again.phase, 'queued'); assert.notEqual(again.id, queued.id);
  assert.equal((await f.create().claimMaintenance('chat:one', 'run-two')).lastAttemptAt, f.now());
});

test('real-message conversion cancels queued or active purpose and releases guarded channel sends', async t => {
  const f = fixture(t), store = f.create();
  await store.queue(request('chat:queued'));
  assert.equal((await f.create().cancelMaintenance('chat:queued')).phase, 'ordinary');
  assert.equal((await store.listMaintenanceRequests()).length, 0);
  assert.equal(await store.claimMaintenance('chat:queued', 'unused-run'), null);
  for (const phase of ['running', 'finishing']) {
    const group = `chat:${phase}`, runId = `run-${phase}`;
    await store.queue(request(group)); await store.claimMaintenance(group, runId);
    if (phase === 'finishing') await store.update(group, runId, { phase: 'finishing', outcome: 'success' });
    const env = { ...f.env, ZYLOS_SESSION_GROUP: group, ZYLOS_RUN_ID: runId };
    assert.equal((await readMaintenanceSession(env)).runId, runId);
    await assert.rejects(sendExternal({ channel: 'bad/channel' }, 'private', { env }), { code: 'MAINTENANCE_SESSION' });
    await assert.rejects(sendInternal(['internal', 'origin'], () => assert.fail('maintenance cannot read send body'), { env }), { code: 'MAINTENANCE_SESSION' });
    assert.equal(await store.cancelMaintenance(group, 'different-run'), null);
    assert.equal((await f.create().cancelMaintenance(group, runId)).phase, 'ordinary');
    assert.equal(readMaintenanceRun({ env }), null);
    assert.equal(await readMaintenanceSession(env), null);
    assert.equal(await f.create().queue(request(group)), null, 'real-message conversion preserves the claimed attempt window');
    assert.equal(await store.update(group, runId, { phase: 'finishing' }), null, 'late worker cannot restore maintenance purpose');
    await assert.rejects(sendExternal({ channel: 'bad/channel' }, 'private', { env }), { code: 'INVALID_ARGS' });
    let inserted = 0;
    const sent = await sendInternal(['internal', 'origin'], () => 'ordinary message', { env,
      readIdentity: () => ({ runId, sessionId: 'session' }),
      insertMessage: (sender, recipient, content) => { inserted++; assert.equal(sender, group); assert.equal(recipient, 'origin'); assert.equal(content, 'ordinary message'); return { inRow: { id: 1 } }; },
    });
    assert.equal(inserted, 1); assert.match(sent, /queued for origin/);
  }
});

test('unreadable ledger blocks maintenance decisions while ordinary sends use only their own run purpose', async t => {
  const f = fixture(t), store = f.create();
  await store.queue(request('chat:one'));
  const row = await store.claimMaintenance('chat:one', 'run-one');
  const env = { ...f.env, ZYLOS_SESSION_GROUP: 'chat:one', ZYLOS_RUN_ID: 'run-one' };
  const invalid = [
    '{', JSON.stringify({ v: 2, groups: {} }),
    JSON.stringify({ v: 1, groups: { 'chat:one': { ...row, phase: 'unknown' } } }),
    JSON.stringify({ v: 1, groups: { 'chat:one': row, 'chat:two': { ...row, sessionGroup: 'chat:two', id: 'second', runId: 'run-two' } } }),
  ];
  for (const text of invalid) {
    fs.writeFileSync(f.file, text);
    assert.throws(() => f.create().read(), { code: 'SYNC_MAINTENANCE_UNREADABLE' });
    assert.equal(readMaintenanceRun({ env }), null);
    assert.deepEqual(f.create().observe(), []);
    await assert.rejects(f.create().listMaintenanceRequests(), { code: 'SYNC_MAINTENANCE_UNREADABLE' });
    await assert.rejects(f.create().claimMaintenance('chat:one', 'new-run'), { code: 'SYNC_MAINTENANCE_UNREADABLE' });
    await assert.rejects(f.create().queue(request('chat:other')), { code: 'SYNC_MAINTENANCE_UNREADABLE' });
    await assert.rejects(sendInternal(['internal', 'origin'], () => assert.fail('maintenance purpose cannot send'), { env }), { code: 'MAINTENANCE_SESSION' });
    await assert.rejects(sendExternal({ channel: 'bad/channel' }, 'private', { env }), { code: 'MAINTENANCE_SESSION' });
    const ordinaryEnv = { ...env, ZYLOS_RUN_ID: 'ordinary-replacement' };
    await assert.rejects(sendExternal({ channel: 'bad/channel' }, 'private', { env: ordinaryEnv }), { code: 'INVALID_ARGS' });
    let inserted = 0;
    await sendInternal(['internal', 'origin'], () => 'ordinary', { env: ordinaryEnv,
      readIdentity: () => ({ runId: ordinaryEnv.ZYLOS_RUN_ID, sessionId: 'ordinary' }),
      insertMessage: () => { inserted++; return { inRow: { id: 1 } }; },
    });
    assert.equal(inserted, 1);
    assert.equal(fs.readFileSync(f.file, 'utf8'), text);
  }
});

test('real input releases exact-run purpose even when the maintenance ledger is unreadable', async t => {
  const f = fixture(t), store = f.create();
  await store.queue(request('chat:one'));
  await store.claimMaintenance('chat:one', 'run-one');
  const env = { ...f.env, ZYLOS_SESSION_GROUP: 'chat:one', ZYLOS_RUN_ID: 'run-one' };
  fs.writeFileSync(f.file, '{"v":2}');
  await store.cancelMaintenanceForConversation('chat:one', 'different-run');
  await assert.rejects(sendExternal({ channel: 'bad/channel' }, 'private', { env }), { code: 'MAINTENANCE_SESSION' });
  await store.cancelMaintenanceForConversation('chat:one', 'run-one');
  await assert.rejects(sendExternal({ channel: 'bad/channel' }, 'private', { env }), { code: 'INVALID_ARGS' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{"v":2}');
});

test('safe ledger observation reports one diagnostic per unreadable episode and resets on recovery', t => {
  const f = fixture(t), events = [];
  const store = createMaintenanceRequests({ env: f.env, diagnostic: (event, fields) => events.push({ event, ...fields }) });
  fs.mkdirSync(path.dirname(store.file), { recursive: true });
  fs.writeFileSync(store.file, '{"v":2}');
  assert.deepEqual(store.observe(), []); assert.deepEqual(store.observe(), []);
  assert.equal(events.length, 1);
  fs.writeFileSync(store.file, '{"v":1,"groups":{}}');
  assert.deepEqual(store.observe(), []);
  fs.writeFileSync(store.file, '{"v":2}');
  assert.deepEqual(store.observe(), []);
  assert.equal(events.length, 2);
});

test('diagnostic failure cannot block safe observation or real-message conversion', async t => {
  const f = fixture(t), store = createMaintenanceRequests({ env: f.env, diagnostic: () => { throw new Error('diagnostic unavailable'); } });
  await store.queue(request('chat:one')); await store.claimMaintenance('chat:one', 'run-one');
  fs.writeFileSync(store.file, '{"v":2}');
  assert.deepEqual(store.observe(), []);
  await store.cancelMaintenanceForConversation('chat:one', 'run-one');
  const env = { ...f.env, ZYLOS_SESSION_GROUP: 'chat:one', ZYLOS_RUN_ID: 'run-one' };
  await assert.rejects(sendExternal({ channel: 'bad/channel' }, 'private', { env }), { code: 'INVALID_ARGS' });
});
