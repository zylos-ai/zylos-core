import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';

// exercise the composed owner and durable , with frozen
// scene/DB contracts. Actual dispatcher delivery and marker execution are separate.
function fixture(t, { mode = 'multi', runtime = 'codex', checkAuth, create = createSupervisor } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const group = mode === 'single' ? 'origin' : 'lark:oc_b';
  const state = { now: 1000000, live: new Map(), fences: new Map(), checks: [], stops: [],
    running: 0, controls: 0, pending: true, d8Writes: 0 };
  const db = {
    getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    getModeTransition: () => null, getDrainFence: g => state.fences.get(g) ?? null,
    listDrainFences: () => [...state.fences.values()],
    setDrainFence: (g, value) => { state.d8Writes++; state.fences.set(g, { sessionGroup: g, ...value }); },
    clearDrainFence: g => state.fences.delete(g),
    recordRunEnd: (g, { clearFence }) => { if (clearFence) state.fences.delete(g); },
    listPendingSessionGroups: () => state.pending ? [{ sessionGroup: group }] : [],
    listPendingContinuations: () => [],
    countGlobalRunningConversations: () => state.running,
    countRunningConversations: () => state.running,
    countNonTerminalControls: () => ({ running: state.controls }),
    expireStaleRunningControls: () => [], getControlById: () => null,
  };
  const scenes = {
    observe: async () => [...state.live.values()],
    readIdentity(group) { return this.observeGroup(group); }, observeGroup: async g => state.live.get(g) ?? { present: false, sessionGroup: g },
    listRuns: async () => [...state.live.values()], readRun: async g => state.live.get(g),
    stop: async scene => { state.stops.push(scene.runId); state.live.delete(scene.sessionGroup); },
  };
  const add = (sceneRuntime = runtime, sessionGroup = group, runId = 'old-run') => {
    const scene = { present: true, ready: true, processRunning: true, runtime: sceneRuntime,
      sessionGroup, runId, sessionId: runId, runDir: path.join(root, runId), state: 'idle', idleSince: 1 };
    state.live.set(sessionGroup, scene); return scene;
  };
  let supervisor;
  const reopen = async () => {
    await supervisor?.stop();
    supervisor = create({ db, scenes, zylosDir: root, env: { ZYLOS_DIR: root }, now: () => state.now,
      readMode: () => ({ mode, keyPresent: true }), readConfiguration: () => ({ mode, runtime, capacity: 4 }),
      resolveTargetRuntime: () => runtime, requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
      readSyncMarker: () => ({ held: false, stale: false }),
      checkAuth: async checked => { state.checks.push(checked); return checkAuth ? checkAuth(checked) : { status: 'success' }; },
      loopOptions: { schedule: () => 1, cancel: () => {} },
    });
    await supervisor.loop.deps.readConfiguration();
    await supervisor.loop.deps.restore();
    return supervisor;
  };
  t.after(async () => supervisor?.stop());
  const tick = () => supervisor.loop.deps.writeMetricsAndMaintain({scenes:[...state.live.values()],fences:db.listDrainFences()});
  const seed = (active = false, cooldown = 0) => {
    const store = supervisor.health.store(runtime), health = store.read();
    health.health = 'auth_failed'; health.reason = 'authentication_failed'; health.rateLimitActive = active;
    health.scheduling.cooldownUntil = cooldown; health.scheduling.restartFailureCount = 2;
    store.write(health);
  };
  return { root, state, group, add, reopen, tick, seed, get supervisor() { return supervisor; } };
}

test('composed multi auth captures only affected runtime, retains until old target and are gone, rechecks after restart', async t => {
  const f = fixture(t); await f.reopen(); f.seed(); f.add(); f.add('claude', 'lark:other', 'claude-run');
  await f.tick();
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
  assert.deepEqual(f.supervisor.health.authTargets('codex').map(s => s.runId), ['old-run']);
  assert.equal(f.state.fences.get(f.group).reason, 'auth'); assert.deepEqual(f.state.stops, []);
  await f.reopen();
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
  assert.equal(f.supervisor.health.authRecoveries.size, 0);
  // The persisted auth fence excludes this pending group from recovery demand.
  // Startup rechecks even though the persisted auth fence excludes demand.
  // Health remains blocked until the old run and its fence are gone.
  await f.tick(); assert.deepEqual(f.state.checks, ['codex', 'codex']);
  const fence = f.state.fences.get(f.group);
  f.state.running = 1;
  assert.equal(await f.supervisor.lifecycle.advanceReclaim(fence, {configuration:{mode:'multi'},scenes:[...f.state.live.values()],fences:[...f.state.fences.values()],restartRequests:[],transition:null}), 'waiting_inflight');
  await f.tick(); assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
  f.state.running = 0;
  assert.equal(await f.supervisor.lifecycle.advanceReclaim(fence, {configuration:{mode:'multi'},scenes:[...f.state.live.values()],fences:[...f.state.fences.values()],restartRequests:[],transition:null}), 'done');
  await f.tick();
  assert.deepEqual(f.state.checks, ['codex', 'codex']);
  assert.deepEqual(f.state.stops, ['old-run']); assert.equal(f.state.live.get('lark:other').runId, 'claude-run');
  assert.equal(f.supervisor.health.store('codex').read().health, 'ok'); assert.equal(f.state.fences.size, 0);
});

// Composed auth recovery must use the same dependency preflight.

