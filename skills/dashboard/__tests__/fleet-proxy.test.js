import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { publicDir } from '../src/lib/config.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';

import { acceptObserverWebSocket, connectObserverWebSocket } from '../src/lib/observer-websocket.js';

const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
    return next(specifier, context);
  },
});

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
    const resp = await fetch(`${hub.origin}/fleet/Remote/api/instance?x=1`);
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

test('fleet Observer WebSocket relays display only and closes on browser input', async () => {
  const leaseId = 'w'.repeat(32);
  let upstreamAuth = null;
  let upstreamSocket = null;
  const remote = await listen((req, res) => {
    if (req.method === 'POST' && req.url === '/api/observer/leases') {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: leaseId, expiresAt: new Date(Date.now() + 30_000).toISOString(), preset: 'standard' }));
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
      [`${hub.origin}/fleet/Remote/api/instance/name`, { method: 'PUT', body: '{}' }],
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
      assert.deepEqual(await resp.json(), { ok: false, error: { code: 'local_endpoint_not_proxyable', message: 'local_endpoint_not_proxyable' } });
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
    req._authContext = { kind: 'api', scope: 'admin', principalId: 'fixture' };
    const url = new URL(req.url, 'http://hub.test');
    proxy.handle(req, res, url);
  });
  try {
    const entries = await fetch(`${hub.origin}/fleet/Remote/api/memory/entries?dir=reference&limit=50`);
    assert.equal(entries.status, 200);
    assert.deepEqual(await entries.json(), { ok: true, method: 'GET', url: '/api/memory/entries?dir=reference&limit=50' });

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
    assert.deepEqual(await unsafe.json(), { ok: false, error: { code: 'invalid_memory_path', message: 'invalid_memory_path' } });

    const unsafePut = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=..%2Fstate.md`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    assert.equal(unsafePut.status, 400);
    assert.deepEqual(await unsafePut.json(), { ok: false, error: { code: 'invalid_memory_path', message: 'invalid_memory_path' } });

    const write = await fetch(`${hub.origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'POST',
      body: '{}'
    });
    assert.equal(write.status, 403);
    assert.deepEqual(await write.json(), { ok: false, error: { code: 'not_allowed_via_fleet', message: "This change can't be made when opening another agent from the fleet" } });

    assert.deepEqual(seen, [
      { method: 'GET', url: '/api/memory/entries?dir=reference&limit=50' },
      { method: 'GET', url: '/api/memory/file?path=reference%2Fprojects.md' },
      { method: 'PUT', url: '/api/memory/file?path=identity.md' },
      { method: 'PUT', url: '/api/memory/file?path=identity.md' }
    ]);
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

test('history GET routes require admin and retain secret response guard', async () => {
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
    assert.equal(leaked.status, 502); assert.equal((await leaked.json()).error.code, 'secret_leak_blocked');
  } finally { await hub.close(); await remote.close(); }
});

// Integration: actual Fleet HTTP forwarding to a strict legacy-query producer fixture.
// Run for chat locale transport or proxy header/query changes; skip for body styling.
// Use isolated HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, private socket/DB paths;
// only loopback servers are opened, and both are closed even on failure/timeout.

// Workbench proxy integration: injected transport or private loopback only, no
// child processes, filesystem mutations, PM2 or tmux. Run for proxy page/write
// routing; skip rendering-only changes. Each owned server is closed in finally.

// Permission integration: only the real proxy and injected fetch are used. Run
// when timezone routes or proxy write authorization change; skip display-only
// changes. No DB or child process; every relay is awaited before returning.

// Every hub signs in, so a write without a local principal is refused. Admin principals
// keep the explicit write allowlist and the cookie same-origin boundary.
test('fleet object writes need a local admin principal and keep the write allowlist', async () => {
  const agent = { name: 'Remote', base_url: 'https://remote.invalid' };
  let calls = 0;
  const proxy = new FleetProxy({ config: { fleet: { agents: [agent] } },
    poller: { getSessionToken: async () => 'remote-fixture' },
    fetch: async () => { calls++; return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }); },
  });
  const admin = { scope: 'admin', kind: 'api', principalId: 'local-fixture' };
  for (const [method, suffix, context, status] of [
    ['PUT', '/api/instance/defaults', undefined, 403],
    ['POST', '/api/groups/dashboard%3Aa/actions/interrupt', undefined, 403],
    ['PUT', '/api/instance/defaults', admin, 200],
    ['POST', '/api/instance/actions/switch-mode', admin, 200],
    ['PUT', '/api/groups/dashboard%3Aa/config', admin, 200],
    ['POST', '/api/groups/dashboard%3Aa/actions/interrupt', admin, 200],
    ['POST', '/api/groups/dashboard%3Aa/actions/unregistered', admin, 403],
    ['DELETE', '/api/groups/dashboard%3Aa', admin, 200],
    ['POST', '/api/groups/dashboard%3Aa/actions/interrupt', { scope: 'admin', kind: 'cookie' }, 403],
  ]) {
    const req = Readable.from([Buffer.from('{"confirmed":true}')]);
    req.method = method; req.headers = { 'content-type': 'application/json' }; req._authContext = context;
    const res = Object.assign(new EventEmitter(), { status: null,
      writeHead(code) { this.status = code; }, end() { this.writableFinished = true; } });
    const before = calls;
    await proxy.proxyApi(req, res, agent, suffix, '');
    assert.equal(res.status, status, `${method} ${suffix}`);
    assert.equal(calls - before, status === 200 ? 1 : 0, 'rejected requests do not reach the producer');
  }
});

// Real proxy handlers with isolated loopback servers. Run for route migrations,
// local-only paths or write authorization; no child process or live resource.

// Loopback HTTP proxy boundary; no real destination, credential or process is used.
// Run when the Fleet schedule allowlist changes; unrelated UI work can skip.
