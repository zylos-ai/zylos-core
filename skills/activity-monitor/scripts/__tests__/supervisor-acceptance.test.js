import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
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

