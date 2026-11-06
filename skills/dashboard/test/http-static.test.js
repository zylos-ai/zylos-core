import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import test from 'node:test';
import { serveStatic } from '../src/lib/http.js';
import { StateEngine } from '../src/lib/state-engine.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';

const root = path.resolve(import.meta.dirname, '../public');

function response() {
  const chunks = [];
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } });
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; };
  res.body = () => Buffer.concat(chunks).toString('utf8');
  return res;
}

for (const url of ['/%', '/%2', '/%GG', '/%E0%A4', '/%FF', '/_assets/js/%', 'http://[invalid/']) {
  test(`static handler returns handled public 400 for invalid URI ${url}`, async () => {
    const res = response();
    assert.equal(serveStatic({ url }, res, root), true);
    await finished(res);
    assert.equal(res.status, 400);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body()), { error: 'invalid_request' });
  });
}

for (const url of ['/js/gauge-utils.js', '/_assets/js/gauge-utils.js', '/js/%67auge-utils.js', '/js/gauge-utils.js?unused=%']) {
  test(`static handler still serves valid asset ${url}`, async () => {
    const res = response();
    assert.equal(serveStatic({ url }, res, root), true);
    await finished(res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(res.body(), fs.readFileSync(path.join(root, 'js/gauge-utils.js'), 'utf8'));
  });
}

test('static handler leaves missing file to caller', () => {
  const res = response();
  assert.equal(serveStatic({ url: '/missing-%25-file.js' }, res, root), false);
  assert.equal(res.status, undefined);
  assert.equal(res.writableEnded, false);
  assert.equal(res.body(), '');
});

test('static handler preserves traversal rejection', async () => {
  const res = response();
  assert.equal(serveStatic({ url: '/_assets/..%2fpackage.json' }, res, root), true);
  await finished(res);
  assert.equal(res.status, 403);
  assert.equal(res.body(), 'forbidden');
});

for (const url of ['/themes/dark.css', '/_assets/themes/dark.css']) {
  test(`static handler serves the dark theme ${url}`, async () => {
    const res = response();
    assert.equal(serveStatic({ url }, res, root), true);
    await finished(res);
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'text/css; charset=utf-8');
    assert.equal(res.body(), fs.readFileSync(path.join(root, 'themes/dark.css'), 'utf8'));
  });
}

// HTTP integration: real createServer page dispatch and index rendering. Run for
// local page routes or browser-base changes; skip component-only styling edits.
// Runner supplies private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and tmux namespace.
// This case owns one temporary SQLite root and random loopback listener. No Core,
// PM2, tmux or remote transport starts; CLI calls are replaced before import.
// Requests are bounded to 3s, case to 15s. Close listener, timers and Store before
// removing only the owned fixture root, including when import or requests fail.
test('workbench local pages render index with the browser asset base', { timeout: 15000 }, async t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'page-http-'));
  const data = path.join(fixtureRoot, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ auth: { enabled: false } }));
  const previousRoot = process.env.ZYLOS_DIR;
  let server, engine;
  const timers = [], originalInterval = globalThis.setInterval;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previousRoot;
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    for (const timer of timers) clearInterval(timer);
    engine?.stopSnapshotTimer();
    engine?.store.close();
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });
  t.mock.method(globalThis, 'setInterval', (...args) => {
    const timer = originalInterval(...args); timers.push(timer); return timer;
  });
  t.mock.method(EventLoopMonitor.prototype, 'start', function () { return this; });
  t.mock.method(VersionChecker.prototype, 'start', () => {});
  t.mock.module('node:child_process', { namedExports: { ...childProcess,
    execFileSync: () => '1.0.0', execFile: () => assert.fail('CLI child forbidden') } });
  t.mock.module('../src/lib/state-engine.js', { namedExports: {
    StateEngine: class extends StateEngine { constructor(...args) { super(...args); engine = this; } },
  } });
  process.env.ZYLOS_DIR = fixtureRoot;
  const { createServer } = await import(`../src/index.js?local-page-http=${Date.now()}`);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  for (const route of ['/schedule', '/usage', '/settings', '/trends']) {
    const res = await fetch(origin + route, { signal: AbortSignal.timeout(3000),
      headers: { 'x-forwarded-prefix': '/dashboard' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /id="wb-board"/);
    assert.match(html, /\/dashboard\/_assets/);
    assert.equal(html.includes('__BASE_PATH__'), false);
    assert.equal(html.includes('__ASSET_ROOT__'), false);
  }
});
