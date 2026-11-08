import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { AuthGate, validateApiSession } from '../src/lib/auth.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('canonical auth context uses server session hash and stable API key id', t => {
  const cookieToken = 'browser-secret';
  const apiToken = `zylos_st_${'a'.repeat(64)}`;
  const now = Date.now();
  const store = {
    getSession(hash) {
      return hash === sha256(cookieToken)
        ? { created_at: now, last_activity_at: now, remember: 0 }
        : null;
    },
    touchSession() {},
    deleteSession() {},
    getApiSession(hash) {
      return hash === sha256(apiToken)
        ? { api_key_id: 42, scope: 'admin', expires_at: now + 60_000, key_revoked_at: null }
        : null;
    },
    cleanupSessions() {},
    cleanupExpiredApiSessions() {},
  };
  const gate = new AuthGate({ auth: { enabled: true, password: 'scrypt:configured' } }, store);
  t.after(() => clearInterval(gate._cleanupTimer));

  const cookieReq = { headers: { cookie: `__Secure-zylos_dashboard_session=${cookieToken}` } };
  assert.deepEqual(gate.resolveAuthContext(cookieReq), {
    kind: 'cookie',
    principalId: sha256(cookieToken),
    scope: 'admin',
  });
  assert.equal(gate.revalidateAuthContext(cookieReq._authContext)?.principalId, sha256(cookieToken));
  const apiReq = { headers: { authorization: `Bearer ${apiToken}` } };
  assert.deepEqual(gate.resolveAuthContext(apiReq), {
    kind: 'api',
    principalId: '42',
    scope: 'admin',
  });
  assert.equal(gate.revalidateAuthContext(apiReq._authContext)?.principalId, '42');
  assert.deepEqual(validateApiSession(apiToken), apiReq._authContext);
});

test('auth-disabled mode has no canonical Observer principal', () => {
  const gate = new AuthGate({ auth: { enabled: false, password: null } }, null);
  assert.equal(gate.resolveAuthContext({ headers: {} }), null);
});

test('missing password rejects existing cookie and API principals and their revalidation', t => {
  const now = Date.now(), token = `zylos_st_${'c'.repeat(64)}`;
  const config = { auth: { enabled: true, password: 'configured' } };
  const gate = new AuthGate(config, {
    getSession: () => ({ created_at: now, last_activity_at: now, remember: 0 }),
    touchSession() {},
    getApiSession: () => ({ api_key_id: 9, scope: 'admin', expires_at: now + 60_000, key_revoked_at: null }),
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  for (const headers of [{ cookie: '__Secure-zylos_dashboard_session=existing' }, { authorization: `Bearer ${token}` }]) {
    const context = gate.resolveAuthContext({ headers });
    assert.ok(context);
    config.auth.password = null;
    assert.equal(gate.enabled, true);
    assert.equal(gate.isAuthenticated({ headers }), false);
    assert.equal(gate.resolveAuthContext({ headers }), null);
    assert.equal(gate.revalidateAuthContext(context), null);
    config.auth.password = 'configured';
  }
});

// Permission integration: real AuthGate with in-memory API sessions only. Run
// for workbench proxy/admin classification; skip UI-only changes. No network,
// DB or children; each gate's cleanup timer is removed in test teardown.
test('workbench proxied memory and registered writes require local admin', async t => {
  const { workbenchWriteRoutes } = await import('./fixtures/workbench-write-routes.js');
  const now = Date.now(), token = `zylos_st_${'b'.repeat(64)}`;
  let scope = 'read';
  const gate = new AuthGate({ auth: { enabled: true, password: 'scrypt:fixture' } }, {
    getApiSession: hash => hash === sha256(token) ? { api_key_id: 7, scope, expires_at: now + 60_000, key_revoked_at: null } : null,
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  const routes = [
    { method: 'GET', path: '/api/workbench/memory/backlog' },
    { method: 'GET', path: '/api/chat/conversations' },
    ...['messages', 'status', 'questions'].map(kind => ({ method: 'GET', path: `/api/chat/conversations/local-chat/${kind}` })),
    ...['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].flatMap(method =>
      ['/api/chat/conversations/', '/api/chat/future'].map(path => ({ method, path }))),
    ...workbenchWriteRoutes,
  ];
  for (const route of routes) {
    const url = new URL(`/fleet/Remote${route.path}`, 'http://hub.test');
    const response = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    const request = () => ({ method: route.method, url: url.pathname, headers: { authorization: `Bearer ${token}` } });
    scope = 'read';
    assert.equal(await gate.handle(request(), response, url), true);
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'insufficient_scope', required: 'admin' });
    scope = 'admin';
    assert.equal(await gate.handle(request(), response, url), false);
  }
});
