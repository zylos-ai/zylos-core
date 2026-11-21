import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';

// Covers the hosting channel route, C4 registry and local admin boundary.
// Run when channel selection or hosting access changes. Skip UI-only changes.
// The official runner isolates HOME, PM2_HOME and TMPDIR. This case owns its
// ZYLOS_DIR and database files beneath TMPDIR and uses loopback HTTP only.
test('session hosting lists registered channel names for local admins', { timeout: 15_000 }, async t => {
  const { HOME, ZYLOS_DIR, PM2_HOME, TMPDIR, TMUX_TMPDIR } = process.env;
  const root = path.dirname(HOME);
  assert.match(root, /\/zylos-tests-[A-Za-z0-9]{6}$/);
  assert.equal(fs.realpathSync(root), root);
  assert.equal(HOME, path.join(root, 'home'));
  assert.equal(ZYLOS_DIR, path.join(HOME, 'zylos'));
  assert.equal(fs.realpathSync(ZYLOS_DIR), ZYLOS_DIR);
  assert.equal(PM2_HOME, path.join(HOME, '.pm2'));
  assert.equal(TMPDIR, path.join(root, 'tmp'));
  assert.equal(TMUX_TMPDIR, TMPDIR);
  assert.equal(process.env.TMUX, undefined);
  assert.equal(fs.realpathSync(TMPDIR), TMPDIR);
  const caseRoot = fs.mkdtempSync(path.join(TMPDIR, 'host-'));
  let c4, store, auth, server;
  t.after(async () => {
    try {
      if (server) {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
      clearInterval(auth?._cleanupTimer);
      store?.close();
      c4?.close();
    } finally {
      process.env.ZYLOS_DIR = ZYLOS_DIR;
      process.env.TMUX_TMPDIR = TMUX_TMPDIR;
      fs.rmSync(caseRoot, { recursive: true, force: true });
    }
  });
  process.env.ZYLOS_DIR = caseRoot;
  process.env.TMUX_TMPDIR = caseRoot;
  const socket = path.join(process.env.TMUX_TMPDIR, `tmux-${process.getuid()}`, 'default');
  assert.ok(Buffer.byteLength(socket) < 100);
  assert.equal(fs.existsSync(socket), false);

  const { DB_PATH } = await import('../skills/comm-bridge/scripts/c4-config.js');
  const dashboardDb = path.join(caseRoot, 'components/dashboard/dashboard.db');
  assert.equal(DB_PATH, path.join(caseRoot, 'comm-bridge/c4.db'));
  assert.equal(fs.existsSync(path.dirname(DB_PATH)), false);
  assert.equal(fs.existsSync(path.dirname(dashboardDb)), false);
  console.log('Session hosting channel isolation:', {
    HOME, ZYLOS_DIR: process.env.ZYLOS_DIR, PM2_HOME, TMPDIR, socket, DB_PATH, dashboardDb,
  });

  const { AuthGate, exchangeApiKeyForToken, generateApiKey, hashApiKey, hashPassword } =
    await import('../skills/dashboard/src/lib/auth.js');
  const { FleetProxy } = await import('../skills/dashboard/src/lib/fleet-proxy.js');
  const { sendJson } = await import('../skills/dashboard/src/lib/http.js');
  const { createSessionHostRoutes } = await import('../skills/dashboard/src/lib/session-host-routes.js');
  const { Store } = await import('../skills/dashboard/src/lib/store.js');
  c4 = await import('../skills/comm-bridge/scripts/c4-db.js');
  const db = c4.getDb();
  const register = db.prepare('INSERT INTO channel_namespaces (namespace, component_name) VALUES (?, ?)');
  register.run('tg', 'telegram');
  register.run('browser', 'browser-remote');
  register.run('desk', 'dashboard');
  c4.setSessionHostAllowlist('telegram', true);
  c4.setSessionHostAllowlist('unregistered', true);

  store = new Store(dashboardDb);
  const config = {
    auth: { password: hashPassword('fixture-password') },
    fleet: { agents: [{ name: 'fixture' }] },
  };
  auth = new AuthGate(config, store);
  const key = generateApiKey();
  store.insertApiKey({ name: 'fixture', keyHash: hashApiKey(key), scope: 'admin' });
  const { token } = exchangeApiKeyForToken(key);
  const route = createSessionHostRoutes({ auth });
  const fleet = new FleetProxy({ config, fetch: async () => assert.fail('Fleet must block this route before forwarding') });
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.apiPath = url.pathname;
      if (await auth.handle(req, res, url) || await route(req, res, url) || await fleet.handle(req, res, url)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch {
      sendJson(res, 500, { error: 'fixture_request_failed' });
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const login = await fetch(origin + '/login', {
    method: 'POST',
    body: new URLSearchParams({ password: 'fixture-password' }),
    redirect: 'manual',
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(login.status, 302);
  await login.text();
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('__Secure-zylos_dashboard_session=')).split(';')[0];
  const hosting = '/api/session-hosts';
  const channels = hosting + '/channels';
  const request = async (endpoint, headers) => {
    const response = await fetch(origin + endpoint, { headers, signal: AbortSignal.timeout(3000) });
    return { status: response.status, body: await response.json() };
  };

  assert.deepEqual(await request(channels, { Cookie: cookie }), {
    status: 200, body: { channels: ['browser-remote', 'dashboard', 'telegram'] },
  });
  for (const [headers, status, error] of [
    [{}, 401, 'unauthorized'],
    [{ Authorization: `Bearer ${token}` }, 403, 'local_cookie_required'],
  ]) {
    const denial = { status, body: { ok: false, error: { code: error, message: error } } };
    assert.deepEqual(await request(channels, headers), denial);
    assert.deepEqual(await request(hosting, headers), denial);
  }
  assert.deepEqual(await request('/fleet/fixture' + channels, { Cookie: cookie }), {
    status: 403,
    body: { ok: false, error: { code: 'local_endpoint_not_proxyable', message: 'local_endpoint_not_proxyable' } },
  });
});
