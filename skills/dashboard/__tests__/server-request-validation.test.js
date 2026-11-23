import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { VersionChecker } from '../src/lib/version-checker.js';

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
  assert.deepEqual(JSON.parse(body), { ok: false, error: { code: error, message: error } });
  assert.doesNotMatch(bytes, /ERR_INVALID_URL|TypeError|input|stack/);
}

// Real HTTP/auth entry: run for routing, request validation or health visibility
// changes; skip UI-only edits. The official runner/private launcher isolates
// HOME/ZYLOS_DIR/PM2_HOME, short TMPDIR, private tmux socket and this test DB.
// Version checks are disabled; listeners and temporary data close in teardown.
test('Dashboard entry rejects malformed Host on HTTP and both upgrade routes with public 400', async t => {
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-invalid-request-'));
  fs.mkdirSync(path.join(dir, 'components/dashboard'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'components/dashboard/config.json'), JSON.stringify({ auth: { password: 'scrypt:fixture' } }));
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
      assert.deepEqual(JSON.parse(response.body), { ok: false, error: { code: 'invalid_request', message: 'invalid_request' } });
      const health = await fetch(`http://127.0.0.1:${port}/api/health`);
      assert.equal(health.status, 200);
      const payload = await health.json();
      assert.deepEqual(Object.keys(payload).sort(), ['bootId', 'ok', 'service']);
      assert.equal(payload.ok, true);
      assert.match(payload.bootId, /^[a-f0-9-]{36}$/);
    }
    const reset = new EventEmitter();
    let destroyed = false;
    reset.destroy = () => { destroyed = true; };
    reset.end = () => reset.emit('error', new Error('fixture reset during rejection write'));
    server.emit('upgrade', { url: '/observer/stream', headers: { host: '][' } }, reset, Buffer.alloc(0));
    assert.equal(destroyed, true, 'entry owns socket errors before writing the rejection');
  } finally {
    await close(server);
    await server.closeAttachments();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
