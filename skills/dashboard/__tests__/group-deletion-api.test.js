import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { AuthGate } from '../src/lib/auth.js';
import { FleetProxy } from '../src/lib/fleet-proxy.js';

import { createGroupDeletionBridge, createGroupDeletionRoutes } from '../src/lib/workbench/group-deletion.js';

const cookie = 'deletion-private-cookie', api = `zylos_st_${'a'.repeat(64)}`;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const boundary = { cutoffId: 4 };
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
  const f = fixture(t), path = '/api/groups/dashboard%3Aexample/deletion-preview';
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
});

test('deletion requires same origin and explicit confirmation bound to an operation', async t => {
  const f = fixture(t), path = '/api/groups/dashboard%3Aexample';
  const body = { confirmed: true, operationId: 'private-operation', ...boundary };
  assert.equal((await call(f.handler, path, { method: 'DELETE', body, headers: { cookie: owner.cookie, origin: 'https://foreign.invalid', host: 'local.invalid' } })).status, 403);
  for (const invalid of [{}, { operationId: 'private-operation' }, { confirmed: true }, { ...body, actor: 'somebody-else' }, { ...body, operationId: '' }]) {
    assert.equal((await call(f.handler, path, { method: 'DELETE', body: invalid })).status, 400);
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await call(f.handler, path, { method: 'DELETE', body })).status, 200);
  assert.equal(f.calls[0].options.operationId, body.operationId);
  assert.equal(f.calls[0].options.cutoffId, boundary.cutoffId);
  assert.deepEqual(Object.keys(f.calls[0].options).sort(), ['actor', 'cutoffId', 'operationId', 'preview']);
});

test('Origin and malformed group targets never reach Core', async t => {
  const f = fixture(t);
  assert.equal((await call(f.handler, '/api/groups/origin/deletion-preview')).status, 403);
  assert.equal((await call(f.handler, '/api/groups/%ZZ/deletion-preview')).status, 400);
  assert.equal((await call(f.handler, '/api/groups/bad%2Fgroup/deletion-preview')).status, 400);
  const legacyPath = '/api/groups/' + encodeURIComponent('telegram:运维群-测试');
  assert.equal((await call(f.handler, legacyPath + '/deletion-preview')).status, 400);
  assert.equal((await call(f.handler, legacyPath, { method: 'DELETE',
    body: { confirmed: true, operationId: 'private-operation', ...boundary } })).status, 400);
  assert.equal(f.calls.length, 0);
});

test('Core bridge uses the shared child entry with a server actor and no caller group', async () => {
  const seen = [];
  const bridge = createGroupDeletionBridge({ zylosDir: '/private/instance', env: { HOME: '/private/home', ZYLOS_SESSION_GROUP: 'origin' },
    loadCoreModule: async name => { assert.equal(name, 'group-delete.js'); return { groupDeletionCliPath: '/core/group-delete-cli.js' }; },
    execute: async (...args) => { seen.push(args); return { stdout: '{"ok":true,"pending":true,"operationId":"existing"}' }; },
  });
  assert.equal((await bridge({ sessionGroup: 'dashboard:x' }, { actor: 'dashboard:owner', operationId: 'existing', ...boundary })).pending, true);
  assert.deepEqual(seen[0][1], ['/core/group-delete-cli.js', '--group', 'dashboard:x', '--yes', '--json', '--actor', 'dashboard:owner', '--operation-id', 'existing', '--cutoff-id', '4']);
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
  let calls = 0, tokenCalls = 0;
  const proxy = new FleetProxy({ config: { fleet: { agents: [] } }, poller: { getSessionToken: async () => { tokenCalls++; return 'private'; } }, fetch: async () => { calls++; throw new Error('must not relay'); } });
  for (const suffix of ['/api/groups/dashboard%3Ax/deletion-preview', '/api/groups/dashboard%3Ax', '/api/conversations/drafts/x/deletion', '/api/conversations/drafts/x']) {
    const req = { method: (suffix.endsWith('/deletion-preview') || suffix.endsWith('/deletion')) ? 'GET' : 'DELETE', headers: owner, _authContext: { kind: 'cookie', scope: 'admin' } };
    const res = { writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
    await proxy.proxyApi(req, res, { name: 'remote' }, suffix, '');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'remote_deletion_forbidden');
  }
  assert.equal(calls, 0);
  assert.equal(tokenCalls, 0);
});
