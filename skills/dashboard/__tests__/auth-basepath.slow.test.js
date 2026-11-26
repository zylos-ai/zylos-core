// covers: skills/comm-bridge/scripts/sqlite-driver.js skills/dashboard/src/lib/auth.js skills/dashboard/src/lib/store.js skills/dashboard/src/lib/version-checker.js skills/dashboard/src/lib/workbench/group-snapshot.js skills/dashboard/src/lib/core-state.js skills/dashboard/src/index.js skills/dashboard/src/lib/ skills/dashboard/public/themes/ skills/dashboard/public/index.html skills/dashboard/public/manifest.json skills/dashboard/public/icons/ skills/dashboard/__tests__/helpers/explicit-migration.js skills/dashboard/__tests__/fixtures/schema13.js skills/dashboard/__tests__/fixtures/memory-installation.js skills/dashboard/__tests__/fixtures/fleet-object-api.js skills/dashboard/__tests__/helpers/dashboard-sign-in.js skills/dashboard/__tests__/helpers/fleet-restart-server.js
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test, { after, mock } from 'node:test';
import Database from '../../comm-bridge/scripts/sqlite-driver.js';
import { generateApiKey, hashApiKey } from '../src/lib/auth.js';
import { Store } from '../src/lib/store.js';
import { migrateDashboardFile } from './helpers/explicit-migration.js';
import { migrateSchema13 } from './fixtures/schema13.js';
import { installMemoryScripts, memoryTestEnv, memoryTempRoot } from './fixtures/memory-installation.js';
import { VersionChecker } from '../src/lib/version-checker.js';
import { objectResponse, isObjectApi } from './fixtures/fleet-object-api.js';
import { createGroupSnapshot, systemSample } from '../src/lib/workbench/group-snapshot.js';

import { signIn } from './helpers/dashboard-sign-in.js';

// HTTP/auth fixtures exercise actual product routing, not remote version hosts.
assert.notEqual(process.env.HOME, os.userInfo().homedir, 'Run through the isolated Node test runner');
process.env.TMUX_TMPDIR = path.join(os.tmpdir(), 'auth-tmux');
fs.mkdirSync(process.env.TMUX_TMPDIR, { recursive: true, mode: 0o700 });
fs.chmodSync(process.env.TMUX_TMPDIR, 0o700);
mock.method(VersionChecker.prototype, 'start', () => {});
// A test that waits forever must fail fast instead of holding the whole Node
// batch until the outer runner timeout. Generous so a loaded host still passes.
const TEST_TIMEOUT_MS = 60_000;
// Every listening server is tracked so a test that fails before its own
// cleanup cannot keep this file's process alive after the last test.
const openServers = new Set();
after(async () => {
  for (const server of openServers) await closeServer(server);
});
// These fixtures verify HTTP/auth and fleet behavior. The object APIs now need
// a group catalog even for an empty instance; inject source observations while
// retaining the real snapshot builder, projection and private Store.
const emptyAuthObservations = {
  reader: { readAccountUsage: async () => null },
  get: async () => ({ mode: 'single', group: null, observations: new Map() }),
  peek: () => ({ mode: 'single', group: null, observations: new Map() }),
};
let buildAuthSnapshot = options => createGroupSnapshot({ ...options, sessionObservations: emptyAuthObservations,
    core: { groups: async () => ({ ok: true, data: { groups: [], hasOlder: false } }),
      groupQueues: async () => ({ ok: true, data: { groups: [], hasOlder: false } }),
      readOverrides: async () => ({ ok: true, data: { baseline: { runtime: 'claude' }, runtime: [], model: [] } }) },
    loadCoreModule: async name => {
      if (name === 'config.js') return { readSessionMode: () => ({ mode: 'single' }) };
      if (name === 'status-view.js') return { collectStatus: async () => ({ view: 'single', origin: { presence: 'not_running' }, groupListError: null, runtimeHealth: {} }) };
      return import(new URL(`../../../cli/lib/${name}`, import.meta.url));
    } });
