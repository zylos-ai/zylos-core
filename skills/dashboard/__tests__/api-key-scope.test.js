import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { AuthGate } from '../src/lib/auth.js';
import { API_KEY_PERMISSIONS, normalizeApiKeyScope } from '../src/lib/api-key-scope.js';

const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

// A real AuthGate over an in-memory API session whose key scope the test changes, as PATCH /api/keys does.
function gateWithKey(t, scope) {
  const token = `zylos_st_${'d'.repeat(64)}`, now = Date.now();
  const key = { scope };
  const gate = new AuthGate({ auth: { password: 'scrypt:fixture' } }, {
    getApiSession: hash => hash === sha256(token)
      ? { api_key_id: 5, scope: 'read', key_scope: key.scope, expires_at: now + 60_000, key_revoked_at: null } : null,
    cleanupSessions() {}, cleanupExpiredApiSessions() {},
  });
  t.after(() => clearInterval(gate._cleanupTimer));
  const send = async (method, path) => {
    const url = new URL(path, 'http://dashboard.test');
    const res = { status: null, body: null, setHeader() {}, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    const handled = await gate.handle({ method, url: url.pathname + url.search, headers: { authorization: `Bearer ${token}` } }, res, url);
    return handled ? { status: res.status, required: res.body.required } : { status: 'pass' };
  };
  return { gate, key, send, headers: { authorization: `Bearer ${token}` } };
}

test('a custom scope is stored as its known permission names, deduplicated and sorted', () => {
  assert.equal(normalizeApiKeyScope(' groups.read, groups.control ,groups.read'), 'groups.control,groups.read');
  assert.equal(normalizeApiKeyScope('read'), 'read');
  assert.equal(normalizeApiKeyScope('admin'), 'admin');
  for (const invalid of ['', ' ', 'groups.read,', 'groups.read,unknown', 'read,groups.read', 'admin,groups.read', null, ['groups.read']]) {
    assert.equal(normalizeApiKeyScope(invalid), null, String(invalid));
  }
});

test('a custom key reaches only the routes its permissions name', async t => {
  // One route per permission; each is refused naming that permission until the key holds it.
  const routes = {
    'instance.read': ['GET', '/api/instance'],
    'instance.settings': ['PUT', '/api/instance/defaults'],
    'instance.ops': ['POST', '/api/instance/actions/switch-runtime'],
    'groups.read': ['GET', '/api/groups/origin/messages'],
    'groups.control': ['POST', '/api/groups/origin/actions/restart'],
    'groups.settings': ['PUT', '/api/groups/origin/config'],
    'usage.read': ['HEAD', '/api/usage/series'],
    'memory.list': ['GET', '/api/memory/entries'],
    'memory.read': ['GET', '/api/memory/file?path=state.md'],
    'memory.write': ['PUT', '/api/memory/file?path=state.md'],
    'schedules.read': ['GET', '/api/schedules/task-1/history'],
    'schedules.write': ['DELETE', '/api/schedules/task-1'],
    'conversations.read': ['GET', '/api/stream?chat=1'],
    'conversations.write': ['POST', '/api/conversations/g%3A6F/send'],
    'terminal.read': ['GET', '/api/observer/history/sessions'],
    'terminal.control': ['POST', '/api/observer/leases'],
    'fleet.read': ['GET', '/api/fleet'],
  };
  assert.deepEqual(Object.keys(routes).sort(), [...API_KEY_PERMISSIONS].sort());
  const { key, send } = gateWithKey(t, 'groups.read');
  for (const permission of API_KEY_PERMISSIONS) {
    const [method, path] = routes[permission];
    key.scope = permission === 'groups.read' ? 'groups.control' : 'groups.read';
    assert.deepEqual(await send(method, path), { status: 403, required: permission }, `${method} ${path} without ${permission}`);
    key.scope = normalizeApiKeyScope(`${permission},groups.read`);
    assert.deepEqual(await send(method, path), { status: 'pass' }, `${method} ${path} with ${permission}`);
  }
  // Even every permission at once opens nothing outside the table: key management, the remote switch, Fleet
  // registration, session hosts, deletion, the Fleet proxy and routes the table does not name.
  key.scope = API_KEY_PERMISSIONS.join(',');
  for (const [method, path] of [['GET', '/api/keys'], ['PATCH', '/api/keys/reader'], ['PUT', '/api/settings/chat'],
    ['POST', '/api/fleet/agents'], ['GET', '/api/session-hosts'], ['GET', '/api/groups/g1/deletion-preview'],
    ['DELETE', '/api/groups/g1'], ['GET', '/api/conversations/drafts/d1/deletion'], ['GET', '/fleet/Remote/api/groups'],
    ['POST', '/api/instance/actions/unknown-future-action'], ['GET', '/api/schedules/task-1/runs'],
    ['POST', '/api/schedules/task-1/actions/run-now']]) {
    assert.deepEqual(await send(method, path), { status: 403, required: 'admin' }, `${method} ${path}`);
  }
});

test('a scope change applies to an existing token at its next request and to long-lived access at its next check', async t => {
  const { gate, key, send, headers } = gateWithKey(t, 'groups.read,terminal.control');
  const terminal = gate.resolveAuthContext({ headers });
  assert.equal(terminal.scope, 'groups.read,terminal.control');
  assert.ok(gate.revalidateAuthContext(terminal, { permission: 'terminal.control' }));
  assert.equal(gate.revalidateAuthContext(terminal), null, 'without a named permission admin is still required');
  assert.deepEqual(await send('POST', '/api/groups/origin/actions/restart'), { status: 403, required: 'groups.control' });

  key.scope = 'groups.control,groups.read';
  assert.deepEqual(await send('POST', '/api/groups/origin/actions/restart'), { status: 'pass' });
  assert.equal(gate.revalidateAuthContext(terminal, { permission: 'terminal.control' }), null);

  key.scope = 'admin';
  assert.equal(gate.revalidateAuthContext(terminal, { permission: 'terminal.control' }).scope, 'admin');
});
