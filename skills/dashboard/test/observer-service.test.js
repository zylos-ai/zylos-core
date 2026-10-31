import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { ObserverSizeMonitor } from '../src/lib/observer-size-monitor.js';
import test from 'node:test';
import { ObserverService, OBSERVER_WEBSOCKET_PROTOCOL } from '../src/lib/observer-service.js';
import { ObserverCoordinator } from '../src/lib/observer-coordinator.js';
import { ObserverManager } from '../src/lib/observer-manager.js';
import { connectObserverWebSocket } from '../src/lib/observer-websocket.js';
import { shutdownDashboardTransports } from '../src/lib/dashboard-shutdown.js';

const LEASE_ID = 'a'.repeat(32);

function fixture({ authEnabled = true, deferUpstream = false, initialDisplay = null, sizeMonitor, resizeAgent, starting = false, managerFactory } = {}) {
  const context = { kind: 'cookie', principalId: 'browser', scope: 'admin' };
  const otherContext = { kind: 'cookie', principalId: 'other-browser', scope: 'admin' };
  const apiContext = { kind: 'api', principalId: 'api-admin', scope: 'admin' };
  const readContext = { kind: 'api', principalId: 'api-read', scope: 'read' };
  const containment = Object.assign(new EventEmitter(), {
    active: { generation: 7, port: 1234, sessionName: 'observer-test', tokenFile: '/private/token' },
    resizes: [],
    async resize(active, size) { assert.equal(active, this.active); this.resizes.push(size); return true; },
    async reconcilePersisted() { return []; },
    async stopGeneration() { return { stopped: true }; },
    agentResizes: [],
    async resizeAgent(request) {
      this.agentResizes.push(request);
      if (resizeAgent) return resizeAgent(request);
      return { cols: request.cols, rows: request.rows, statusLines: 1 };
    },
  });
  const coordinator = {
    savedAgentSizes: [],
    async agentSize() { return this.savedAgentSizes.at(-1) || { cols: 120, rows: 50 }; },
    async saveAgentSize(size) { this.savedAgentSizes.push(size); return size; },
    async reconcileStartup() { return { state: 'installed', desired: { enabled: true } }; },
    async firstLease() { return containment.active; },
    async status() { return { state: 'installed', binaryPath: '/private/zellij', desired: { enabled: true } }; },
  };
  const manager = {
    runtime: 'claude',
    isStarting() { return starting; },
    runtimeStatus() { return { state: 'live', error: null }; },
    validateLease(id, supplied) {
      if (id !== LEASE_ID) throw Object.assign(new Error('missing'), { code: 'lease_not_found' });
      assert.equal(supplied.scope, 'admin');
      return { id, generation: 7 };
    },
    async createLease() { return { id: LEASE_ID, generation: 7 }; },
    renewLease() { return { id: LEASE_ID, generation: 7 }; },
    releaseLease() { return { released: true }; },
    async invalidateAndDisable() { return { state: 'disabled' }; },
    async handleContainmentFailure() {},
    async shutdown() { return { stopped: true }; },
  };
  const authGate = {
    enabled: authEnabled,
    resolveAuthContext(req) {
      if (req.headers.cookie === 'admin=1') return context;
      if (req.headers.cookie === 'admin=2') return otherContext;
      if (req.headers.authorization === 'Bearer admin-token') return apiContext;
      if (req.headers.authorization === 'Bearer read-token') return readContext;
      return null;
    },
    revalidateAuthContext(value) { return value; },
  };
  const upstreams = [];
  let resolveConnect;
  const connectGate = deferUpstream ? new Promise((resolve) => { resolveConnect = resolve; }) : null;
  const upstreamFactory = () => {
    const upstream = {
      closed: false,
      async connect(callbacks) {
        this.callbacks = callbacks;
        if (Array.isArray(initialDisplay)) {
          for (const payload of initialDisplay) callbacks.onDisplay(Buffer.from(payload));
        } else if (initialDisplay) callbacks.onDisplay(Buffer.from(initialDisplay));
        if (connectGate) await connectGate;
        return this;
      },
      resizes: [],
      resize(size) { this.resizes.push(size); return true; },
      close() { this.closed = true; },
    };
    upstreams.push(upstream);
    return upstream;
  };
  const service = new ObserverService({
    coordinator, containment, authGate, upstreamFactory, sizeMonitor,
    manager: managerFactory ? managerFactory({ coordinator, containment, authGate }) : manager,
  });
  return { service, upstreams, resolveConnect, containment, coordinator };
}

async function waitUntil(check, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('condition did not become true');
}

function resetUpgrade(port, path, headers = {}) {
  let client;
  const closed = new Promise((resolve, reject) => {
    client = net.connect(port, '127.0.0.1');
    client.on('error', () => {});
    client.on('close', resolve);
    client.on('connect', () => {
      const lines = [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ];
      client.write(lines.join('\r\n'), (error) => {
        if (error) reject(error);
      });
    });
  });
  return { client, closed };
}

async function startHttp(service) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!await service.handle(req, res, url)) {
      res.writeHead(404).end();
    }
  });
  server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { server, origin, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('Observer HTTP surface fails closed without Dashboard authentication', async () => {
  const { service } = fixture({ authEnabled: false });
  const app = await startHttp(service);
  try {
    const response = await fetch(`${app.origin}/api/observer/status`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'auth_required' });
  } finally { await app.close(); }
});

