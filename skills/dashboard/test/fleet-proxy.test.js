import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import test from 'node:test';
import { publicDir } from '../src/lib/config.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';
import { acceptObserverWebSocket, connectObserverWebSocket } from '../src/lib/observer-websocket.js';

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    close: () => new Promise(resolve => server.close(resolve))
  };
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
      client.write([
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
        '',
        '',
      ].join('\r\n'), (error) => {
        if (error) reject(error);
      });
    });
  });
  return { client, closed };
}

test('fleet proxy serves hub static frontend under agent prefix without secrets', async () => {
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /\/fleet\/Remote\/_assets/);
    assert.equal(body.includes('zylos_ak_secret'), false);
    assert.equal(body.includes('zylos_st_secret'), false);
  } finally {
    await hub.close();
  }
});

test('fleet proxy prefixes rewritten paths with the reverse-proxy base path (#159)', async () => {
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    // Caddy forwards /dashboard/fleet/Remote/ as /fleet/Remote/ with this header.
    const resp = await fetch(`${hub.origin}/fleet/Remote/`, {
      headers: { 'x-forwarded-prefix': '/dashboard' }
    });
    assert.equal(resp.status, 200);
    const body = await resp.text();
    // Browser-facing asset/API paths must carry the /dashboard prefix so the
    // browser requests stay under /dashboard/* (the only route Caddy proxies).
    assert.match(body, /\/dashboard\/fleet\/Remote\/_assets/);
    // And must NOT emit the bare /fleet/Remote/_assets path that 404s at root.
    assert.equal(/["'(]\/fleet\/Remote\/_assets/.test(body), false);
  } finally {
    await hub.close();
  }
});

test('fleet proxy standalone HTML resolves admin access before injection', async () => {
  const tokenRequests = [];
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: {
      getSessionToken: async (name) => {
        tokenRequests.push(name);
        return 'zylos_st_secret';
      },
      getAgentAccess: () => 'admin'
    }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /data-remote-access="admin"/);
    assert.deepEqual(tokenRequests, ['Remote']);
  } finally {
    await hub.close();
  }
});

test('fleet proxy standalone HTML falls back to read when access cannot be resolved', async () => {
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://remote.invalid', read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: {
      getSessionToken: async () => {
        const err = new Error('auth_failed');
        err.status = 403;
        throw err;
      },
      getAgentAccess: () => 'admin'
    }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /data-remote-access="read"/);
  } finally {
    await hub.close();
  }
});

