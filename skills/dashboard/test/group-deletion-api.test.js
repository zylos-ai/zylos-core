import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { AuthGate } from '../src/lib/auth.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';
import { handleChatHistory } from '../src/lib/chat/history-routes.js';
import { createGroupDeletionBridge, createGroupDeletionRoutes } from '../src/lib/workbench/group-deletion.js';

const cookie = 'deletion-private-cookie', api = `zylos_st_${'a'.repeat(64)}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const boundary = { cutoffId: 4, generationId: null, targetKey: JSON.stringify(['group', 'dashboard:example']) };
const owner = { cookie: `__Secure-zylos_dashboard_session=${cookie}`, 'sec-fetch-site': 'same-origin' };
function fixture(t) {
  const config = { zylosDir: process.env.ZYLOS_DIR, auth: { enabled: true, password: 'scrypt:configured' } };
  const now = Date.now();
  const auth = new AuthGate(config, {
    getSession: hash => hash === sha(cookie) ? { created_at: now, last_activity_at: now } : null,
    touchSession() {}, deleteSession() {}, cleanupSessions() {}, cleanupExpiredApiSessions() {},
    getApiSession: hash => hash === sha(api) ? { api_key_id: 'private', scope: 'admin', expires_at: now + 60000 } : null,
  });
  t.after(() => clearInterval(auth._cleanupTimer));
  const calls = [];
  const handler = createGroupDeletionRoutes({ config, auth,
    conversations: { get: localId => ({ localId, sessionGroup: localId === 'bound' ? 'dashboard:bound' : null }) },
    core: async (target, options) => { calls.push({ target, options }); return { ok: true, operationId: 'private-operation', messages: 4, attachments: 2 }; },
  });
  return { config, auth, calls, handler };
}
async function call(handler, path, { method = 'GET', headers = owner, body } = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, headers });
  const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  assert.equal(await handler(req, res, new URL(path, 'http://fixture')), true);
  return res;
}

test('deletion preview admits only password owner cookies including against admin API keys', async t => {
  const f = fixture(t), path = '/api/workbench/groups/dashboard%3Aexample/deletion';
  for (const headers of [{}, { authorization: `Bearer ${api}` }]) {
    assert.equal((await call(f.handler, path, { headers })).status, 403);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await call(f.handler, path)).status, 200);
  assert.deepEqual(f.calls[0].target, { sessionGroup: 'dashboard:example' });
  assert.equal(f.calls[0].options.preview, true);
  assert.equal(f.calls[0].options.actor, `dashboard:${sha(cookie)}`);
  f.config.auth.password = null;
  assert.equal((await call(f.handler, path)).status, 403);
  f.config.auth.password = 'scrypt:configured'; f.config.auth.enabled = false;
  assert.equal((await call(f.handler, path)).status, 403);
});

test('deletion requires same origin and explicit confirmation bound to an operation', async t => {
  const f = fixture(t), path = '/api/workbench/groups/dashboard%3Aexample';
  const body = { confirmed: true, operationId: 'private-operation', ...boundary };
  assert.equal((await call(f.handler, path, { method: 'DELETE', body, headers: { cookie: owner.cookie, origin: 'https://foreign.invalid', host: 'local.invalid' } })).status, 403);
  for (const invalid of [{}, { operationId: 'private-operation' }, { confirmed: true }, { ...body, actor: 'somebody-else' }, { ...body, operationId: '' }]) {
    assert.equal((await call(f.handler, path, { method: 'DELETE', body: invalid })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await call(f.handler, path, { method: 'DELETE', body })).status, 200);
  assert.equal(f.calls[0].options.operationId, body.operationId);
  assert.equal(f.calls[0].options.cutoffId, boundary.cutoffId);
  assert.equal(f.calls[0].options.generationId, null);
  assert.equal(f.calls[0].options.targetKey, boundary.targetKey);
});

test('missing or malformed preview boundaries never reach the deletion child', async t => {
  const f = fixture(t), path = '/api/workbench/groups/dashboard%3Aexample';
  const body = { confirmed: true, operationId: 'private-operation', ...boundary };
  for (const change of [{ cutoffId: undefined }, { cutoffId: -1 }, { cutoffId: 1.1 },
    { generationId: undefined }, { generationId: 0 }, { targetKey: undefined }, { targetKey: '' }]) {
    assert.equal((await call(f.handler, path, { method: 'DELETE', body: { ...body, ...change } })).status, 400);
  }
  assert.equal(f.calls.length, 0);
});

test('Origin and malformed group targets never reach Core', async t => {
  const f = fixture(t);
  assert.equal((await call(f.handler, '/api/workbench/groups/origin/deletion')).status, 403);
  assert.equal((await call(f.handler, '/api/workbench/groups/%ZZ/deletion')).status, 400);
  assert.equal((await call(f.handler, '/api/workbench/groups/bad%2Fgroup/deletion')).status, 400);
  assert.equal(f.calls.length, 0);
});

test('draft targets let Core distinguish uploaded drafts from actual groups', async t => {
  const f = fixture(t);
  await call(f.handler, '/api/chat/drafts/empty/deletion');
  await call(f.handler, '/api/chat/drafts/bound/deletion');
  assert.deepEqual(f.calls.map(x => x.target), [{ draftLocalId: 'empty' }, { draftLocalId: 'bound' }]);
});

test('pending deletion and Core conflicts preserve their result envelope', async t => {
  const f = fixture(t); let value = { ok: true, pending: true, operationId: 'same-operation' };
  const handler = createGroupDeletionRoutes({ ...f, core: async () => value });
  let res = await call(handler, '/api/workbench/groups/dashboard%3Aexample/deletion');
  assert.equal(res.status, 202); assert.equal(res.body.operationId, 'same-operation');
  value = { ok: false, error: { code: 'FENCE_MISMATCH' } };
  res = await call(handler, '/api/workbench/groups/dashboard%3Aexample/deletion');
  assert.equal(res.status, 409); assert.deepEqual(res.body, value);
  value = { ok: false, error: { code: 'TRANSITION_OPEN' } };
  assert.equal((await call(handler, '/api/workbench/groups/dashboard%3Aexample/deletion')).status, 409);
  value = { ok: false, error: { code: 'transition_open' } };
  assert.equal((await call(handler, '/api/workbench/groups/dashboard%3Aexample/deletion')).status, 409);
});

test('missing draft registration still reaches Core for an idempotent completed retry', async t => {
  const f = fixture(t);
  const handler = createGroupDeletionRoutes({ ...f,
    conversations: { get() { throw Object.assign(new Error('missing'), { code: 'chat_conversation_not_found', status: 404 }); } },
    core: async (target, options) => {
      assert.deepEqual(target, { draftLocalId: 'removed' });
      assert.equal(options.operationId, 'completed-operation');
      return { ok: true, pending: false, operationId: options.operationId };
    },
  });
  const res = await call(handler, '/api/chat/drafts/removed', {
    method: 'DELETE', body: { confirmed: true, operationId: 'completed-operation', ...boundary },
  });
  assert.equal(res.status, 200);
});

test('Core bridge uses the shared child entry with a server actor and no caller group', async () => {
  const seen = [];
  const bridge = createGroupDeletionBridge({ zylosDir: '/private/instance', env: { HOME: '/private/home', ZYLOS_SESSION_GROUP: 'origin' },
    loadCoreModule: async name => { assert.equal(name, 'group-delete.js'); return { groupDeletionCliPath: '/core/group-delete-cli.js' }; },
    execute: async (...args) => { seen.push(args); return { stdout: '{"ok":true,"pending":true,"operationId":"existing"}' }; },
  });
  assert.equal((await bridge({ sessionGroup: 'dashboard:x' }, { actor: 'dashboard:owner', operationId: 'existing', ...boundary })).pending, true);
  assert.deepEqual(seen[0][1], ['/core/group-delete-cli.js', '--group', 'dashboard:x', '--yes', '--json', '--actor', 'dashboard:owner', '--operation-id', 'existing', '--cutoff-id', '4', '--generation-id', 'null', '--target-key', boundary.targetKey]);
  assert.equal(seen[0][2].env.ZYLOS_DIR, '/private/instance');
  assert.equal(Object.hasOwn(seen[0][2].env, 'ZYLOS_SESSION_GROUP'), false);
  await bridge({ draftLocalId: 'draft' }, { actor: 'dashboard:owner', preview: true });
  assert.ok(seen[1][1].includes('--draft-local-id')); assert.ok(seen[1][1].includes('--preview'));
});

test('unknown child outcomes are never turned into successful deletion', async () => {
  const bridge = createGroupDeletionBridge({ zylosDir: '/private/instance',
    loadCoreModule: async () => ({ groupDeletionCliPath: '/core/group-delete-cli.js' }),
    execute: async () => { throw new Error('terminated before a reply'); },
  });
  await assert.rejects(bridge({ sessionGroup: 'dashboard:x' }, { actor: 'owner' }), { code: 'deletion_result_unknown' });
});

test('Fleet never relays group or draft deletion preview and writes', async () => {
  let calls = 0;
  const proxy = new FleetProxy({ config: { fleet: { agents: [] } }, poller: { getSessionToken: async () => 'private' }, fetch: async () => { calls++; throw new Error('must not relay'); } });
  for (const suffix of ['/api/workbench/groups/dashboard%3Ax/deletion', '/api/workbench/groups/dashboard%3Ax', '/api/chat/drafts/x/deletion', '/api/chat/drafts/x']) {
    const req = { method: suffix.endsWith('/deletion') ? 'GET' : 'DELETE', headers: owner, _authContext: { kind: 'cookie', scope: 'admin' } };
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await proxy.proxyApi(req, res, { name: 'remote' }, suffix, '');
    assert.equal(res.status, 403);
  }
  assert.equal(calls, 0);
});

test('conversation list exposes deletion capability only to the local password owner', async t => {
  const f = fixture(t);
  for (const [headers, allowed] of [[owner, true], [{ authorization: `Bearer ${api}` }, false]]) {
    const req = { method: 'GET', headers }, res = { writeHead() {}, end(body) { this.body = JSON.parse(body); } };
    await handleChatHistory(req, res, new URL('http://fixture/api/chat/conversations'), { ...f,
      config: { ...f.config, chat: { allowRemote: true } }, history: { list: () => ({ items: [] }) } });
    assert.equal(res.body.deletionAllowed, allowed);
  }
});


test('unmatched group read routes fall through without deletion authorization or Core calls', async t => {
  const f = fixture(t);
  for (const path of ['/api/workbench/groups/search', '/api/workbench/groups/telegram%3Aexample', '/api/chat/drafts/example']) {
    const req = { method: 'GET', headers: {} };
    const res = { writeHead() { assert.fail('Must leave the response to the existing read route'); } };
    assert.equal(await f.handler(req, res, new URL(path, 'http://fixture')), false);
  }
  assert.equal(f.calls.length, 0);
});

test('Core storage errors preserve their HTTP status through the bridge response envelope', async t => {
  const f = fixture(t);
  for (const status of [404, 503]) {
    const handler = createGroupDeletionRoutes({ ...f, core: async () => ({ ok: false,
      error: { code: status === 404 ? 'chat_conversation_not_found' : 'group_delete_dashboard_unavailable', status } }) });
    const res = await call(handler, '/api/chat/drafts/missing/deletion');
    assert.equal(res.status, status);
  }
});


test('completed Core retention fields pass through the child bridge and DELETE response unchanged', async t => {
  const f = fixture(t);
  for (const retainedMessages of [0, 3]) {
    const receipt = { ok: true, pending: false, operationId: 'completed-operation', retainedMessages,
      groupDataRetained: retainedMessages > 0, counts: { messages: 4, attachments: 0, files: 0 } };
    const bridge = createGroupDeletionBridge({ zylosDir: f.config.zylosDir,
      loadCoreModule: async () => ({ groupDeletionCliPath: '/core/group-delete-cli.js' }),
      execute: async () => ({ stdout: JSON.stringify(receipt) }) });
    const handler = createGroupDeletionRoutes({ ...f, core: bridge });
    const response = await call(handler, '/api/workbench/groups/dashboard%3Aexample', {
      method: 'DELETE', body: { confirmed: true, operationId: 'completed-operation', ...boundary },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, receipt);
  }
});
