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

for (const [label, active, cooldown, expected] of [
  ['unexpired', true, 1500, 1500], ['expired', true, 900, 0], ['zero', true, 0, 0], ['no-limit', false, 0, 0],
]) test(`composed auth recovery after reopen retains ${label} rate-limit facts`, async t => {
  const f = fixture(t); await f.reopen(); f.seed(active, cooldown); await f.reopen();
  const before = f.supervisor.health.store('codex').read();
  assert.equal(before.health, 'auth_failed'); assert.equal(before.rateLimitActive, active);
  assert.equal(before.scheduling.cooldownUntil, cooldown);
  await f.tick();
  const after = f.supervisor.health.store('codex').read();
  assert.equal(after.health, active ? 'rate_limited' : 'ok'); assert.equal(after.rateLimitActive, active);
  assert.equal(after.scheduling.cooldownUntil, expected);
});

for (const kind of ['early', 'limit']) test(`composed ${kind} recovery boundary`, async t => {
  const verify = async create => {
    const f = fixture(t, { create });
    await f.reopen(); f.seed(kind === 'limit', kind === 'limit' ? 1500 : 0);
    if (kind !== 'limit') f.add();
    await f.tick();
    const health = f.supervisor.health.store('codex').read();
    if (kind === 'early') { assert.equal(health.health, 'auth_failed'); assert.deepEqual(f.state.stops, []); }
    if (kind === 'limit') { assert.equal(health.health, 'rate_limited'); assert.equal(health.scheduling.cooldownUntil, 1500); }
  };
  await verify(createSupervisor);
});

test('composed owners keep current and legacy caches inside their own root', async t => {
  const a = fixture(t), b = fixture(t); await a.reopen(); await b.reopen();
  a.supervisor.router.writeNegativeCache('codex', 'unavailable', 'runtime_unavailable');
  b.supervisor.router.writeNegativeCache('codex', 'rate_limited', 'rate_limit');
  assert.equal(a.supervisor.router.cachePath('codex'), path.join(a.root, 'activity-monitor/message-router-probe-cache/codex.json'));
  assert.equal(a.supervisor.router.readNegativeCache('codex', 'unavailable', 'runtime_unavailable').health, 'unavailable');
  b.supervisor.router.clearCache('codex');
  assert.ok(a.supervisor.router.readNegativeCache('codex', 'unavailable', 'runtime_unavailable'));
  const legacyA = path.join(a.root, 'activity-monitor/message-router-probe-cache.json');
  const legacyB = path.join(b.root, 'activity-monitor/message-router-probe-cache.json');
  fs.writeFileSync(legacyA, 'old-a'); fs.writeFileSync(legacyB, 'old-b');
  await a.reopen(); assert.equal(fs.existsSync(legacyA), false); assert.equal(fs.readFileSync(legacyB, 'utf8'), 'old-b');
});

