import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { AuthGate, hashPassword } from '../src/lib/auth.js';
import { createDraftStore, createDraftAuth, consumeDraftReset, draftAuthRoot, draftInstance, draftResetCookieName, MAX_DRAFT_BYTES } from '../public/js/wb/chat-drafts.js';

class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(index) { return [...this.data.keys()][index] ?? null; }
  getItem(key) { return this.data.get(key) ?? null; }
  setItem(key, value) { this.data.set(key, value); }
  removeItem(key) { this.data.delete(key); }
}
const scope = extra => ({ authRoot: 'https://example.test/dashboard', instance: 'https://example.test/dashboard',
  conversationId: 'one', messageId: 'message', blockId: 'form', schemaVersion: 2, ...extra });

// Pure browser store/auth adapters: no HTTP listener, database, subprocess or live paths.
test('form draft identity includes target, conversation, immutable block context and tab', () => {
  const storage = new Storage(), store = createDraftStore({ storage });
  const identities = [scope(), ...['authRoot', 'instance', 'conversationId', 'messageId', 'blockId', 'schemaVersion'].map(key => scope({ [key]: `other-${key}` }))];
  identities.forEach((identity, index) => assert.equal(store.save(identity, { name: `value-${index}` }).saved, true));
  identities.forEach((identity, index) => assert.equal(store.load(identity).name, `value-${index}`));
  assert.equal(createDraftStore({ storage: new Storage() }).load(scope()), null);
  assert.equal(store.load(scope({ blockId: 'unknown' })), null);
});

test('draft limit evicts least recently edited across all instances and reads do not renew', () => {
  const storage = new Storage(); let time = 0;
  const store = createDraftStore({ storage, now: () => ++time });
  storage.setItem('foreign', 'keep');
  for (let i = 0; i < 64; i += 1) store.save(scope({ conversationId: String(i), instance: String(i % 2) }), { value: i });
  assert.equal(store.load(scope({ conversationId: '0', instance: '0' })).value, 0);
  store.save(scope({ conversationId: '64' }), { value: 64 });
  assert.equal(store.load(scope({ conversationId: '0', instance: '0' })), null);
  assert.equal(storage.length, 65);
  store.save(scope({ conversationId: '1', instance: '1' }), { value: 'edited' });
  store.save(scope({ conversationId: '65' }), { value: 65 });
  assert.equal(store.load(scope({ conversationId: '2', instance: '0' })), null);
  assert.equal(store.load(scope({ conversationId: '1', instance: '1' })).value, 'edited');
  assert.equal(storage.getItem('foreign'), 'keep');
});

test('serialized UTF8 exact byte limit is accepted and oversize retains stored drafts', () => {
  const storage = new Storage(), store = createDraftStore({ storage, now: () => 1 });
  store.save(scope(), { value: '' });
  const key = storage.key(0), overhead = new TextEncoder().encode(storage.getItem(key)).byteLength;
  const room = MAX_DRAFT_BYTES - overhead;
  const text = '汉'.repeat(Math.floor(room / 3)) + 'a'.repeat(room % 3);
  assert.equal(store.save(scope(), { value: text }).saved, true);
  assert.equal(new TextEncoder().encode(storage.getItem(key)).byteLength, MAX_DRAFT_BYTES);
  assert.deepEqual(store.save(scope(), { value: text + 'a' }), { saved: false, reason: 'oversize' });
  assert.equal(store.load(scope()).value, text);
});

test('storage access/write failure reports unsaved without mutating caller memory or evicting', () => {
  const storage = new Storage(), store = createDraftStore({ storage });
  store.save(scope(), { value: 'previous' });
  const original = storage.setItem;
  storage.setItem = () => { throw Error('quota'); };
  const memory = { name: 'current', hidden: 'retained' };
  assert.deepEqual(store.save(scope(), memory), { saved: false, reason: 'storage' });
  assert.deepEqual(memory, { name: 'current', hidden: 'retained' });
  assert.equal(store.load(scope()).value, 'previous');
  storage.setItem = original;
  assert.equal(store.save(scope(), memory).saved, true);
  const unavailable = createDraftStore({ storage: () => { throw Error('denied'); } });
  assert.equal(unavailable.load(scope()), null);
  assert.equal(unavailable.save(scope(), memory).saved, false);
});

test('a failed sixty-fifth draft write preserves all sixty-four stored edits without eviction', () => {
  const storage = new Storage(), store = createDraftStore({ storage });
  for (let index = 0; index < 64; index += 1) assert.equal(store.save(scope({ conversationId: String(index) }), { value: index }).saved, true);
  let removed = 0;
  storage.removeItem = () => { removed++; };
  storage.setItem = () => { throw Error('quota'); };
  const memory = { value: 'unsaved sixty-fifth', hidden: 'retain in memory' };
  assert.deepEqual(store.save(scope({ conversationId: '65' }), memory), { saved: false, reason: 'storage' });
  assert.equal(storage.length, 64);
  assert.equal(removed, 0, 'write failure must happen before any eviction');
  for (let index = 0; index < 64; index += 1) assert.equal(store.load(scope({ conversationId: String(index) })).value, index);
  assert.equal(memory.hidden, 'retain in memory');
});

test('malformed draft data supplies no values and auth cleanup does not touch foreign keys', () => {
  const storage = new Storage(), store = createDraftStore({ storage });
  store.save(scope(), { value: 'ok' });
  storage.setItem(storage.key(0), '{bad');
  assert.equal(store.load(scope()), null);
  store.clearAuthRoot(scope().authRoot);
  assert.equal(storage.length, 0, 'auth cleanup removes malformed records using their identity key');
  store.save(scope(), { value: 'new' });
  storage.setItem('other-form', 'foreign');
  store.remove(scope());
  assert.equal(store.load(scope()), null);
  assert.equal(storage.getItem('other-form'), 'foreign');
});