test('local Observer upgrade survives downstream resets during reject and pending handshake', async () => {
  const rejected = fixture();
  const rejectedApp = await startHttp(rejected.service);
  try {
    for (const path of ['/observer/stream', '/ws', '/observer/stream?x=1']) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const reset = resetUpgrade(rejectedApp.server.address().port, path);
        await new Promise((resolve) => setImmediate(resolve));
        reset.client.resetAndDestroy();
        await reset.closed;
      }
    }
    const healthy = await fetch(`${rejectedApp.origin}/api/observer/status`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(healthy.status, 200);
  } finally {
    await rejected.service.shutdown();
    await rejectedApp.close();
  }

  const pending = fixture({ deferUpstream: true });
  const pendingApp = await startHttp(pending.service);
  try {
    const reset = resetUpgrade(pendingApp.server.address().port, '/observer/stream', {
      Cookie: 'admin=1',
      Origin: pendingApp.origin,
      'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
    });
    await waitUntil(() => pending.upstreams.length === 1 && pending.service.streams.size === 1);
    reset.client.resetAndDestroy();
    await reset.closed;
    pending.resolveConnect();
    await waitUntil(() => pending.service.streams.size === 0 && pending.upstreams[0].closed);
    const healthy = await fetch(`${pendingApp.origin}/api/observer/status`, {
      headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(healthy.status, 200);
  } finally {
    pending.resolveConnect();
    await pending.service.shutdown();
    await pendingApp.close();
  }
});

test('local Observer rejects pre-ready bytes and disconnects without allocating an upstream', async (t) => {
  for (const action of ['data', 'end', 'reset']) await t.test(action, async () => {
    const { service, upstreams } = fixture();
    let releaseReady;
    let readySeen = false;
    service._ready = async () => {
      readySeen = true;
      await new Promise((resolve) => { releaseReady = resolve; });
    };
    let handling;
    let raw;
    const original = service.handleUpgrade.bind(service);
    service.handleUpgrade = (...args) => {
      raw = args[1];
      return (handling = original(...args));
    };
    const app = await startHttp(service);
    let reset;
    try {
      reset = resetUpgrade(app.server.address().port, '/observer/stream', {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      });
      await waitUntil(() => readySeen);
      if (action === 'data') reset.client.write('x');
      if (action === 'end') reset.client.end();
      if (action === 'reset') reset.client.resetAndDestroy();
      // The readiness operation is still held: a byte must actively close the socket.
      await waitUntil(() => reset.client.destroyed && raw.destroyed);
      releaseReady();
      await handling;
      assert.equal(upstreams.length, 0);
      assert.equal(service.streams.size, 0);
    } finally {
      releaseReady?.();
      reset?.client.destroy();
      raw?.destroy();
      await handling;
      await service.shutdown();
      await app.close();
    }
  });
});

test('cookie lifecycle requires a same-origin request and frame requires the bound lease header', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  try {
    const missingOrigin = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: 'admin=1' },
    });
    assert.equal(missingOrigin.status, 403);
    const lease = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin },
    });
    assert.equal(lease.status, 201);
    assert.equal((await lease.json()).id, LEASE_ID);

    const missingLease = await fetch(`${app.origin}/observer/frame`, { headers: { Cookie: 'admin=1' } });
    assert.equal(missingLease.status, 404);
    const frame = await fetch(`${app.origin}/observer/frame`, {
      headers: { Cookie: 'admin=1', 'X-Observer-Lease': LEASE_ID },
    });
    assert.equal(frame.status, 200);
    assert.equal(frame.headers.get('x-frame-options'), 'SAMEORIGIN');
    const html = await frame.text();
    assert.match(html, /sandbox|observer-init/);
    assert.match(html, /connect-src 'none'/);
    assert.doesNotMatch(html, /session_token|auth_token/);
  } finally { await app.close(); }
});

test('exact Observer upgrade authenticates before upstream and rejects browser input', async () => {
  const { service, upstreams } = fixture();
  const app = await startHttp(service);
  let socket;
  try {
    socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1',
        Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    });
    assert.equal(upstreams.length, 1);
    const messages = [];
    socket.on('message', (value) => messages.push(value));
    socket.activate();
    upstreams[0].callbacks.onDisplay(Buffer.from('safe display'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(messages.some((value) => Buffer.isBuffer(value) && value.toString() === 'safe display'));
    socket.sendText('keyboard input');
    await new Promise((resolve) => socket.once('close', resolve));
    assert.equal(upstreams[0].closed, true);
  } finally {
    await service.shutdown();
    socket?.destroy();
    await app.close();
  }
});

for (const [failure, reason] of [
  ['pong_timeout', 'pong_timeout'],
  ['auth_expired', 'auth_expired'],
  ['admin_required', 'auth_expired'],
  ['lease_mismatch', 'lease_invalid'],
]) {
  test(`Observer revalidation closes ${failure} with its public reason and one safe log`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { service } = fixture();
    const app = await startHttp(service);
    let socket;
    try {
      socket = await connectObserverWebSocket({
        port: app.server.address().port,
        path: '/observer/stream',
        headers: {
          Cookie: 'admin=1', Origin: app.origin,
          'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
        },
      });
      socket.activate();
      const stream = [...service.streams][0];
      assert.ok(stream.downstream);
      const close = t.mock.method(stream.downstream, 'close');
      const log = t.mock.method(console, 'error', () => {});
      if (failure === 'pong_timeout') stream.awaitingPong = true;
      else if (failure === 'auth_expired') service.authGate.revalidateAuthContext = () => null;
      else service.manager.validateLease = () => { throw Object.assign(new Error(failure), { code: failure }); };

      t.mock.timers.tick(10_000);
      assert.equal(close.mock.callCount(), 1);
      assert.deepEqual(close.mock.calls[0].arguments, [1008, reason]);
      assert.equal(log.mock.callCount(), 1);
      const [line] = log.mock.calls[0].arguments;
      assert.equal(line, `[observer] stream closed: ${reason} (${failure}) lease=aaaaaaaa…`);
      assert.ok(!line.includes(LEASE_ID));
      assert.ok(!line.includes('\n'));
      assert.equal(service.streams.size, 0);
    } finally {
      await service.shutdown();
      socket?.destroy();
      await app.close();
    }
  });
}