mock.module('../src/lib/workbench/group-snapshot.js', { namedExports: {
  systemSample, createGroupSnapshot: options => buildAuthSnapshot(options),
} });

function writeConfig(zylosDir, password = 'secret', extra = {}) {
  const configDir = path.join(zylosDir, 'components', 'dashboard');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), `${JSON.stringify({
    auth: {
      password
    },
    ...extra
  }, null, 2)}\n`);
}

async function makeServerWithDir(zylosDir) {
  const previousZylosDir = process.env.ZYLOS_DIR;
  const previousPort = process.env.DASHBOARD_PORT;
  const previousTmux = process.env.TMUX_TMPDIR;
  process.env.ZYLOS_DIR = zylosDir;
  process.env.DASHBOARD_PORT = '0';
  const privateTmux = path.join(zylosDir, 'tmux'); fs.mkdirSync(privateTmux, { recursive: true, mode: 0o700 });
  fs.chmodSync(privateTmux, 0o700);
  process.env.TMUX_TMPDIR = privateTmux;
  let createServer;
  try {
    console.log('Auth HTTP isolation:', JSON.stringify({ HOME: process.env.HOME, ZYLOS_DIR: zylosDir, PM2_HOME: process.env.PM2_HOME, TMPDIR: process.env.TMPDIR, TMUX_TMPDIR: privateTmux, db: path.join(zylosDir, 'components/dashboard/dashboard.db') }));
    const moduleUrl = new URL(`../src/index.js?test=${Date.now()}-${Math.random()}`, import.meta.url);
    ({ createServer } = await import(moduleUrl.href));
  } finally {
    process.env.ZYLOS_DIR = previousZylosDir;
    process.env.DASHBOARD_PORT = previousPort;
    if (previousZylosDir == null) delete process.env.ZYLOS_DIR;
    if (previousPort == null) delete process.env.DASHBOARD_PORT;
    if (previousTmux == null) delete process.env.TMUX_TMPDIR; else process.env.TMUX_TMPDIR = previousTmux;
  }

  const server = createServer();
  openServers.add(server);
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

/** Every key the list route returns, following nextCursor page by page. */
async function listedKeys(origin, token) {
  const keys = [];
  let cursor = null;
  do {
    const resp = await fetch(`${origin}/api/keys?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    keys.push(...body.items);
    cursor = body.nextCursor;
  } while (cursor);
  return keys;
}

async function closeServer(server) {
  openServers.delete(server);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function listen(handler) {
  const server = http.createServer(handler);
  openServers.add(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    server,
    close: () => closeServer(server)
  };
}

function form(body) {
  return new URLSearchParams(body);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Login sets a credential cookie and a readable, noncredential reset marker.
function loginCookies(response, { base = '', markerBase = base, maxAge = 86400, legacy = false } = {}) {
  const cookies = response.headers.getSetCookie();
  assert.equal(cookies.length, legacy ? 3 : 2);
  const session = cookies.find(cookie => cookie.startsWith('__Secure-zylos_dashboard_session='));
  assert.ok(session, 'login must set its session cookie');
  const [credential, ...attributes] = session.split('; ');
  assert.match(credential, /^__Secure-zylos_dashboard_session=[^;]+$/);
  assert.deepEqual(attributes, ['HttpOnly', 'Secure', 'SameSite=Lax', `Path=${base || '/'}`, `Max-Age=${maxAge}`]);
  const marker = cookies.find(cookie => cookie.startsWith('zylos_dashboard_draft_reset_'));
  assert.equal(marker, `zylos_dashboard_draft_reset_${encodeURIComponent(markerBase)}=1; Secure; SameSite=Strict; Path=${base || '/'}`);
  assert.doesNotMatch(marker, /HttpOnly/);
  return session;
}

// Actual HTTP entry + loaded config + AuthGate. Run for authentication/config
// changes; unrelated UI may skip. Runner must isolate HOME/ZYLOS_DIR/PM2_HOME,
// short temp/tmux socket and DBs; each server/root is closed in teardown.

// Actual HTTP entry + loaded config + AuthGate, same isolation as the missing-password cases.
// Run for authentication/config changes. A config file that still carries the removed
// sign-in switch must not open any page or API; signing in then works as usual.
test('a stored enabled:false auth setting still requires sign-in for pages and APIs', { timeout: 15_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-stored-off-'));
  let server;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await closeServer(server); }
    fs.rmSync(root, { recursive: true, force: true });
  });
  writeConfig(root, 'secret', { auth: { enabled: false, password: 'secret' } });
  const running = await makeServerWithDir(root);
  server = running.server;
  const { origin } = running;
  const page = await fetch(`${origin}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login?next=%2F');
  await page.text();
  const loginPage = await fetch(`${origin}/login`, { redirect: 'manual' });
  assert.equal(loginPage.status, 200);
  assert.match(await loginPage.text(), /type="password"/);
  for (const [method, route] of [['GET', '/api/settings/timezone'], ['PUT', '/api/settings/timezone'],
    ['POST', '/api/settings/timezone/actions/restart-services'], ['GET', '/api/memory/entries'], ['GET', '/api/memory/file?path=state.md'],
    ['GET', '/api/conversations'], ['GET', '/api/stream'], ['GET', '/api/keys']]) {
    const response = await fetch(origin + route, { method, headers: { Origin: origin } });
    assert.equal(response.status, 401, `${method} ${route}`);
    await response.text();
  }
  const cookie = await signIn(origin, 'secret');
  for (const route of ['/api/settings/timezone', '/api/keys']) {
    const response = await fetch(origin + route, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, route);
    await response.text();
  }
});

test('login sets secure cookie and authenticated requests can reach API and SSE', { timeout: TEST_TIMEOUT_MS }, async () => {
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

    const cookie = loginCookies(login, { base: '/dashboard' });

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

// Post-login `next` targets outside the forwarded prefix fall back to the
// Dashboard root, and the login page never echoes them as a hidden field.
// Actual HTTP entry + loaded config + AuthGate. Run for login/redirect or
// browser-base changes; unrelated UI may skip. Runner must isolate
// HOME/ZYLOS_DIR/PM2_HOME, short temp/tmux socket and DBs; each server/root is
// closed in teardown.

// HTTP integration: actual authenticated logout in runner-isolated installation;
// run for logout/auth/browser-origin changes. The fixture has private DB, PM2_HOME
// and tmux directory and disabled network version checks; loopback servers close.
test('logout always clears browser sessions and respects forwarded prefix', { timeout: TEST_TIMEOUT_MS }, async () => {
  const { origin, server } = await makeServer();
  const clearCookie = '__Secure-zylos_dashboard_session=; HttpOnly; Secure; SameSite=Lax; Path=/dashboard; Max-Age=0';
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
    const cookie = await loginCookie();
    const mismatched = await logout({ Cookie: cookie, Origin: 'https://agent.example.com' });
    assert.equal(mismatched.status, 302);
    assert.equal(mismatched.headers.get('location'), '/dashboard/login');
    assert.equal(mismatched.headers.get('set-cookie'), clearCookie);
    const revoked = await fetch(`${origin}/api/instance`, { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(revoked.status, 401);
    for (const headers of [{ Origin: origin }, {}]) {
      const accepted = await logout({ Cookie: await loginCookie(), ...headers });
      assert.equal(accepted.status, 302);
      assert.equal(accepted.headers.get('location'), '/dashboard/login');
      assert.equal(accepted.headers.get('set-cookie'), clearCookie);
    }

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

test('/api/instance exposes stable agent identity without fleet secrets', { timeout: TEST_TIMEOUT_MS }, async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  const legacyMarker = path.join(zylosDir, 'components', 'dashboard', 'upgrade-zylos-pending.json');
  writeConfig(zylosDir, 'secret', {
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
    const resp = await fetch(`${origin}/api/instance`, { headers: { Cookie: await signIn(origin, 'secret') } });
    assert.equal(resp.status, 200);
    const body = await resp.json();
    assert.equal(body.agent.name, 'Jinglever');
    assert.equal(body.agent.id, 'jinglever-main');
    // Identity also carries the deterministic identity color/hue.
    assert.equal(typeof body.agent.color, 'string');
    assert.equal(typeof body.agent.hue, 'number');
    assert.equal(Object.hasOwn(body, 'new_session_threshold'), false, 'per-session threshold belongs to the group');
    assert.equal(Object.hasOwn(body, 'runtime_info'), false);
    assert.deepEqual(Object.keys(body.versions).sort(), ['agy', 'claude', 'codex', 'zylos']);
    for (const [runtime, version] of Object.entries(body.versions)) {
      const keys = ['installed', 'latest', 'update'];
      if (runtime === 'agy') keys.push('update_check');
      assert.deepEqual(Object.keys(version).sort(), keys);
    }
    assert.equal(body.versions.agy.update_check, 'unsupported');
    assert.ok(body.resources && typeof body.resources === 'object');
    assert.ok(Object.hasOwn(body.resources, 'cpu_pct'));
    assert.ok(Object.hasOwn(body.resources, 'mem_pct'));
    assert.ok(Object.hasOwn(body.resources, 'disk_pct'));
    assert.equal(Object.hasOwn(body, 'session_cost'), false);
    assert.equal(Object.hasOwn(body, 'daily_cost'), false);
    assert.equal(Object.hasOwn(body, 'weekly_cost'), false);
    assert.equal(Object.hasOwn(body, 'context_pct'), false);
    for (const rawField of ['identity', 'status', 'usage', 'launchConfig', 'input']) {
      assert.equal(JSON.stringify(body).includes(`"${rawField}"`), false);
    }
    assert.equal(JSON.stringify(body).includes('zylos_upgrade_result'), false);
    assert.equal(Object.hasOwn(body, 'dashboard_version'), false, 'Dashboard has no version of its own; pages show versions.zylos.installed');
    assert.equal(fs.existsSync(legacyMarker), true, 'Dashboard must not consume the legacy upgrade marker');
    assert.equal(JSON.stringify(body).includes('zylos_ak_secret'), false);
    assert.equal(JSON.stringify(body).includes('read_api_key'), false);
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

// Integration: real auth/routing and Core save, including the 1 MiB boundary.
// Run when memory transport or auth changes; skip unrelated UI/collector edits.
// All config/DB/memory is fixture-owned; Core uses a private short tmux socket.
test('/api/memory tree accepts read keys while file contents require admin', { timeout: TEST_TIMEOUT_MS }, async () => {
  const zylosDir = memoryTempRoot('wba-');
  installMemoryScripts(zylosDir);
  const isolatedEnv = memoryTestEnv(zylosDir);
  const envKeys = ['HOME', 'ZYLOS_DIR', 'ZYLOS_PACKAGE_ROOT', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR', 'TMUX'];
  const previousEnv = new Map(envKeys.map(key => [key, process.env[key]]));
  let server;
  try {
    for (const key of envKeys) {
      if (isolatedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = isolatedEnv[key];
    }
    writeConfig(zylosDir, 'secret', { auth: { password: 'secret' } });
    fs.mkdirSync(path.join(zylosDir, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(zylosDir, 'memory', 'identity.md'), '# Identity\n');
    const newlineText = '\n'.repeat(1024 * 1024);
    fs.writeFileSync(path.join(zylosDir, 'memory', 'large.txt'), newlineText);

    let origin;
    ({ origin, server } = await makeServerWithDir(zylosDir));
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

    const readResp = await fetch(`${origin}/api/memory/entries`, {
      headers: { Authorization: `Bearer ${readToken}` }
    });
    assert.equal(readResp.status, 200);
    assert.equal(Array.isArray((await readResp.json()).items), true);
    const readFile = await fetch(`${origin}/api/memory/file?path=identity.md`, { headers: { Authorization: `Bearer ${readToken}` } });
    assert.equal(readFile.status, 403);
    assert.equal((await readFile.json()).error.code, 'insufficient_scope');

    const adminResp = await fetch(`${origin}/api/memory/entries`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(adminResp.status, 200);
    const adminBody = await adminResp.json();
    assert.equal(JSON.stringify(adminBody).includes('sha256'), false);
    assert.equal(adminBody.items.some(node => node.path === 'identity.md'), true);

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
    assert.deepEqual(await readWriteResp.json(), { ok: false, error: { code: 'insufficient_scope', message: 'insufficient_scope' }, required: 'admin' });

    const nullWriteResp = await fetch(`${origin}/api/memory/file?path=identity.md`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: 'null'
    });
    assert.equal(nullWriteResp.status, 400);
    assert.deepEqual(await nullWriteResp.json(), { ok: false, error: { code: 'invalid_memory_write', message: 'invalid_memory_write' } });

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
    assert.equal(conflictBody.error.code, 'memory_conflict');
    assert.equal(conflictBody.current.sha256, adminWriteBody.sha256);
    assert.equal(conflictBody.current.text, '# Identity\nEdited\n');
    assert.equal(fs.readFileSync(path.join(zylosDir, 'memory', 'identity.md'), 'utf8'), '# Identity\nEdited\n');
  } finally {
    // Restore first: later tests must not inherit this fixture's HOME/TMPDIR
    // even if closing the server or removing the directory fails.
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (server) await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('API key management is admin-gated, show-once, and revoke invalidates active sessions', { timeout: TEST_TIMEOUT_MS }, async () => {
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', { auth: { password: 'secret' } });

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
    assert.deepEqual(await readList.json(), { ok: false, error: { code: 'insufficient_scope', message: 'insufficient_scope' }, required: 'admin' });

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
    assert.equal('keys' in createBody, false, 'a write answers without the key list');
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
    assert.deepEqual(await duplicate.json(), { ok: false, error: { code: 'duplicate_name', message: 'duplicate_name' } });

    const badScope = await fetch(`${origin}/api/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'bad-scope', scope: 'owner' })
    });
    assert.equal(badScope.status, 400);
    assert.deepEqual(await badScope.json(), { ok: false, error: { code: 'invalid_scope', message: 'invalid_scope' } });

    const createAdmin = await fetch(`${origin}/api/keys`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'producer-admin', scope: 'admin' })
    });
    // An API key, even admin, cannot hand out admin power; only the local password session creates admin keys.
    assert.equal(createAdmin.status, 403);
    assert.deepEqual(await createAdmin.json(), { ok: false, error: { code: 'local_cookie_required', message: 'local_cookie_required' } });

    const list = await fetch(`${origin}/api/keys`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.items.some(k => k.name === 'producer-read' && k.status === 'active'), true);
    assert.equal(JSON.stringify(listBody).includes(createBody.plaintext_key), false);
    assert.equal(listBody.items.some(k => k.name === 'producer-admin'), false);
    assert.equal(JSON.stringify(listBody).includes('key_hash'), false);

    const revoke = await fetch(`${origin}/api/keys/producer-read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(revoke.status, 200);
    assert.deepEqual(await revoke.json(), { ok: true });
    assert.equal((await listedKeys(origin, adminToken)).some(k => k.name === 'producer-read' && k.status === 'revoked'), true);

    const revokedExchange = await fetch(`${origin}/api/auth/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${createBody.plaintext_key}` }
    });
    assert.equal(revokedExchange.status, 401);

    const staleSessionUse = await fetch(`${origin}/api/instance`, {
      headers: { Authorization: `Bearer ${createdToken}` }
    });
    assert.equal(staleSessionUse.status, 401, 'revoking a key should immediately invalidate existing session tokens');

    const secondRevoke = await fetch(`${origin}/api/keys/producer-read`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(secondRevoke.status, 404);
    assert.deepEqual(await secondRevoke.json(), { ok: false, error: { code: 'unknown_key', message: 'unknown_key' } });
  } finally {
    await closeServer(server);
    fs.rmSync(zylosDir, { recursive: true, force: true });
  }
});

test('API key migration v11 preserves ids, sessions, and active-name uniqueness', { timeout: TEST_TIMEOUT_MS }, () => {
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

  assert.throws(() => new Store(dbPath), { code: 'SCHEMA_UPGRADE_REQUIRED' });
  migrateDashboardFile(dbPath);
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

test('fleet management API is admin-gated, masks keys, persists atomically, and hot-applies config', { timeout: TEST_TIMEOUT_MS }, async () => {
  const remoteRequests = [];
  const remote = await listen(async (req, res) => {
    remoteRequests.push(req.url);
    if (req.url === '/api/auth/token') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'zylos_st_remote_read',
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        scope: 'read'
      }));
      return;
    }
    if (isObjectApi(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(await objectResponse(req.url, { working: 1,
        instance: { agent: { name: 'masked zylos_ak_...abcd in identity text' }, versions: { zylos: { installed: '1.0.0-beta.16', latest: '1.0.0', update: '1.0.0' } } },
        rows: [{ id: 'origin', displayName: 'Origin', runtime: 'claude', model: null, state: { kind: 'working' }, flags: { blocked: { reason: 'auth_failed' } } }],
      }).text());
      return;
    }
    if (req.url === '/api/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('event: instance\ndata: {"state":"IDLE"}\n\n');
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  const zylosDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-dashboard-test-'));
  writeConfig(zylosDir, 'secret', {
    auth: { password: 'secret' },
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
    assert.deepEqual(await readList.json(), { ok: false, error: { code: 'insufficient_scope', message: 'insufficient_scope' }, required: 'admin' });

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
    assert.deepEqual(await duplicate.json(), { ok: false, error: { code: 'duplicate_name', message: 'duplicate_name' } });

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
    assert.deepEqual(await reserved.json(), { ok: false, error: { code: 'reserved_name', message: 'reserved_name' } });

    const list = await fetch(`${origin}/api/fleet/agents`, {
      headers: { Authorization: `Bearer ${adminToken}` }
    });
    assert.equal(list.status, 200);
    const listBody = await list.json();
    assert.equal(listBody.self.name, 'Local');
    assert.equal(listBody.items[0].name, 'Remote');
    assert.equal(listBody.items[0].key_masked, 'zylos_ak_...1234');
    assert.equal(listBody.items[0].access, 'read');
    assert.equal(JSON.stringify(listBody).includes('supersecret'), false);

    let fleetBody = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const fleet = await fetch(`${origin}/api/fleet`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      assert.equal(fleet.status, 200);
      fleetBody = await fleet.json();
      if (fleetBody.items.find(a => a.name === 'Remote')?.health_reason === 'ok') break;
      await sleep(25);
    }
    assert.equal(fleetBody.items.some(a => a.name === 'Remote'), true, 'hot-added agent should appear without restart');
    const remoteRecord = fleetBody.items.find(a => a.name === 'Remote');
    for (const field of ['model', 'effort', 'context_pct', 'new_session_threshold']) assert.equal(Object.hasOwn(remoteRecord, field), false);
    assert.equal(remoteRequests.some(route => /^\/api\/groups\/origin(?:[/?]|$)/.test(route)), false, 'Fleet never fetches Origin detail or another Origin resource');
    assert.equal(JSON.stringify(fleetBody).includes('zylos_ak_'), false);

    const rename = await fetch(`${origin}/api/instance/name`, {
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
    assert.deepEqual(delBody, { ok: true });

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

// Real HTTP duplicate-cookie admission and current-prefix logout.

// HTTP integration: group detail retains actual sampled model policy while Fleet omits session metadata.
// Run for threshold/usage-to-state changes; skip rendering-only changes.
// The official runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR and tmux.
// Core observations are injected; the real HTTP server/DB are private and closed.

// Actual HTTP auth and method dispatch: private installation and loopback only.
// Run when API method routing or Fleet authentication changes; unrelated views may skip.
