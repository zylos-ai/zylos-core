import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';

function fixture(t, create = createSupervisor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-acceptance-'));
  let clock = 1792000000000;
  const current = [], pending = [], controls = [], stops = [];
  const runtimeFor = group => group.startsWith('codex:') ? 'codex' : 'claude';
  const db = {
    getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listPendingSessionGroups: () => pending,
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
    insertControl: (content, options) => {
      controls.push({ id: controls.length + 1, content, ...options, status: 'pending' });
      return controls.length;
    },
    getControlById: id => controls[id - 1],
  };
  const scenes = {
    observe: async () => current,
    readIdentity(group) { return this.observeGroup(group); }, observeGroup: async group => current.find(s => s.sessionGroup === group) ?? { present: false },
    readRun: async group => current.find(s => s.sessionGroup === group) ?? null,
    listRuns: async () => current,
    readScreen: async () => '',
    bindTarget: async scene => ({ runId: scene.runId, runtime: scene.runtime }),
    stop: async scene => { stops.push(scene); },
  };
  const supervisor = create({ db, scenes, zylosDir: root, env: { ZYLOS_DIR: root }, now: () => clock,
    readConfiguration: async () => ({ mode: 'multi', runtime: 'claude', capacity: 3 }),
    readMode: () => ({ mode: 'multi' }), resolveTargetRuntime: async group => runtimeFor(group),
    requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
    checkAuth: async () => ({ status: 'uncertain' }), matchScreen: async () => ({}),
    loopOptions: { schedule: () => 1, cancel: () => {} },
  });
  t.after(async () => { await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const addScene = (runtime, group = `${runtime}:a`) => {
    const runDir = path.join(root, runtime, group.replace(':', '-'));
    fs.mkdirSync(runDir, { recursive: true });
    const scene = { runtime, sessionGroup: group, runId: `${runtime}-run`, sessionId: `${runtime}-session`,
      runDir, createdAt: clock, present: true, ready: true, processRunning: true };
    current.push(scene); return scene;
  };
  const setHealth = (runtime, health) => {
    const store = supervisor.health.store(runtime), state = store.read();
    state.health = health; state.reason = ''; store.write(state);
  };
  const prepared = async () => {
    // Await every actual preparation promise, including ones added by callbacks.
    while (supervisor.observer.preparations.size) await Promise.all([...supervisor.observer.preparations]);
  };
  return { root, supervisor, current, pending, controls, stops, addScene, setHealth, prepared,
    now: () => clock, advance: ms => { clock += ms; } };
}
async function socketClient(t, f) {
  const sock = path.join(f.root, 'supervisor.sock');
  const peers = new Set();
  const server = net.createServer(socket => {
    peers.add(socket); socket.once('close', () => peers.delete(socket));
    f.supervisor.connectionHandler(socket);
    socket.once('data', () => f.onIngest?.());
  });
  t.after(async () => {
    for (const peer of peers) peer.destroy();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  server.listen(sock); await once(server, 'listening');
  f.supervisor.admission.openEntry();
  return async request => {
    const socket = net.createConnection(sock);
    socket.setTimeout(3000, () => socket.destroy(new Error('acceptance socket timeout')));
    await once(socket, 'connect');
    socket.write(`${JSON.stringify(request)}\n`);
    let data = '';
    socket.on('data', chunk => { data += chunk; });
    await once(socket, 'end'); socket.destroy();
    return JSON.parse(data);
  };
}
async function deliveryScenario(t, create) {
  const f = fixture(t, create), scene = f.addScene('claude', 'telegram:a');
  const send = await socketClient(t, f);
  const message = { version: 2, type: 'notify_delivered', requestId: 'delivery',
    sessionGroup: scene.sessionGroup, runtime: scene.runtime, runId: scene.runId, pastedAt: f.now() - 1000 };
  assert.equal((await send(message)).type, 'ack');
  await f.supervisor.observer.observeScene(scene);
  const before = structuredClone(f.supervisor.observer.scenes.get(scene.sessionGroup));
  assert.equal(before.delivery.elapsed, 1000);
  assert.equal(before.delivery.pastedAt, message.pastedAt);
  // A stale message with an older paste time would reset elapsed and replace the
  // earliest time if the socket accepted it using only the matching runtime.
  const reply = await send({ ...message, requestId: 'stale', runId: 'old-run', pastedAt: f.now() - 500000 });
  assert.equal(reply.type, 'ack');
  assert.deepEqual(f.supervisor.observer.scenes.get(scene.sessionGroup), before, 'stale run changed observer counters');
  f.advance(1000); await f.supervisor.observer.observeScene(scene);
  assert.equal(f.supervisor.observer.scenes.get(scene.sessionGroup).delivery.elapsed, 2000);
  assert.equal(f.stops.length, 0);
  const origin = f.addScene('claude', 'origin');
  const legacy = await send({ version: 1, type: 'notify_delivered', requestId: 'legacy', deliveredAt: f.now() - 50 });
  assert.equal(legacy.type, 'ack');
  await f.supervisor.observer.observeScene(origin);
  assert.equal(f.supervisor.observer.scenes.get('origin').delivery.elapsed, 50);
  assert.equal(f.supervisor.observer.scenes.get('origin').delivery.pastedAt, f.now() - 50);
  assert.equal(f.supervisor.observer.scenes.get(scene.sessionGroup).delivery.elapsed, 2000);
}

test('IF-14 composed socket rejects stale-run delivery without resetting observer counters', async t => {
  await deliveryScenario(t, createSupervisor);
});

async function aggregationScenario(t, create) {
  const f = fixture(t, create);
  f.pending.push({ sessionGroup: 'telegram:a' }, { sessionGroup: 'telegram:b' }, { sessionGroup: 'codex:c' });
  f.addScene('claude', 'telegram:a'); f.addScene('codex', 'codex:c');
  f.setHealth('claude', 'unavailable'); f.setHealth('codex', 'unavailable');
  const driven = [], drive = f.supervisor.observer.driveDemand.bind(f.supervisor.observer);
  // Observe before requestProbe's single-flight map can hide duplicate drives.
  f.supervisor.observer.driveDemand = runtime => { driven.push(runtime); return drive(runtime); };
  await f.supervisor.loop.deps.readConfiguration();
  await f.supervisor.loop.deps.writeMetricsAndMaintain({scenes:f.current,fences:[]}); await f.prepared();
  assert.deepEqual(driven, ['claude', 'codex'], 'pending groups drove a runtime more than once');
  assert.deepEqual(f.controls.map(c => c.targetBinding.runtime).sort(), ['claude', 'codex']);
  assert.equal(f.supervisor.observer.probes.size, 2);
}
test('#16a composed maintenance drives once per runtime before probe coalescing', async t => {
  await aggregationScenario(t, createSupervisor);
});

async function runtimeScenario(t, create) {
  const f = fixture(t, create);
  const codex = f.addScene('codex', 'origin');
  f.pending.push({ sessionGroup: 'telegram:a' });
  f.setHealth('claude', 'rate_limited'); f.setHealth('codex', 'unavailable');
  const codexBefore = fs.readFileSync(f.supervisor.health.store('codex').file, 'utf8');
  await f.supervisor.loop.deps.readConfiguration();
  await f.supervisor.loop.deps.writeMetricsAndMaintain({scenes:f.current,fences:[]}); await f.prepared();
  assert.equal(f.controls.length, 0, 'Claude demand probed the existing Codex runtime');
  assert.equal(f.supervisor.observer.probes.size, 0);
  assert.equal(f.stops.length, 0);
  const claude = f.addScene('claude', 'telegram:a');
  await f.supervisor.loop.deps.writeMetricsAndMaintain({scenes:f.current,fences:[]}); await f.prepared();
  assert.equal(f.controls.length, 1);
  assert.deepEqual(f.controls[0].targetBinding, { runtime: 'claude', runId: claude.runId });
  assert.equal(f.controls[0].sessionGroup, claude.sessionGroup);
  assert.equal(f.controls[0].ackDeadlineAt, f.now() / 1000 + 120);
  f.controls[0].status = 'done';
  await f.supervisor.loop.deps.writeMetricsAndMaintain({scenes:f.current,fences:[]}); await f.prepared();
  assert.equal(f.supervisor.health.store('claude').read().health, 'ok');
  assert.equal(fs.readFileSync(f.supervisor.health.store('codex').file, 'utf8'), codexBefore);
  assert.equal(f.current[0], codex); assert.equal(f.stops.length, 0);
}
test('IF-27 composed mixed-runtime demand waits for its own runtime and only recovers its F10', async t => {
  await runtimeScenario(t, createSupervisor);
});


async function serialScenario(t, create) {
  const f = fixture(t, create), send = await socketClient(t, f);
  f.pending.push({ sessionGroup: 'telegram:a' }, { sessionGroup: 'telegram:b' });
  f.setHealth('claude', 'unavailable');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  // Both requests have read F10 before this awaited read. With the serial queue
  // removed, both can hold the old budget and publish competing registrations.
  f.supervisor.health.readNegativeCache = async () => { enter(); await barrier; return null; };
  const request = group => ({ version: 1, type: 'start_attempt',
    requestId: `sa-${f.now()}-${randomUUID().replaceAll('-', '').slice(0, 12)}`,
    runtime: 'claude', sessionGroup: group, runId: randomUUID() });
  const a = send(request('telegram:a')); await entered;
  const secondIngested = new Promise(resolve => { f.onIngest = resolve; });
  const b = send(request('telegram:b'));
  // Wait for actual socket ingestion and its microtasks, not elapsed wall time.
  // Waiting for two DB entries would deadlock the correct serialized code.
  await secondIngested;
  await new Promise(resolve => setImmediate(resolve));
  release();
  const replies = await Promise.all([a, b]);
  assert.equal(replies.filter(r => r.result === 'registered').length, 1, 'concurrent same-runtime requests both registered');
  assert.equal(replies.filter(r => r.code === 'attempt_backoff').length, 1);
  assert.equal(f.supervisor.health.store('claude').read().scheduling.restartFailureCount, 1);
  assert.deepEqual(f.pending.map(g => g.sessionGroup), ['telegram:a', 'telegram:b']);
  assert.equal(f.controls.length, 0);
}
test('#16a concurrent socket requests serialize one F10 registration and retain pending demand', async t => {
  await serialScenario(t, createSupervisor);
});
