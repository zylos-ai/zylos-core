import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as childProcess from 'node:child_process';
import test from 'node:test';
import { hashPassword } from '../src/lib/auth.js';
import { StateEngine } from '../src/lib/state-engine.js';
import { EventLoopMonitor } from '../src/lib/event-loop-monitor.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';

// HTTP integration: real createServer dispatch, auth, static, errors and SSE.
// Run for crawler policy, auth ordering or response dispatch changes; skip pure UI
// styling changes. Official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR
// and tmux namespace. Own private SQLite fixture and random loopback listener;
// no CLI, PM2, tmux, production DB or remote transport. Every request has a 3s
// limit and the case a 20s limit. Close streams/listener/timers/Store on failure
// as well as success, then remove only the owned fixture root.
test('Dashboard responses and documents exclude search crawlers', { timeout: 20000 }, async t => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'robots-http-'));
  const data = path.join(fixtureRoot, 'components/dashboard');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({
    auth: { enabled: true, password: hashPassword('crawler-test-password') },
  }));
  const previousRoot = process.env.ZYLOS_DIR;
  const timers = [], originalInterval = globalThis.setInterval;
  let server, engine;
  t.after(async () => {
    if (previousRoot === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = previousRoot;
    server?.closeAllConnections();
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await server?.closeAttachments?.();
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
  // Supply conflicting upstream headers without starting a remote Fleet server.
  t.mock.method(FleetProxy.prototype, 'handle', async (_req, res, url) => {
    res.setHeader('X-Robots-Tag', 'index, follow');
    if (url.pathname.endsWith('/raw')) {
      res.writeHead(200, ['Content-Type', 'text/plain']);
    } else {
      res.writeHead(200, 'OK', { 'x-robots-tag': 'all', 'content-type': 'text/plain' });
    }
    res.end('upstream body');
  });
  process.env.ZYLOS_DIR = fixtureRoot;
  const { createServer } = await import(`../src/index.js?robots-http=${Date.now()}`);
  server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (route, status, options = {}) => {
    const res = await fetch(origin + route, { redirect: 'manual', signal: AbortSignal.timeout(3000), ...options });
    assert.equal(res.status, status, route);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', route);
    return { res, body: await res.text() };
  };

  // Anonymous dispatch: run for auth exclusions, redirects, static or errors;
  // skip UI-only changes. Uses the parent fixture and bounded request helper.
  await t.test('anonymous pages, JSON, static files and errors carry the policy', async () => {
    await request('/api/health', 200);
    await request('/api/state', 401);
    const redirect = await request('/', 302);
    assert.match(redirect.res.headers.get('location'), /^\/login\?/);
    const login = await request('/login', 200);
    assert.match(login.body, /<meta name="robots" content="noindex, nofollow">/);
    await request('/login', 405, { method: 'PUT' });
    await request('/_assets/js/state-refresh.js', 200);
    await request('/_assets/js/%', 400);
    await request('/_assets/..%2fpackage.json', 403);
  });

  // Public robots route: run for auth ordering or prefix handling; skip style.
  // Caddy strips the prefix and passes it in X-Forwarded-Prefix.
  await t.test('robots file stays public through proxy prefixes', async () => {
    for (const [route, headers] of [
      ['/robots.txt', {}],
      ['/robots.txt', { 'x-forwarded-prefix': '/dashboard' }],
    ]) {
      const { res, body } = await request(route, 200, { headers });
      assert.match(res.headers.get('content-type'), /text\/plain/);
      assert.equal(body, 'User-agent: *\nDisallow: /\n');
    }
    await request('/other/robots.txt', 302, { headers: { 'x-forwarded-prefix': '/dashboard' } });
  });

  const login = await request('/login', 302, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'password=crawler-test-password' });
  const cookie = login.res.headers.get('set-cookie').split(';')[0];
  const headers = { cookie };

  // Authenticated page/error/Fleet dispatch: run for response policy or proxy
  // changes; skip style. Cookie and SQLite session exist only in this fixture.
  await t.test('authenticated pages and conflicting proxy headers retain the policy', async () => {
    const page = await request('/', 200, { headers });
    assert.match(page.body, /<meta name="robots" content="noindex, nofollow">/);
    await request('/missing-page', 404, { headers });
    for (const route of ['/fleet/example/object', '/fleet/example/raw']) {
      const proxy = await request(route, 200, { headers });
      assert.equal(proxy.body, 'upstream body');
      assert.match(proxy.res.headers.get('content-type'), /text\/plain/);
      assert.equal(proxy.res.headers.has('0'), false);
      assert.equal(proxy.res.headers.has('1'), false);
    }
  });

  // Real SSE emission: run for header policy or SSE dispatch; skip style. Abort
  // and cancel the body in finally; parent cleanup also closes sockets/timers.
  await t.test('stream response carries the policy before its first event', async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    let res;
    try {
      res = await fetch(origin + '/api/stream', { headers, signal: controller.signal });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
      assert.match(res.headers.get('content-type'), /text\/event-stream/);
    } finally {
      await res?.body?.cancel();
      controller.abort();
      clearTimeout(timeout);
    }
  });

  // Pre-auth malformed URL path: run for request parsing or header policy;
  // skip style. Native client permits invalid Host; destroy it on timeout.
  await t.test('invalid request URL error retains the policy', async () => {
    await new Promise((resolve, reject) => {
      const req = http.get(origin, { headers: { host: '[' } }, res => {
        try {
          assert.equal(res.statusCode, 400);
          assert.equal(res.headers['x-robots-tag'], 'noindex, nofollow');
          res.resume();
          res.on('end', resolve);
          res.on('error', reject);
        } catch (error) { res.destroy(); reject(error); }
      });
      req.setTimeout(3000, () => req.destroy(new Error('request timeout')));
      req.on('error', reject);
    });
  });
});
