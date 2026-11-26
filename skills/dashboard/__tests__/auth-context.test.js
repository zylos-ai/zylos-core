import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { AuthGate } from '../src/lib/auth.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('missing password rejects existing cookie and API principals and their revalidation', t => {
  const now = Date.now(), token = `zylos_st_${'c'.repeat(64)}`;
  const config = { auth: { password: 'configured' } };
  const gate = new AuthGate(config, {
    getSession: () => ({ created_at: now, last_activity_at: now, remember: 0 }),
    touchSession() {},
    getApiSession: () => ({ api_key_id: 9, scope: 'admin', key_scope: 'admin', expires_at: now + 60_000, key_revoked_at: null }),
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  for (const headers of [{ cookie: '__Secure-zylos_dashboard_session=existing' }, { authorization: `Bearer ${token}` }]) {
    const context = gate.resolveAuthContext({ headers });
    assert.ok(context);
    config.auth.password = null;
    assert.equal(gate.isAuthenticated({ headers }), false);
    assert.equal(gate.resolveAuthContext({ headers }), null);
    assert.equal(gate.revalidateAuthContext(context), null);
    config.auth.password = 'configured';
  }
});

// Permission integration: real AuthGate with in-memory API sessions only. Run
// for workbench proxy/admin classification; skip UI-only changes. No network,
// DB or children; each gate's cleanup timer is removed in test teardown.
test('proxied writes and sensitive reads require admin while status reads accept read scope', async t => {
  const { workbenchWriteRoutes } = await import('./fixtures/workbench-write-routes.js');
  const now = Date.now(), token = `zylos_st_${'b'.repeat(64)}`;
  let scope = 'read';
  const gate = new AuthGate({ auth: { password: 'scrypt:fixture' } }, {
    getApiSession: hash => hash === sha256(token) ? { api_key_id: 7, scope, key_scope: scope, expires_at: now + 60_000, key_revoked_at: null } : null,
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  const routes = [
    { method: 'GET', path: '/api/memory/backlog' },
    { method: 'GET', path: '/api/conversations' },
    ...['messages', 'status', 'questions'].map(kind => ({ method: 'GET', path: `/api/conversations/local-chat/${kind}` })),
    ...['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].flatMap(method =>
      ['/api/conversations/', '/api/conversations/future'].map(path => ({ method, path }))),
    ...workbenchWriteRoutes,
  ];
  for (const route of routes) {
    const url = new URL(`/fleet/Remote${route.path}`, 'http://hub.test');
    const response = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    const request = () => ({ method: route.method, url: url.pathname, headers: { authorization: `Bearer ${token}` } });
    scope = 'read';
    const adminRequired = !['GET', 'HEAD', 'OPTIONS'].includes(route.method) || route.path.startsWith('/api/conversations');
    assert.equal(await gate.handle(request(), response, url), adminRequired);
    if (adminRequired) {
      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'insufficient_scope');
    }
    scope = 'admin';
    assert.equal(await gate.handle(request(), response, url), false);
  }
});