test('auth root and target routing are canonical across standalone fleet documents', () => {
  const location = { origin: 'https://example.test' };
  assert.equal(draftAuthRoot(location, '/dashboard/fleet/A%20B'), 'https://example.test/dashboard');
  assert.equal(draftInstance(draftAuthRoot(location, '/dashboard'), 'A B'), 'https://example.test/dashboard/fleet/A%20B');
  assert.equal(draftAuthRoot(location, ''), 'https://example.test');
});

test('late target A401 clears A and its hidden-memory callback while B stays intact', async () => {
  const storage = new Storage(), store = createDraftStore({ storage });
  const root = scope().authRoot, a = scope({ instance: draftInstance(root, 'A') }), b = scope({ instance: draftInstance(root, 'B') });
  store.save(a, { hidden: 'A' }); store.save(b, { hidden: 'B' });
  let respond; const cleared = [];
  const auth = createDraftAuth({ authRoot: root, store, fetch: () => new Promise(resolve => { respond = resolve; }), onClear: value => cleared.push(value) });
  const pending = auth.fetch('/dashboard/fleet/A/api/chat/questions');
  respond({ status: 401 }); await pending;
  assert.equal(store.load(a), null);
  assert.equal(store.load(b).hidden, 'B');
  assert.deepEqual(cleared, [{ authRoot: root, instance: a.instance }]);
});

test('401 cleanup ignores foreign roots and logout clears all authorized targets before a failed request', async () => {
  const storage = new Storage(), store = createDraftStore({ storage });
  const root = scope().authRoot, other = scope({ authRoot: 'https://example.test/other' });
  store.save(scope(), { value: 1 }); store.save(scope({ instance: draftInstance(root, 'A') }), { value: 2 }); store.save(other, { value: 3 });
  const cleared = [];
  const auth = createDraftAuth({ authRoot: root, store, fetch: async () => ({ status: 401 }), onClear: value => cleared.push(value) });
  await auth.fetch('/other/api/state'); await auth.fetch('https://foreign.test/dashboard/api/state');
  assert.equal(cleared.length, 0);
  auth.clear();
  assert.equal(store.load(scope()), null);
  assert.equal(store.load(scope({ instance: draftInstance(root, 'A') })), null);
  assert.equal(store.load(other).value, 3);
  const failing = createDraftAuth({ authRoot: root, store, fetch: async () => { assert.equal(store.load(scope()), null); throw Error('offline'); } });
  await assert.rejects(failing.fetch('/dashboard/logout'), /offline/);
});

function cookieDocument(cookie) {
  return { get cookie() { return cookie; }, set cookie(value) { cookie = value.includes('Max-Age=0') ? '' : value; } };
}
test('successful login marker clears root before restore, including fleet route and other-root isolation', () => {
  const storage = new Storage(), store = createDraftStore({ storage }), root = scope().authRoot;
  store.save(scope(), { value: 'local' });
  store.save(scope({ instance: draftInstance(root, 'A') }), { hidden: 'remote' });
  const other = scope({ authRoot: 'https://example.test/elsewhere' }); store.save(other, { value: 'keep' });
  const document = cookieDocument(`${draftResetCookieName('/dashboard')}=1`);
  assert.equal(consumeDraftReset({ document, location: { origin: 'https://example.test' }, base: '/dashboard/fleet/A', store }), true);
  assert.equal(store.load(scope()), null);
  assert.equal(store.load(scope({ instance: draftInstance(root, 'A') })), null);
  assert.equal(store.load(other).value, 'keep');
  assert.equal(document.cookie, '');
});

test('failed reset storage access retains marker for the next restore gate', () => {
  const document = cookieDocument(`${draftResetCookieName('/dashboard')}=1`);
  consumeDraftReset({ document, location: { origin: 'https://example.test' }, base: '/dashboard', store: { clearAuthRoot: () => false } });
  assert.match(document.cookie, /=1/);
});

function response() {
  const headers = new Map();
  return { headers, getHeader: name => headers.get(name), setHeader: (name, value) => headers.set(name, value),
    writeHead(status, values) { this.status = status; Object.entries(values ?? {}).forEach(([name, value]) => headers.set(name, value)); },
    end(body) { this.body = body; } };
}
test('native login success preserves redirect/session cookie and marks draft reset; wrong password does not', async () => {
  const gate = new AuthGate({ auth: { enabled: true, password: hashPassword('correct') } });
  async function login(password) {
    const req = Readable.from([Buffer.from(new URLSearchParams({ password, next: '/dashboard/?tab=chat' }).toString())]);
    req.method = 'POST'; req.headers = {}; req.socket = { remoteAddress: '127.0.0.44' };
    const res = response();
    await gate.handleLogin(req, res, '/dashboard', new URL('https://example.test/dashboard/login'));
    return res;
  }
  const failed = await login('incorrect');
  assert.equal(failed.status, 200);
  assert.equal(failed.headers.has('Set-Cookie'), false);
  const success = await login('correct');
  assert.equal(success.status, 302);
  assert.equal(success.headers.get('location'), '/dashboard/?tab=chat');
  const cookies = success.headers.get('Set-Cookie');
  assert.match(cookies[0], /^__Secure-zylos_dashboard_session=.+; HttpOnly; Secure; SameSite=Strict; Path=\/dashboard; Max-Age=86400$/);
  assert.equal(cookies[1], `${draftResetCookieName('/dashboard')}=1; Secure; SameSite=Strict; Path=/dashboard`);
});
