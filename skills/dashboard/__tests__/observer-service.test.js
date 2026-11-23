import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';

import test from 'node:test';
import { ObserverService, OBSERVER_WEBSOCKET_PROTOCOL } from '../src/lib/observer-service.js';

import { connectObserverWebSocket } from '../src/lib/observer-websocket.js';

const LEASE_ID = 'a'.repeat(32);

// `config` defaults to remote access allowed, so API key cases elsewhere test their own concern.
function fixture({ deferUpstream = false, initialDisplay = null, sizeMonitor, resizeAgent, starting = false, managerFactory,
  config = { chat: { allowRemote: true } } } = {}) {
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
    async targetStatus(sessionGroup) { return { sessionMode: 'multi', target: { sessionGroup, runId: 'selected-run', runtime: 'codex' } }; },
    validateLease(id, supplied) {
      if (id !== LEASE_ID) throw Object.assign(new Error('missing'), { code: 'lease_not_found' });
      assert.equal(supplied.scope, 'admin');
      return { id, generation: 7 };
    },
    async createLease() { return { id: LEASE_ID, generation: 7 }; },
    renewLease() { return { id: LEASE_ID, generation: 7 }; },
    releaseLease() { return { released: true }; },
    released: [],
    releaseLeasesWhere(matches) { this.released.push(matches); return 1; },
    async invalidateAndDisable() { return { state: 'disabled' }; },
    async handleContainmentFailure() {},
    async shutdown() { return { stopped: true }; },
  };
  const authGate = {
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
    coordinator, containment, authGate, upstreamFactory, sizeMonitor, config,
    manager: managerFactory ? managerFactory({ coordinator, containment, authGate }) : manager,
  });
  return { service, upstreams, resolveConnect, containment, coordinator, config, manager };
}

async function startHttp(service) {
  const server = http.createServer(async (req, res) => {
    res.apiPath = new URL(req.url, 'http://fixture').pathname;
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

test('Observer HTTP surface fails closed without credentials', async () => {
  const { service } = fixture();
  const app = await startHttp(service);
  try {
    const response = await fetch(`${app.origin}/api/observer/status`);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { ok: false, error: { code: 'unauthorized', message: 'unauthorized' } });
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
      [{ cols: 120, rows: 50 }, { Cookie: 'admin=1' }, 403, 'same_origin_required'],
      [{ cols: 120, rows: 50 }, { Cookie: 'admin=1', Origin: 'https://evil.example' }, 403, 'same_origin_required'],
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
      assert.deepEqual(await response.json(), { ok: false, error: { code: error, message: error } });
    }
    assert.deepEqual(containment.agentResizes, []);
    assert.deepEqual(coordinator.savedAgentSizes, []);
  } finally { await app.close(); }
});

// Real loopback HTTP validates selected-group propagation and the lease body allowlist;
// manager/containment are injected, so no native process or database is opened.
// Run for observer request fields, target propagation or resize changes; skip unrelated UI.
// Use the official runner with private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and socket/DB
// paths read back before startup. The case closes its private HTTP server in finally.

// Real loopback HTTP -> service -> manager -> target resolver; Core observations are
// injected so no tmux/model/PM2 is launched. Run for group-status/error mapping or
// lease target changes, skip unrelated presentation changes. Official runner owns
// isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; finally closes HTTP and manager timers.

// "Allow remote access to conversations and terminal" (`chat.allowRemote`) also governs the observer:
// API keys (remote Dashboards) are refused while it is off; the local browser cookie never depends on it.
test('remote observer access follows the conversation switch on every route and the upgrade', async () => {
  const { service, upstreams, config } = fixture({ config: { chat: { allowRemote: false } } });
  const app = await startHttp(service);
  const bearer = { Authorization: 'Bearer admin-token' };
  try {
    for (const [path, method] of [['/api/observer/status', 'GET'], ['/api/observer/leases', 'POST'],
      [`/api/observer/leases/${LEASE_ID}/release`, 'POST'], ['/api/observer/agent-size', 'POST'], ['/api/observer/enable', 'POST'],
      ['/api/observer/history/sessions', 'GET']]) {
      const response = await fetch(`${app.origin}${path}`, { method, headers: bearer });
      assert.equal(response.status, 403, path);
      assert.equal((await response.json()).error.code, 'remote_chat_disabled', path);
    }
    // The switch is checked before the key scope, as for conversations: a read key learns the switch is off.
    const readWhileOff = await fetch(`${app.origin}/api/observer/status`, { headers: { Authorization: 'Bearer read-token' } });
    assert.equal((await readWhileOff.json()).error.code, 'remote_chat_disabled');
    const frame = await fetch(`${app.origin}/observer/frame`, { headers: { ...bearer, 'X-Observer-Lease': LEASE_ID } });
    assert.equal(frame.status, 403);
    await assert.rejects(connectObserverWebSocket({ port: app.server.address().port, path: '/observer/stream',
      headers: { ...bearer, 'Sec-WebSocket-Protocol': `${OBSERVER_WEBSOCKET_PROTOCOL}, lease.${LEASE_ID}` } }), /rejected \(403\)/);
    assert.equal(upstreams.length, 0);
    const local = await fetch(`${app.origin}/api/observer/leases`, { method: 'POST', headers: { Cookie: 'admin=1', Origin: app.origin } });
    assert.equal(local.status, 201, 'the local browser is not affected');
    // The settings route replaces config.chat in place; the next request sees it.
    config.chat = { allowRemote: true };
    assert.equal((await fetch(`${app.origin}/api/observer/leases`, { method: 'POST', headers: bearer })).status, 201);
    const readOnly = await fetch(`${app.origin}/api/observer/leases`, { method: 'POST', headers: { Authorization: 'Bearer read-token' } });
    assert.equal((await readOnly.json()).error.code, 'insufficient_scope', 'a read key is still refused for its scope');
  } finally {
    await service.shutdown();
    await app.close();
  }
});

// Real HTTP handler and lease manager. Auth identity, installation and terminal
// target observation are injected; no terminal, service or live DB is accessed.

// Exercise the actual pre-upgrade admission path and wire serializer without
// opening a socket or starting an Observer/runtime process. Run for handshake
// authorization/error contract changes; skip unrelated terminal rendering.
