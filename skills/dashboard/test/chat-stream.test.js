import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { AuthGate } from '../src/lib/auth.js';
import { SseHub } from '../src/lib/sse.js';
import { ChatChangeObserver } from '../src/lib/chat/change-observer.js';
import { handleChatStream } from '../src/lib/chat/stream.js';

// Handler/auth/transport units: real product modules and fixture-only sessions,
// no DB, HTTP, PM2 or tmux. Official runner owns all environment paths.
class Response extends EventEmitter {
  constructor() { super(); this.frames = []; this.writableLength = 0; this.writableEnded = false; this.slow = false; }
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(frame) { assert.ok(this.frames.length < 100); this.frames.push(String(frame)); return !this.slow; }
  end(body) { if (body) this.frames.push(String(body)); this.writableEnded = true; this.emit('close'); }
  destroy() { this.destroyed = true; this.end(); }
  text() { return this.frames.join(''); }
}
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function fixture(t) {
  let revoked = false, reads = 0, touches = 0, deletes = 0;
  const session = { created_at: Date.now(), last_activity_at: Date.now() };
  const cookie = 'isolated-chat-stream-session';
  const tokens = { read: 'zylos_st_' + 'a'.repeat(64), admin: 'zylos_st_' + 'b'.repeat(64) };
  const store = {
    getSession: hash => !revoked && hash === digest(cookie) ? session : null,
    touchSession(_hash, at) { touches++; session.last_activity_at = at; }, deleteSession() { deletes++; revoked = true; }, cleanupSessions() {}, cleanupExpiredApiSessions() {},
    getApiSession(hash) {
      const scope = Object.keys(tokens).find(key => hash === digest(tokens[key]));
      return !revoked && scope ? { api_key_id: scope, scope, expires_at: Date.now() + 60000 } : null;
    }
  };
  const config = { auth: { enabled: true, password: 'scrypt:fixture' }, chat: { allowRemote: false } };
  const auth = new AuthGate(config, store), hub = new SseHub(10);
  let task;
  const observer = new ChatChangeObserver({ c4Reader: { readVersion: () => ({ generation: 1, version: 1 }) },
    history: { chatChangeSnapshot: () => { reads++; return { highwater: 1, listChanged: false, latestId: 1, delivery: [] }; } },
    setTimeout: fn => { task = fn; return 1; }, clearTimeout: () => { task = null; } });
  t.after(() => { observer.close(); hub.closeAll(); clearInterval(auth._cleanupTimer); });
  const request = (identity = 'cookie', search = '?chat=1&chat_tab=mine', method = 'GET') => {
    const req = { method, headers: identity === 'cookie' ? { cookie: `__Secure-zylos_dashboard_session=${cookie}` }
      : tokens[identity] ? { authorization: `Bearer ${tokens[identity]}` } : {} };
    const res = new Response();
    const handled = handleChatStream(req, res, new URL('/api/stream' + search, 'http://fixture'), { auth, config, hub, observer });
    return { req, res, handled };
  };
  return { request, config, hub, observer, session, touches: () => touches, deletes: () => deletes, reads: () => reads, revoke: () => { revoked = true; }, tick: () => task?.() };
}

test('chat stream uses actual cookie and API chat admission before any snapshot', t => {
  const f = fixture(t);
  for (const allowRemote of [false, true]) {
    f.config.chat.allowRemote = allowRemote;
    for (const identity of ['none', 'read', 'admin', 'cookie']) {
      const before = f.reads(), { res } = f.request(identity);
      const allowed = identity === 'cookie' || identity === 'admin' && allowRemote;
      assert.equal(res.status, allowed ? 200 : 403, identity);
      assert.equal(res.text().includes('chat_ready'), allowed);
      if (!allowed) { assert.equal(f.reads(), before); assert.doesNotMatch(res.text(), /conversationId|chat_ready|chat_messages_changed/); }
      res.end();
    }
  }
  f.config.auth.enabled = false;
  const before = f.reads(), { res } = f.request('cookie');
  assert.equal(res.status, 403); assert.equal(f.reads(), before);
});

test('ordinary streams never opt in and chat events cannot be globally broadcast', t => {
  const f = fixture(t);
  assert.equal(f.request('cookie', '').handled, false);
  const ordinary = new Response(); f.hub.addClient(ordinary);
  const chat = f.request().res;
  const before = ordinary.text();
  f.hub.broadcast('chat_messages_changed', { conversationId: 'forbidden' });
  assert.equal(ordinary.text(), before);
  assert.doesNotMatch(ordinary.text(), /chat_ready|conversationId/);
  f.hub.broadcast('state_change', { state: 'idle' });
  assert.match(ordinary.text(), /state_change/); assert.match(chat.text(), /state_change/);
  assert.match(chat.text(), /chat_ready/);
  assert.doesNotMatch(chat.text(), /content|preview|attachment|token|password/);
});

