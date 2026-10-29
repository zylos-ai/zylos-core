import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { AuthGate, validateApiSession } from '../src/lib/auth.js';

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('canonical auth context uses server session hash and stable API key id', () => {
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
