import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { generateApiKey, hashApiKey } from '../src/lib/auth.js';
import { Store } from '../src/lib/store.js';
import { migrateSchema13 } from './fixtures/schema13.js';

function writeConfig(zylosDir, password = 'secret', extra = {}) {
  const configDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify({
    auth: {
      enabled: true,
      password
    },
    ...extra
  }, null, 2)}\n`);
}

async function makeServerWithDir(zylosDir) {
  const previousZylosDir = process.env.ZYLOS_DIR;
  const previousPort = process.env.DASHBOARD_PORT;
  process.env.ZYLOS_DIR = zylosDir;
  process.env.DASHBOARD_PORT = '0';

  const moduleUrl = new URL(`../src/index.js?test=${Date.now()}-${Math.random()}`, import.meta.url);
  const { createServer } = await import(moduleUrl.href);

  process.env.ZYLOS_DIR = previousZylosDir;
  process.env.DASHBOARD_PORT = previousPort;
  if (previousZylosDir == null) delete process.env.ZYLOS_DIR;
  if (previousPort == null) delete process.env.DASHBOARD_PORT;

  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    zylosDir
  };
}

async function makeServer() {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir);
  return makeServerWithDir(zylosDir);
}

async function closeServer(server) {
  await new Promise((resolve) => server.close(resolve));
}

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

function form(body) {
  return new URLSearchParams(body);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('auth protects API and renders proxy-prefixed login URLs', async () => {
  const { origin, server } = await makeServer();
  try {
    const health = await fetch(`${origin}/api/health`);
    assert.equal(health.status, 200);

    const unauthed = await fetch(`${origin}/`, { redirect: 'manual' });
    assert.equal(unauthed.status, 302);

    const prefixed = await fetch(`${origin}/`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard' },
      redirect: 'manual'
    });
    assert.equal(prefixed.status, 302);
    assert.equal(prefixed.headers.get('location'), '/dashboard/login?next=%2Fdashboard%2F');

    const login = await fetch(`${origin}/login?next=%2Fdashboard%2F`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard' },
      redirect: 'manual'
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/dashboard\/login"/);
    assert.match(body, /Zylos/);
    assert.match(body, /name="next" value="\/dashboard\/"/);
  } finally {
    await closeServer(server);
  }
});

test('login sets secure cookie and authenticated requests can reach API and SSE', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Prefix': '/dashboard'
      },
      body: form({ password: 'secret', next: '/dashboard/' }),
      redirect: 'manual'
    });
    assert.equal(login.status, 302);
    assert.equal(login.headers.get('location'), '/dashboard/');

    const cookie = login.headers.get('set-cookie');
    assert.match(cookie, /^__Secure-zylos_dashboard_session=/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\/dashboard;/);
    assert.match(cookie, /Max-Age=86400$/);

    const health = await fetch(`${origin}/api/health`, {
      headers: { Cookie: cookie }
    });
    assert.equal(health.status, 200);
    const json = await health.json();
    assert.equal(json.ok, true);
  } finally {
    await closeServer(server);
  }
});

test('logout succeeds without origin checks and respects forwarded prefix', async () => {
  const { origin, server } = await makeServer();
  const clearCookie = '__Secure-zylos_dashboard_session=; HttpOnly; Secure; SameSite=Strict; Path=/dashboard; Max-Age=0';
  const loginCookie = async () => (await fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ password: 'secret' }),
    redirect: 'manual'
  })).headers.get('set-cookie');
  const logout = headers => fetch(`${origin}/logout`, {
    method: 'POST',
    headers: { 'X-Forwarded-Prefix': '/dashboard', ...headers },
    redirect: 'manual'
  });
  try {
    // A proxy that rewrites Host (e.g. Cloudflare in front) makes Origin differ.
    const cookie = await loginCookie();
    const mismatched = await logout({ Cookie: cookie, Origin: 'https://agent.example.com' });
    assert.equal(mismatched.status, 302);
    assert.equal(mismatched.headers.get('location'), '/dashboard/login');
    assert.equal(mismatched.headers.get('set-cookie'), clearCookie);
    const revoked = await fetch(`${origin}/api/state`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.notEqual(revoked.status, 200);

    const noHeaders = await logout({ Cookie: await loginCookie() });
    assert.equal(noHeaders.status, 302);
    assert.equal(noHeaders.headers.get('set-cookie'), clearCookie);

    const expired = await logout({ Cookie: '__Secure-zylos_dashboard_session=stale' });
    assert.equal(expired.status, 302);
    assert.equal(expired.headers.get('location'), '/dashboard/login');
    assert.equal(expired.headers.get('set-cookie'), clearCookie);

    const get = await fetch(`${origin}/logout`, { redirect: 'manual' });
    assert.equal(get.status, 405);
  } finally {
    await closeServer(server);
  }
});

test('session cookie path follows the forwarded prefix and falls back to root', async () => {
  const { origin, server } = await makeServer();
  const loginWith = (headers, body = { password: 'secret' }) => fetch(`${origin}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: form(body),
    redirect: 'manual'
  });
  try {
    const direct = await loginWith({});
    assert.match(direct.headers.get('set-cookie'), /^__Secure-zylos_dashboard_session=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=86400$/);

    const trailing = await loginWith({ 'X-Forwarded-Prefix': '/dashboard/' });
    assert.match(trailing.headers.get('set-cookie'), /; Path=\/dashboard; /);

    const remembered = await loginWith({ 'X-Forwarded-Prefix': '/dashboard' }, { password: 'secret', remember: 'on' });
    assert.match(remembered.headers.get('set-cookie'), /; Path=\/dashboard; Max-Age=2592000$/);

    for (const prefix of ['/dash;Domain=evil.test', '/dashboard?x=1', '/../dashboard', '//evil.test']) {
      const resp = await loginWith({ 'X-Forwarded-Prefix': prefix });
      assert.equal(resp.status, 302, prefix);
      const cookie = resp.headers.get('set-cookie');
      assert.match(cookie, /; Path=\/; Max-Age=86400$/, prefix);
      assert.doesNotMatch(cookie, /Domain|evil/, prefix);
    }

    const multi = await loginWith({ 'X-Forwarded-Prefix': '/dashboard, /other' });
    assert.match(multi.headers.get('set-cookie'), /; Path=\/dashboard; /);
  } finally {
    await closeServer(server);
  }
});