test('display received before downstream admission is delivered after activation', async () => {
  const { service } = fixture({ initialDisplay: 'INITIAL SNAPSHOT' });
  const app = await startHttp(service);
  let socket;
  try {
    socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    });
    const messages = [];
    socket.on('message', (value) => messages.push(value));
    socket.activate();
    await waitUntil(() => messages.some((value) => Buffer.isBuffer(value)));
    assert.ok(messages.some((value) => Buffer.isBuffer(value) && value.toString() === 'INITIAL SNAPSHOT'));
  } finally {
    await service.shutdown();
    socket?.destroy();
    await app.close();
  }
});

test('startup display flush keeps the queued tail when the first accepted write backpressures', async () => {
  const { service } = fixture({ initialDisplay: [Buffer.alloc(256 * 1024, 65), Buffer.from('TAIL')] });
  const app = await startHttp(service);
  app.server.on('connection', (serverSocket) => {
    const originalWrite = serverSocket._write;
    serverSocket._write = function delayedWrite(chunk, encoding, callback) {
      originalWrite.call(this, chunk, encoding, (error) => setTimeout(() => callback(error), 20));
    };
  });
  let socket;
  try {
    socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    });
    const messages = [];
    socket.on('message', (value) => messages.push(value));
    socket.activate();
    await waitUntil(() => messages.some((value) => Buffer.isBuffer(value) && value.toString() === 'TAIL'));
    assert.equal(messages.filter(Buffer.isBuffer).reduce((sum, value) => sum + value.length, 0), 262148);
    assert.equal([...service.streams][0]?.closed, false);
  } finally {
    await service.shutdown();
    socket?.destroy();
    await app.close();
  }
});

test('release, close, and reconnect leave no untracked upgraded socket', async () => {
  const { service, upstreams } = fixture();
  const app = await startHttp(service);
  let first;
  let second;
  const connect = async () => {
    const socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
      closeTimeoutMs: 50,
    });
    socket.activate();
    return socket;
  };
  try {
    first = await connect();
    const firstClosed = new Promise((resolve) => first.once('close', resolve));
    const release = await fetch(`${app.origin}/api/observer/leases/${LEASE_ID}/release`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin },
    });
    assert.equal(release.status, 200);
    await firstClosed;
    await waitUntil(() => service.streams.size === 0);
    assert.equal(upstreams[0].closed, true);

    second = await connect();
    assert.equal(service.streams.size, 1);
    second.close();
    second.close();
    await waitUntil(() => service.streams.size === 0);
    assert.equal(upstreams[1].closed, true);
  } finally {
    await service.shutdown();
    first?.destroy();
    second?.destroy();
    await app.close();
  }
});

test('Dashboard transport shutdown closes an active upgraded viewer while HTTP drains', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  let socket;
  let controlClosed = false;
  try {
    socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
      closeTimeoutMs: 50,
    });
    socket.activate();
    const started = Date.now();
    const result = await shutdownDashboardTransports({
      server: app.server,
      observerService: service,
      observerControl: { async close() { controlClosed = true; } },
      timeoutMs: 500,
    });
    assert.equal(result.http.timedOut, false);
    assert.equal(result.http.error, null);
    assert.equal(result.observer.timedOut, false);
    assert.equal(result.observer.error, null);
    assert.equal(controlClosed, true);
    assert.equal(service.streams.size, 0);
    assert.ok(Date.now() - started < 500);
  } finally {
    socket?.destroy();
    if (app.server.listening) await app.close();
  }
});

test('all non-allowlisted WebSocket paths are rejected without upstream allocation', async () => {
  const { service, upstreams } = fixture();
  const app = await startHttp(service);
  try {
    await assert.rejects(connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/assets/xterm.js',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    }), /rejected \(404\)/);
    assert.equal(upstreams.length, 0);
  } finally { await app.close(); }
});

test('admin bearer uses the explicit no-Origin path while cookie precedence still requires Origin', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  let socket;
  try {
    const lease = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-token' },
    });
    assert.equal(lease.status, 201);
    const frame = await fetch(`${app.origin}/observer/frame`, {
      headers: { Authorization: 'Bearer admin-token', 'X-Observer-Lease': LEASE_ID },
    });
    assert.equal(frame.status, 200);
    const readOnly = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Authorization: 'Bearer read-token' },
    });
    assert.equal(readOnly.status, 403);
    const cookieWins = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: 'admin=1', Authorization: 'Bearer admin-token' },
    });
    assert.equal(cookieWins.status, 403);
    socket = await connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Authorization: 'Bearer admin-token',
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    });
    socket.activate();
    assert.equal(socket.closed, false);
  } finally {
    await service.shutdown();
    socket?.destroy();
    await app.close();
  }
});

