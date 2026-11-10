import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import Database from '../../skills/comm-bridge/scripts/sqlite-driver.js';
import * as c4Schema from '../../skills/comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../skills/comm-bridge/scripts/sqlite-schema.js';

const repository = path.resolve(import.meta.dirname, '../..');

async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

export async function runCookieBrowser(t) {
  const caddy = process.env.WC_COOKIE_CADDY_BIN;
  const browserModule = process.env.WC_COOKIE_BROWSER_MODULE;
  const browserBinary = process.env.WC_COOKIE_BROWSER_BIN;
  for (const binary of [caddy, browserModule, browserBinary]) {
    assert.ok(binary && path.isAbsolute(binary) && fs.statSync(binary).isFile(), 'explicit installed tools required');
  }
  assert.ok(process.env.HOME && !fs.realpathSync(process.env.HOME).startsWith(os.userInfo().homedir + '/'),
    'use the official isolated test runner');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wc-cookie-'));
  const shortTmp = fs.mkdtempSync('/dev/shm/wcc-');
  const home = path.join(root, 'home');
  const zylos = path.join(home, 'zylos');
  const privateBin = path.join(root, 'bin');
  for (const directory of [home, zylos, privateBin, path.join(root, 'pm2'), path.join(zylos, 'comm-bridge')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.symlinkSync(process.execPath, path.join(privateBin, 'node'));
  const env = { HOME: home, ZYLOS_DIR: zylos, PM2_HOME: path.join(root, 'pm2'),
    TMPDIR: shortTmp, TMUX_TMPDIR: shortTmp, PATH: privateBin,
    XDG_CONFIG_HOME: path.join(root, 'xdg-config'), XDG_DATA_HOME: path.join(root, 'xdg-data'),
    XDG_CACHE_HOME: path.join(root, 'xdg-cache'), ZYLOS_PACKAGE_ROOT: repository,
    WEB_CONSOLE_BIND: '127.0.0.1', WEB_CONSOLE_SKILLS_DIR: path.join(root, 'unused-skills') };
  const dbPath = path.join(zylos, 'comm-bridge', 'c4.db');
  const children = [];
  let browser, capture;
  let cleanupPromise;
  async function cleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      let browserError;
      try { await browser?.close(); } catch (error) { browserError = error; }
      for (const { child } of children.reverse()) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close');
          const timer = setTimeout(() => child.kill('SIGKILL'), 1000);
          child.kill('SIGTERM');
          try { await closed; } finally { clearTimeout(timer); }
        }
      }
      if (capture) { capture.closeAllConnections(); await new Promise(resolve => capture.close(resolve)); }
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(shortTmp, { recursive: true, force: true });
      if (browserError) throw browserError;
    })();
    return cleanupPromise;
  }
  t.after(cleanup);
  const abort = () => { void cleanup(); };
  t.signal.addEventListener('abort', abort, { once: true });
  function launch(binary, args, extraEnv = {}) {
    t.signal.throwIfAborted();
    console.log('Cookie child readback:', JSON.stringify({ binary, args, ...env, ...extraEnv,
      database: dbPath, tmuxSocket: path.join(shortTmp, 'private-tmux.sock'), pm2Launches: 0 }));
    const child = spawn(binary, args, { cwd: root, env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    const active = { child, output: '' };
    const record = chunk => { active.output = (active.output + chunk.toString()).slice(-12000); };
    child.stdout.on('data', record); child.stderr.on('data', record);
    children.push(active);
    return active;
  }
  try {
    fs.writeFileSync(path.join(zylos, '.env'), 'WEB_CONSOLE_PASSWORD=cookie-fixture-password\n');
    const db = new Database(dbPath);
    try { guardDatabase(db, c4Schema); } finally { db.close(); }
    const wcPort = await freePort();
    const tlsPort = await freePort();
    const wc = launch(process.execPath, [path.join(repository, 'skills/web-console/scripts/server.js')],
      { WEB_CONSOLE_PORT: String(wcPort) });
    const end = Date.now() + 10000;
    while (!wc.output.includes('Web Console server running')) {
      t.signal.throwIfAborted();
      assert.equal(wc.child.exitCode, null, wc.output);
      assert.ok(Date.now() < end, `Web Console startup timed out: ${wc.output}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const observed = [];
    capture = http.createServer((req, res) => {
      if (observed.length >= 30) { res.writeHead(500).end(); return; }
      observed.push({ url: req.url, cookie: req.headers.cookie || '' });
      res.setHeader('content-type', 'application/json'); res.end('{}');
    });
    capture.listen(0, '127.0.0.1');
    await once(capture, 'listening');
    const cert = path.join(root, 'cert.pem'), key = path.join(root, 'key.pem');
    console.log('Cookie certificate readback:', JSON.stringify({ binary: '/usr/bin/openssl', cert, key, ...env }));
    execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert], { env, timeout: 10000, stdio: 'pipe' });
    const caddyfile = path.join(root, 'Caddyfile');
    fs.writeFileSync(caddyfile, `{
  admin off
  auto_https disable_redirects
}
https://127.0.0.1:${tlsPort} {
  tls ${cert} ${key}
  handle_path /console/* {
    reverse_proxy 127.0.0.1:${wcPort} {
      header_up X-Forwarded-Prefix /console
    }
  }
  handle {
    reverse_proxy 127.0.0.1:${capture.address().port}
  }
}
`);
    const proxy = launch(caddy, ['run', '--config', caddyfile, '--adapter', 'caddyfile']);
    const proxyDeadline = Date.now() + 10000;
    while (!proxy.output.includes('serving initial configuration')) {
      t.signal.throwIfAborted();
      assert.equal(proxy.child.exitCode, null, proxy.output);
      assert.ok(Date.now() < proxyDeadline, `Caddy startup timed out: ${proxy.output}`);
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    const { chromium } = await import(pathToFileURL(browserModule));
    console.log('Cookie browser launch readback:', JSON.stringify({ binary: browserBinary,
      module: browserModule, ...env, permittedOrigins: [tlsPort, wcPort].map(port => `127.0.0.1:${port}`) }));
    browser = await chromium.launch({ executablePath: browserBinary, headless: true, timeout: 10000, env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run'] });
    const tlsBase = `https://127.0.0.1:${tlsPort}`;
    const httpBase = `http://127.0.0.1:${wcPort}`;
    async function open(base) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true });
      await context.route('**/*', route => route.request().url().startsWith(base + '/')
        ? route.continue() : route.abort());
      const page = await context.newPage(); page.setDefaultTimeout(5000);
      return { context, page };
    }
    async function auth(page, url, password, remember) {
      return page.evaluate(async ({ url, password, remember }) => {
        const result = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password, remember }) });
        return { status: result.status, body: await result.json() };
      }, { url, password, remember });
    }
    async function apiStatus(page, prefix) {
      return page.evaluate(async prefix => (await fetch(`${prefix}/api/status`)).status, prefix);
    }
    async function socketResult(page, base, prefix) {
      return page.evaluate(({ base, prefix }) => new Promise((resolve, reject) => {
        const socket = new WebSocket(base.replace(/^http/, 'ws') + prefix + '/');
        const timer = setTimeout(() => { socket.close(); reject(new Error('WebSocket timed out')); }, 4000);
        socket.onmessage = () => { clearTimeout(timer); socket.close(); resolve('authenticated'); };
        socket.onclose = event => { clearTimeout(timer); if (event.code === 4001) resolve('rejected'); };
        socket.onerror = () => { clearTimeout(timer); reject(new Error('WebSocket error')); };
      }), { base, prefix });
    }
    let checks = 0;
    for (const remember of [true, false]) {
      const { context, page } = await open(tlsBase);
      try {
        await context.addCookies([{ name: 'wc_session', value: 'legacy-fixture-token', domain: '127.0.0.1',
          path: '/', secure: true, httpOnly: true, sameSite: 'Strict' }]);
        await page.goto(tlsBase + '/console/');
        assert.equal(await apiStatus(page, '/console'), 401);
        assert.equal(await socketResult(page, tlsBase, '/console'), 'rejected');
        const wrong = await auth(page, '/console/api/auth', 'wrong-password', remember);
        assert.equal(wrong.status, 401);
        await page.locator('#login-password').fill('cookie-fixture-password');
        await page.locator('#login-remember').setChecked(remember);
        await page.locator('#login-form button[type=submit]').click();
        await page.locator('#login-screen').waitFor({ state: 'hidden' });
        const cookies = (await context.cookies()).filter(cookie => cookie.name === 'wc_session');
        assert.equal(cookies.length, 1, 'legacy root cookie removed');
        const cookie = cookies[0];
        assert.equal(cookie.path, '/console'); assert.equal(cookie.secure, true);
        assert.equal(cookie.httpOnly, true); assert.equal(cookie.sameSite, 'Strict');
        if (remember) assert.ok(cookie.expires > Date.now() / 1000 + 604700);
        else assert.equal(cookie.expires, -1);
        assert.equal(await apiStatus(page, '/console'), 200);
        assert.equal(await socketResult(page, tlsBase, '/console'), 'authenticated');
        for (const unrelated of ['/pages/cookie-check', '/dashboard/cookie-check', '/console-extra']) {
          await page.evaluate(url => fetch(url), unrelated);
          assert.equal(observed.at(-1).url, unrelated);
          assert.ok(!observed.at(-1).cookie.includes('wc_session='), `${unrelated} receives no WC cookie`);
        }
        const logout = await page.evaluate(async () => (await fetch('/console/api/logout', { method: 'POST' })).status);
        assert.equal(logout, 200);
        assert.equal((await context.cookies()).filter(cookie => cookie.name === 'wc_session').length, 0);
        assert.equal(await apiStatus(page, '/console'), 401);
        assert.equal(await socketResult(page, tlsBase, '/console'), 'rejected');
        console.log('Cookie browser readback:', JSON.stringify({ transport: 'local-caddy-tls', remember,
          cookie: { ...cookie, value: '[redacted]' }, legacyRootRemoved: true, unrelatedRequestsWithoutCookie: 3,
          authenticatedApi: 200, loggedOutApi: 401, webSocket: ['rejected', 'authenticated', 'rejected'] }));
        checks++;
      } finally { await context.close(); }
    }
    const { context, page } = await open(httpBase);
    try {
      await page.goto(httpBase + '/');
      assert.equal((await auth(page, '/api/auth', 'cookie-fixture-password', false)).status, 200);
      const cookies = (await context.cookies()).filter(cookie => cookie.name === 'wc_session');
      assert.equal(cookies.length, 1);
      assert.equal(cookies[0].path, '/'); assert.equal(cookies[0].secure, false); assert.equal(cookies[0].expires, -1);
      assert.equal(await apiStatus(page, ''), 200);
      await page.evaluate(() => fetch('/api/logout', { method: 'POST' }));
      assert.equal((await context.cookies()).filter(cookie => cookie.name === 'wc_session').length, 0);
      console.log('Cookie browser readback:', JSON.stringify({ transport: 'direct-http', path: '/', secure: false,
        sessionCookie: true, authenticatedApi: 200, logoutRemoved: true }));
      checks++;
    } finally { await context.close(); }
    assert.equal(checks, 3);
  } finally {
    t.signal.removeEventListener('abort', abort);
    await cleanup();
  }
}
