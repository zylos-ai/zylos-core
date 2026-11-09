import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import * as owner from '../../../comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { SupervisorAdmission } from '../supervisor-admission.js';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';
import { validateReply } from '../../../../cli/lib/am-sock-client.js';
function fixture(t, { absent = false } = {}) {
  const db = new Database(':memory:'); guardDatabase(db, owner); t.after(() => db.close());
  const store = createStore(db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
  let live = absent ? null : { sessionGroup: 'telegram', runId: 'runtime-old', sessionId: 'session-old', present: true, ready: true,
    processRunning: true, state: 'idle', idleSince: 0, runtime: 'claude', runDir: '/private/fixture', createdAt: 0 };
  const state = { requests: [], stops: [], config: { mode: 'multi' } };
  const requests = { read: () => state.requests, write: rows => { state.requests = rows; } };
  const admission = new SupervisorAdmission({ store: requests, db: store, readMode: () => state.config, readRun: () => live, now: () => 10000 }); admission.openEntry();
  const deps = { db: store, requests, observeGroup: () => live ?? { present: false }, readSyncMarker: () => ({ held: false, stale: false }),
    stop: scene => { assert.equal(scene.runId, live?.runId); state.stops.push(scene.runId); live = null; }, intentionalStop: () => {}, diagnostic: () => {} };
  const lifecycle = new SupervisorLifecycle(deps, { now: () => 10000 });
  const context = () => ({ configuration: state.config, transition: store.getModeTransition(), scenes: live ? [{ ...live }] : [], fences: store.listDrainFences(), restartRequests: state.requests });
  return { db, store, admission, lifecycle, state, context, get live() { return live; } };
}
const request = { version: 1, type: 'delete_group', requestId: 'delete-request', sessionGroup: 'telegram', actor: 'password:owner', preview: { messages: 1 } };
test('deletion admission owns a durable fence, cancels matching restart intent and validates standard replies', async t => {
  const f = fixture(t); f.state.requests = [
    { requestId: 'manual', reason: 'manual_restart', sessionGroup: 'telegram', mode: 'multi', expectedRunId: 'runtime-old', runIds: ['runtime-old'] },
    { requestId: 'upgrade', reason: 'upgrade', runIds: ['runtime-old', 'other-run'] }];
  const reply = await f.admission.handle(request); assert.equal(reply.result, 'accepted'); assert.equal(reply.runId, 'runtime-old'); assert.equal(validateReply(request, reply), true);
  assert.equal(f.state.requests.length, 1); assert.equal(f.state.requests[0].runIds[0], 'other-run');
  const retry = await f.admission.handle({ ...request, requestId: 'retry' }); assert.equal(retry.result, 'already_accepted'); assert.equal(retry.operationId, request.requestId);
});
test('deletion waits running inputs, controls and idle before stopping, and keeps its fence through recording', async t => {
  const f = fixture(t), input = f.store.insertConversation('in', 'telegram', 'room', 'in flight'); f.store.claimConversation(input.id);
  await f.admission.handle(request); const fence = f.store.getDrainFence('telegram');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'waiting_inflight'); f.store.markDelivered(input.id);
  const control = f.store.insertControl('active control', { sessionGroup: 'telegram', appendAckSuffix: false }); f.db.prepare("UPDATE control_queue SET status='running' WHERE id=?").run(control.id);
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'waiting_inflight'); f.db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(control.id);
  f.live.state = 'busy'; assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'waiting_idle'); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
  f.live.state = 'idle'; assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'done'); assert.equal(f.state.stops.length, 1);
  assert.equal(f.store.listRunEndings(['telegram'])[0].reason, 'delete'); assert.equal(f.store.listPendingContinuations().length, 0); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'done'); assert.equal(f.state.stops.length, 1);
});
test('deletion stop-recording failures never release the fence after repeated lifecycle rounds', async t => {
  const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram'), original = f.store.recordRunEnd;
  f.store.recordRunEnd = () => { throw new Error('database unavailable'); };
  for (let round = 0; round < 4; round++) { f.lifecycle.beginRound(); await assert.rejects(f.lifecycle.advanceReclaim(fence, f.context()), /database unavailable/); assert.equal(f.store.getDrainFence('telegram').reason, 'delete'); }
  f.store.recordRunEnd = original; assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'done'); assert.equal(f.state.stops.length, 1);
});
test('absent-runtime groups still acquire deletion fences and get durable stopped evidence', async t => {
  const f = fixture(t, { absent: true }); const reply = await f.admission.handle(request); assert.equal(reply.runId, null); const fence = f.store.getDrainFence('telegram');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'done'); const ending = f.store.listRunEndings(['telegram'])[0];
  assert.equal(ending.runId, reply.operationId); assert.equal(ending.reason, 'delete'); assert.equal(f.state.stops.length, 0); assert.equal(f.store.listDrainFences().length, 1);
});
test('deletion admission rejects Origin and open mode transitions without creating audit records', async t => {
  const f = fixture(t); assert.equal((await f.admission.handle({ ...request, sessionGroup: 'origin' })).reason, 'origin_forbidden');
  f.store.beginModeTransition('multi', 'single'); assert.equal((await f.admission.handle(request)).reason, 'transition_open'); assert.equal(f.db.prepare('SELECT count(*) AS n FROM group_deletion_audit').get().n, 0);
});
test('a replacement runtime cannot be stopped or marked as the deleting run', async t => {
  const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram'); f.live.runId = 'replacement-run';
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'changed'); assert.equal(f.state.stops.length, 0); assert.equal(f.store.listRunEndings(['telegram']).length, 0); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
});
test('a control arriving during idle confirmation postpones deletion stop', async t => {
  const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram'), readMarker = f.lifecycle.d.readSyncMarker;
  f.lifecycle.d.readSyncMarker = () => { const row = f.store.insertControl('late in-flight completion', { sessionGroup: 'telegram', appendAckSuffix: false }); f.db.prepare("UPDATE control_queue SET status='running' WHERE id=?").run(row.id); return readMarker(); };
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'waiting_inflight'); assert.equal(f.state.stops.length, 0); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
});