test('lease release closes a pending upstream connection before WebSocket admission', async () => {
  const { service, upstreams, resolveConnect } = fixture({ deferUpstream: true });
  const app = await startHttp(service);
  try {
    const upgrade = assert.rejects(connectObserverWebSocket({
      port: app.server.address().port,
      path: '/observer/stream',
      headers: {
        Cookie: 'admin=1', Origin: app.origin,
        'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
      },
    }));
    await waitUntil(() => upstreams.length === 1 && service.streams.size === 1);
    const release = await fetch(`${app.origin}/api/observer/leases/${LEASE_ID}/release`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin },
    });
    assert.equal(release.status, 200);
    resolveConnect();
    await upgrade;
    assert.equal(upstreams[0].closed, true);
    assert.equal(service.streams.size, 0);
  } finally { await app.close(); }
});


test('recovery cannot clear a startup failure while persisted survivors remain', async (t) => {
  for (const recovery of ['disable', 'uninstall', 'preUninstall']) await t.test(recovery, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'observer-service-recovery-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const configPath = path.join(directory, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ observer: { enabled: true, generation: 7 } }));
    const desired = () => JSON.parse(fs.readFileSync(configPath, 'utf8')).observer;
    const failure = Object.assign(new Error('persisted survivor is still alive'), { code: 'teardown_failed' });
    let cleanupAllowed = false;
    let survivors = true;
    let installed = true;
    let reconciliations = 0;
    let starts = 0;
    const events = [];
    const containment = {
      active: null,
      async stopGeneration() { events.push('stop-active'); },
      async reconcilePersisted() {
        reconciliations += 1;
        events.push('reconcile-persisted');
        if (reconciliations > 1) {
          assert.equal(desired().enabled, false, 'retry must durably disable before cleanup');
          assert.equal(desired().teardownFence, true, 'retry must durably fence before cleanup');
        }
        if (!cleanupAllowed) throw failure;
        survivors = false;
        events.push('survivors-cleared');
      },
    };
    const installer = {
      async verify() { return { state: installed ? 'installed' : 'not_installed' }; },
      async removeInstalledArtifacts() {
        assert.equal(survivors, false, 'artifacts must outlive persisted survivors');
        installed = false;
        events.push('remove-artifacts');
        return this.verify();
      },
    };
    const authGate = {
      enabled: true,
      resolveAuthContext(req) {
        return req.headers.authorization === 'Bearer admin-token'
          ? { kind: 'api', principalId: 'admin', scope: 'admin' } : null;
      },
      revalidateAuthContext(context) { return context; },
    };
    const coordinator = new ObserverCoordinator({
      configPath, installer,
      teardown: () => containment.stopGeneration(),
      reconcilePersisted: () => containment.reconcilePersisted(),
      start: async () => { starts += 1; throw new Error('unexpected start'); },
    });
    const manager = new ObserverManager({ coordinator, containment, authGate });
    const service = new ObserverService({ coordinator, containment, manager, authGate });
    const app = await startHttp(service);
    const request = async (route, method = 'POST', authenticated = true) => {
      const response = await fetch(`${app.origin}/api/observer/${route}`, {
        method, headers: authenticated ? { Authorization: 'Bearer admin-token' } : {},
      });
      return { status: response.status, body: await response.json() };
    };
    const recover = async () => {
      if (recovery === 'preUninstall') return service.preUninstall();
      return request(recovery === 'disable' ? 'disable' : 'install', recovery === 'disable' ? 'POST' : 'DELETE');
    };
    try {
      await service.startup();
      assert.equal(reconciliations, 1);
      assert.equal(service.startupError, failure);
      // Recovery endpoints retain the same authentication gate even during failure.
      assert.equal((await request('disable', 'POST', false)).status, 401);
      assert.equal((await request('install', 'DELETE', false)).status, 401);
      assert.equal(reconciliations, 1);
      if (recovery === 'preUninstall') {
        await assert.rejects(recover(), { code: 'removal_failed' });
      } else {
        const failed = await recover();
        assert.equal(failed.status, 503);
        assert.equal(failed.body.error, recovery === 'disable' ? 'teardown_failed' : 'removal_failed');
      }
      assert.equal(reconciliations, 2, 'recovery must retry persisted cleanup with active=null');
      assert.equal(service.startupError, failure);
      assert.equal(manager._runtimeError, failure);
      assert.equal(desired().enabled, false);
      assert.equal(desired().teardownFence, true);
      assert.equal(survivors, true);
      assert.equal(installed, true);
      for (const route of ['enable', 'install', 'leases']) {
        const blocked = await request(route);
        assert.equal(blocked.status, 503);
        assert.equal(blocked.body.error, 'teardown_failed');
      }
      assert.equal(starts, 0);
      cleanupAllowed = true;
      const result = await recover();
      if (recovery !== 'preUninstall') assert.equal(result.status, 200);
      assert.equal(reconciliations, 3);
      assert.equal(survivors, false);
      assert.equal(service.startupError, null);
      assert.equal(manager._runtimeError, null);
      assert.equal(desired().enabled, false);
      assert.equal(desired().teardownFence, true);
      assert.equal(installed, recovery === 'disable');
      if (recovery !== 'disable') {
        assert.ok(events.indexOf('survivors-cleared') < events.indexOf('remove-artifacts'));
        assert.equal(desired().removalState, null);
      }
      // Recovery clears the startup error, but never implicitly admits a viewer.
      const disabled = await request('leases');
      assert.equal(disabled.status, 404);
      assert.equal(disabled.body.error, 'observer_disabled');
      assert.equal(starts, 0);
    } finally {
      await service.shutdown();
      await app.close();
    }
  });
});


