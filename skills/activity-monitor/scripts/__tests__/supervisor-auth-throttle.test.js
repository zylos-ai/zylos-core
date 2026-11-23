import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor, AUTH_DEMAND_RETRY_MS } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';

function fixture(t, checkAuth, create = createSupervisor, mode = 'multi') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-throttle-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = { now: 1000000, runtime: 'claude' };
  const db = { getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    listSlotOccupancy:()=>[],pruneSlots:()=>({deletedHeld:0,deletedOrphans:[]}),listPendingContinuations:()=>[],listRunEndings:()=>[],getLastCompletedModeTransition:()=>null,listPendingSessionGroups: () => [{ sessionGroup: 'chat:pending' }], getControlById: () => null };
  const scenes = { observe: async () => [], readIdentity(group) { return this.observeGroup(group); }, observeGroup: async () => ({ present: false }), listRuns: async () => [] };
  const supervisor = create({ db, scenes, now: () => state.now, env: { ZYLOS_DIR: root }, zylosDir: root,
    readMode: () => ({ mode }), readConfiguration: () => ({ mode, runtime: 'claude' }),
    resolveTargetRuntime: () => state.runtime, checkAuth,
    requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
    loopOptions: { schedule: () => 1, cancel() {} } });
  t.after(() => supervisor.stop());
  for (const runtime of ['claude', 'codex']) {
    const store = supervisor.health.store(runtime), health = store.read();
    health.health = 'auth_failed'; health.reason = 'authentication_failed'; store.write(health);
  }
  return { state, supervisor, db, start: () => supervisor.loop.deps.readConfiguration(),
    tick: () => supervisor.loop.deps.writeMetricsAndMaintain({scenes:[],fences:[]}),
    route: () => supervisor.router.route({ version: 1, type: 'route', requestId: 'incoming', noReply: false, receivedAt: state.now }) };
}

test('pending auth demand retries no more than once per minute per runtime, including adapter errors', async t => {
  const calls = [];
  let throws = false;
  const f = fixture(t, async runtime => { calls.push(runtime); if (throws) throw new Error('adapter failed'); return { status: 'failure' }; });
  await f.start(); await f.tick();
  for (let i = 1; i < 60; i++) { f.state.now += 1000; await f.tick(); }
  assert.deepEqual(calls, ['claude']);
  f.state.runtime = 'codex'; await f.tick(); assert.deepEqual(calls, ['claude', 'codex']);
  f.state.runtime = 'claude'; f.state.now += 1000; throws = true;
  await assert.rejects(f.tick(), /adapter failed/);
  await f.tick(); assert.deepEqual(calls, ['claude', 'codex', 'claude']);
  f.state.now += AUTH_DEMAND_RETRY_MS; throws = false; await f.tick();
  assert.deepEqual(calls, ['claude', 'codex', 'claude', 'claude']);
  assert.equal(f.supervisor.health.store('claude').read().health, 'auth_failed');
});