test('deletion waits active subagents and proceeds when they finish without an extra cooldown', async t => {
  const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram');
  f.state.config.hotTtlSeconds = 1;
  f.live.activeSubagents = [{ agentId: 'worker', lastActivityAt: 0 }];
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'waiting_idle');
  assert.equal(f.state.stops.length, 0); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
  f.live.activeSubagents = []; f.live.lastSubagentActivityAt = 9999;
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'done');
  assert.equal(f.state.stops.length, 1); assert.equal(f.store.listRunEndings(['telegram']).length, 1);
});

test('a subagent first observed just before stopping preserves the deletion fence', async t => {
  const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram');
  const observe = f.lifecycle.d.observeGroup;
  f.lifecycle.d.observeGroup = () => ({ ...observe(), activeSubagents: [{ agentId: 'late-worker', lastActivityAt: 9999 }] });
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'waiting_idle');
  assert.equal(f.state.stops.length, 0); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
  assert.equal(f.store.listRunEndings(['telegram']).length, 0);
});

test('deletion does not record an ending while post-stop process liveness is true or unknown', async t => {
  for (const processRunning of [true, undefined]) {
    const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram');
    f.lifecycle.d.stop = () => { f.state.stops.push('attempt'); f.live.processRunning = processRunning; };
    await assert.rejects(f.lifecycle.advanceReclaim(fence, f.context()), { code: 'STOP_UNCONFIRMED' });
    assert.equal(f.state.stops.length, 1); assert.equal(f.store.listRunEndings(['telegram']).length, 0);
    assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
  }
});

test('a post-stop replacement cannot become stopped evidence for deletion', async t => {
  const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram');
  f.lifecycle.d.stop = () => { f.live.runId = 'replacement-run'; };
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'changed');
  assert.equal(f.store.listRunEndings(['telegram']).length, 0); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
});
