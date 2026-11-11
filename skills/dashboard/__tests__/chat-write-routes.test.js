import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../src/lib/store.js';
import { AuthGate } from '../src/lib/auth.js';
import { ChatConversations } from '../src/lib/chat/conversations.js';
import { handleChatConversations } from '../src/lib/chat/write-routes.js';
import { sendJson } from '../src/lib/http.js';
import { chatHttpFixture } from './helpers/chat-http.js';

// Actual route/AuthGate/Store on an ephemeral loopback server and private DB.
// The sender spy isolates HTTP authorization and body routing from Core receive,
// which chat-conversations.test.js exercises with two real private databases.
// Run for write-route/auth/body/rename changes; unrelated UI may skip. Teardown
// owns the listener, auth timer and DB; no Core, tmux, PM2 or external network.
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-write-http-'));
  const store = new Store(path.join(root, 'dashboard.db'));
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const cookie = 'private-route-cookie';
  const tokens = { read: `zylos_st_${'a'.repeat(64)}`, admin: `zylos_st_${'b'.repeat(64)}` };
  const authStore = {
    getSession: hash => hash === digest(cookie) ? { created_at: Date.now(), last_activity_at: Date.now() } : null,
    touchSession() {}, deleteSession() {}, cleanupSessions() {}, cleanupExpiredApiSessions() {},
    getApiSession(hash) {
      const scope = Object.keys(tokens).find(scope => hash === digest(tokens[scope]));
      return scope ? { api_key_id: scope, scope, expires_at: Date.now() + 60000 } : null;
    },
  };
  const config = { auth: { enabled: true, password: 'scrypt:fixture' }, chat: { allowRemote: false } };
  const auth = new AuthGate(config, authStore);
  const conversations = new ChatConversations({ store });
  let mode = 'multi', calls = 0;
  const sender = {
    async resolve(id) {
      if (!id.startsWith('d:')) throw Object.assign(new Error('chat_conversation_forbidden'), { statusCode: 403 });
      return conversations.get(id.slice(2));
    },
    async reconcile(id) { const row = await this.resolve(id); return { localId: row.localId, stored: false }; },
    async send(id, body, { authorize }) {
      const row = await this.resolve(id);
      const denied = authorize({ ...row, namespace: 'owned' });
      if (denied) throw Object.assign(new Error(denied.error), { code: denied.error, statusCode: denied.status });
      if (body.content === 'conflicting') throw Object.assign(new Error('chat_conversation_started'), {
        code: 'chat_conversation_started', statusCode: 409, conversationId: 'g:6F776E65643A6C6F63616C', preserveInput: true,
      });
      calls++;
      return { localId: row.localId, content: body.content,
        ...(Object.hasOwn(body, 'quote') ? { quote: body.quote } : {}) };
    },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (await auth.handle(req, res, url)) return;
    if (await handleChatConversations(req, res, url, { auth, config, conversations, sender, readMode: () => mode })) return;
    sendJson(res, 404, { error: 'not_found' });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    clearInterval(auth._cleanupTimer); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function request(pathname, { method = 'POST', body = {}, identity = 'cookie', origin = base } = {}) {
    const headers = { 'content-type': 'application/json' };
    if (origin !== null) headers.origin = origin;
    if (identity === 'cookie') headers.cookie = `__Secure-zylos_dashboard_session=${cookie}`;
    else if (tokens[identity]) headers.authorization = `Bearer ${tokens[identity]}`;
    const response = await fetch(base + pathname, { method, headers,
      ...(['GET', 'HEAD'].includes(method) ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }
  return { request, conversations, config, calls: () => calls, setMode: value => { mode = value; } };
}

test('write routes deny read keys, closed remote access, cross-origin and single mode before writes', async t => {
  const f = await fixture(t);
  for (const options of [{ identity: 'read' }, { identity: 'admin' }, { origin: 'https://outside.invalid' }]) {
    assert.equal((await f.request('/api/chat/drafts', options)).status, 403);
  }
  f.setMode('single');
  assert.equal((await f.request('/api/chat/drafts')).status, 403);
  assert.equal(f.conversations.db.prepare('SELECT COUNT(*) n FROM chat_conversations').get().n, 0);
  assert.equal(f.calls(), 0);
});

test('draft create, open and rename use the registered record and reject caller routing fields', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/chat/drafts', { body: { displayName: 'First name' } });
  assert.equal(created.status, 201);
  const row = created.body.conversation, route = `/api/chat/conversations/${encodeURIComponent(row.id)}`;
  assert.equal((await f.request(route, { method: 'GET' })).body.conversation.localId, row.localId);
  assert.equal((await f.request(route, { method: 'PATCH', body: { displayName: 'Renamed' } })).body.conversation.displayName, 'Renamed');
  for (const field of ['channel', 'endpoint', 'endpoint_id', 'group', 'groupName', 'targetGroup', 'namespace', 'localId']) {
    assert.equal((await f.request(route + '/send', { body: { content: 'hello', [field]: 'forged' } })).status, 400);
  }
  assert.equal((await f.request(route + '/send', { body: { content: 'hello', retry: 'true' } })).status, 400);
  assert.equal(f.calls(), 0);
  assert.equal((await f.request(route + '/send', { body: { content: 'hello' } })).status, 200);
  assert.equal(f.calls(), 1);
  const conflict = await f.request(route + '/send', { body: { content: 'conflicting' } });
  assert.equal(conflict.status, 409);
  assert.deepEqual(conflict.body, { error: 'chat_conversation_started', conversationId: 'g:6F776E65643A6C6F63616C', preserveInput: true });
  assert.equal((await f.request(route, { method: 'DELETE' })).status, 405);
  assert.equal((await f.request(route + '?channel=telegram', { method: 'GET' })).status, 400);
  assert.equal((await f.request('/api/chat/conversations/%ZZ', { method: 'GET' })).status, 400);
});

test('remote admin writes require the data instance switch and stored ownership', async t => {
  const f = await fixture(t); f.config.chat.allowRemote = true;
  const created = await f.request('/api/chat/drafts', { identity: 'admin' });
  assert.equal(created.status, 201);
  const route = `/api/chat/conversations/${encodeURIComponent(created.body.conversation.id)}`;
  assert.equal((await f.request(route, { method: 'PATCH', identity: 'read', body: { displayName: 'bad' } })).status, 403);
  assert.equal((await f.request(route, { method: 'PATCH', identity: 'admin', body: { displayName: 'remote name' } })).status, 200);
  assert.equal((await f.request('/api/chat/conversations/g:74673A6F74686572/send', { body: { content: 'wrong group' } })).status, 403);
  assert.equal(f.calls(), 0);
});

test('write routes forward the optional quote field to the sender', async t => {
  const f = await fixture(t);
  const created = await f.request('/api/chat/drafts');
  const route = `/api/chat/conversations/${encodeURIComponent(created.body.conversation.id)}/send`;
  const response = await f.request(route, { body: { content: 'quoted body', quote: 42 } });
  assert.equal(response.status, 200);
  assert.equal(response.body.quote, 42);
  assert.equal(f.calls(), 1);
});

test('fleet proxy allowlists draft rename and still checks both admin and remote switch', async t => {
  const f = await chatHttpFixture(t, { chat: { allowRemote: true } });
  const route = { method: 'PATCH', path: '/api/chat/conversations/d%3Alocal-chat' };
  // This helper's receiver does not implement registration: its access gate is
  // sufficient to prove the new allowlist reaches the protected data instance.
  assert.equal((await f.request(route, { fleet: true })).status, 200);
  const before = f.counts.upstream;
  assert.equal((await f.request(route, { fleet: true, identity: 'read' })).status, 403);
  assert.equal(f.counts.upstream, before);
  f.config.chat.allowRemote = false;
  assert.equal((await f.request(route, { fleet: true })).status, 403);
});
