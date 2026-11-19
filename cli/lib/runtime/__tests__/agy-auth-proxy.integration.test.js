import { checkAuth } from '../agy/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile } from 'node:child_process';

// Integration boundary: the real curl transport reaches a loopback-only HTTP
// proxy selected by the saved launch environment; no Gemini request is sent.
// Run for auth transport/proxy changes; unrelated launch or UI work may skip.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR. This fixture
// reads those paths back, uses no tmux or database, and bounds/reaps curl.
// Teardown closes every proxy socket/server and removes the fixture directory.
test('agy auth uses the saved HTTPS proxy without exposing its key in CONNECT or argv', { timeout: 5000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-proxy-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sockets = new Set();
  let connect = '';
  const proxy = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let input = '';
    socket.on('data', chunk => {
      input += chunk.toString();
      if (input.length > 4096) { socket.destroy(); return; }
      if (!input.includes('\r\n\r\n')) return;
      connect = input;
      // Stop at CONNECT: no external connection and no TLS/model/API request.
      socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (proxy.listening) await new Promise(resolve => proxy.close(resolve));
  });
  await new Promise((resolve, reject) => { proxy.once('error', reject); proxy.listen(0, '127.0.0.1', resolve); });
  const savedProxy = `http://127.0.0.1:${proxy.address().port}`;
  const env = { HOME: root, ZYLOS_DIR: root, PM2_HOME: path.join(root, 'pm2'), TMPDIR: root,
    PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:1', https_proxy: 'http://127.0.0.1:1' };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(env[key] === root || env[key].startsWith(root + path.sep), key);
  console.log('isolated auth proxy paths', JSON.stringify({ ...Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, env[key]])), proxy: savedProxy }));
  await fs.writeFile(path.join(root, '.env'), `GEMINI_API_KEY=isolated-fake-key\nHTTPS_PROXY=${savedProxy}\n`);
  let requests = 0;
  const adapterOptions = { root, env, execFile: (command, args, options, callback) => {
    requests++;
    assert.equal(options.env.HTTPS_PROXY, savedProxy);
    assert.equal(JSON.stringify(args).includes('isolated-fake-key'), false);
    // If proxy handling regresses, the direct path still resolves only to
    // loopback instead of making a real request to the public API.
    return execFile(command, [...args, '--resolve', 'generativelanguage.googleapis.com:443:127.0.0.1', '--connect-timeout', '1', '--max-time', '2'], { ...options, timeout: 2500 }, callback);
  } };
  const result = await checkAuth(adapterOptions);
  assert.deepEqual(result, { status: 'uncertain', reason: 'http_probe_network_error' });
  assert.equal(requests, 1);
  assert.match(connect, /^CONNECT generativelanguage\.googleapis\.com:443 HTTP\/1\.1\r\n/);
  assert.equal(connect.toLowerCase().includes('x-goog-api-key'), false);
  assert.equal(connect.includes('isolated-fake-key'), false);
  assert.equal(JSON.stringify(result).includes('isolated-fake-key'), false);
});
