import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor, AUTH_DEMAND_RETRY_MS } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { EventEmitter } from 'node:events';

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

async function authenticate(supervisor, runtime = 'claude') {
  supervisor.admission.openEntry();
  const socket = new EventEmitter();
  let resolve;
  const result = new Promise(done => { resolve = done; });
  socket.destroy = () => resolve(null);
  socket.end = data => resolve(JSON.parse(data));
  supervisor.connectionHandler(socket);
  socket.emit('data', Buffer.from(JSON.stringify({ version: 1, type: 'auth_completed', requestId: 'auth', runtime }) + '\n'));
  const reply = await result;
  await supervisor.connectionHandler.drain();
  return reply;
}

for (const mode of ['single', 'multi'])
for (const health of ['rate_limited', 'unavailable', 'recovering', 'down', 'auth_failed', 'ok'])
test(`authentication handler and real incoming route share recovery effects: ${mode} ${health}`, async t => {
  const effects = [];
  for (const source of ['message', 'authentication']) {
    const calls = { auth: 0, probes: 0 };
    const f = fixture(t, () => { calls.auth++; return { status: 'success' }; }, createSupervisor, mode);
    await f.start();
    const store = f.supervisor.health.store('claude');
    const state = store.read();
    state.health = health; state.reason = health === 'ok' ? '' : health;
    Object.assign(state.scheduling, { cooldownUntil: 5000, restartFailureCount: 3,
      lastRecoveryAt: 999, lastDownCheckAt: 999, lastUserMessageRecoveryAt: 0 });
    store.write(state);
    const probe = f.supervisor.observer.requestProbe.bind(f.supervisor.observer);
    f.supervisor.observer.requestProbe = (...args) => { calls.probes++; return probe(...args); };
    if (source === 'message') await f.route();
    else assert.deepEqual(await authenticate(f.supervisor), { version: 1, type: 'ack', requestId: 'auth' });
    effects.push({ state: store.read(), calls, targets: f.supervisor.health.authTargets('claude'), cache: f.supervisor.router.readNegativeCache('claude') });
  }
  assert.deepEqual(effects[1], effects[0]);
  const { state, calls, cache } = effects[1];
  assert.equal(calls.auth, health === 'auth_failed' ? 1 : 0);
  assert.equal(calls.probes, ['auth_failed', 'ok'].includes(health) ? 0 : 1);
  assert.equal(state.scheduling.lastUserMessageRecoveryAt, ['auth_failed', 'ok'].includes(health) ? 0 : 1000);
  if (health === 'rate_limited') assert.equal(state.scheduling.cooldownUntil, 0);
  if (['unavailable', 'recovering'].includes(health)) {
    assert.equal(state.scheduling.restartFailureCount, 0);
    assert.equal(state.scheduling.lastRecoveryAt, 0);
  }
  if (health === 'down') assert.equal(state.scheduling.lastDownCheckAt, 0);
  assert.equal(cache, null, 'absent ready scene must not cache a failed probe');
});

for (const first of ['message', 'authentication'])
test(`authentication and incoming messages share the minute acceleration budget: ${first} first`, async t => {
  const f = fixture(t, () => assert.fail('restricted runtime must not check auth'));
  await f.start();
  const store = f.supervisor.health.store('claude'), state = store.read();
  state.health = 'unavailable';
  Object.assign(state.scheduling, { restartFailureCount: 3, lastRecoveryAt: 999 });
  store.write(state);
  const message = () => f.route(), auth = () => authenticate(f.supervisor);
  await (first === 'message' ? message() : auth());
  assert.equal(store.read().scheduling.lastUserMessageRecoveryAt, 1000);
  const after = store.read();
  after.scheduling.restartFailureCount = 2; after.scheduling.lastRecoveryAt = 1000; store.write(after);
  f.state.now += 30000;
  await (first === 'message' ? auth() : message());
  assert.equal(store.read().scheduling.lastUserMessageRecoveryAt, 1000);
  assert.equal(store.read().scheduling.restartFailureCount, 2);
  assert.equal(store.read().scheduling.lastRecoveryAt, 1000);
  f.state.now += 30000;
  await (first === 'message' ? auth() : message());
  assert.equal(store.read().scheduling.lastUserMessageRecoveryAt, 1060);
  assert.equal(store.read().scheduling.restartFailureCount, 0);
});

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

test('incoming routing joins pending auth flight; distinct runtimes stay independent; later incoming may retry immediately', async t => {
  let release, entered;
  const barrier = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const calls = [];
  const f = fixture(t, async runtime => { calls.push(runtime); if (runtime === 'claude') { entered(); await barrier; } return { status: 'failure' }; });
  await f.start(); const tick = f.tick(); await started;
  const routes = [f.route(), f.route()];
  const other = await f.supervisor.router.checkAuth('codex'); assert.equal(other.status, 'failure');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['claude', 'codex']);
  release(); await tick;
  for (const route of await Promise.all(routes)) assert.equal(route.decision, 'auth_rejected');
  await f.tick(); assert.equal(calls.length, 2);
  assert.equal((await f.route()).decision, 'auth_rejected');
  assert.deepEqual(calls, ['claude', 'codex', 'claude']);
});

test('continuation-only groups drive authentication demand without changing inbound waiting metrics', async t => {
  let calls = 0;
  const f = fixture(t, () => { calls++; return { status: 'uncertain' }; });
  f.db.listPendingSessionGroups = () => [];
  f.db.listPendingContinuations = () => [{ sessionGroup: 'chat:continuation', controlId: 1, createdAt: 1, endedAt: 1 }];
  await f.start(); await f.tick();
  assert.equal(calls, 1);
  const metrics = fs.readFileSync(path.join(f.supervisor.health.zylosDir, 'activity-monitor/pool-metrics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(metrics.waiting, 0);
});
