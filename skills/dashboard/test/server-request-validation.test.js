import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FleetProxy } from '../src/lib/fleet-proxy.js';
import { ObserverService } from '../src/lib/observer-service.js';

const BAD_HOSTS = ['][', 'a b', '127.0.0.1:99999', '[::1', '%'];
const serverSockets = new WeakMap();

async function listen(server) {
  const sockets = new Set();
  serverSockets.set(server, sockets);
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function close(server) {
  for (const socket of serverSockets.get(server)) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}

function httpRequest(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: '/', headers: { Host: host } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(2_000, () => req.destroy(new Error('HTTP request did not complete')));
  });
}

function rawRequest(port, target, host, { upgrade = true, headers = [] } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('raw request did not close'));
    }, 2_000);
    socket.on('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    socket.on('connect', () => socket.write([
      `GET ${target} HTTP/1.1`, `Host: ${host}`,
      ...(upgrade ? ['Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=='] : ['Connection: close']),
      ...headers, '', '',
    ].join('\r\n')));
  });
}

function assertResponse(bytes, status, reason, error) {
  assert.match(bytes, new RegExp(`^HTTP/1\\.1 ${status} ${reason}\\r\\n`));
  const boundary = bytes.indexOf('\r\n\r\n');
  assert.ok(boundary > 0);
  const body = bytes.slice(boundary + 4);
  const length = bytes.slice(0, boundary).match(/content-length: (\d+)/i);
  assert.ok(length);
  assert.equal(Buffer.byteLength(body), Number(length[1]));
  assert.deepEqual(JSON.parse(body), { error });
  assert.doesNotMatch(bytes, /ERR_INVALID_URL|TypeError|input|stack/);
}

test('Dashboard entry rejects malformed Host on HTTP and both upgrade routes with public 400', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-invalid-request-'));
  fs.mkdirSync(path.join(dir, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'components/dashboard/config.json'), JSON.stringify({ auth: { enabled: false } }));
  const previous = process.env.ZYLOS_DIR;
  let createServer;
  try {
    process.env.ZYLOS_DIR = dir;
    ({ createServer } = await import(`../src/index.js?invalid-request=${Date.now()}`));
  } finally {
    if (previous === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previous;
  }
  const server = createServer();
  const port = await listen(server);
  try {
    for (const host of BAD_HOSTS) {
      for (const target of ['/observer/stream', '/fleet/Remote/observer/stream']) {
        assertResponse(await rawRequest(port, target, host), 400, 'Bad Request', 'invalid_request');
      }
      const response = await httpRequest(port, host);
      assert.equal(response.status, 400);
      assert.deepEqual(JSON.parse(response.body), { error: 'invalid_request' });
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/health`)).status, 200);
    }
    const reset = new EventEmitter();
    let destroyed = false;
    reset.destroy = () => { destroyed = true; };
    reset.end = () => reset.emit('error', new Error('fixture reset during rejection write'));
    server.emit('upgrade', { url: '/observer/stream', headers: { host: '][' } }, reset, Buffer.alloc(0));
    assert.equal(destroyed, true, 'entry owns socket errors before writing the rejection');
  } finally {
    await close(server);
  }
});

test('local and Fleet upgrade handlers independently sanitize invalid URLs before auth or upstream work', async (t) => {
  for (const type of ['local', 'fleet']) await t.test(type, async () => {
    const unexpected = () => { throw new Error('malformed request reached a dependency'); };
    const service = type === 'local'
      ? new ObserverService({ containment: {}, coordinator: {}, manager: {}, authGate: {}, upstreamFactory: unexpected })
      : new FleetProxy({ config: {}, poller: { getSessionToken: unexpected } });
    if (type === 'local') service._ready = unexpected;
    const server = http.createServer((_req, res) => res.writeHead(204).end());
    server.on('upgrade', (req, socket, head) => service.handleUpgrade(req, socket, head));
    const port = await listen(server);
    try {
      for (const host of BAD_HOSTS) {
        assertResponse(await rawRequest(port, type === 'local' ? '/observer/stream' : '/fleet/Remote/observer/stream', host),
          400, 'Bad Request', 'invalid_request');
      }
      assert.equal((await fetch(`http://127.0.0.1:${port}`)).status, 204);
      const reset = new EventEmitter();
      let destroyed = false;
      reset.destroy = () => { destroyed = true; };
      reset.end = () => reset.emit('error', new Error('fixture reset during rejection write'));
      await service.handleUpgrade({ url: '/observer/stream', headers: { host: '][' } }, reset, Buffer.alloc(0));
      assert.equal(destroyed, true, 'handler owns socket errors before writing the rejection');
    } finally {
      await close(server);
    }
  });
});

test('Fleet upstream connection failure drains the complete byte-level 502 response before cleanup', async () => {
  const principal = { kind: 'api', principalId: 'fixture', scope: 'admin' };
  const leaseId = 'f'.repeat(32);
  let attempts = 0;
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'http://127.0.0.1:1' }] } },
    poller: { getSessionToken: async () => 'fixture-token' },
    authGate: { revalidateAuthContext: (value) => value },
    observerConnect: async () => { attempts += 1; throw new Error('fixture unreachable'); },
  });
  proxy.observerLeases.set(leaseId, { agentName: 'Remote', principal, expiresAt: Date.now() + 30_000 });
  const server = http.createServer();
  server.on('upgrade', (req, socket, head) => {
    req._authContext = principal;
    proxy.handleUpgrade(req, socket, head);
  });
  const port = await listen(server);
  try {
    assertResponse(await rawRequest(port, '/fleet/Remote/observer/stream', `127.0.0.1:${port}`, {
      headers: [`Sec-WebSocket-Protocol: zylos-observer-v1, lease.${leaseId}`],
    }), 502, 'Bad Gateway', 'upstream_unreachable');
    assert.equal(attempts, 2);
    assert.equal(proxy.observerStreams.size, 0);
  } finally {
    await close(server);
  }
});

test('local raw close preserves a rejection response that is already draining', async () => {
  const service = new ObserverService({ containment: {}, coordinator: {}, manager: {}, authGate: {} });
  const socket = new EventEmitter();
  let destroyed = false;
  let response = '';
  socket.writableEnded = false;
  socket.destroy = () => { destroyed = true; };
  socket.end = (bytes) => {
    response = bytes;
    socket.writableEnded = true;
    socket.emit('end');
  };
  await service.handleUpgrade({ url: '/ws', headers: { host: 'localhost' } }, socket, Buffer.alloc(0));
  assert.equal(destroyed, false, 'raw close must not truncate the queued response');
  assertResponse(response, 404, 'Not Found', 'not_found');
});