test('legacy __Host- session cookie is revoked and cleared on any request', async () => {
  const { origin, server, zylosDir } = await makeServer();
  const legacyClear = '__Host-zylos_dashboard_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0';
  try {
    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Forwarded-Prefix': '/dashboard' },
      body: form({ password: 'secret' }),
      redirect: 'manual'
    });
    const token = login.headers.get('set-cookie').split(';')[0].split('=').slice(1).join('=');
    // Only the new cookie is set when the browser has no legacy cookie.
    assert.equal(login.headers.getSetCookie().length, 1);

    // A session presented under the legacy name is not accepted, and is revoked.
    const legacy = await fetch(`${origin}/api/state`, {
      headers: { Cookie: `__Host-zylos_dashboard_session=${token}` }
    });
    assert.equal(legacy.status, 401);
    assert.deepEqual(legacy.headers.getSetCookie(), [legacyClear]);

    const revoked = await fetch(`${origin}/api/state`, {
      headers: { Cookie: `__Secure-zylos_dashboard_session=${token}` }
    });
    assert.equal(revoked.status, 401);

    // Logging in with a legacy cookie still present sets the new one and clears the old one.
    const relogin = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Forwarded-Prefix': '/dashboard',
        Cookie: '__Host-zylos_dashboard_session=stale'
      },
      body: form({ password: 'secret' }),
      redirect: 'manual'
    });
    assert.equal(relogin.status, 302);
    const cookies = relogin.headers.getSetCookie();
    assert.equal(cookies.length, 2);
    assert.equal(cookies[0], legacyClear);
    assert.match(cookies[1], /^__Secure-zylos_dashboard_session=[^;]+; HttpOnly; Secure; SameSite=Strict; Path=\/dashboard; Max-Age=86400$/);

    const fresh = await fetch(`${origin}/api/state`, {
      headers: { Cookie: `__Host-zylos_dashboard_session=stale; ${cookies[1].split(';')[0]}` }
    });
    assert.equal(fresh.status, 200);
    assert.deepEqual(fresh.headers.getSetCookie(), [legacyClear]);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('unsafe forwarded prefixes fall back to direct root paths', async () => {
  const { origin, server } = await makeServer();
  try {
    const login = await fetch(`${origin}/login`, {
      headers: { 'X-Forwarded-Prefix': '/dashboard?next=//evil.test' },
      redirect: 'manual'
    });
    assert.equal(login.status, 200);
    const body = await login.text();
    assert.match(body, /action="\/login"/);
    assert.match(body, /Zylos/);
    assert.doesNotMatch(body, /evil\.test/);
  } finally {
    await closeServer(server);
  }
});

test('session cookie survives server restart (SQLite persistence)', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir);

  const { origin: origin1, server: server1 } = await makeServerWithDir(zylosDir);
  let cookie;
  try {
    const login = await fetch(`${origin1}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'secret' }),
      redirect: 'manual'
    });
    assert.equal(login.status, 302);
    cookie = login.headers.get('set-cookie');
    assert.ok(cookie);

    const api1 = await fetch(`${origin1}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(api1.status, 200);
  } finally {
    await closeServer(server1);
  }

  const { origin: origin2, server: server2 } = await makeServerWithDir(zylosDir);
  try {
    const api2 = await fetch(`${origin2}/api/state`, { headers: { Cookie: cookie } });
    assert.equal(api2.status, 200, 'session should survive restart');

    const unauthed = await fetch(`${origin2}/api/state`);
    assert.equal(unauthed.status, 401, 'request without cookie should be rejected');
  } finally {
    await closeServer(server2);
  }
});