test('local Observer cookie HTTP admission ignores forwarded protocol and rejects hostile metadata', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  let created = 0;
  service.manager.createLease = async () => { created += 1; return { id: LEASE_ID }; };
  const origin = app.origin.replace('http:', 'https:');
  const post = (headers) => fetch(`${app.origin}/api/observer/leases`, {
    method: 'POST', headers: { Cookie: 'admin=1', Origin: origin, 'X-Forwarded-Proto': 'http', ...headers },
  });
  try {
    for (const headers of [
      { 'Sec-Fetch-Site': 'same-origin' },
      {},
      { 'Sec-Fetch-Site': 'same-origin', Host: 'rewritten.internal' },
    ]) {
      const response = await post(headers);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).id, LEASE_ID);
    }
    assert.equal(created, 3);
    for (const headers of [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'none' },
      { 'Sec-Fetch-Site': '' },
      { 'Sec-Fetch-Site': 'same-origin, cross-site' },
    ]) {
      const response = await post(headers);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'origin_required' });
    }
    assert.equal(created, 3, 'rejected requests must not create leases');
    const bearer = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-token', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(bearer.status, 201, 'origin policy only gates cookie authentication');
  } finally { await app.close(); }
});

test('local Observer cookie WebSocket admission ignores forwarded protocol with preserved Host', async () => {
  const { service, upstreams } = fixture();
  const app = await startHttp(service);
  const headers = {
    Cookie: 'admin=1', Origin: app.origin.replace('http:', 'https:'), 'X-Forwarded-Proto': 'http',
    'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}`,
  };
  const connect = (extra) => connectObserverWebSocket({
    port: app.server.address().port, path: '/observer/stream', headers: { ...headers, ...extra },
  });
  let socket;
  try {
    for (const extra of [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': '' },
      { 'Sec-Fetch-Site': 'same-origin, cross-site' },
    ]) await assert.rejects(connect(extra), /rejected \(403\)/);
    assert.equal(upstreams.length, 0, 'rejected handshakes must not allocate upstreams');
    socket = await connect({});
    socket.activate();
    assert.equal(socket.closed, false);
    assert.equal(upstreams.length, 1);
  } finally {
    socket?.destroy();
    await service.shutdown();
    await app.close();
  }
});

function sizeFixture(options = {}) {
  let output = '100 29 on';
  let queries = 0;
  const monitor = new ObserverSizeMonitor({ intervalMs: 20, exec: async () => {
    queries += 1;
    return { stdout: output };
  } });
  const fixtureValue = fixture({ ...options, sizeMonitor: monitor });
  Object.assign(fixtureValue.service.containment.active, { target: 'claude-main', tmuxPath: '/fixture/tmux' });
  return { ...fixtureValue, monitor, setOutput(value) { output = value; }, queries: () => queries };
}

