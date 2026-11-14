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
  const current = [], pending = [], controls = [], stops = [], cleanup = [];
  const runtimeFor = group => group.startsWith('codex:') ? 'codex' : 'claude';
  const db = {
    getOriginNeed: () => ({ controls: { count: 0 }, inbound: { oldestAt: null } }),
    getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listPendingSessionGroups: () => pending,
    listPendingContinuations: () => [],
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }),
    insertControl: (content, options) => {
      controls.push({ id: controls.length + 1, content, ...options, status: 'pending' });
      return controls.at(-1);
    },
    getControlById: id => controls[id - 1],
  };
  const scenes = {
    observe: async () => current,
    async readIdentity(group) { const { currentSessionTs, ...identity } = await this.observeGroup(group); return identity; },
    observeGroup: async group => current.find(s => s.sessionGroup === group) ?? { present: false },
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
  t.after(async () => {
    for (const release of cleanup) await release();
    await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true });
  });
  const addScene = (runtime, group = `${runtime}:a`) => {
    const runDir = path.join(root, runtime, group.replace(':', '-'));
    fs.mkdirSync(runDir, { recursive: true });
    const scene = { runtime, sessionGroup: group, runId: `${runtime}-run`, sessionId: `${runtime}-session`,
      runDir, createdAt: clock - 10000, currentSessionTs: clock - 10000, present: true, ready: true, processRunning: true };
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
  return { root, supervisor, scenes, current, pending, controls, stops, addScene, setHealth, prepared,
    onCleanup: release => cleanup.push(release),
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
  f.onCleanup(async () => {
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
  assert.equal(before.delivery.sessionId, scene.sessionId);
  assert.equal(before.delivery.recovery, null);
  assert.equal(before.delivery.pastedAt, message.pastedAt);
  // A stale-run paste must not replace the accepted session or its silence boundary.
  const reply = await send({ ...message, requestId: 'stale', runId: 'old-run', pastedAt: f.now() - 500000 });
  assert.equal(reply.type, 'ack');
  assert.deepEqual(f.supervisor.observer.scenes.get(scene.sessionGroup), before, 'stale run changed observer counters');
  f.advance(1000); await f.supervisor.observer.observeScene(scene);
  assert.equal(f.supervisor.observer.scenes.get(scene.sessionGroup).delivery.pastedAt, message.pastedAt);
  assert.equal(f.stops.length, 0);
  const origin = f.addScene('claude', 'origin');
  const legacy = await send({ version: 1, type: 'notify_delivered', requestId: 'legacy', deliveredAt: f.now() - 50 });
  assert.equal(legacy.type, 'ack');
  await f.supervisor.observer.observeScene(origin);
  assert.equal(f.supervisor.observer.scenes.get('origin').delivery.sessionId, origin.sessionId);
  assert.equal(f.supervisor.observer.scenes.get('origin').delivery.pastedAt, f.now() - 50);
  assert.equal(f.supervisor.observer.scenes.get(scene.sessionGroup).delivery.pastedAt, message.pastedAt);
}

test('composed socket rejects stale-run delivery without resetting observer counters', { timeout: 5000 }, async t => {
  await deliveryScenario(t, createSupervisor);
});

test('composed delivery resets lifecycle directly and rejects stale-run notifications', { timeout: 5000 }, async t => {
  const f = fixture(t), scene = f.addScene('claude', 'telegram:a');
  const send = await socketClient(t, f), delivered = [];
  f.supervisor.lifecycle.messageDelivered = notification => delivered.push(notification);
  const message = { version: 2, type: 'notify_delivered', requestId: 'delivery',
    sessionGroup: scene.sessionGroup, runtime: scene.runtime, runId: scene.runId, pastedAt: f.now() };
  assert.equal((await send(message)).type, 'ack');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].sessionGroup, scene.sessionGroup);
  assert.equal(delivered[0].runId, scene.runId);
  assert.equal((await send({ ...message, runId: 'stale-run' })).type, 'ack');
  assert.equal(delivered.length, 1);
});

// Delivery boundary: real composed router on a private socket below the runner's
// isolated HOME/ZYLOS_DIR/short TMPDIR. Scene reads and lifecycle effects are
// injected; no live tmux, database, PM2 or network endpoint is opened. Run when
// delivery observation or lifecycle forwarding changes; unrelated UI can skip.
test('composed no-response observation rejects paste before readRun current session timestamp', { timeout: 5000 }, async t => {
  const f = fixture(t), scene = f.addScene('claude', 'telegram:a');
  const delivered = [], worked = [];
  f.supervisor.lifecycle.messageDelivered = notification => delivered.push(notification);
  f.supervisor.lifecycle.workDelivered = notification => worked.push(notification);
  assert.equal((await f.scenes.readIdentity(scene.sessionGroup)).currentSessionTs, undefined,
    'fixture must model readIdentity without the timestamp');
  const send = await socketClient(t, f);
  const message = { version: 2, type: 'notify_delivered', requestId: 'old-paste',
    sessionGroup: scene.sessionGroup, runtime: scene.runtime, runId: scene.runId,
    pastedAt: scene.currentSessionTs - 1 };
  assert.equal((await send(message)).type, 'ack');
  assert.equal(f.supervisor.observer.scenes.has(scene.sessionGroup), false);
  assert.equal(delivered.length, 1); assert.equal(worked.length, 1);
  assert.equal((await send({ ...message, requestId: 'current-paste', pastedAt: scene.currentSessionTs })).type, 'ack');
  const delivery = f.supervisor.observer.scenes.get(scene.sessionGroup).delivery;
  assert.equal(delivery.pastedAt, scene.currentSessionTs);
  assert.equal(delivery.sessionId, scene.sessionId);
  assert.equal(delivered.length, 2); assert.equal(worked.length, 2);
});

test('composed delivery observation readRun failure preserves conversation lifecycle effects', { timeout: 5000 }, async t => {
  const f = fixture(t), scene = f.addScene('claude', 'telegram:a');
  const delivered = [], worked = [], readRun = f.scenes.readRun;
  f.supervisor.lifecycle.messageDelivered = notification => delivered.push(notification);
  f.supervisor.lifecycle.workDelivered = notification => worked.push(notification);
  let reads = 0;
  f.scenes.readRun = async group => {
    if (++reads === 1) return readRun(group); // Existing outer router stale-run validation.
    throw Object.assign(new Error('isolated observation unavailable'), { code: 'SCENE_READ_FAILED' });
  };
  const send = await socketClient(t, f);
  const message = { version: 2, type: 'notify_delivered', requestId: 'read-failure',
    sessionGroup: scene.sessionGroup, runtime: scene.runtime, runId: scene.runId, pastedAt: f.now() };
  assert.equal((await send(message)).type, 'ack');
  assert.equal(reads, 2);
  assert.equal(delivered.length, 1); assert.equal(worked.length, 1);
  assert.equal(delivered[0].requestId, message.requestId);
  assert.equal(worked[0].requestId, message.requestId);
  assert.equal(f.supervisor.observer.scenes.has(scene.sessionGroup), false);
});

test('composed control delivery keeps baseline lifecycle forwarding without extra scene reads', { timeout: 5000 }, async t => {
  const f = fixture(t), scene = f.addScene('claude', 'telegram:a');
  const delivered = [], worked = [], readRun = f.scenes.readRun;
  f.supervisor.lifecycle.messageDelivered = notification => delivered.push(notification);
  f.supervisor.lifecycle.workDelivered = notification => worked.push(notification);
  f.scenes.readIdentity = async () => assert.fail('control delivery must not introduce identity reads');
  let reads = 0;
  f.scenes.readRun = async group => {
    assert.equal(++reads, 1, 'only baseline router validation reads the run');
    return readRun(group);
  };
  const send = await socketClient(t, f);
  const message = { version: 2, type: 'notify_delivered', requestId: 'control-delivery', controlId: 7,
    sessionGroup: scene.sessionGroup, runtime: scene.runtime, runId: scene.runId, pastedAt: f.now() };
  assert.equal((await send(message)).type, 'ack');
  assert.equal(reads, 1); assert.equal(delivered.length, 0); assert.equal(worked.length, 1);
  assert.equal(worked[0].controlId, 7);
  assert.equal(f.supervisor.observer.scenes.has(scene.sessionGroup), false);
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
test('composed maintenance drives once per runtime before probe coalescing', { timeout: 5000 }, async t => {
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
test('composed mixed-runtime demand waits for its own runtime and only recovers its', { timeout: 5000 }, async t => {
  await runtimeScenario(t, createSupervisor);
});


async function serialScenario(t, create) {
  const f = fixture(t, create), send = await socketClient(t, f);
  f.pending.push({ sessionGroup: 'telegram:a' }, { sessionGroup: 'telegram:b' });
  f.setHealth('claude', 'unavailable');
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const barrier = new Promise(resolve => { release = resolve; });
  f.onCleanup(() => release());
  t.signal.addEventListener('abort', () => release(), { once: true });
  // Both requests have read attempt state before this awaited read. With the serial queue
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
test('concurrent socket requests serialize one start-attempt registration and retain pending demand', { timeout: 5000 }, async t => {
  await serialScenario(t, createSupervisor);
});