test('fleet proxy injects session token for API and keeps token out of client response', async () => {
  let seenAuth = null;
  const remote = await listen((req, res) => {
    seenAuth = req.headers.authorization;
    res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': 'bad=secret' });
    res.end(JSON.stringify({ ok: true, path: req.url }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state?x=1`);
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('set-cookie'), null);
    assert.equal(seenAuth, 'Bearer zylos_st_secret');
    const body = await resp.text();
    assert.match(body, /"ok":true/);
    assert.equal(body.includes('zylos_st_secret'), false);
    assert.equal(body.includes('zylos_ak_secret'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet Observer cookie writes require the exact consumer Origin before any upstream write', async () => {
  let forwarded = 0;
  let tokenFetches = 0;
  const proxy = new FleetProxy({
    config: {},
    poller: { getSessionToken: async () => { tokenFetches += 1; return 'remote-admin-token'; } },
    fetch: async () => {
      forwarded += 1;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
  const agent = { name: 'Remote', base_url: 'https://producer.invalid' };
  const request = (origin) => {
    const req = Readable.from([]);
    req.method = 'POST';
    req.headers = { host: 'hub.example.com', ...(origin === undefined ? {} : { origin }) };
    req._authContext = principal;
    return req;
  };
  const response = () => ({
    status: null,
    writeHead(status) { this.status = status; },
    setHeader() {},
    end() {}
  });

  for (const origin of [undefined, 'https://evil.example.com', 'http://hub.example.com/']) {
    const res = response();
    await proxy.proxyApi(request(origin), res, agent, '/api/observer/disable', '');
    assert.equal(res.status, 403);
    assert.equal(forwarded, 0);
    assert.equal(tokenFetches, 0);
  }

  const res = response();
  await proxy.proxyApi(request('http://hub.example.com'), res, agent, '/api/observer/disable', '');
  assert.equal(res.status, 200);
  assert.equal(forwarded, 1);
  assert.equal(tokenFetches, 1);
});

test('fleet Observer HTTP allowlist binds remote leases to the local admin principal', async () => {
  const leaseId = 'o'.repeat(32);
  const seen = [];
  const remote = await listen(async (req, res) => {
    seen.push([req.method, req.url, req.headers.authorization, req.headers['x-observer-lease']]);
    if (req.method === 'POST' && req.url === '/api/observer/leases') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: leaseId, expiresAt: Date.now() + 30_000, preset: 'standard' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/observer/frame') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Observer</title>');
      return;
    }
    res.writeHead(404).end();
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'remote-admin-token' }
  });
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
  const hub = await listen((req, res) => {
    req._authContext = req.headers['x-test-principal'] === 'other'
      ? { kind: 'cookie', principalId: 'other-admin', scope: 'admin' }
      : principal;
    proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  try {
    const lease = await fetch(`${hub.origin}/fleet/Remote/api/observer/leases`, { method: 'POST', headers: { Origin: hub.origin } });
    assert.equal(lease.status, 201);
    assert.equal((await lease.json()).id, leaseId);
    const preset = await fetch(`${hub.origin}/fleet/Remote/api/observer/leases/${leaseId}/preset`, { method: 'POST', headers: { Origin: hub.origin } });
    assert.equal(preset.status, 403);
    assert.equal(seen.some(([, url]) => url.endsWith('/preset')), false);

    const frame = await fetch(`${hub.origin}/fleet/Remote/observer/frame`, {
      headers: { 'x-observer-lease': leaseId }
    });
    assert.equal(frame.status, 200);
    assert.match(await frame.text(), /Observer/);

    const stolen = await fetch(`${hub.origin}/fleet/Remote/observer/frame`, {
      headers: { 'x-observer-lease': leaseId, 'x-test-principal': 'other' }
    });
    assert.equal(stolen.status, 404);
    assert.equal(seen.filter(([, url]) => url === '/observer/frame').length, 1);
    assert.ok(seen.every(([, , auth]) => auth === 'Bearer remote-admin-token'));
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet Observer renewals advance the local lease fence and stale bindings are reclaimed', async () => {
  const leaseId = 'r'.repeat(32);
  let expiresAt = Date.now() + 30_000;
  const remote = await listen(async (req, res) => {
    if (req.method === 'POST' && (req.url === '/api/observer/leases' || req.url.endsWith('/renew'))) {
      expiresAt += 30_000;
      res.writeHead(req.url.endsWith('/renew') ? 200 : 201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: leaseId, expiresAt, preset: 'standard' }));
      return;
    }
    res.writeHead(404).end();
  });
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'remote-admin-token' }
  });
  const hub = await listen((req, res) => {
    req._authContext = principal;
    proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  try {
    assert.equal((await fetch(`${hub.origin}/fleet/Remote/api/observer/leases`, { method: 'POST', headers: { Origin: hub.origin } })).status, 201);
    const firstExpiry = proxy.observerLeases.get(leaseId).expiresAt;
    assert.equal((await fetch(`${hub.origin}/fleet/Remote/api/observer/leases/${leaseId}/renew`, { method: 'POST', headers: { Origin: hub.origin } })).status, 200);
    assert.ok(proxy.observerLeases.get(leaseId).expiresAt > firstExpiry);

    proxy.observerLeases.get(leaseId).expiresAt = Date.now() - 1;
    proxy.pruneObserverLeases();
    assert.equal(proxy.observerLeases.has(leaseId), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet Observer WebSocket relays display only and closes on browser input', async () => {
  const leaseId = 'w'.repeat(32);
  let upstreamAuth = null;
  let upstreamSocket = null;
  const remote = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/api/observer/leases') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: leaseId, expiresAt: Date.now() + 30_000, preset: 'standard' }));
      return;
    }
    res.writeHead(404).end();
  });
  remote.server.on('upgrade', (req, socket, head) => {
    upstreamAuth = req.headers.authorization;
    upstreamSocket = acceptObserverWebSocket(req, socket, head, 'zylos-observer-v1');
    upstreamSocket.activate();
    upstreamSocket.sendBinary(Buffer.from('REMOTE DISPLAY'));
  });
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'remote-admin-token' },
    authGate: { revalidateAuthContext: (value) => value }
  });
  const hub = await listen((req, res) => {
    req._authContext = principal;
    proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  hub.server.on('upgrade', (req, socket, head) => {
    req._authContext = principal;
    proxy.handleUpgrade(req, socket, head);
  });
  let browser;
  try {
    const lease = await fetch(`${hub.origin}/fleet/Remote/api/observer/leases`, { method: 'POST', headers: { Origin: hub.origin } });
    assert.equal(lease.status, 201);
    browser = await connectObserverWebSocket({
      port: hub.server.address().port,
      path: '/fleet/Remote/observer/stream',
      headers: {
        Origin: hub.origin,
        Cookie: 'session=test',
        'Sec-WebSocket-Protocol': `zylos-observer-v1, lease.${leaseId}`,
      },
    });
    const messages = [];
    browser.on('message', (payload) => messages.push(payload));
    browser.activate();
    const deadline = Date.now() + 2_000;
    while (!messages.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(Buffer.from(messages[0]).toString(), 'REMOTE DISPLAY');
    assert.equal(upstreamAuth, 'Bearer remote-admin-token');
    browser.sendText('forbidden input');
    await new Promise((resolve) => browser.once('close', resolve));
    assert.equal(proxy.observerStreams.size, 0);
  } finally {
    browser?.destroy();
    upstreamSocket?.destroy();
    await hub.close();
    await remote.close();
  }
});

test('fleet Observer revalidates local identity and lease immediately before downstream 101', async (t) => {
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };

  for (const scenario of ['auth-revoked', 'lease-released', 'lease-expired']) {
    await t.test(scenario, async () => {
      const leaseId = scenario[0].repeat(32);
      let valid = true;
      let releaseUpgrade;
      let markUpgradeSeen;
      const upgradeGate = new Promise((resolve) => { releaseUpgrade = resolve; });
      const upgradeSeen = new Promise((resolve) => { markUpgradeSeen = resolve; });
      const upstreamSockets = new Set();
      const remote = await listen((_req, res) => res.writeHead(404).end());
      remote.server.on('upgrade', async (req, socket, head) => {
        markUpgradeSeen();
        await upgradeGate;
        const upstream = acceptObserverWebSocket(req, socket, head, 'zylos-observer-v1');
        upstreamSockets.add(upstream);
        upstream.activate();
      });
      const proxy = new FleetProxy({
        config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
        poller: { getSessionToken: async () => 'remote-admin-token' },
        authGate: { revalidateAuthContext: () => valid ? principal : null }
      });
      proxy.observerLeases.set(leaseId, {
        agentName: 'Remote', principal, expiresAt: Date.now() + 30_000
      });
      const hub = await listen((_req, res) => res.writeHead(404).end());
      hub.server.on('upgrade', (req, socket, head) => {
        req._authContext = principal;
        proxy.handleUpgrade(req, socket, head);
      });

      try {
        const connecting = connectObserverWebSocket({
          port: hub.server.address().port,
          path: '/fleet/Remote/observer/stream',
          headers: {
            Origin: hub.origin,
            Cookie: 'session=test',
            'Sec-WebSocket-Protocol': `zylos-observer-v1, lease.${leaseId}`,
          },
        });
        await upgradeSeen;
        if (scenario === 'auth-revoked') valid = false;
        if (scenario === 'lease-released') proxy.observerLeases.delete(leaseId);
        if (scenario === 'lease-expired') proxy.observerLeases.get(leaseId).expiresAt = Date.now() - 1;
        releaseUpgrade();
        await assert.rejects(connecting, /WebSocket handshake rejected \(404\)/);
        assert.equal(proxy.observerStreams.size, 0);
      } finally {
        releaseUpgrade();
        for (const socket of upstreamSockets) socket.destroy();
        await hub.close();
        await remote.close();
      }
    });
  }
});

test('fleet Observer upgrade survives downstream resets during reject and pending handshake', async () => {
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
  const rejectedProxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://127.0.0.1:1' }] } },
    poller: { getSessionToken: async () => 'unused' },
    authGate: { revalidateAuthContext: (value) => value }
  });
  const rejectedHub = await listen((_req, res) => res.writeHead(204).end());
  rejectedHub.server.on('upgrade', (req, socket, head) => {
    rejectedProxy.handleUpgrade(req, socket, head);
  });
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const reset = resetUpgrade(rejectedHub.server.address().port, '/fleet/Remote/observer/stream');
      await new Promise((resolve) => setImmediate(resolve));
      reset.client.resetAndDestroy();
      await reset.closed;
    }
    assert.equal((await fetch(rejectedHub.origin)).status, 204);
    assert.equal(rejectedProxy.observerStreams.size, 0);
  } finally {
    await rejectedHub.close();
  }

  const leaseId = 'p'.repeat(32);
  let releaseUpgrade;
  let markUpgradeSeen;
  const upgradeGate = new Promise((resolve) => { releaseUpgrade = resolve; });
  const upgradeSeen = new Promise((resolve) => { markUpgradeSeen = resolve; });
  let upstream;
  let upstreamRaw;
  const remote = await listen((_req, res) => res.writeHead(404).end());
  remote.server.on('upgrade', async (req, socket, head) => {
    upstreamRaw = socket;
    socket.on('error', () => {});
    socket.on('end', () => socket.destroy());
    markUpgradeSeen();
    await upgradeGate;
    if (socket.destroyed) return;
    upstream = acceptObserverWebSocket(req, socket, head, 'zylos-observer-v1');
    upstream.activate();
  });
  const pendingProxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
    poller: { getSessionToken: async () => 'remote-admin-token' },
    authGate: { revalidateAuthContext: (value) => value }
  });
  pendingProxy.observerLeases.set(leaseId, {
    agentName: 'Remote', principal, expiresAt: Date.now() + 30_000
  });
  const pendingHub = await listen((_req, res) => res.writeHead(204).end());
  pendingHub.server.on('upgrade', (req, socket, head) => {
    req._authContext = principal;
    pendingProxy.handleUpgrade(req, socket, head);
  });
  try {
    const reset = resetUpgrade(pendingHub.server.address().port, '/fleet/Remote/observer/stream', {
      Cookie: 'session=test',
      Origin: pendingHub.origin,
      'Sec-WebSocket-Protocol': `zylos-observer-v1, lease.${leaseId}`,
    });
    await upgradeSeen;
    reset.client.resetAndDestroy();
    await reset.closed;
    // Abort must tear down the in-flight connect before the remote answers.
    await waitUntil(() => upstreamRaw.destroyed);
    releaseUpgrade();
    assert.equal(pendingProxy.observerStreams.size, 0);
    assert.equal(upstream, undefined);
    assert.equal((await fetch(pendingHub.origin)).status, 204);
  } finally {
    releaseUpgrade();
    upstream?.destroy();
    upstreamRaw?.destroy();
    pendingHub.server.closeAllConnections?.();
    remote.server.closeAllConnections?.();
    await pendingHub.close();
    await remote.close();
  }
});

test('fleet Observer closes a valid client that sends a byte before admission', async () => {
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
  const leaseId = 'b'.repeat(32);
  let releaseToken;
  let tokenSeen = false;
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://127.0.0.1:1' }] } },
    poller: { getSessionToken: () => {
      tokenSeen = true;
      return new Promise((resolve) => { releaseToken = resolve; });
    } },
    authGate: { revalidateAuthContext: (value) => value },
  });
  proxy.observerLeases.set(leaseId, { agentName: 'Remote', principal, expiresAt: Date.now() + 30_000 });
  const hub = await listen((_req, res) => res.writeHead(204).end());
  let handling;
  let raw;
  hub.server.on('upgrade', (req, socket, head) => {
    raw = socket;
    req._authContext = principal;
    handling = proxy.handleUpgrade(req, socket, head);
  });
  let client;
  try {
    ({ client } = resetUpgrade(hub.server.address().port, '/fleet/Remote/observer/stream', {
      Cookie: 'session=test', Origin: hub.origin,
      'Sec-WebSocket-Protocol': `zylos-observer-v1, lease.${leaseId}`,
    }));
    await waitUntil(() => tokenSeen);
    client.write('x');
    await waitUntil(() => client.destroyed && raw.destroyed);
    releaseToken('unused');
    await handling;
    assert.equal(proxy.observerStreams.size, 0);
    assert.equal((await fetch(hub.origin)).status, 204);
  } finally {
    releaseToken?.('unused');
    client?.destroy();
    raw?.destroy();
    await handling;
    await hub.close();
  }
});

test('fleet Observer owns a resolved upstream across downstream cancellation and admission', async (t) => {
  for (const phase of ['resolved-before-admission', 'admission-before-registration']) await t.test(phase, async () => {
    const principal = { kind: 'api', principalId: 'local-admin', scope: 'admin' };
    const leaseId = 'c'.repeat(32);
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.writableEnded = false;
    socket.setNoDelay = () => {};
    socket.write = () => true;
    socket.end = () => { socket.writableEnded = true; };
    socket.destroy = () => { socket.destroyed = true; };
    const upstream = new EventEmitter();
    upstream.closed = false;
    upstream.close = () => { upstream.closed = true; };
    upstream.activate = () => {};
    const proxy = new FleetProxy({
      config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://127.0.0.1:1' }] } },
      poller: { getSessionToken: async () => 'unused' },
      authGate: { revalidateAuthContext: () => {
        if (phase === 'admission-before-registration') queueMicrotask(() => socket.emit('end'));
        return principal;
      } },
      // A completed handshake has stopped observing AbortSignal. Its resolved
      // transport must be reclaimed by the admission fence, not by connect abort.
      observerConnect: () => {
        if (phase === 'resolved-before-admission') queueMicrotask(() => socket.emit('end'));
        return Promise.resolve(upstream);
      },
    });
    proxy.observerLeases.set(leaseId, { agentName: 'Remote', principal, expiresAt: Date.now() + 30_000 });
    await proxy.handleUpgrade({
      url: '/fleet/Remote/observer/stream', _authContext: principal,
      headers: {
        host: 'localhost', connection: 'Upgrade', upgrade: 'websocket',
        'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-protocol': `zylos-observer-v1, lease.${leaseId}`,
      },
    }, socket, Buffer.alloc(0));
    assert.equal(upstream.closed, true);
    assert.equal(proxy.observerStreams.size, 0);
  });
});

test('fleet proxy strips content-encoding from compressed upstream responses (#255)', async () => {
  // A Cloudflare-fronted producer compresses JSON. undici fetch inside the
  // proxy auto-decompresses the body, so the forwarded response must not
  // carry the upstream content-encoding header — browsers would otherwise
  // try to decode plain bytes and fail every remote data request.
  let upstreamAcceptEncoding;
  const remote = await listen((req, res) => {
    upstreamAcceptEncoding = req.headers['accept-encoding'];
    res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(JSON.stringify({ state: 'IDLE', context_pct: 33 })));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state`, {
      headers: { 'accept-encoding': 'gzip, deflate, br' }
    });
    assert.equal(resp.status, 200);
    assert.equal(resp.headers.get('content-encoding'), null);
    const body = await resp.json();
    assert.equal(body.state, 'IDLE');
    assert.equal(body.context_pct, 33);
    // The browser's accept-encoding must not be forwarded verbatim — undici
    // negotiates its own so that auto-decompression stays deterministic.
    assert.notEqual(upstreamAcceptEncoding, 'gzip, deflate, br');
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in proxied response body', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reflected: req.headers.authorization }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_reflected_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/debug-echo`);
    assert.equal(resp.status, 502);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('Bearer'), false);
    assert.equal(body.includes('zylos_st_'), false);
    assert.equal(body.includes('zylos_ak_'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in proxied response headers', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(200, {
      'content-type': 'application/json',
      'x-echo-auth': req.headers.authorization
    });
    res.end(JSON.stringify({ ok: true }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'opaque-session-token' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/header-echo`);
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('x-echo-auth'), null);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('opaque-session-token'), false);
    assert.equal(body.includes('Bearer'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in HEAD response headers', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(204, { 'x-echo-auth': req.headers.authorization });
    res.end();
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'opaque-head-token' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/header-echo`, { method: 'HEAD' });
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('x-echo-auth'), null);
    assert.equal(await resp.text(), '');
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy refreshes token once when upstream returns 401', async () => {
  const seenAuth = [];
  const remote = await listen((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (seenAuth.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expired' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  const tokenRequests = [];
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: {
      getSessionToken: async (_name, options = {}) => {
        tokenRequests.push(options.force ? 'force' : 'cached');
        return options.force ? 'zylos_st_refreshed' : 'zylos_st_cached';
      }
    }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state`);
    assert.equal(resp.status, 200);
    assert.deepEqual(tokenRequests, ['cached', 'force']);
    assert.deepEqual(seenAuth, ['Bearer zylos_st_cached', 'Bearer zylos_st_refreshed']);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy rejects unsafe API methods before reaching upstream', async () => {
  let remoteHit = false;
  const remote = await listen((_req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state`, {
      method: 'PUT',
      body: 'this body must not be proxied'
    });
    assert.equal(resp.status, 403);
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy forwards SSE and whitelisted action POSTs with body', async () => {
  let sseAuth = null;
  let actionAuth = null;
  let actionBody = null;
  let actionContentType = null;
  const remote = await listen((req, res) => {
    if (req.url === '/api/stream') {
      sseAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: state_change\ndata: {"ok":true}\n\n');
      return;
    }
    if (req.url.startsWith('/api/actions/')) {
      actionAuth = req.headers.authorization;
      actionContentType = req.headers['content-type'];
      req.setEncoding('utf8');
      req.on('data', chunk => { actionBody = `${actionBody || ''}${chunk}`; });
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const sse = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(sse.status, 200);
    assert.match(sse.headers.get('content-type'), /text\/event-stream/);
    assert.equal(await sse.text(), 'event: state_change\ndata: {"ok":true}\n\n');
    assert.equal(sseAuth, 'Bearer zylos_st_secret');

    const action = await fetch(`${hub.origin}/fleet/Remote/api/actions/upgrade-cc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'now' })
    });
    assert.equal(action.status, 200);
    assert.deepEqual(await action.json(), { ok: true });
    assert.equal(actionAuth, 'Bearer zylos_st_secret');
    assert.equal(actionContentType, 'application/json');
    assert.equal(actionBody, '{"mode":"now"}');
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy keeps non-whitelisted writes read-only', async () => {
  let remoteHit = false;
  const remote = await listen((_req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const token = await fetch(`${hub.origin}/fleet/Remote/api/auth/token`, { method: 'POST' });
    assert.equal(token.status, 403);
    const del = await fetch(`${hub.origin}/fleet/Remote/api/settings`, { method: 'DELETE' });
    assert.equal(del.status, 403);
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy fail-closes consumer-local fleet management endpoints without touching upstream', async () => {
  let remoteHit = false;
  const remote = await listen((_req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const cases = [
      [`${hub.origin}/fleet/Remote/api/fleet/agents`, { method: 'GET' }],
      [`${hub.origin}/fleet/Remote/api/fleet/agents`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/fleet/agents/test`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/agent/name`, { method: 'PUT', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/fleet/agents%2Ftest`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/fleet%2Fagents`, { method: 'GET' }],
      [`${hub.origin}/fleet/Remote/api%2Fagent%2Fname`, { method: 'PUT', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/keys`, { method: 'GET' }],
      [`${hub.origin}/fleet/Remote/api/keys`, { method: 'POST', body: '{}' }],
      [`${hub.origin}/fleet/Remote/api/keys/producer-read`, { method: 'DELETE' }],
      [`${hub.origin}/fleet/Remote/api/keys%2Fproducer-read`, { method: 'DELETE' }],
      [`${hub.origin}/fleet/Remote/api%2Fkeys`, { method: 'GET' }]
    ];
    for (const [url, init] of cases) {
      const resp = await fetch(url, init);
      assert.equal(resp.status, 403);
      assert.deepEqual(await resp.json(), { error: 'local_endpoint_not_proxyable' });
    }
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy allows admin memory GETs and validates memory query paths consumer-side', async () => {
  const seen = [];
  const remote = await listen((req, res) => {
    seen.push({ method: req.method, url: req.url });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, method: req.method, url: req.url }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const tree = await fetch(`${hub.origin}/fleet/Remote/api/memory/tree`);
    assert.equal(tree.status, 200);
    assert.deepEqual(await tree.json(), { ok: true, method: 'GET', url: '/api/memory/tree' });

    const nested = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=reference%2Fprojects.md`);
    assert.equal(nested.status, 200);
    assert.deepEqual(await nested.json(), { ok: true, method: 'GET', url: '/api/memory/file?path=reference%2Fprojects.md' });

    const put = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '# Identity\n', sha256: 'a'.repeat(64) })
    });
    assert.equal(put.status, 200);
    assert.deepEqual(await put.json(), { ok: true, method: 'PUT', url: '/api/memory/file?path=identity.md' });

    const expandedPut = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '\n'.repeat(1024 * 1024), sha256: 'a'.repeat(64) })
    });
    assert.equal(expandedPut.status, 200);
    assert.deepEqual(await expandedPut.json(), { ok: true, method: 'PUT', url: '/api/memory/file?path=identity.md' });

    const unsafe = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=..%2Fstate.md`);
    assert.equal(unsafe.status, 400);
    assert.deepEqual(await unsafe.json(), { error: 'invalid_memory_path' });

    const unsafePut = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=..%2Fstate.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(unsafePut.status, 400);
    assert.deepEqual(await unsafePut.json(), { error: 'invalid_memory_path' });

    const write = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'POST',
      body: '{}'
    });
    assert.equal(write.status, 403);
    assert.deepEqual(await write.json(), { error: 'read_only_proxy' });

    assert.deepEqual(seen, [
      { method: 'GET', url: '/api/memory/tree' },
      { method: 'GET', url: '/api/memory/file?path=reference%2Fprojects.md' },
      { method: 'PUT', url: '/api/memory/file?path=identity.md' },
      { method: 'PUT', url: '/api/memory/file?path=identity.md' }
    ]);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy keeps encoded slash fail-closed for memory URL path', async () => {
  let remoteHit = false;
  const remote = await listen((_req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    for (const url of [
      `${hub.origin}/fleet/Remote/api%2Fmemory/tree`,
      `${hub.origin}/fleet/Remote/api/memory%2Ftree`
    ]) {
      const resp = await fetch(url);
      assert.equal(resp.status, 403);
      assert.deepEqual(await resp.json(), { error: 'local_endpoint_not_proxyable' });
    }
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy passes through upstream insufficient_scope for whitelisted writes', async () => {
  const remote = await listen((_req, res) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'insufficient_scope', required: 'admin' }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(resp.status, 403);
    assert.deepEqual(await resp.json(), { error: 'insufficient_scope', required: 'admin' });
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy refreshes token once for write 401 and reuses the request body', async () => {
  const seenAuth = [];
  const seenBodies = [];
  let actionExecutions = 0;
  const remote = await listen((req, res) => {
    seenAuth.push(req.headers.authorization);
    if (seenAuth.length === 1) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'expired' }));
      return;
    }
    req.setEncoding('utf8');
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      actionExecutions += 1;
      seenBodies.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  const tokenRequests = [];
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: {
      getSessionToken: async (_name, options = {}) => {
        tokenRequests.push(options.force ? 'force' : 'cached');
        return options.force ? 'zylos_st_refreshed' : 'zylos_st_cached';
      }
    }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"reason":"test"}'
    });
    assert.equal(resp.status, 200);
    assert.deepEqual(tokenRequests, ['cached', 'force']);
    assert.deepEqual(seenAuth, ['Bearer zylos_st_cached', 'Bearer zylos_st_refreshed']);
    assert.equal(actionExecutions, 1);
    assert.deepEqual(seenBodies, ['{"reason":"test"}']);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy rejects oversized write bodies before upstream', async () => {
  let remoteHit = false;
  const remote = await listen((_req, res) => {
    remoteHit = true;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      body: 'x'.repeat(1024 * 1024 + 1)
    });
    assert.equal(resp.status, 413);
    assert.equal(remoteHit, false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks split session token in SSE chunks', async () => {
  const remote = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: debug\ndata: {"token":"zylos_');
    setTimeout(() => {
      res.end('st_split_secret"}\n\n');
    }, 5);
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('zylos_st_'), false);
    assert.equal(body.includes('Bearer'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks long opaque session token split beyond default SSE tail', async () => {
  const token = `opaque-${'x'.repeat(220)}-secret`;
  const remote = await listen((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`event: debug\ndata: {"token":"${token.slice(0, 170)}`);
    setTimeout(() => {
      res.end(`${token.slice(170)}"}\n\n`);
    }, 5);
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => token }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(resp.status, 200);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes(token), false);
    assert.equal(body.includes(token.slice(0, 170)), false);
    assert.equal(body.includes(token.slice(170)), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy blocks reflected session token in SSE response headers', async () => {
  const remote = await listen((req, res) => {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-echo-auth': req.headers.authorization
    });
    res.end('event: state_change\ndata: {"ok":true}\n\n');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'opaque-sse-token' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(resp.status, 502);
    assert.equal(resp.headers.get('x-echo-auth'), null);
    const body = await resp.text();
    assert.match(body, /secret_leak_blocked/);
    assert.equal(body.includes('opaque-sse-token'), false);
    assert.equal(body.includes('Bearer'), false);
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy survives an upstream SSE body failure without killing the server (#257)', async () => {
  const remote = await listen((req, res) => {
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Longer than the secret-guard tail window (128 chars) so a prefix is
      // flushed to the client before the stream dies.
      res.write(`data: ${'hello '.repeat(60)}\n\n`);
      // Abruptly kill the upstream socket mid-stream — reproduces the
      // BodyTimeoutError / "other side closed" failures from production.
      setTimeout(() => res.socket.destroy(), 50);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const sse = await fetch(`${hub.origin}/fleet/Remote/api/stream`);
    assert.equal(sse.status, 200);
    let text = '';
    try {
      for await (const chunk of sse.body) text += Buffer.from(chunk).toString('utf8');
    } catch {
      // The relay may end abruptly; what matters is the process survives.
    }
    assert.match(text, /hello/);
    // Without the fix the unhandled stream 'error' crashes the process before
    // this point. The hub must keep serving requests after the failed relay.
    const after = await fetch(`${hub.origin}/fleet/Remote/api/state`);
    assert.equal(after.status, 200);
    assert.deepEqual(await after.json(), { ok: true });
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy cancels the upstream SSE fetch when the client disconnects (#257)', async () => {
  let upstreamClosed = false;
  const remote = await listen((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Past the secret-guard tail window so the client read resolves.
    res.write(`data: ${'hi '.repeat(60)}\n\n`);
    res.on('close', () => { upstreamClosed = true; });
    // Keep the stream open; only a downstream-driven teardown closes it.
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const controller = new AbortController();
    const sse = await fetch(`${hub.origin}/fleet/Remote/api/stream`, { signal: controller.signal });
    const reader = sse.body.getReader();
    await reader.read();
    controller.abort();
    const deadline = Date.now() + 2000;
    while (!upstreamClosed && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(upstreamClosed, true, 'upstream SSE connection must be torn down after client disconnect');
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet proxy maps a mid-body upstream failure on buffered responses to 502 (#257)', async () => {
  const remote = await listen((req, res) => {
    // Promise more bytes than we deliver, then kill the socket so the
    // proxy-side arrayBuffer() read fails after headers were received.
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '1024' });
    res.write('{"partial":');
    setTimeout(() => res.socket.destroy(), 25);
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_secret' }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'zylos_st_secret' }
  });
  const hub = await listen((req, res) => {
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/state`);
    assert.equal(resp.status, 502);
    assert.deepEqual(await resp.json(), { error: 'upstream_body_error' });
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet Observer cookie HTTP and WebSocket admission ignore forwarded protocol', async () => {
  const leaseId = 'p'.repeat(32);
  const bearerLeaseId = 'b'.repeat(32);
  const upstreamHeaders = [];
  const upstreamSockets = [];
  let writes = 0;
  const remote = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/api/observer/leases') {
      writes += 1;
      upstreamHeaders.push(req.headers);
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: writes > 3 ? bearerLeaseId : leaseId, expiresAt: Date.now() + 30_000, preset: 'standard' }));
      return;
    }
    res.writeHead(404).end();
  });
  remote.server.on('upgrade', (req, socket, head) => {
    upstreamHeaders.push(req.headers);
    const upstream = acceptObserverWebSocket(req, socket, head, 'zylos-observer-v1');
    upstreamSockets.push(upstream);
    upstream.activate();
    upstream.sendBinary(Buffer.from('PROXIED DISPLAY'));
  });
  const principal = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
  const apiPrincipal = { kind: 'api', principalId: 'api-admin', scope: 'admin' };
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
    poller: { getSessionToken: async () => 'remote-admin-token' },
    authGate: { revalidateAuthContext: (value) => value },
  });
  const identify = (req) => {
    req._authContext = req.headers.authorization === 'Bearer local-admin-token' ? apiPrincipal : principal;
  };
  const hub = await listen((req, res) => {
    identify(req);
    proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  hub.server.on('upgrade', (req, socket, head) => {
    identify(req);
    proxy.handleUpgrade(req, socket, head);
  });
  const origin = hub.origin.replace('http:', 'https:');
  const headers = { Origin: origin, Cookie: 'session=test', 'X-Forwarded-Proto': 'http' };
  const post = (extra) => fetch(`${hub.origin}/fleet/Remote/api/observer/leases`, {
    method: 'POST', headers: { ...headers, ...extra },
  });
  const connect = (extra) => connectObserverWebSocket({
    port: hub.server.address().port, path: '/fleet/Remote/observer/stream',
    headers: { ...headers, 'Sec-WebSocket-Protocol': `zylos-observer-v1, lease.${leaseId}`, ...extra },
  });
  let browser;
  try {
    for (const extra of [
      { 'Sec-Fetch-Site': 'same-origin' }, {},
      { 'Sec-Fetch-Site': 'same-origin', Host: 'rewritten.internal' },
    ]) {
      const response = await post(extra);
      assert.equal(response.status, 201);
      assert.equal((await response.json()).id, leaseId);
    }
    assert.equal(writes, 3);
    for (const extra of [
      { Origin: 'https://evil.example' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'none' },
      { 'Sec-Fetch-Site': '' },
      { 'Sec-Fetch-Site': 'same-origin, cross-site' },
    ]) {
      const response = await post(extra);
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), { error: 'origin_required' });
      await assert.rejects(connect(extra), /rejected \(404\)/);
    }
    assert.equal(writes, 3, 'rejected HTTP requests must not reach the producer');
    assert.equal(upstreamSockets.length, 0, 'rejected upgrades must not reach the producer');
    // No Fetch Metadata on this handshake: it exercises the Origin/Host fallback.
    browser = await connect({});
    const display = [];
    browser.on('message', (data) => display.push(data));
    browser.activate();
    await waitUntil(() => display.length > 0);
    assert.equal(Buffer.from(display[0]).toString(), 'PROXIED DISPLAY');
    browser.destroy();
    await waitUntil(() => proxy.observerStreams.size === 0);
    const bearer = await fetch(`${hub.origin}/fleet/Remote/api/observer/leases`, {
      method: 'POST', headers: { Authorization: 'Bearer local-admin-token', 'Sec-Fetch-Site': 'cross-site' },
    });
    assert.equal(bearer.status, 201);
    assert.equal((await bearer.json()).id, bearerLeaseId);
    browser = await connect({ 'Sec-WebSocket-Protocol': `zylos-observer-v1, lease.${bearerLeaseId}`, Cookie: '', Origin: 'https://evil.example', Authorization: 'Bearer local-admin-token', 'Sec-Fetch-Site': 'cross-site' });
    browser.activate();
    assert.equal(browser.closed, false, 'admin bearer WebSocket still bypasses browser origin checks');
    assert.ok(upstreamHeaders.every((h) => h.authorization === 'Bearer remote-admin-token'));
    assert.ok(upstreamHeaders.every((h) => !h.cookie), 'consumer cookies must not reach the producer');
  } finally {
    browser?.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await hub.close();
    await remote.close();
  }
});

test('history GET routes pass Fleet admin gate and retain secret response guard', async () => {
  let responseBody = { entries: [{ fields: { body: { preview: '[redacted]' } } }] };
  const remote = await listen((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(responseBody)); });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'History', base_url: remote.origin, read_api_key: 'zylos_ak_fixture' }] } },
    rootDir: publicDir(), poller: { getSessionToken: async () => 'zylos_st_fixture' },
  });
  const hub = await listen((req, res) => {
    req._authContext = { kind: 'cookie', principalId: 'owner', scope: req.headers['x-test-scope'] || 'admin' };
    proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  try {
    for (const route of ['sessions', 'entries', 'content', 'search']) {
      const response = await fetch(`${hub.origin}/fleet/History/api/observer/history/${route}?session=fixture`);
      assert.equal(response.status, 200, route); assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const denied = await fetch(`${hub.origin}/fleet/History/api/observer/history/sessions`, { headers: { 'x-test-scope': 'read' } });
    assert.equal(denied.status, 403);
    const unknown = await fetch(`${hub.origin}/fleet/History/api/observer/history/write`);
    assert.equal(unknown.status, 403);
    responseBody = { text: 'zylos_st_must_be_blocked' };
    const leaked = await fetch(`${hub.origin}/fleet/History/api/observer/history/content`);
    assert.equal(leaked.status, 502); assert.equal((await leaked.json()).error, 'secret_leak_blocked');
  } finally { await hub.close(); await remote.close(); }
});

test('fleet forwards Observer Set size with its body and relays the producer verdict', async () => {
  const seen = [];
  let producerScope = 'admin';
  const remote = await listen(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push([req.method, req.url, req.headers.authorization, body]);
    const allowed = producerScope === 'admin';
    res.writeHead(allowed ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify(allowed
      ? { agentSize: JSON.parse(body), applied: { ...JSON.parse(body), statusLines: 1 } }
      : { error: 'insufficient_scope' }));
  });
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
    rootDir: publicDir(),
    poller: { getSessionToken: async () => 'remote-session-token' }
  });
  const hub = await listen((req, res) => {
    req._authContext = { kind: 'cookie', principalId: 'local-admin', scope: 'admin' };
    proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  const post = (headers) => fetch(`${hub.origin}/fleet/Remote/api/observer/agent-size`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ cols: 132, rows: 60 }),
  });
  try {
    const crossSite = await post({ Origin: 'https://evil.example' });
    assert.equal(crossSite.status, 403);
    assert.equal(seen.length, 0);

    const applied = await post({ Origin: hub.origin });
    assert.equal(applied.status, 200);
    assert.deepEqual((await applied.json()).agentSize, { cols: 132, rows: 60 });
    assert.deepEqual(seen[0], ['POST', '/api/observer/agent-size', 'Bearer remote-session-token', '{"cols":132,"rows":60}']);

    producerScope = 'read';
    const readOnly = await post({ Origin: hub.origin });
    assert.equal(readOnly.status, 403);
    assert.deepEqual(await readOnly.json(), { error: 'insufficient_scope' });
  } finally {
    await hub.close();
    await remote.close();
  }
});

test('fleet Observer relay admits a rewritten-Host cookie handshake only with its own one-time ticket', async () => {
  let leases = 0;
  const upstreamHeaders = [];
  const upstreamSockets = [];
  const upstreamTicket = 'u'.repeat(43);
  const remote = await listen((req, res) => {
    const renew = req.url.match(/^\/api\/observer\/leases\/([A-Za-z0-9_-]{32})\/renew$/);
    if (req.method === 'POST' && (req.url === '/api/observer/leases' || renew)) {
      const id = renew ? renew[1] : `${'l'.repeat(31)}${(leases += 1)}`;
      res.writeHead(renew ? 200 : 201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, expiresAt: Date.now() + 30_000, generation: 3, resource: 'frame', ticket: upstreamTicket }));
      return;
    }
    res.writeHead(404).end();
  });
  remote.server.on('upgrade', (req, socket, head) => {
    upstreamHeaders.push(req.headers);
    const upstream = acceptObserverWebSocket(req, socket, head, 'zylos-observer-v1');
    upstreamSockets.push(upstream);
    upstream.activate();
  });
  const principals = {
    'session=a': { kind: 'cookie', principalId: 'admin-a', scope: 'admin' },
    'session=b': { kind: 'cookie', principalId: 'admin-b', scope: 'admin' },
  };
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: remote.origin }] } },
    poller: { getSessionToken: async () => 'remote-admin-token' },
    authGate: { revalidateAuthContext: (value) => value },
  });
  const identify = (req) => { req._authContext = principals[req.headers.cookie]; };
  const hub = await listen((req, res) => {
    identify(req);
    proxy.handle(req, res, new URL(req.url, 'http://hub.test'));
  });
  hub.server.on('upgrade', (req, socket, head) => {
    identify(req);
    proxy.handleUpgrade(req, socket, head);
  });
  // The public origin differs from the Host the hub receives.
  const publicOrigin = 'https://dashboard.example';
  const post = async (path, cookie = 'session=a') => {
    const response = await fetch(`${hub.origin}/fleet/Remote/api/observer/${path}`, {
      method: 'POST', headers: { Cookie: cookie, Origin: publicOrigin, 'Sec-Fetch-Site': 'same-origin' },
    });
    assert.ok(response.ok);
    return response.json();
  };
  const connect = (leaseId, ticket, extra = {}) => connectObserverWebSocket({
    port: hub.server.address().port, path: '/fleet/Remote/observer/stream',
    headers: {
      Cookie: 'session=a', Origin: publicOrigin,
      'Sec-WebSocket-Protocol': ['zylos-observer-v1', `lease.${leaseId}`, ...(ticket ? [`ticket.${ticket}`] : [])].join(', '),
      ...extra,
    },
  });
  const browsers = [];
  try {
    const lease = await post('leases');
    const other = await post('leases');
    const foreign = await post('leases', 'session=b');
    assert.match(lease.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(lease.ticket, upstreamTicket, 'the browser receives the relay ticket, not the upstream one');
    assert.equal(lease.generation, 3, 'upstream lease fields are preserved');
    const renewed = await post(`leases/${lease.id}/renew`);
    assert.match(renewed.ticket, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(renewed.ticket, lease.ticket);

    for (const [leaseId, ticket, extra] of [
      [lease.id, null],
      [lease.id, upstreamTicket],
      [lease.id, 'A'.repeat(43)],
      [lease.id, other.ticket],
      [foreign.id, foreign.ticket],
      [lease.id, lease.ticket, { 'Sec-Fetch-Site': 'cross-site' }],
    ]) await assert.rejects(connect(leaseId, ticket, extra), /rejected \(404\)/);
    assert.equal(upstreamSockets.length, 0, 'rejected upgrades must not reach the producer');

    const browser = await connect(lease.id, renewed.ticket);
    browsers.push(browser);
    browser.activate();
    assert.equal(browser.closed, false);
    await assert.rejects(connect(lease.id, renewed.ticket), /rejected \(404\)/, 'tickets are single-use');
    for (const ticket of proxy.observerTickets.values()) ticket.expiresAt = Date.now() - 1;
    await assert.rejects(connect(lease.id, lease.ticket), /rejected \(404\)/, 'expired ticket');

    // Same-origin handshakes still need no ticket.
    const sameOrigin = await connect(other.id, null, { Origin: hub.origin });
    browsers.push(sameOrigin);
    sameOrigin.activate();
    assert.equal(upstreamSockets.length, 2);
    assert.ok(upstreamHeaders.every((h) => h.authorization === 'Bearer remote-admin-token'));
    assert.ok(upstreamHeaders.every((h) => /^zylos-observer-v1, lease\.[A-Za-z0-9_-]{32}$/.test(h['sec-websocket-protocol'])),
      'the relay never forwards browser tickets upstream');
  } finally {
    for (const browser of browsers) browser.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    await hub.close();
    await remote.close();
  }
});