// Composed auth recovery must use the same dependency preflight.
async function unavailableAuthAssertion(t, create) {
  const f = fixture(t, { create }); await f.reopen(); f.seed(); f.add();
  f.supervisor.lifecycle.d.readSyncMarker = () => { throw Object.assign(new Error(' unavailable'), { code: 'DEPENDENCY_UNAVAILABLE' }); };
  await assert.rejects(f.tick(), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(f.state.d8Writes, 0, 'unavailable Sync dependency must not fence auth recovery');
  assert.equal(f.state.fences.size, 0); assert.deepEqual(f.state.stops, []);
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
}
test('auth preflight runs before fence', async t => {
  await unavailableAuthAssertion(t, createSupervisor);

});

// These composed tests use real health persistence, routing and lifecycle code,
// with in-memory DB/scenes and a stub auth adapter. They cover startup auth
// scheduling/recovery changes; real CLI credentials and process replacement
// require a separate isolated instance and are not exercised here.
for (const mode of ['single', 'multi'])
for (const runtime of ['claude', 'codex', 'agy'])
test(`idle startup auth recovery retires the affected run: ${mode} ${runtime}`, async t => {
  const f = fixture(t, { mode, runtime });
  await f.reopen(); f.seed(); f.add(); f.state.pending = false;
  const otherRuntime = runtime === 'claude' ? 'codex' : 'claude';
  f.add(otherRuntime, 'chat:other', 'other-run');
  await f.reopen();
  assert.equal(f.state.checks.length, 0);
  await f.tick();
  assert.deepEqual(f.state.checks, [runtime]);
  {
    const fence = f.state.fences.get(f.group);
    assert.equal(fence.reason, 'auth');
    assert.equal(f.supervisor.health.store(runtime).read().health, 'auth_failed');
    assert.equal(await f.supervisor.lifecycle.advanceReclaim(fence, {
      configuration: { mode }, scenes: [...f.state.live.values()],
      fences: [...f.state.fences.values()], restartRequests: [], transition: null,
    }), 'done');
    await f.tick();
  }
  assert.equal(f.supervisor.health.store(runtime).read().health, 'ok');
  assert.deepEqual(f.state.stops, ['old-run']);
  assert.equal(f.state.fences.size, 0);
  assert.equal(f.state.live.get('chat:other').runId, 'other-run');
  assert.equal(f.supervisor.health.store(otherRuntime).read().health, 'ok');
  await f.tick();
  assert.equal(f.state.checks.length, 1);
});

for (const mode of ['single', 'multi'])
for (const outcome of ['failure', 'uncertain', 'exception'])
test(`idle startup auth does not retry after ${outcome}: ${mode}`, async t => {
  let result = outcome;
  const f = fixture(t, { mode, checkAuth: () => {
    if (result === 'exception') throw new Error('auth adapter unavailable');
    return { status: result, reason: 'authentication_failed' };
  } });
  await f.reopen(); f.seed(); f.add(); f.state.pending = false; await f.reopen();
  if (outcome === 'exception') await assert.rejects(f.tick(), /auth adapter unavailable/);
  else await f.tick();
  assert.equal(f.state.checks.length, 1);
  for (let seconds = 0; seconds < 600; seconds++) {
    f.state.now += 1000; await f.tick();
    assert.equal(f.state.checks.length, 1);
  }
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
  assert.equal(f.state.stops.length, 0);
  assert.equal(f.state.fences.size, 0);
  result = 'failure';
  const route = await f.supervisor.router.route({ version: 1, type: 'route', requestId: 'incoming', noReply: false, receivedAt: f.state.now });
  assert.equal(route.decision, 'auth_rejected');
  assert.ok(route.userMessage);
  assert.equal(f.state.checks.length, 2);
  f.state.pending = true;
  for (let seconds = 0; seconds < 59; seconds++) {
    f.state.now += 1000; await f.tick();
    assert.equal(f.state.checks.length, 2);
  }
  f.state.now += 1000; await f.tick();
  assert.equal(f.state.checks.length, 3);
});

for (const mode of ['single', 'multi'])
test(`healthy startup does not grant an idle auth check to later failure: ${mode}`, async t => {
  const f = fixture(t, { mode }); await f.reopen(); f.state.pending = false;
  await f.tick(); assert.equal(f.state.checks.length, 0);
  f.seed(); await f.tick();
  f.state.now += 600000; await f.tick();
  assert.equal(f.state.checks.length, 0);
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
});

test('startup auth eligibility is consumed if health changes before the first maintenance pass', async t => {
  const f = fixture(t); await f.reopen(); f.seed(); f.state.pending = false; await f.reopen();
  const store = f.supervisor.health.store('codex'), state = store.read();
  state.health = 'ok'; state.reason = ''; store.write(state);
  await f.tick(); f.seed(); await f.tick();
  assert.equal(f.state.checks.length, 0);
});

for (const first of ['startup', 'message'])
test(`startup and incoming auth share one call and retain the message: ${first} first`, { timeout: 5000 }, async t => {
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  t.signal.addEventListener('abort', () => { release(); entered(); }, { once: true });
  const f = fixture(t, { checkAuth: async () => {
    entered(); await barrier; return { status: 'success' };
  } });
  await f.reopen(); f.seed(); f.add(); f.state.pending = false; await f.reopen();
  const route = () => f.supervisor.router.route({ version: 1, type: 'route', requestId: 'incoming', noReply: false, receivedAt: f.state.now });
  let tickPromise, routePromise;
  try {
    if (first === 'startup') { tickPromise = f.tick(); await started; routePromise = route(); }
    else { routePromise = route(); await started; tickPromise = f.tick(); }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.state.checks.length, 1);
  } finally {
    release();
    await Promise.allSettled([tickPromise, routePromise]);
  }
  const reply = await routePromise;
  assert.equal(reply.decision, 'pending');
  assert.equal(reply.userMessage, undefined);
  assert.equal(f.state.checks.length, 1);
  assert.equal(f.state.fences.get(f.group).reason, 'auth');
});