test('/api/state exposes stable agent identity without fleet secrets', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  const legacyMarker = path.join(zylosDir, 'components', 'dashboard', 'upgrade-zylos-pending.json');
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: false },
    agent: { name: 'Jinglever', id: 'jinglever-main' },
    fleet: {
      agents: [
        {
          name: 'Remote',
          base_url: 'https://remote.example.test/dashboard',
          read_api_key: 'zylos_ak_secret'
        }
      ]
    }
  });
  fs.writeFileSync(legacyMarker, JSON.stringify({ from: '0.5.1', to: '0.5.2', startedAt: '2026-01-01T00:00:00.000Z' }));

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const resp = await fetch(`${origin}/api/state`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.agent.name, 'Jinglever');
    assert.equal(body.agent.id, 'jinglever-main');
    // Identity now also carries the deterministic mascot tint color/hue.
    assert.equal(typeof body.agent.color, 'string');
    assert.equal(typeof body.agent.hue, 'number');
    assert.equal(typeof body.new_session_threshold, 'number');
    assert.ok(body.runtime_info && typeof body.runtime_info === 'object');
    assert.ok(body.system_metrics && typeof body.system_metrics === 'object');
    assert.ok(Object.hasOwn(body.system_metrics, 'cpu_pct'));
    assert.ok(Object.hasOwn(body.system_metrics, 'mem_pct'));
    assert.ok(Object.hasOwn(body.system_metrics, 'disk_pct'));
    assert.ok(Object.hasOwn(body, 'session_cost'));
    assert.ok(Object.hasOwn(body, 'daily_cost'));
    assert.ok(Object.hasOwn(body, 'weekly_cost'));
    assert.ok(Object.hasOwn(body, 'context_pct'));
    for (const rawField of ['identity', 'status', 'usage', 'launchConfig', 'input']) {
      assert.equal(JSON.stringify(body).includes(`"${rawField}"`), false);
    }
    assert.equal(Object.hasOwn(body.runtime_info, 'zylos_upgrade_result'), false);
    assert.equal(fs.existsSync(legacyMarker), true, 'Dashboard must not consume the legacy upgrade marker');
    assert.equal(JSON.stringify(body).includes('zylos_ak_secret'), false);
    assert.equal(JSON.stringify(body).includes('read_api_key'), false);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('/api/fleet self record includes cost tiers from DB (#174)', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', { auth: { enabled: false } });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(dbPath);
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO metric_points (timestamp, metric_name, metric_value, dimensions, source, confidence)
      VALUES (?, 'usage_event', 1000, ?, 'jsonl_usage', 'actual')`).run(now, JSON.stringify({ cost: 2.34 }));
    db.close();

    const resp = await fetch(`${origin}/api/fleet`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    const self = body.agents.find(a => a.self === true);
    assert.ok(self, 'self record must exist');
    assert.equal(typeof self.daily_cost, 'number');
    assert.ok(self.daily_cost > 0, `daily_cost should be positive, got ${self.daily_cost}`);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('/api/stream accepts Bearer API session and emits initial fleet_state', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: true, password: 'secret' },
    agent: { name: 'Jinglever' }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const store = new Store(dbPath);
    const apiKey = generateApiKey();
    store.insertApiKey({ name: 'test-key', keyHash: hashApiKey(apiKey), scope: 'read' });
    store.close();

    const tokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    assert.equal(tokenResp.status, 200);
    const { token } = await tokenResp.json();

    const controller = new AbortController();
    const streamResp = await fetch(`${origin}/api/stream`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal
    });
    assert.equal(streamResp.status, 200);
    const reader = streamResp.body.getReader();
    const decoder = new TextDecoder();
    let body = '';
    while (!body.includes('event: fleet_state')) {
      const { value, done } = await reader.read();
      if (done) break;
      body += decoder.decode(value, { stream: true });
    }
    controller.abort();
    try { reader.releaseLock(); } catch { /* already released */ }
    assert.match(body, /event: fleet_state/);
    const dataLine = body.split('\n').find(line => line.startsWith('data: '));
    assert.ok(dataLine, 'fleet_state should include a data line');
    const payload = JSON.parse(dataLine.slice('data: '.length));
    assert.equal(payload.agent.name, 'Jinglever');
    assert.ok(Object.hasOwn(payload, 'context_pct'));
    assert.ok(Object.hasOwn(payload, 'session_cost'));
    assert.ok(Object.hasOwn(payload, 'system_metrics'));
    assert.equal(body.includes(apiKey), false);
    assert.equal(body.includes(token), false);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('/api/memory is admin-gated and browser sessions can read tree', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', { auth: { enabled: true, password: 'secret' } });
  fs.mkdirSync(path.join(zylosDir, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(zylosDir, 'memory', 'identity.md'), '# Identity\n');
  const newlineText = '\n'.repeat(1024 * 1024);
  fs.writeFileSync(path.join(zylosDir, 'memory', 'large.txt'), newlineText);

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const store = new Store(dbPath);
    const readKey = generateApiKey();
    const adminKey = generateApiKey();
    store.insertApiKey({ name: 'read-key', keyHash: hashApiKey(readKey), scope: 'read' });
    store.insertApiKey({ name: 'admin-key', keyHash: hashApiKey(adminKey), scope: 'admin' });
    store.close();

    const readTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readKey}` }
    });
    const adminTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    const { token: readToken } = await readTokenResp.json();
    const { token: adminToken } = await adminTokenResp.json();

    const readResp = await fetch(`${origin}/api/memory/tree`, {
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.equal(readResp.status, 403);
    assert.deepEqual(await readResp.json(), { error: 'insufficient_scope', required: 'admin' });

    const adminResp = await fetch(`${origin}/api/memory/tree`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(adminResp.status, 200);
    const adminBody = await adminResp.json();
    assert.equal(JSON.stringify(adminBody).includes('sha256'), false);
    assert.equal(adminBody.root.children.some(node => node.path === 'identity.md'), true);

    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'secret', next: '/' }),
      redirect: 'manual'
    });
    const cookie = login.headers.get('set-cookie');
    const browserResp = await fetch(`${origin}/api/memory/file?path=identity.md`, {
      headers: { Cookie: cookie }
    });
    assert.equal(browserResp.status, 200);
    const browserBody = await browserResp.json();
    assert.equal(browserBody.text, '# Identity\n');
    assert.match(browserBody.sha256, /^[a-f0-9]{64}$/);

    const readWriteResp = await fetch(`${origin}/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: '# Read key write\n', sha256: browserBody.sha256 })
    });
    assert.equal(readWriteResp.status, 403);
    assert.deepEqual(await readWriteResp.json(), { error: 'insufficient_scope', required: 'admin' });

    const nullWriteResp = await fetch(`${origin}/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: 'null'
    });
    assert.equal(nullWriteResp.status, 400);
    assert.deepEqual(await nullWriteResp.json(), { error: 'invalid_memory_write' });

    const largeWriteResp = await fetch(`${origin}/api/memory/file?path=large.txt`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        text: newlineText,
        sha256: crypto.createHash('sha256').update(newlineText).digest('hex')
      })
    });
    assert.equal(largeWriteResp.status, 200);
    const largeWriteBody = await largeWriteResp.json();
    assert.equal(largeWriteBody.text.length, 1024 * 1024);
    assert.equal(fs.readFileSync(path.join(zylosDir, 'memory', 'large.txt'), 'utf8'), newlineText);

    const adminWriteResp = await fetch(`${origin}/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: '# Identity\nEdited\n', sha256: browserBody.sha256 })
    });
    assert.equal(adminWriteResp.status, 200);
    const adminWriteBody = await adminWriteResp.json();
    assert.equal(adminWriteBody.text, '# Identity\nEdited\n');
    assert.notEqual(adminWriteBody.sha256, browserBody.sha256);
    assert.equal(fs.readFileSync(path.join(zylosDir, 'memory', 'identity.md'), 'utf8'), '# Identity\nEdited\n');

    const conflictResp = await fetch(`${origin}/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: '# Stale overwrite\n', sha256: browserBody.sha256 })
    });
    assert.equal(conflictResp.status, 409);
    const conflictBody = await conflictResp.json();
    assert.equal(conflictBody.error, 'memory_conflict');
    assert.equal(conflictBody.current.sha256, adminWriteBody.sha256);
    assert.equal(Object.hasOwn(conflictBody.current, 'text'), false);
    assert.equal(fs.readFileSync(path.join(zylosDir, 'memory', 'identity.md'), 'utf8'), '# Identity\nEdited\n');
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('proxied interrupt and chop-chop writes require consumer admin API scope or browser session', async () => {
  let actionHits = 0;
  let memoryWriteHits = 0;
  const remote = await listen((req, res) => {
    if (req.url === '/api/auth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'zylos_st_remote_admin',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: 'admin'
      }));
      return;
    }
    if (req.url === '/api/actions/interrupt' || req.url === '/api/actions/chop-chop') {
      actionHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/api/memory/file?path=identity.md' && req.method === 'PUT') {
      memoryWriteHits += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: 'identity.md' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: true, password: 'secret' },
    fleet: {
      agents: [
        { name: 'Remote', base_url: remote.origin, read_api_key: 'zylos_ak_remote' }
      ]
    }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const store = new Store(dbPath);
    const readKey = generateApiKey();
    const adminKey = generateApiKey();
    store.insertApiKey({ name: 'read-key', keyHash: hashApiKey(readKey), scope: 'read' });
    store.insertApiKey({ name: 'admin-key', keyHash: hashApiKey(adminKey), scope: 'admin' });
    store.close();

    const readTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readKey}` }
    });
    const adminTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    const { token: readToken } = await readTokenResp.json();
    const { token: adminToken } = await adminTokenResp.json();

    const readWrite = await fetch(`${origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(readWrite.status, 403);
    assert.deepEqual(await readWrite.json(), { error: 'insufficient_scope', required: 'admin' });
    assert.equal(actionHits, 0);

    const adminWrite = await fetch(`${origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(adminWrite.status, 200);
    assert.equal(actionHits, 1);

    const deniedChop = await fetch(`${origin}/fleet/Remote/api/actions/chop-chop`, {
      method: 'POST', headers: { Authorization: `Bearer ${readToken}`, 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(deniedChop.status, 403);
    assert.equal(actionHits, 1);
    const allowedChop = await fetch(`${origin}/fleet/Remote/api/actions/chop-chop`, {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(allowedChop.status, 200);
    assert.deepEqual(await allowedChop.json(), { ok: true });
    assert.equal(actionHits, 2);

    const readMemoryWrite = await fetch(`${origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${readToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: '# Read key write\n', sha256: 'a'.repeat(64) })
    });
    assert.equal(readMemoryWrite.status, 403);
    assert.deepEqual(await readMemoryWrite.json(), { error: 'insufficient_scope', required: 'admin' });
    assert.equal(memoryWriteHits, 0);

    const adminMemoryWrite = await fetch(`${origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: '# Admin write\n', sha256: 'a'.repeat(64) })
    });
    assert.equal(adminMemoryWrite.status, 200);
    assert.deepEqual(await adminMemoryWrite.json(), { ok: true, path: 'identity.md' });
    assert.equal(memoryWriteHits, 1);

    const login = await fetch(`${origin}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ password: 'secret', next: '/' }),
      redirect: 'manual'
    });
    const cookie = login.headers.get('set-cookie');
    const browserWrite = await fetch(`${origin}/fleet/Remote/api/actions/interrupt`, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    assert.equal(browserWrite.status, 200);
    assert.equal(actionHits, 3);

    const browserMemoryWrite = await fetch(`${origin}/fleet/Remote/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Cookie: cookie,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text: '# Browser write\n', sha256: 'a'.repeat(64) })
    });
    assert.equal(browserMemoryWrite.status, 200);
    assert.deepEqual(await browserMemoryWrite.json(), { ok: true, path: 'identity.md' });
    assert.equal(memoryWriteHits, 2);
  } finally {
    await closeServer(server);
    await remote.close();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('API key management is admin-gated, show-once, and revoke invalidates active sessions', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', { auth: { enabled: true, password: 'secret' } });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const store = new Store(dbPath);
    const readKey = generateApiKey();
    const adminKey = generateApiKey();
    store.insertApiKey({ name: 'read-key', keyHash: hashApiKey(readKey), scope: 'read' });
    store.insertApiKey({ name: 'admin-key', keyHash: hashApiKey(adminKey), scope: 'admin' });
    store.close();

    const readTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readKey}` }
    });
    const adminTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    const { token: readToken } = await readTokenResp.json();
    const { token: adminToken } = await adminTokenResp.json();

    const readList = await fetch(`${origin}/api/keys`, {
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.equal(readList.status, 403);
    assert.deepEqual(await readList.json(), { error: 'insufficient_scope', required: 'admin' });

    const create = await fetch(`${origin}/api/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'producer-read', scope: 'read' })
    });
    assert.equal(create.status, 200);
    const createBody = await create.json();
    assert.equal(createBody.key.name, 'producer-read');
    assert.equal(createBody.key.scope, 'read');
    assert.equal(createBody.key.status, 'active');
    assert.match(createBody.plaintext_key, /^zylos_ak_/);
    assert.equal(JSON.stringify(createBody.keys).includes(createBody.plaintext_key), false);
    assert.equal(JSON.stringify(createBody).includes('key_hash'), false);

    const createdTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${createBody.plaintext_key}` }
    });
    assert.equal(createdTokenResp.status, 200);
    const { token: createdToken, scope } = await createdTokenResp.json();
    assert.equal(scope, 'read');

    const duplicate = await fetch(`${origin}/api/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'producer-read', scope: 'read' })
    });
    assert.equal(duplicate.status, 400);
    assert.deepEqual(await duplicate.json(), { error: 'duplicate_name' });

    const badScope = await fetch(`${origin}/api/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'bad-scope', scope: 'owner' })
    });
    assert.equal(badScope.status, 400);
    assert.deepEqual(await badScope.json(), { error: 'invalid_scope' });

    const createAdmin = await fetch(`${origin}/api/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'producer-admin', scope: 'admin' })
    });
    assert.equal(createAdmin.status, 200);
    const createAdminBody = await createAdmin.json();
    assert.equal(createAdminBody.key.scope, 'admin');
    assert.match(createAdminBody.plaintext_key, /^zylos_ak_/);

    const list = await fetch(`${origin}/api/keys`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.keys.some(k => k.name === 'producer-read' && k.status === 'active'), true);
    assert.equal(JSON.stringify(listBody).includes(createBody.plaintext_key), false);
    assert.equal(JSON.stringify(listBody).includes(createAdminBody.plaintext_key), false);
    assert.equal(JSON.stringify(listBody).includes('key_hash'), false);

    const revoke = await fetch(`${origin}/api/keys/producer-read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(revoke.status, 200);
    const revokeBody = await revoke.json();
    assert.equal(revokeBody.keys.some(k => k.name === 'producer-read' && k.status === 'revoked'), true);

    const revokedExchange = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${createBody.plaintext_key}` }
    });
    assert.equal(revokedExchange.status, 401);

    const staleSessionUse = await fetch(`${origin}/api/state`, {
      headers: { Authorization: `Bearer ${createdToken}` }
    });
    assert.equal(staleSessionUse.status, 401, 'revoking a key should immediately invalidate existing session tokens');

    const secondRevoke = await fetch(`${origin}/api/keys/producer-read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(secondRevoke.status, 404);
    assert.deepEqual(await secondRevoke.json(), { error: 'unknown_key' });
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('API key migration v11 preserves ids, sessions, and active-name uniqueness', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-key-migration-'));
  const dbPath = path.join(dir, 'dashboard.db');
  // Seed the pinned released schema, rather than retaining later migration DDL.
  const initialDb = new Database(dbPath);
  migrateSchema13(initialDb);
  initialDb.close();

  const db = new Database(dbPath);
  try {
    db.exec(`
      DELETE FROM api_sessions;
      -- Migrations gate on MAX(version), so every row at or above 11 must go or
      -- migration 11 is treated as already applied and never retried.
      DELETE FROM schema_migrations WHERE version >= 11;
      DROP INDEX IF EXISTS idx_api_keys_active_name;
      DROP TABLE api_keys;
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        key_hash TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'read',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT
      );
      INSERT INTO api_keys (id, name, key_hash, scope, created_at, revoked_at)
      VALUES
        (7, 'active-key', 'active-hash', 'read', '2026-01-01 00:00:00', NULL),
        (11, 'reusable-key', 'revoked-hash', 'admin', '2026-01-02 00:00:00', '2026-01-03 00:00:00');
      INSERT INTO api_sessions (token_hash, api_key_id, scope, created_at, expires_at)
      VALUES
        ('active-session', 7, 'read', 1, 9999999999999),
        ('revoked-session', 11, 'admin', 1, 9999999999999);
    `);
  } finally {
    db.close();
  }

  const store = new Store(dbPath);
  try {
    // Assert the v11 migration ran, not that it is the newest one — later
    // migrations must not require editing this test.
    assert.ok(store.db.prepare('SELECT 1 FROM schema_migrations WHERE version = 11').get());
    assert.deepEqual(
      store.db.prepare('SELECT id, name FROM api_keys ORDER BY id').all(),
      [
        { id: 7, name: 'active-key' },
        { id: 11, name: 'reusable-key' }
      ]
    );
    assert.equal(store.getApiSession('active-session')?.api_key_id, 7);
    assert.equal(store.getApiSession('revoked-session')?.api_key_id, 11);
    assert.equal(store.getApiSession('revoked-session')?.key_revoked_at, '2026-01-03 00:00:00');

    store.insertApiKey({ name: 'reusable-key', keyHash: 'new-active-hash', scope: 'read' });
    assert.equal(store.getApiKeyByName('reusable-key')?.key_hash, 'new-active-hash');
    assert.throws(
      () => store.insertApiKey({ name: 'reusable-key', keyHash: 'duplicate-active-hash', scope: 'read' }),
      /UNIQUE constraint failed: api_keys\.name/
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API key migration v11 rolls back failed rebuild and can retry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-key-migration-retry-'));
  const dbPath = path.join(dir, 'dashboard.db');
  // Seed the pinned released schema, rather than retaining later migration DDL.
  const initialDb = new Database(dbPath);
  migrateSchema13(initialDb);
  initialDb.close();

  const db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DELETE FROM api_sessions;
      -- Migrations gate on MAX(version), so every row at or above 11 must go or
      -- migration 11 is treated as already applied and never retried.
      DELETE FROM schema_migrations WHERE version >= 11;
      DROP INDEX IF EXISTS idx_api_keys_active_name;
      DROP TABLE api_keys;
      CREATE TABLE api_keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'read',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_used_at TEXT,
        revoked_at TEXT
      );
      INSERT INTO api_keys (id, name, key_hash, scope, created_at, revoked_at)
      VALUES
        (21, 'duplicate-active', 'active-hash-a', 'read', '2026-01-01 00:00:00', NULL),
        (22, 'duplicate-active', 'active-hash-b', 'read', '2026-01-02 00:00:00', NULL);
    `);
  } finally {
    db.close();
  }

  assert.throws(
    () => new Store(dbPath),
    /UNIQUE constraint failed: api_keys\.name/
  );

  const inspectDb = new Database(dbPath);
  try {
    assert.deepEqual(
      inspectDb.prepare('SELECT id, name, key_hash, revoked_at FROM api_keys ORDER BY id').all(),
      [
        { id: 21, name: 'duplicate-active', key_hash: 'active-hash-a', revoked_at: null },
        { id: 22, name: 'duplicate-active', key_hash: 'active-hash-b', revoked_at: null }
      ]
    );
    assert.equal(
      inspectDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_keys_new'").get(),
      undefined
    );
    assert.equal(
      inspectDb.prepare('SELECT version FROM schema_migrations WHERE version = 11').get(),
      undefined
    );
    inspectDb.prepare("UPDATE api_keys SET revoked_at = '2026-01-03 00:00:00' WHERE id = 22").run();
  } finally {
    inspectDb.close();
  }

  const store = new Store(dbPath);
  try {
    assert.equal(store.db.prepare('SELECT version FROM schema_migrations WHERE version = 11').get().version, 11);
    assert.equal(store.getApiKeyByName('duplicate-active')?.id, 21);
    assert.equal(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_api_keys_active_name'").get().name,
      'idx_api_keys_active_name'
    );
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API key lifecycle supports name reuse, rotate, permanent delete, and revoked purge', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-key-lifecycle-'));
  writeConfig(zylosDir, 'secret', { auth: { enabled: true, password: 'secret' } });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const seedStore = new Store(dbPath);
    const readKey = generateApiKey();
    const adminKey = generateApiKey();
    seedStore.insertApiKey({ name: 'read-key', keyHash: hashApiKey(readKey), scope: 'read' });
    seedStore.insertApiKey({ name: 'admin-key', keyHash: hashApiKey(adminKey), scope: 'admin' });
    seedStore.close();

    const readTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readKey}` }
    });
    const adminTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    const { token: readToken } = await readTokenResp.json();
    const { token: adminToken } = await adminTokenResp.json();

    async function createKey(name, scope = 'read') {
      const resp = await fetch(`${origin}/api/keys`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name, scope })
      });
      const body = await resp.json();
      assert.equal(resp.status, 200, JSON.stringify(body));
      assert.equal(body.key.name, name);
      assert.match(body.plaintext_key, /^zylos_ak_/);
      return body;
    }

    const first = await createKey('producer-read');
    const firstTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${first.plaintext_key}` }
    });
    assert.equal(firstTokenResp.status, 200);
    const { token: firstSession } = await firstTokenResp.json();

    const revokeFirst = await fetch(`${origin}/api/keys/producer-read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(revokeFirst.status, 200);

    const recreated = await createKey('producer-read');
    assert.equal(recreated.keys.filter(key => key.name === 'producer-read' && key.status === 'revoked').length, 1);
    assert.equal(recreated.keys.filter(key => key.name === 'producer-read' && key.status === 'active').length, 1);
    const activeTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${recreated.plaintext_key}` }
    });
    assert.equal(activeTokenResp.status, 200);
    const { token: activeSessionBeforeRotate } = await activeTokenResp.json();

    const duplicate = await fetch(`${origin}/api/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'producer-read', scope: 'read' })
    });
    assert.equal(duplicate.status, 400);
    assert.deepEqual(await duplicate.json(), { error: 'duplicate_name' });

    const beforeRotate = new Store(dbPath);
    const rowBefore = beforeRotate.getApiKeyByName('producer-read');
    beforeRotate.close();

    const rotateReadScope = await fetch(`${origin}/api/keys/producer-read/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.equal(rotateReadScope.status, 403);

    const rotate = await fetch(`${origin}/api/keys/producer-read/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(rotate.status, 200);
    const rotateBody = await rotate.json();
    assert.equal(rotateBody.key.name, 'producer-read');
    assert.equal(rotateBody.key.scope, rowBefore.scope);
    assert.equal(rotateBody.key.created_at, rowBefore.created_at);
    assert.match(rotateBody.plaintext_key, /^zylos_ak_/);
    assert.equal(JSON.stringify(rotateBody).includes('key_hash'), false);

    const oldKeyResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${recreated.plaintext_key}` }
    });
    assert.equal(oldKeyResp.status, 401);
    const staleSession = await fetch(`${origin}/api/state`, {
      headers: { Authorization: `Bearer ${activeSessionBeforeRotate}` }
    });
    assert.equal(staleSession.status, 401);
    const newKeyResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${rotateBody.plaintext_key}` }
    });
    assert.equal(newKeyResp.status, 200);

    const afterRotate = new Store(dbPath);
    const rowAfter = afterRotate.getApiKeyByName('producer-read');
    afterRotate.close();
    assert.equal(rowAfter.id, rowBefore.id);
    assert.equal(rowAfter.scope, rowBefore.scope);
    assert.equal(rowAfter.created_at, rowBefore.created_at);

    const revokedRotate = await fetch(`${origin}/api/keys/missing-key/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(revokedRotate.status, 404);

    const namedRotate = await createKey('rotate');
    const revokeNamedRotate = await fetch(`${origin}/api/keys/rotate`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(revokeNamedRotate.status, 200);
    assert.equal((await revokeNamedRotate.json()).keys.some(key => key.name === 'rotate' && key.status === 'revoked'), true);
    const recreatedNamedRotate = await createKey('rotate');
    const rotateNamedRotate = await fetch(`${origin}/api/keys/rotate/rotate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(rotateNamedRotate.status, 200);
    const rotateNamedRotateBody = await rotateNamedRotate.json();
    assert.equal(rotateNamedRotateBody.key.name, 'rotate');
    assert.match(rotateNamedRotateBody.plaintext_key, /^zylos_ak_/);
    const oldNamedRotateResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${recreatedNamedRotate.plaintext_key}` }
    });
    assert.equal(oldNamedRotateResp.status, 401);
    assert.notEqual(namedRotate.plaintext_key, recreatedNamedRotate.plaintext_key);

    await createKey('old-delete');
    await fetch(`${origin}/api/keys/old-delete`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    await createKey('old-delete');
    const deleteRevokedWhileActive = await fetch(`${origin}/api/keys/old-delete?permanent=1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(deleteRevokedWhileActive.status, 200);
    const deleteRevokedWhileActiveBody = await deleteRevokedWhileActive.json();
    assert.equal(deleteRevokedWhileActiveBody.deleted, 1);
    assert.equal(deleteRevokedWhileActiveBody.keys.some(key => key.name === 'old-delete' && key.status === 'active'), true);
    assert.equal(deleteRevokedWhileActiveBody.keys.some(key => key.name === 'old-delete' && key.status === 'revoked'), false);
    await fetch(`${origin}/api/keys/old-delete`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    await createKey('old-delete');
    await fetch(`${origin}/api/keys/old-delete`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    const hardDelete = await fetch(`${origin}/api/keys/old-delete?permanent=1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(hardDelete.status, 200);
    assert.equal((await hardDelete.json()).deleted, 2);

    await createKey('active-delete');
    const activeHardDelete = await fetch(`${origin}/api/keys/active-delete?permanent=1`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(activeHardDelete.status, 409);
    assert.deepEqual(await activeHardDelete.json(), { error: 'must_revoke_first' });

    await createKey('purge-revoked');
    const deleteNamedPurge = await fetch(`${origin}/api/keys/purge-revoked`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(deleteNamedPurge.status, 200);
    assert.equal((await deleteNamedPurge.json()).keys.some(key => key.name === 'purge-revoked' && key.status === 'revoked'), true);

    const purgeReadScope = await fetch(`${origin}/api/keys/purge-revoked`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.equal(purgeReadScope.status, 403);

    const purge = await fetch(`${origin}/api/keys/purge-revoked`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(purge.status, 200);
    const purgeBody = await purge.json();
    assert.ok(purgeBody.purged >= 2);
    assert.equal(purgeBody.keys.some(key => key.status === 'revoked'), false);
    assert.equal(purgeBody.keys.some(key => key.name === 'active-delete' && key.status === 'active'), true);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('/api/fleet exposes safe records without registry secrets', async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: false },
    fleet: {
      agents: [
        {
          name: 'Remote',
          base_url: 'https://remote.example.test/dashboard',
          read_api_key: 'zylos_ak_secret'
        }
      ]
    }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const resp = await fetch(`${origin}/api/fleet`);
    assert.equal(resp.status, 200);
    const body = await resp.json();
    // Self record is always injected first, followed by external agents.
    assert.equal(body.count, 2);
    assert.equal(body.agents[0].self, true);
    assert.equal(body.agents[1].self, false);
    assert.equal(body.agents[1].name, 'Remote');
    assert.equal(body.agents[1].health_reason, 'not_polled');
    const serialized = JSON.stringify(body);
    assert.equal(serialized.includes('zylos_ak_secret'), false);
    assert.equal(serialized.includes('read_api_key'), false);
    assert.equal(serialized.includes('read_session_token'), false);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('fleet management API is admin-gated, masks keys, persists atomically, and hot-applies config', async () => {
  const remote = await listen((req, res) => {
    if (req.url === '/api/auth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'zylos_st_remote_read',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: 'read'
      }));
      return;
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        state: 'BUSY',
        active_subagents: [{ last_activity: 'masked zylos_ak_...abcd in activity text' }],
        runtime_info: { zylos_version: '0.3.0' }
      }));
      return;
    }
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: fleet_state\ndata: {"state":"IDLE"}\n\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { enabled: true, password: 'secret' },
    agent: { name: 'Local' },
    preserved: { keep: true }
  });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const dbPath = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
    const store = new Store(dbPath);
    const readKey = generateApiKey();
    const adminKey = generateApiKey();
    store.insertApiKey({ name: 'read-key', keyHash: hashApiKey(readKey), scope: 'read' });
    store.insertApiKey({ name: 'admin-key', keyHash: hashApiKey(adminKey), scope: 'admin' });
    store.close();

    const readTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${readKey}` }
    });
    const adminTokenResp = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminKey}` }
    });
    const { token: readToken } = await readTokenResp.json();
    const { token: adminToken } = await adminTokenResp.json();

    const readList = await fetch(`${origin}/api/fleet/agents`, {
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.equal(readList.status, 403);
    assert.deepEqual(await readList.json(), { error: 'insufficient_scope', required: 'admin' });

    const add = await fetch(`${origin}/api/fleet/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Remote',
        base_url: remote.origin,
        read_api_key: 'zylos_ak_supersecret1234'
      })
    });
    assert.equal(add.status, 200);
    const addBody = await add.json();
    assert.equal(addBody.agent.name, 'Remote');
    assert.equal(addBody.agent.key_masked, 'zylos_ak_...1234');
    assert.equal(addBody.agent.access, 'read');
    assert.equal(JSON.stringify(addBody).includes('supersecret'), false);

    const duplicate = await fetch(`${origin}/api/fleet/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'Remote',
        base_url: remote.origin,
        read_api_key: 'zylos_ak_other'
      })
    });
    assert.equal(duplicate.status, 400);
    assert.deepEqual(await duplicate.json(), { error: 'duplicate_name' });

    const reserved = await fetch(`${origin}/api/fleet/agents`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: 'test',
        base_url: remote.origin,
        read_api_key: 'zylos_ak_other'
      })
    });
    assert.equal(reserved.status, 400);
    assert.deepEqual(await reserved.json(), { error: 'reserved_name' });

    const list = await fetch(`${origin}/api/fleet/agents`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.self.name, 'Local');
    assert.equal(listBody.agents[0].name, 'Remote');
    assert.equal(listBody.agents[0].key_masked, 'zylos_ak_...1234');
    assert.equal(listBody.agents[0].access, 'read');
    assert.equal(JSON.stringify(listBody).includes('supersecret'), false);

    let fleetBody = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const fleet = await fetch(`${origin}/api/fleet`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(fleet.status, 200);
      fleetBody = await fleet.json();
      if (fleetBody.agents.find(a => a.name === 'Remote')?.activity === 'masked [redacted] in activity text') break;
      await sleep(25);
    }
    assert.equal(fleetBody.agents.some(a => a.name === 'Remote'), true, 'hot-added agent should appear without restart');
    const remoteRecord = fleetBody.agents.find(a => a.name === 'Remote');
    assert.equal(remoteRecord.activity, 'masked [redacted] in activity text');
    assert.equal(JSON.stringify(fleetBody).includes('zylos_ak_'), false);

    const rename = await fetch(`${origin}/api/agent/name`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'LocalRenamed' })
    });
    assert.equal(rename.status, 200);
    assert.deepEqual(await rename.json(), { ok: true, self: { name: 'LocalRenamed' } });

    const del = await fetch(`${origin}/api/fleet/agents/Remote`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(del.status, 200);
    const delBody = await del.json();
    assert.equal(delBody.agents.length, 0);

    const configPath = path.join(zylosDir, 'components', 'dashboard', 'config.json');
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    assert.deepEqual(saved.preserved, { keep: true });
    assert.equal(saved.agent.name, 'LocalRenamed');
    assert.deepEqual(saved.fleet.agents, []);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
  } finally {
    await closeServer(server);
    await remote.close();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('fleet management add rechecks duplicate names after slow probe', async () => {
  let tokenHits = 0;
  const remote = await listen((req, res) => {
    if (req.url === '/api/auth/token') {
      tokenHits += 1;
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          token: `zylos_st_remote_read_${tokenHits}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          scope: 'read'
        }));
      }, 75);
      return;
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 'IDLE', runtime_info: { zylos_version: '0.3.0' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', { auth: { enabled: false } });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const request = () => fetch(`${origin}/api/fleet/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Remote',
        base_url: remote.origin,
        read_api_key: 'zylos_ak_supersecret1234'
      })
    });

    const responses = await Promise.all([request(), request()]);
    const statuses = responses.map(resp => resp.status).sort();
    assert.deepEqual(statuses, [200, 400]);

    const bodies = await Promise.all(responses.map(resp => resp.json()));
    assert.equal(bodies.some(body => body.ok === true && body.agent?.name === 'Remote'), true);
    assert.equal(bodies.some(body => body.error === 'duplicate_name'), true);

    const saved = JSON.parse(fs.readFileSync(path.join(zylosDir, 'components', 'dashboard', 'config.json'), 'utf8'));
    assert.equal(saved.fleet.agents.filter(agent => agent.name === 'Remote').length, 1);

    const del = await fetch(`${origin}/api/fleet/agents/Remote`, { method: 'DELETE' });
    assert.equal(del.status, 200);
  } finally {
    await closeServer(server);
    await remote.close();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('fleet test-connection API reports auth failures and reachable read scope without persisting secrets', async () => {
  const remote = await listen((req, res) => {
    if (req.url === '/api/auth/token') {
      if (req.headers.authorization !== 'Bearer zylos_ak_good') {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_api_key' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'zylos_st_remote_read',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: 'read'
      }));
      return;
    }
    if (req.url === '/api/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ state: 'IDLE', runtime_info: { zylos_version: '0.3.0' } }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', { auth: { enabled: false } });

  const { origin, server } = await makeServerWithDir(zylosDir);
  try {
    const bad = await fetch(`${origin}/api/fleet/agents/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: remote.origin, read_api_key: 'zylos_ak_bad' })
    });
    assert.equal(bad.status, 200);
    assert.deepEqual(await bad.json(), { reachable: false, error: 'auth_failed' });

    const good = await fetch(`${origin}/api/fleet/agents/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: remote.origin, read_api_key: 'zylos_ak_good' })
    });
    assert.equal(good.status, 200);
    assert.deepEqual(await good.json(), { reachable: true, scope: 'read', version: '0.3.0' });

    const saved = JSON.parse(fs.readFileSync(path.join(zylosDir, 'components', 'dashboard', 'config.json'), 'utf8'));
    assert.equal(saved.fleet, undefined, 'test-connection must not persist the submitted key');
  } finally {
    await closeServer(server);
    await remote.close();
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('retired ingest endpoints accept neither local nor proxied writes', async () => {
  const { origin, server } = await makeServer();
  try {
    for (const endpoint of ['/api/ingest', '/api/ingest/statusline']) {
      for (const proxied of [false, true]) {
        const response = await fetch(`${origin}${endpoint}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(proxied ? { 'X-Forwarded-Prefix': '/dashboard' } : {})
          },
          body: JSON.stringify({ hook_event_name: 'Stop', ingest_id: 'retired-write', metrics: [] })
        });
        assert.equal(response.status, 401, 'retired endpoints pass through normal authentication');
      }
    }
  } finally {
    await closeServer(server);
  }
});