async function sizeClient(app, leaseId = LEASE_ID) {
  const socket = await connectObserverWebSocket({
    port: app.server.address().port, path: '/observer/stream', closeTimeoutMs: 50,
    headers: { Cookie: 'admin=1', Origin: app.origin,
      'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${leaseId}` },
  });
  const messages = [];
  socket.on('message', (value) => messages.push(Buffer.isBuffer(value) ? value : JSON.parse(value)));
  socket.activate();
  return { socket, messages };
}

test('size follow shares one monitor, precedes display, broadcasts changes and stops at final close', async () => {
  const f = sizeFixture({ initialDisplay: 'snapshot' });
  const app = await startHttp(f.service);
  const clients = [];
  try {
    clients.push(await sizeClient(app));
    await waitUntil(() => clients[0].messages.length === 2);
    assert.deepEqual(clients[0].messages[0], { type: 'size', cols: 100, rows: 30 });
    assert.equal(clients[0].messages[1].toString(), 'snapshot');
    const timer = f.monitor.timer;
    const secondId = 'b'.repeat(32);
    const validate = f.service.manager.validateLease;
    f.service.manager.validateLease = (id, context) => id === secondId ? { id, generation: 7 } : validate(id, context);
    clients.push(await sizeClient(app, secondId));
    await waitUntil(() => clients[1].messages.length === 2);
    assert.equal(f.monitor.timer, timer);
    assert.deepEqual(f.upstreams.map((upstream) => upstream.callbacks.size), [{ cols: 100, rows: 30 }, { cols: 100, rows: 30 }]);
    f.setOutput('140 40 3');
    await waitUntil(() => clients.every((client) => client.messages.length === 3));
    for (let index = 0; index < clients.length; index += 1) {
      assert.deepEqual(clients[index].messages[2], { type: 'size', cols: 140, rows: 43 });
      assert.deepEqual(f.upstreams[index].resizes, [{ cols: 140, rows: 43 }]);
    }
    await f.monitor.poll();
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.deepEqual(clients.map((client) => client.messages.length), [3, 3]);
    clients[0].socket.close();
    await waitUntil(() => f.service.streams.size === 1);
    assert.equal(f.monitor.timer, timer);
    let finish;
    f.monitor.exec = () => new Promise((resolve) => { finish = resolve; });
    const late = f.monitor.poll();
    clients[1].socket.close();
    await waitUntil(() => f.service.streams.size === 0);
    assert.equal(f.monitor.timer, null);
    finish({ stdout: '200 50 off' });
    await late;
    assert.deepEqual(f.monitor.size, { cols: 140, rows: 43 });
    assert.deepEqual(f.upstreams.map((upstream) => upstream.resizes.length), [1, 1]);
  } finally {
    await f.service.shutdown();
    clients.forEach((client) => client.socket.destroy());
    await app.close();
  }
});

test('upstream handshake race uses latest size before admitting downstream', async () => {
  const f = sizeFixture({ deferUpstream: true });
  const app = await startHttp(f.service);
  let client;
  try {
    const connecting = sizeClient(app);
    await waitUntil(() => f.upstreams[0]?.callbacks);
    f.setOutput('140 39 on');
    await f.monitor.poll();
    assert.equal(f.upstreams[0].resizes.length, 0);
    f.resolveConnect();
    client = await connecting;
    await waitUntil(() => client.messages.length === 1);
    assert.deepEqual(client.messages[0], { type: 'size', cols: 140, rows: 40 });
    assert.deepEqual(f.upstreams[0].resizes, [{ cols: 140, rows: 40 }]);
  } finally { f.resolveConnect(); await f.service.shutdown(); client?.socket.destroy(); await app.close(); }
});

test('size monitor is stopped and late query fenced after disable, failure or shutdown', async (t) => {
  for (const action of ['disable', 'failure', 'shutdown']) await t.test(action, async () => {
    const f = sizeFixture();
    const app = await startHttp(f.service);
    let client;
    try {
      client = await sizeClient(app);
      await waitUntil(() => client.messages.length === 1);
      let finish;
      f.monitor.exec = () => new Promise((resolve) => { finish = resolve; });
      const pending = f.monitor.poll();
      if (action === 'disable') {
        const response = await fetch(`${app.origin}/api/observer/disable`, { method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin } });
        assert.equal(response.status, 200);
      } else if (action === 'failure') f.service.containment.emit('failure', new Error('fixture'), f.service.containment.active);
      else await f.service.shutdown();
      assert.equal(f.monitor.timer, null);
      assert.equal(f.service.streams.size, 0);
      finish({ stdout: '160 50 off' });
      await pending;
      assert.deepEqual(f.monitor.size, { cols: 100, rows: 30 });
      assert.equal(f.upstreams[0].resizes.length, 0);
    } finally { await f.service.shutdown(); client?.socket.destroy(); await app.close(); }
  });
});

test('removed preset endpoint returns 404', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  try {
    const response = await fetch(`${app.origin}/api/observer/leases/${LEASE_ID}/preset`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin, 'Content-Type': 'application/json' }, body: '{"preset":"wide"}',
    });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'not_found' });
  } finally { await app.close(); }
});

test('failed upstream handshake and generation replacement stop the monitor without admission', async (t) => {
  for (const action of ['connect-error', 'generation-change']) await t.test(action, async () => {
    const f = sizeFixture({ deferUpstream: true });
    const app = await startHttp(f.service);
    if (action === 'connect-error') f.service.upstreamFactory = () => ({
      async connect() { throw new Error('fixture connect failed'); }, close() {},
    });
    try {
      const rejected = assert.rejects(sizeClient(app));
      if (action === 'generation-change') {
        await waitUntil(() => f.upstreams[0]?.callbacks);
        f.service.containment.active = { ...f.service.containment.active, generation: 8 };
        f.resolveConnect();
      }
      await rejected;
      assert.equal(f.service.streams.size, 0);
      assert.equal(f.monitor.timer, null);
      assert.equal(f.monitor.active, null);
    } finally { f.resolveConnect(); await f.service.shutdown(); await app.close(); }
  });
});

test('private resize must settle before upstream and browser broadcast; failure retries same measurement', async () => {
  const f = sizeFixture();
  // Drive the real monitor/service callback deterministically without sockets.
  f.monitor.intervalMs = 60_000;
  const active = f.service.containment.active;
  const events = [];
  f.service.streams.add({ active, connected: true, closed: false,
    upstream: { resize(size) { events.push(['upstream', size]); } },
    downstream: { sendText(text) { events.push(['browser', JSON.parse(text)]); } },
  });
  let finish;
  let fail = false;
  f.service.containment.resize = async (_active, size) => {
    events.push(['private-start', size]);
    await new Promise((resolve) => { finish = resolve; });
    if (fail) throw new Error('private resize failed');
    events.push(['private-done', size]);
    return true;
  };
  try {
    const initial = f.monitor.start(active);
    await waitUntil(() => finish);
    assert.deepEqual(events.map(([name]) => name), ['private-start']);
    finish(); await initial;
    assert.deepEqual(events.map(([name]) => name), ['private-start', 'private-done', 'upstream', 'browser']);
    events.length = 0; finish = null; fail = true;
    f.setOutput('140 40 off');
    const failed = f.monitor.poll();
    await waitUntil(() => finish); finish(); await failed;
    assert.deepEqual(events.map(([name]) => name), ['private-start']);
    assert.deepEqual(f.monitor.size, { cols: 100, rows: 30 });
    events.length = 0; finish = null; fail = false;
    const retry = f.monitor.poll();
    await waitUntil(() => finish); finish(); await retry;
    assert.deepEqual(events.map(([name]) => name), ['private-start', 'private-done', 'upstream', 'browser']);
    assert.deepEqual(f.monitor.size, { cols: 140, rows: 40 });
  } finally { f.monitor.stop(); f.service.streams.clear(); }
});

