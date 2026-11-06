import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { AuthGate } from '../src/lib/auth.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';
import { workbenchWriteRoutes } from './fixtures/workbench-write-routes.js';

const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t, remoteScope) {
  const localToken = `zylos_st_${'a'.repeat(64)}`;
  const cookie = 'private-browser-session';
  const store = {
    getSession: hash => hash === digest(cookie) ? { created_at: Date.now(), last_activity_at: Date.now(), remember: 0 } : null,
    touchSession() {}, deleteSession() {}, cleanupSessions() {}, cleanupExpiredApiSessions() {},
    getApiSession: hash => hash === digest(localToken) ? {
      api_key_id: 1, scope: 'read', expires_at: Date.now() + 60_000, key_revoked_at: null,
    } : null,
  };
  const auth = new AuthGate({ auth: { enabled: true, password: 'scrypt:fixture' } }, store);
  t.after(() => clearInterval(auth._cleanupTimer));
  const forwarded = [];
  const proxy = new FleetProxy({
    config: { fleet: { agents: [{ name: 'Remote', base_url: 'https://remote.invalid/dashboard' }] } },
    poller: { getSessionToken: async () => remoteScope === 'admin' ? 'remote-admin-fixture' : 'remote-read-fixture' },
    fetch: async (url, options) => {
      forwarded.push({ url, method: options.method, body: options.body?.toString(), headers: options.headers });
      const body = remoteScope === 'admin' ? { ok: true, data: { accepted: true } } : { error: 'insufficient_scope', required: 'admin' };
      return new Response(JSON.stringify(body), { status: remoteScope === 'admin' ? 200 : 403,
        headers: { 'content-type': 'application/json', 'x-remote-result': 'preserved' } });
    },
  });
  async function request(route, localScope = 'admin') {
    const req = Readable.from(route.body === null ? [] : [Buffer.from(route.body)]);
    req.method = route.method;
    req.url = `/fleet/Remote${route.path}?exact=1`;
    req.headers = { host: 'hub.test', origin: 'http://hub.test', 'content-type': 'application/json',
      ...(localScope === 'read' ? { authorization: `Bearer ${localToken}` } : { cookie: `__Secure-zylos_dashboard_session=${cookie}` }) };
    const response = { status: null, headers: {}, body: '',
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers = {}) { this.status = status; Object.assign(this.headers, headers); },
      end(body) { this.body += body?.toString() ?? ''; },
    };
    const url = new URL(req.url, 'http://hub.test');
    if (!await auth.handle(req, response, url)) await proxy.handle(req, response, url);
    return response;
  }
  return { request, forwarded };
}

// Cross-module permission integration: actual AuthGate and FleetProxy, in-memory
// sessions and an injected upstream transport. Run for workbench write routes or
// either allowlist; skip UI-only edits. No sockets, child processes, DB, PM2 or
// tmux. Auth cleanup timer belongs to this test and is removed in teardown.
for (const route of workbenchWriteRoutes) {
  test(`workbench proxy ${route.method} ${route.path} follows local and remote key scopes`, { timeout: 5000 }, async t => {
    const adminRemote = fixture(t, 'admin');
    let response = await adminRemote.request(route, 'read');
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: 'insufficient_scope', required: 'admin' });
    assert.equal(adminRemote.forwarded.length, 0);
    response = await adminRemote.request(route);
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), { ok: true, data: { accepted: true } });
    assert.equal(response.headers['x-remote-result'], 'preserved');
    assert.equal(adminRemote.forwarded.length, 1);
    assert.deepEqual({ ...adminRemote.forwarded[0], headers: undefined }, {
      url: `https://remote.invalid/dashboard${route.path}?exact=1`, method: route.method,
      body: route.body ?? '', headers: undefined,
    });
    assert.equal(adminRemote.forwarded[0].headers.authorization, 'Bearer remote-admin-fixture');
    const readRemote = fixture(t, 'read');
    response = await readRemote.request(route);
    assert.equal(response.status, 403);
    assert.equal(readRemote.forwarded.length, 1);
    assert.deepEqual(JSON.parse(response.body), { error: 'insufficient_scope', required: 'admin' });
    assert.equal(readRemote.forwarded[0].headers.authorization, 'Bearer remote-read-fixture');
  });
}

test('workbench proxy rejects writes outside the registered table before upstream', { timeout: 5000 }, async t => {
  const f = fixture(t, 'admin');
  for (const route of [
    { method: 'POST', path: '/api/workbench/groups/telegram%3Ateam/name', body: '{}' },
    { method: 'PUT', path: '/api/workbench/groups/telegram%3Ateam/unregistered', body: '{}' },
  ]) {
    const response = await f.request(route);
    assert.equal(response.status, 403);
    assert.deepEqual(JSON.parse(response.body), { error: 'read_only_proxy' });
    assert.equal(f.forwarded.length, 0);
  }
});