for (const identity of ['cookie', 'admin']) test(`${identity} revocation stops a subscribed chat without a database commit`, t => {
  const f = fixture(t); f.config.chat.allowRemote = true;
  const { res } = f.request(identity); assert.match(res.text(), /chat_ready/);
  const prior = res.text(); f.revoke(); f.tick();
  assert.equal(res.writableEnded, true); assert.equal(f.observer.subscriptions.size, 0);
  assert.equal(res.text(), prior);
});

test('keepalive rechecks live chat policy and releases observer membership', async t => {
  const f = fixture(t); f.config.chat.allowRemote = true;
  const { res } = f.request('admin');
  f.config.chat.allowRemote = false;
  const deadline = Date.now() + 500;
  while (!res.writableEnded && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(res.writableEnded, true); assert.equal(f.observer.subscriptions.size, 0);
  assert.equal(f.hub.keepaliveTimer, null);
  assert.match(res.text(), /auth_expired/);
});

test('invalid chat query and methods are rejected before subscription', t => {
  const f = fixture(t);
  for (const query of ['?chat=0', '?chat=1&chat=1', '?chat=1&chat_tab=other', '?chat=1&chat_ids=1', '?chat=1&chat_conversation=g:AA&chat_ids=1', '?chat=1&chat_conversation=d:1']) {
    const before = f.reads(); assert.equal(f.request('cookie', query).res.status, 400); assert.equal(f.reads(), before);
  }
  assert.equal(f.request('cookie', '?chat=1', 'POST').res.status, 405);
});

test('a slow or throwing client is removed once and cannot retain a pending event queue', t => {
  const f = fixture(t), res = new Response(); let closed = 0;
  const client = f.hub.addClient(res, () => true, { onClose: () => closed++ });
  res.slow = true;
  assert.equal(f.hub.sendTo(client, 'chat_ready', { version: 1 }), false);
  assert.equal(res.destroyed, true); assert.equal(f.hub.clients.size, 0); assert.equal(closed, 1);
  assert.equal(f.hub.sendTo(client, 'chat_ready', {}), false);
  f.hub.closeAll(); assert.equal(closed, 1);
  const throwing = new Response(), second = f.hub.addClient(throwing, () => true, { onClose: () => closed++ });
  throwing.write = () => { throw Error('fixture write failed'); };
  assert.equal(f.hub.sendTo(second, 'state_change', {}), false);
  assert.equal(closed, 2); assert.equal(f.hub.clients.size, 0);
});

test('chat sampling emission and keepalive revalidate cookies without extending idle expiry', { timeout: 2000 }, async t => {
  const f = fixture(t), { res } = f.request();
  const touches = f.touches(), lastActivity = f.session.last_activity_at;
  assert.equal(touches, 1, 'initial HTTP admission remains activity');
  const client = [...f.hub.clients][0];
  for (let i = 0; i < 10; i++) { f.tick(); f.hub.sendTo(client, 'chat_ready', { version: 1 }); }
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.touches(), touches, 'sampling, sending and keepalive never touch the session');
  assert.equal(f.session.last_activity_at, lastActivity);
  f.session.last_activity_at = Date.now() - 3_600_001;
  f.tick();
  assert.equal(res.writableEnded, true, 'open stream cannot keep an idle cookie valid');
  assert.equal(f.deletes(), 0, 'readonly expiry check does not write a deletion');
  assert.equal(f.observer.subscriptions.size, 0); assert.equal(f.hub.chatClients.size, 0);
});

test('chat connection caps reject before headers and release capacity on close', t => {
  const f = fixture(t); f.config.chat.allowRemote = true;
  assert.equal(f.hub.maxChatClients, 100); assert.equal(f.hub.maxChatClientsPerPrincipal, 20);
  f.hub.maxChatClients = 2; f.hub.maxChatClientsPerPrincipal = 1;
  const cookie = f.request().res, before = f.reads();
  const duplicate = f.request().res;
  assert.equal(duplicate.status, 429); assert.match(duplicate.text(), /chat_connection_limit/);
  assert.doesNotMatch(duplicate.headers['content-type'], /event-stream/);
  assert.equal(f.reads(), before); assert.equal(f.observer.subscriptions.size, 1);
  const admin = f.request('admin').res;
  assert.equal(admin.status, 200); assert.equal(f.hub.clients.size, 2);
  const ordinary = new Response(); f.hub.addClient(ordinary);
  assert.equal(ordinary.status, 200, 'ordinary streams do not consume chat admission');
  cookie.end(); assert.equal(f.observer.subscriptions.size, 1);
  const replacement = f.request().res;
  assert.equal(replacement.status, 200); assert.equal(f.observer.subscriptions.size, 2);
  admin.end(); replacement.end();
  assert.equal(f.hub.chatClients.size, 0); assert.equal(f.observer.subscriptions.size, 0);
});

test('the instance chat cap bounds different principals before snapshot work', t => {
  const f = fixture(t); f.config.chat.allowRemote = true;
  f.hub.maxChatClients = 1; f.hub.maxChatClientsPerPrincipal = 2;
  const first = f.request().res, reads = f.reads();
  assert.equal(f.request('admin').res.status, 429);
  assert.equal(f.reads(), reads); assert.equal(f.hub.clients.size, 1);
  first.end(); assert.equal(f.request('admin').res.status, 200);
});