test('generation replacement during private resize fences upstream and browser delivery', async () => {
  const f = sizeFixture();
  const active = f.service.containment.active;
  const events = [];
  f.service.streams.add({ active, connected: true, closed: false,
    upstream: { resize() { events.push('upstream'); } },
    downstream: { sendText() { events.push('browser'); } },
  });
  let finish;
  f.service.containment.resize = () => new Promise((resolve) => { finish = resolve; });
  const pending = f.service._resizeStreams({ cols: 140, rows: 40 }, active);
  f.service.containment.active = { ...active, generation: 8 };
  finish(true); await pending;
  assert.deepEqual(events, []);
  f.service.streams.clear();
});

test('Set size resizes the Agent, then remembers the applied size', async () => {
  const { service, containment, coordinator } = fixture();
  const app = await startHttp(service);
  const post = (body, headers = { Cookie: 'admin=1', Origin: app.origin }) => fetch(`${app.origin}/api/observer/agent-size`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  try {
    const initial = await fetch(`${app.origin}/api/observer/status`, { headers: { Cookie: 'admin=1' } });
    assert.deepEqual((await initial.json()).agentSize, { cols: 120, rows: 50 });

    const response = await post({ cols: 132, rows: 60 });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      agentSize: { cols: 132, rows: 60 },
      applied: { cols: 132, rows: 60, statusLines: 1 },
    });
    assert.deepEqual(containment.agentResizes, [{ runtime: 'claude', cols: 132, rows: 60 }]);
    assert.deepEqual(coordinator.savedAgentSizes, [{ cols: 132, rows: 60 }]);

    const status = await fetch(`${app.origin}/api/observer/status`, { headers: { Cookie: 'admin=1' } });
    assert.deepEqual((await status.json()).agentSize, { cols: 132, rows: 60 });

    const bearer = await post({ cols: 100, rows: 40 }, { Authorization: 'Bearer admin-token' });
    assert.equal(bearer.status, 200);
  } finally { await app.close(); }
});

test('Set size is an admin write guarded by origin and strict size validation', async () => {
  const { service, containment, coordinator } = fixture();
  const app = await startHttp(service);
  const post = (body, headers) => fetch(`${app.origin}/api/observer/agent-size`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const admin = { Cookie: 'admin=1', Origin: app.origin };
  try {
    const cases = [
      [{ cols: 120, rows: 50 }, {}, 401, 'unauthorized'],
      [{ cols: 120, rows: 50 }, { Cookie: 'admin=1' }, 403, 'origin_required'],
      [{ cols: 120, rows: 50 }, { Cookie: 'admin=1', Origin: 'https://evil.example' }, 403, 'origin_required'],
      [{ cols: 120, rows: 50 }, { Authorization: 'Bearer read-token' }, 403, 'insufficient_scope'],
      [{ cols: 19, rows: 50 }, admin, 400, 'invalid_size'],
      [{ cols: 501, rows: 50 }, admin, 400, 'invalid_size'],
      [{ cols: 120, rows: 4 }, admin, 400, 'invalid_size'],
      [{ cols: 120, rows: 201 }, admin, 400, 'invalid_size'],
      [{ cols: 120.5, rows: 50 }, admin, 400, 'invalid_size'],
      [{ cols: '120', rows: 50 }, admin, 400, 'invalid_size'],
      [{ cols: 120 }, admin, 400, 'invalid_size'],
      [{ cols: 120, rows: 50, target: 'other' }, admin, 400, 'invalid_size'],
      [[120, 50], admin, 400, 'invalid_size'],
      ['{not json', admin, 400, 'invalid_size'],
    ];
    for (const [body, headers, status, error] of cases) {
      const response = await post(body, headers);
      assert.equal(response.status, status, JSON.stringify([body, headers]));
      assert.deepEqual(await response.json(), { error });
    }
    assert.deepEqual(containment.agentResizes, []);
    assert.deepEqual(coordinator.savedAgentSizes, []);
  } finally { await app.close(); }
});

test('Set size failures leave the remembered size unchanged', async () => {
  const failures = [
    [Object.assign(new Error('gone'), { code: 'target_unavailable' }), 409, 'agent_session_unavailable'],
    [Object.assign(new Error('mismatch'), { code: 'agent_resize_failed' }), 500, 'agent_resize_failed'],
    [Object.assign(new Error('tmux exited 1'), { code: 1 }), 500, 'agent_resize_failed'],
    [Object.assign(new Error('status too tall'), { code: 'invalid_size', maxRows: 197 }), 400, 'invalid_size', { maxRows: 197 }],
  ];
  for (const [error, status, code, detail = {}] of failures) {
    const { service, coordinator } = fixture({ resizeAgent: async () => { throw error; } });
    const app = await startHttp(service);
    try {
      const response = await fetch(`${app.origin}/api/observer/agent-size`, {
        method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin }, body: JSON.stringify({ cols: 120, rows: 50 }),
      });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error: code, ...detail });
      assert.deepEqual(coordinator.savedAgentSizes, []);
    } finally { await app.close(); }
  }
});

test('Set size refuses to race an Observer attachment in progress', async () => {
  const { service, containment } = fixture({ starting: true });
  const app = await startHttp(service);
  try {
    const response = await fetch(`${app.origin}/api/observer/agent-size`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin }, body: JSON.stringify({ cols: 120, rows: 50 }),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: 'observer_starting' });
    assert.deepEqual(containment.agentResizes, []);
  } finally { await app.close(); }
});

