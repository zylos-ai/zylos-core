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
  const deps = { db: store, requests, observeGroup: () => live ?? { present: false },
    stop: scene => { assert.equal(scene.runId, live?.runId); state.stops.push(scene.runId); live = null; }, intentionalStop: () => {}, diagnostic: () => {} };
  const lifecycle = new SupervisorLifecycle(deps, { now: () => 10000 });
  const context = () => ({ configuration: state.config, transition: store.getModeTransition(), scenes: live ? [{ ...live }] : [], fences: store.listDrainFences(), restartRequests: state.requests });
  return { db, store, admission, lifecycle, state, context, replaceLive: value => { live = value; }, get live() { return live; } };
}
const request = { version: 1, type: 'delete_group', requestId: 'delete-request', sessionGroup: 'telegram', actor: 'password:owner', cutoffId: 0, preview: { messages: 1 } };
test('deletion admission owns a durable fence, cancels matching restart intent and validates standard replies', async t => {
  const f = fixture(t); f.state.requests = [
    { requestId: 'manual', reason: 'manual_restart', sessionGroup: 'telegram', mode: 'multi', expectedRunId: 'runtime-old', runIds: ['runtime-old'] },
    { requestId: 'upgrade', reason: 'upgrade', runIds: ['runtime-old', 'other-run'] }];
  const reply = await f.admission.handle(request); assert.equal(reply.result, 'accepted'); assert.equal(reply.runId, 'runtime-old'); assert.equal(validateReply(request, reply), true);
  assert.equal(f.state.requests.length, 1); assert.equal(f.state.requests[0].runIds[0], 'other-run');
  const retry = await f.admission.handle({ ...request, requestId: 'retry', operationId: request.requestId }); assert.equal(retry.result, 'already_accepted'); assert.equal(retry.operationId, request.requestId);
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
test('a replacement runtime cannot be stopped or marked as the deleting run', async t => {
  const f = fixture(t); await f.admission.handle(request); const fence = f.store.getDrainFence('telegram'); f.live.runId = 'replacement-run';
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context()), 'changed'); assert.equal(f.state.stops.length, 0); assert.equal(f.store.listRunEndings(['telegram']).length, 0); assert.equal(f.store.getDrainFence('telegram').reason, 'delete');
});

