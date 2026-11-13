import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { once } from 'node:events';
import path from 'node:path';
import test, { mock } from 'node:test';
import { VersionChecker } from '../skills/dashboard/src/lib/version-checker.js';
import { EventLoopMonitor } from '../skills/dashboard/src/lib/event-loop-monitor.js';
import { StateEngine } from '../skills/dashboard/src/lib/state-engine.js';
import { Store } from '../skills/dashboard/src/lib/store.js';
import { generateApiKey, hashApiKey } from '../skills/dashboard/src/lib/auth.js';
import { SupervisorAdmission } from '../skills/activity-monitor/scripts/supervisor-admission.js';
import { createSupervisorConnectionHandler } from '../skills/activity-monitor/scripts/router-socket.js';
import * as sessionReader from '../cli/lib/session-state-reader.js';
import Database from '../skills/comm-bridge/scripts/sqlite-driver.js';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';

// Integration boundary: real Dashboard HTTP/auth, mode/health readers, socket
// client and supervisor rejection. Only live-session observation is injected.
// Run for readiness/auth/IPC changes; skip UI-only changes. Official Node runner
// plus the private launcher isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and
// private tmux socket; Dashboard DB and am.sock are owned by this test. No live
// runtime, PM2 or external network is used. All servers/peers close on failure.
test('Dashboard readiness uses public HTTP and the existing supervisor reply', { timeout: 20000 }, async t => {
  const root = process.env.ZYLOS_DIR;
  assert.ok(root && root.startsWith(process.env.HOME + path.sep));
  assert.ok(process.env.PM2_HOME?.startsWith(process.env.HOME + path.sep));
  assert.ok(process.env.TMPDIR.length < 60);
  const socketPath = path.join(root, 'activity-monitor/am.sock');
  assert.ok(Buffer.byteLength(socketPath) < 104);
  console.log('Readiness isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: root,
    PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    database: path.join(root, 'components/dashboard/dashboard.db'), socketPath, tmux: 'observation injected' }));

  let present = true, identityReads = 0, identityGate = null;
  mock.module('../cli/lib/session-state-reader.js', { namedExports: { ...sessionReader,
    readLiveIdentity: async group => {
      assert.equal(group, null); identityReads++;
      if (identityGate) {
        dashboard.emit('probe-identity-entered');
        await identityGate;
      }
      return { present, ready: false, pid: 31337, runId: 'private-run', sessionId: 'private-session' };
    },
  } });
  t.after(() => mock.restoreAll());
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(EventLoopMonitor.prototype, 'snapshot', () => ({ lag_ms: 0 }));
  t.mock.method(StateEngine.prototype, 'getSourceHealth', () => ({ fixture: { healthy: true } }));
  t.mock.method(process, 'uptime', () => 12);
  t.mock.timers.enable({ apis: ['Date'], now: 1800000000000 });

  fs.mkdirSync(path.join(root, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(root, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: true, password: 'fixture-password' } }));
  fs.mkdirSync(path.join(root, '.zylos'), { recursive: true });
  const setMode = mode => fs.writeFileSync(path.join(root, '.zylos/config.json'), JSON.stringify({ session_mode: mode }));
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.mkdirSync(path.join(root, 'activity-monitor/runtime-health'));
  const healthFile = path.join(root, 'activity-monitor/runtime-health/claude.json');
  const setHealth = health => fs.writeFileSync(healthFile, JSON.stringify({
    v: 1, runtime: 'claude', health, reason: 'fixture', updatedAt: 1800000000000,
    unavailableSince: 0, cooldownUntil: 0, recoveringStartedAt: 0, lastUserMessageRecoveryAt: 0,
    restartFailureCount: 0, lastRecoveryAt: 0, lastDownCheckAt: 0, rateLimitResetTime: '',
    hook: { pid: 31337, promptId: 'private-prompt', groups: { origin: { runId: 'private-run' } } },
  }));
  setMode('single');

  let socketServer;
  const socketServers = new Set();
  const peers = new Set();
  const stopSocket = async (server = socketServer) => {
    const closed = [...peers].map(peer => once(peer, 'close'));
    for (const peer of peers) peer.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    await Promise.all(closed);
  };
  const stopSockets = async () => {
    for (const server of socketServers) await stopSocket(server);
  };
  t.after(stopSockets);
  const startSocket = async handler => {
    const server = net.createServer(peer => {
      peers.add(peer); peer.once('close', () => peers.delete(peer));
      handler(peer);
    });
    socketServers.add(server);
    socketServer = server;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  };
  const admission = new SupervisorAdmission();
  // No operational dependencies: a probe reaching any mutation would fail.
  const handler = createSupervisorConnectionHandler({ admission });
  const { createServer } = await import('../skills/dashboard/src/index.js');
  const dashboard = createServer();
  t.after(async () => {
    dashboard.closeAllConnections();
    await new Promise(resolve => dashboard.close(resolve));
    await dashboard.closeAttachments();
  });
  await new Promise(resolve => dashboard.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${dashboard.address().port}`;
  const request = async (route, headers = {}) => {
    const response = await fetch(origin + route, { headers, signal: AbortSignal.timeout(4000) });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    return { status: response.status, body: await response.json() };
  };
  const ready = () => request('/api/health?probe=ready');

  await t.test('ordinary public health exposes only liveness and a stable boot identity', async () => {
    const { body: expected } = await request('/api/health');
    assert.deepEqual(Object.keys(expected).sort(), ['bootId', 'ok', 'service']);
    assert.equal(expected.ok, true);
    assert.equal(expected.service, 'zylos-dashboard');
    assert.match(expected.bootId, /^[a-f0-9-]{36}$/);
    for (const route of ['/api/health', '/api/health?probe=other']) {
      assert.deepEqual(await request(route), { status: 200, body: expected });
      assert.deepEqual(await request(route, { Authorization: 'Bearer invalid' }), { status: 200, body: expected });
      assert.deepEqual(await request(route, { Cookie: '__Secure-zylos_dashboard_session=invalid' }), { status: 200, body: expected });
    }
    assert.equal(identityReads, 0);
  });
  // Extends the same real HTTP/auth boundary to cookie and API-session detail
  // admission. Run for health/auth changes; UI-only changes may skip this case.
  await t.test('signed-in health includes diagnostics for cookie and API sessions', async () => {
    const login = await fetch(origin + '/login', { method: 'POST', redirect: 'manual',
      body: new URLSearchParams({ password: 'fixture-password' }), signal: AbortSignal.timeout(4000) });
    assert.equal(login.status, 302);
    await login.text();
    const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session=')).split(';')[0];
    const key = generateApiKey();
    const database = new Store(path.join(root, 'components/dashboard/dashboard.db'));
    try { database.insertApiKey({ name: 'health-reader', keyHash: hashApiKey(key), scope: 'read' }); }
    finally { database.close(); }
    const exchange = await fetch(origin + '/api/auth/token', { method: 'POST',
      headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(4000) });
    assert.equal(exchange.status, 200);
    const { token } = await exchange.json();
    const publicHealth = (await request('/api/health')).body;
    for (const headers of [{ Cookie: cookie }, { Authorization: `Bearer ${token}` }]) {
      assert.deepEqual(await request('/api/health', headers), { status: 200, body: {
        ...publicHealth, startedAt: '2027-01-15T08:00:00.000Z', uptimeSeconds: 12,
        event_loop: { lag_ms: 0 }, source: { fixture: { healthy: true } }
      } });
    }
    assert.equal(identityReads, 0);
  });
  await t.test('missing supervisor returns 503 without requiring login', async () => {
    const response = await ready();
    assert.equal(response.status, 503);
    assert.equal(response.body.reason, 'supervisor_unavailable');
  });
  await t.test('connected but unresponsive supervisor times out and releases its peer', async () => {
    let closed;
    await startSocket(peer => {
      peer.resume();
      closed = once(peer, 'close');
    });
    try {
      const before = performance.now();
      assert.equal((await ready()).status, 503);
      assert.ok(performance.now() - before >= 900);
      await closed;
    } finally {
      await stopSocket();
    }
    assert.equal(peers.size, 0);
  });
  await t.test('socket cleanup closes the earlier listener after a later bind fails', async () => {
    await startSocket(peer => peer.resume());
    const first = socketServer;
    try {
      await assert.rejects(startSocket(peer => peer.resume()), { code: 'EADDRINUSE' });
    } finally {
      await stopSockets();
    }
    assert.equal(first.listening, false);
    assert.equal(peers.size, 0);
  });
  await startSocket(handler);
  // Covers HTTP wiring to the shared check; run for readiness/coalescing changes,
  // skip unrelated UI changes. Uses the same isolated servers and injected identity.
  await t.test('concurrent HTTP probes share one check while ordinary health stays independent', async () => {
    const count = 30;
    const before = identityReads;
    let release, received = 0;
    identityGate = new Promise(resolve => { release = resolve; });
    const onRequest = req => {
      if (req.url === '/api/health?probe=ready' && ++received === count) dashboard.emit('probe-batch-arrived');
    };
    dashboard.on('request', onRequest);
    const arrived = once(dashboard, 'probe-batch-arrived', { signal: AbortSignal.timeout(3000) });
    const entered = once(dashboard, 'probe-identity-entered', { signal: AbortSignal.timeout(3000) });
    const requests = Array.from({ length: count }, ready);
    try {
      await Promise.all([arrived, entered]);
      assert.equal((await request('/api/health')).status, 200);
      assert.equal(identityReads, before + 1);
      release();
      const responses = await Promise.all(requests);
      assert.equal(identityReads, before + 1);
      for (const response of responses) assert.deepEqual(response, responses[0]);
      assert.equal(responses[0].status, 200);
      identityGate = null;
      assert.equal((await ready()).status, 200);
      assert.equal(identityReads, before + 2);
    } finally {
      dashboard.off('request', onRequest);
      release();
      identityGate = null;
      await Promise.allSettled(requests);
    }
  });
  await t.test('single session exists even before startup readiness or login', async () => {
    const response = await ready();
    assert.equal(response.status, 200);
    assert.equal(response.body.ready, true);
    assert.equal(response.body.reason, null);
    assert.equal(response.body.session_mode, 'single');
    assert.equal(response.body.session_running, true);
    assert.deepEqual(response.body.runtime_health, { claude: { source: 'missing', health: null }, codex: { source: 'missing', health: null } });
  });
  await t.test('confirmed single-session absence returns 503', async () => {
    present = false;
    const response = await ready();
    assert.equal(response.status, 503);
    assert.equal(response.body.reason, 'session_not_running');
    assert.equal(response.body.session_running, false);
  });
  await t.test('multi mode needs no Origin or other running sessions', async () => {
    setMode('multi');
    const reads = identityReads;
    const response = await ready();
    assert.equal(response.status, 200);
    assert.equal(response.body.session_mode, 'multi');
    assert.equal(response.body.session_running, null);
    assert.equal(identityReads, reads);
  });
  for (const health of ['auth_failed', 'rate_limited', 'down', 'recovering']) {
    await t.test(`${health} is diagnostic in both session modes`, async () => {
      setHealth(health); present = true;
      for (const mode of ['single', 'multi']) {
        setMode(mode);
        const response = await ready();
        assert.equal(response.status, 200);
        assert.deepEqual(response.body.runtime_health.claude, { source: 'record', health });
        assert.deepEqual(Object.keys(response.body).sort(), ['ready', 'reason', 'runtime_health', 'session_mode', 'session_running']);
        assert.doesNotMatch(JSON.stringify(response.body), /private|31337|pid|runId|sessionId|prompt|tool|\/home\//);
      }
    });
  }
  await t.test('upgrade and mode-switch materials add no readiness gate', async () => {
    fs.mkdirSync(path.join(root, '.zylos/upgrade'));
    fs.writeFileSync(path.join(root, '.zylos/upgrade/active.json'), JSON.stringify({ transactionId: 'private-upgrade' }));
    fs.mkdirSync(path.join(root, 'comm-bridge'), { recursive: true });
    const db = new Database(path.join(root, 'comm-bridge/c4.db'));
    t.after(() => db.close());
    guardDatabase(db, schema);
    const c4 = createStore(db, { validateComponent: () => true });
    c4.beginModeTransition('single', 'multi');
    assert.equal(c4.getModeTransition().phase, 'gating');
    fs.writeFileSync(path.join(root, 'activity-monitor/restart-requests.json'), JSON.stringify([
      { requestId: 'private-restart', reason: 'upgrade', acceptedAt: 1800000000000, runIds: ['private-run'] },
    ]));
    for (const mode of ['single', 'multi']) {
      setMode(mode);
      const response = await ready();
      assert.equal(response.status, 200);
      assert.equal(response.body.session_mode, mode);
    }
  });
  await t.test('health query exemption does not open other API paths', async () => {
    for (const route of ['/api/state?probe=ready', '/api/instance-status?probe=ready', '/api/health/extra?probe=ready']) {
      assert.equal((await request(route)).status, 401);
    }
  });
});