test('concurrent Set size requests persist in the order they were applied', async () => {
  const releases = [];
  const { service, coordinator } = fixture({
    resizeAgent: (request) => new Promise((resolve) => releases.push(() => resolve({ ...request, statusLines: 1 }))),
  });
  const first = service._setAgentSize({ cols: 100, rows: 40 });
  const second = service._setAgentSize({ cols: 140, rows: 45 });
  await waitUntil(() => releases.length === 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(releases.length, 1, 'second resize must wait for the first');
  releases[0]();
  await first;
  await waitUntil(() => releases.length === 2);
  releases[1]();
  await second;
  assert.deepEqual(coordinator.savedAgentSizes, [{ cols: 100, rows: 40 }, { cols: 140, rows: 45 }]);
});

test('one-time ticket admits a cookie WebSocket when a proxy rewrites Host and Fetch Metadata is absent', async () => {
  let clock = 1_000;
  const { service, upstreams } = fixture({
    managerFactory: (deps) => new ObserverManager({ ...deps, runtime: 'claude', ticketTtlMs: 1_000, now: () => clock }),
  });
  const app = await startHttp(service);
  // The public origin differs from the Host the Dashboard receives.
  const publicOrigin = 'https://dashboard.example';
  const lease = async (cookie = 'admin=1') => {
    const response = await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'same-origin', Origin: publicOrigin },
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const renew = async (id) => {
    const response = await fetch(`${app.origin}/api/observer/leases/${id}/renew`, {
      method: 'POST', headers: { Cookie: 'admin=1', 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const connect = (leaseId, ticket, extra = {}) => connectObserverWebSocket({
    port: app.server.address().port, path: '/observer/stream',
    headers: {
      Cookie: 'admin=1', Origin: publicOrigin,
      'Sec-WebSocket-Protocol': [OBSERVER_WEBSOCKET_PROTOCOL, `lease.${leaseId}`, ...(ticket ? [`ticket.${ticket}`] : [])].join(', '),
      ...extra,
    },
  });
  const sockets = [];
  try {
    const first = await lease();
    const second = await lease();
    const foreign = await lease('admin=2');
    assert.match(first.ticket, /^[A-Za-z0-9_-]{43}$/);
    const renewed = await renew(first.id);
    assert.match(renewed.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(renewed.ticket, first.ticket);

    await assert.rejects(connect(first.id, null), /rejected \(403\)/, 'no ticket');
    await assert.rejects(connect(first.id, 'A'.repeat(43)), /rejected \(403\)/, 'garbage ticket');
    await assert.rejects(connect(first.id, second.ticket), /rejected \(403\)/, 'ticket from another lease');
    await assert.rejects(connect(foreign.id, foreign.ticket), /rejected \(403\)/, 'ticket for another principal');
    await assert.rejects(connect(first.id, first.ticket, { 'Sec-Fetch-Site': 'cross-site' }), /rejected \(403\)/,
      'explicit cross-site Fetch Metadata is never overridden by a ticket');
    await assert.rejects(connect(first.id, `${first.ticket}, ticket.${renewed.ticket}`), /rejected \(403\)/, 'repeated ticket token');
    assert.equal(upstreams.length, 0, 'rejected handshakes must not allocate upstreams');

    const third = await renew(first.id);
    // Token order is not significant.
    const socket = await connectObserverWebSocket({
      port: app.server.address().port, path: '/observer/stream',
      headers: {
        Cookie: 'admin=1', Origin: publicOrigin,
        'Sec-WebSocket-Protocol': `ticket.${third.ticket}, ${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${first.id}`,
      },
    });
    sockets.push(socket);
    socket.activate();
    assert.equal(socket.closed, false);
    assert.equal(upstreams.length, 1);
    // A reused ticket fails the origin check before the lease-in-use check.
    await assert.rejects(connect(first.id, third.ticket), /rejected \(403\)/, 'reused ticket');
    await assert.rejects(connect(first.id, renewed.ticket), /rejected \(409\)/, 'an unused ticket reaches the lease check');

    const expiring = await lease();
    clock += 1_000;
    await assert.rejects(connect(expiring.id, expiring.ticket), /rejected \(403\)/, 'expired ticket');
  } finally {
    for (const socket of sockets) socket.destroy();
    await service.shutdown();
    await app.close();
  }
});

test('same-origin cookie and bearer WebSocket handshakes do not need a ticket', async () => {
  const { service, upstreams } = fixture({
    managerFactory: (deps) => new ObserverManager({ ...deps, runtime: 'claude' }),
  });
  const app = await startHttp(service);
  const sockets = [];
  try {
    const cookieLease = await (await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin },
    })).json();
    const bearerLease = await (await fetch(`${app.origin}/api/observer/leases`, {
      method: 'POST', headers: { Authorization: 'Bearer admin-token' },
    })).json();
    for (const headers of [
      { Cookie: 'admin=1', Origin: app.origin, 'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${cookieLease.id}` },
      { Authorization: 'Bearer admin-token', 'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${bearerLease.id}` },
    ]) {
      const socket = await connectObserverWebSocket({ port: app.server.address().port, path: '/observer/stream', headers });
      sockets.push(socket);
      socket.activate();
      assert.equal(socket.closed, false);
    }
    assert.equal(upstreams.length, 2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await service.shutdown();
    await app.close();
  }
});
