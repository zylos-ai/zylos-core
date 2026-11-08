import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { createConversationPush, normalizeChatSubscription } from '../public/js/wb/conversation-push.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { createConversationState } = await import('../public/js/wb/conversation-state.js');
// Pure real controller/transport policy: fake clock and request adapters only.
// Official runner owns HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; DB/HTTP/PM2/tmux unused.
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(process.env[key].startsWith(runnerRoot + path.sep), key);
console.info('chat push controller isolation', JSON.stringify(Object.fromEntries(['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR'].map(key => [key, process.env[key]]))), 'no DB/HTTP/PM2/tmux');
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function clock() {
  let now = 1000, serial = 0;
  const jobs = new Map();
  return {
    now: () => now,
    setTimeout(fn, ms) { const id = ++serial; jobs.set(id, { fn, at: now + ms }); return id; },
    clearTimeout(id) { jobs.delete(id); },
    count: () => jobs.size,
    async advance(ms) {
      const target = now + ms;
      for (let steps = 0; ; steps++) {
        assert.ok(steps < 1000, 'bounded fake-clock callbacks');
        const entry = [...jobs].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!entry) break;
        now = entry[1].at; jobs.delete(entry[0]); entry[1].fn(); await flush();
      }
      now = target; await flush();
    }
  };
}
function fixture(t, override = () => undefined) {
  const timer = clock(), calls = [], listeners = new Set();
  const document = { hidden: false, visibilityState: 'visible', addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  let identity = 'local';
  const state = createConversationState({ ...timer, document, identity: () => identity, request: async (url, options) => {
    const u = new URL(url, 'http://fixture');
    assert.ok(calls.length < 250, 'bounded request log'); calls.push({ url, u, options, at: timer.now() });
    const result = override(u, options, timer.now()); if (result !== undefined) return result;
    if (url === '/api/session-mode') return { data: { sessionMode: 'multi' } };
    if (u.pathname === '/api/chat/conversations') return { items: [{ id: 'g:AA' }], nextCursor: null };
    if (u.pathname.endsWith('/messages')) return { items: u.searchParams.get('direction') === 'before' ? [{ id: 1, direction: 'in', content: 'hello', status: 'pending' }] : [], afterCursor: 'cursor', nextCursor: null };
    if (u.pathname.endsWith('/questions') || u.pathname.endsWith('/status')) return { items: [], nextCursor: null };
    if (u.pathname.endsWith('/send')) return { stored: true, conversationId: 'g:AA', deliveryState: 'pending' };
    return { conversation: { id: 'g:AA', state: 'active' }, conversationId: 'g:AA', stored: true };
  } });
  t.after(() => { state.destroy(); assert.equal(timer.count(), 0); });
  return {
    state, timer, calls,
    reads: () => calls.filter(call => call.u.pathname.endsWith('/messages')),
    setIdentity: value => { identity = value; },
    async open() { await state.open(); await state.select('g:AA'); },
    async visible(value) { document.hidden = !value; document.visibilityState = value ? 'visible' : 'hidden'; for (const fn of listeners) fn(); await flush(); },
    event(name, extra = {}, subscription = state.streamSubscription()) { state.streamEvent(name, { version: 1, ...subscription, ...extra }, subscription); return flush(); }
  };
}

test('stream readiness immediately fetches truth and uses a thirty second fallback without trusting event state', async t => {
  const f = fixture(t); await f.open();
  const before = f.reads().length;
  await f.event('chat_ready', { status: 'delivered', content: 'untrusted' });
  assert.equal(f.state.snapshot().streamState, 'live');
  assert.equal(f.reads().length, before + 1);
  assert.equal(f.state.snapshot().messages[0].status, 'pending');
  assert.equal(f.state.snapshot().messages[0].content, 'hello');
  const live = f.reads().length;
  await f.timer.advance(29999); assert.equal(f.reads().length, live);
  await f.timer.advance(1); assert.equal(f.reads().length, live + 1);
});

test('old streams without ready retain five second polling after the bounded capability wait', async t => {
  const f = fixture(t); await f.open();
  f.state.streamStatus('connecting');
  await f.timer.advance(2999); assert.equal(f.state.snapshot().streamState, 'connecting');
  await f.timer.advance(1); assert.equal(f.state.snapshot().streamState, 'polling');
  const before = f.reads().length;
  await f.timer.advance(1999); assert.equal(f.reads().length, before);
  await f.timer.advance(1); assert.equal(f.reads().length, before + 1);
  await f.timer.advance(10000); assert.equal(f.reads().length, before + 3);
});

test('a disconnected stream restores the original accelerated polling interval', async t => {
  const f = fixture(t); await f.open(); f.state.setInput('send once'); await f.state.send();
  await f.event('chat_ready'); f.state.streamStatus('disconnected');
  const before = f.reads().length;
  await f.timer.advance(1999); assert.equal(f.reads().length, before);
  await f.timer.advance(1); assert.equal(f.reads().length, before + 1);
  assert.equal(f.calls.filter(call => call.u.pathname.endsWith('/send')).length, 1);
});

test('hidden dirty hints cause no automatic reads and coalesce on visible restoration', async t => {
  const f = fixture(t); await f.open(); f.state.setInput('keep this input');
  const forms = f.state.snapshot().questionForms; forms.set('1:q', { values: { text: 'keep form' } });
  await f.event('chat_ready'); await f.visible(false);
  const before = f.calls.length;
  await f.event('chat_messages_changed'); await f.event('chat_delivery_changed');
  await f.timer.advance(60000); assert.equal(f.calls.length, before);
  await f.visible(true);
  assert.equal(f.reads().filter(call => call.at === f.timer.now()).length, 1);
  assert.equal(f.state.snapshot().input, 'keep this input');
  assert.equal(f.state.snapshot().questionForms, forms);
  assert.equal(forms.get('1:q').values.text, 'keep form');
});

test('ready initializes a missing cursor and reconciles an uncertain draft without resending', async t => {
  let established = false;
  const f = fixture(t, u => {
    if (u.pathname.endsWith('/send')) throw { code: 'unknown_send' };
    if (u.pathname.endsWith('/messages')) return { items: established ? [{ id: 1, direction: 'in', status: 'pending', content: 'stored' }] : [], afterCursor: established ? 'new-cursor' : null, nextCursor: null };
    if (/\/conversations\/[^/]+$/.test(u.pathname)) return { conversation: { id: established ? 'g:AA' : 'd:draft', state: established ? 'active' : 'draft' }, conversationId: established ? 'g:AA' : 'd:draft', stored: established ? true : false };
  });
  await f.state.open(); await f.state.select('d:draft'); f.state.setInput('uncertain first send'); await f.state.send();
  assert.equal(f.state.snapshot().retryRequired, true); established = true;
  await f.event('chat_ready');
  assert.equal(f.state.snapshot().selectedId, 'g:AA');
  assert.equal(f.state.snapshot().retryRequired, false);
  assert.equal(f.state.snapshot().afterCursor, 'new-cursor');
  assert.equal(f.calls.filter(call => call.u.pathname.endsWith('/send')).length, 1);
  assert.equal(f.state.streamSubscription().conversationId, 'g:AA');
});

test('fallback polling initializes a canonical conversation whose first history read had no cursor', async t => {
  let ready = false;
  const f = fixture(t, u => u.pathname.endsWith('/messages') ? { items: [], afterCursor: ready ? 'initialized' : null, nextCursor: null } : undefined);
  await f.open(); assert.equal(f.state.snapshot().afterCursor, null); ready = true;
  await f.timer.advance(5000);
  assert.equal(f.state.snapshot().afterCursor, 'initialized');
  assert.equal(f.reads().length, 2);
});

test('stale scope, protocol and watch ids cannot trigger reads or mark push ready', async t => {
  const f = fixture(t); await f.open(); const subscription = f.state.streamSubscription(), before = f.calls.length;
  for (const patch of [{ version: 2 }, { tab: 'external' }, { conversationId: 'g:BB' }, { ids: [] }]) await f.event('chat_ready', patch, subscription);
  assert.equal(f.calls.length, before); assert.equal(f.state.snapshot().streamState, 'polling');
  f.state.close(); f.setIdentity('remote'); await f.state.open();
  f.state.streamEvent('chat_ready', { version: 1, ...subscription }, subscription); await flush();
  assert.equal(f.state.snapshot().streamState, 'polling');
});

test('dirty hints during a pending read share one pass and queue one bounded catchup', async t => {
  let resolve, reads = 0, active = 0, maximum = 0;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    reads++; active++; maximum = Math.max(maximum, active);
    return (async () => { try { return reads === 1 ? await pending : { items: [], afterCursor: 'cursor' }; } finally { active--; } })();
  });
  await f.open(); await f.event('chat_ready');
  await f.event('chat_messages_changed'); await f.event('chat_delivery_changed');
  assert.equal(reads, 1);
  resolve({ items: [], afterCursor: 'cursor' }); await flush(); await f.timer.advance(0);
  assert.equal(reads, 2); assert.equal(maximum, 1);
});

class FakeSource extends EventTarget {
  emit(name, data) { const event = new Event(name); event.data = JSON.stringify(data); this.dispatchEvent(event); }
}
test('push binding only augments the existing stream URL and ignores detached or stale source events', () => {
  const changes = [], statuses = [], events = [];
  let current;
  const push = createConversationPush({ onSubscriptionChange: value => changes.push(value), onStatus: value => statuses.push(value), onEvent: (...value) => events.push(value), isCurrent: source => source === current });
  assert.equal(push.streamUrl('/fleet/Peer/api/stream'), '/fleet/Peer/api/stream');
  const sub = { tab: 'mine', conversationId: 'g:AA', ids: [3, 1, 1] };
  push.setSubscription(sub); push.setSubscription({ ...sub, ids: [1, 3] }); assert.equal(changes.length, 1);
  const url = new URL(push.streamUrl('/dashboard/fleet/Peer/api/stream'), 'http://fixture');
  assert.equal(url.pathname, '/dashboard/fleet/Peer/api/stream'); assert.equal(url.searchParams.get('chat_ids'), '1,3');
  assert.equal(url.searchParams.has('token'), false);
  const first = current = new FakeSource(); push.attach(first);
  const data = { version: 1, tab: 'mine', conversationId: 'g:AA', ids: [1, 3] };
  first.emit('chat_ready', data); assert.equal(events.length, 1);
  push.setSubscription({ ...sub, conversationId: 'g:BB' }); first.emit('chat_ready', data); assert.equal(events.length, 1);
  const second = current = new FakeSource(); push.attach(second); current = new FakeSource(); second.emit('chat_ready', { ...data, conversationId: 'g:BB' }); assert.equal(events.length, 1);
  push.destroy(); assert.equal(statuses.length, 2);
  assert.deepEqual(normalizeChatSubscription({ tab: 'external', conversationId: 'd:draft', ids: [1] }), { tab: 'external', conversationId: null, ids: [] });
});

test('coalesced hints cannot bypass bounded backoff after a pending read fails', async t => {
  let reject, attempts = 0;
  const pending = new Promise((_, fail) => { reject = fail; });
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    attempts++;
    if (attempts === 1) return pending;
    if (attempts === 2) return Promise.reject({ code: 'temporary' });
    return { items: [], afterCursor: 'cursor' };
  });
  await f.open(); await f.event('chat_ready');
  for (let i = 0; i < 3; i++) await f.event('chat_messages_changed');
  reject({ code: 'temporary' }); await flush();
  assert.equal(attempts, 1); assert.equal(f.state.snapshot().updateError, 'temporary');
  await f.event('chat_messages_changed'); assert.equal(attempts, 1, 'fresh hints also respect the active backoff');
  await f.timer.advance(1000); await f.event('chat_messages_changed');
  await f.timer.advance(1000); await f.event('chat_delivery_changed');
  await f.timer.advance(2999); assert.equal(attempts, 1);
  await f.timer.advance(1); assert.equal(attempts, 2);
  await f.timer.advance(3000); await f.event('chat_messages_changed');
  await f.timer.advance(6999); assert.equal(attempts, 2);
  await f.timer.advance(1); assert.equal(attempts, 3);
  assert.equal(f.state.snapshot().updateError, null);
});

test('a message hint coalesced with manual status still reads new message truth', async t => {
  const f = fixture(t, u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after'
    ? { items: [{ id: 2, direction: 'out', status: 'delivered', content: 'combined reply' }], afterCursor: 'after2' } : undefined);
  await f.open();
  const event = f.event('chat_messages_changed');
  const manual = f.state.refreshStatus();
  await event; await manual;
  assert.equal(f.reads().length, 2);
  assert.equal(f.state.snapshot().messages.find(row => row.id === 2)?.content, 'combined reply');
  assert.equal(f.calls.filter(call => call.u.pathname.endsWith('/status')).length, 1);
});

test('a previous conversation read cannot update visible messages or list previews after selection changes', async t => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const f = fixture(t, u => {
    if (u.pathname.includes('g%3AAA/messages') && u.searchParams.get('direction') === 'after') return pending;
    if (u.pathname.includes('g%3ABB/messages')) return { items: [{ id: 4, direction: 'out', status: 'delivered', content: 'current conversation' }], afterCursor: 'after4' };
    if (u.pathname.endsWith('g%3ABB')) return { conversation: { id: 'g:BB', state: 'active' }, conversationId: 'g:BB', stored: true };
  });
  await f.open(); await f.event('chat_ready');
  await f.state.select('g:BB');
  resolve({ items: [{ id: 3, direction: 'out', status: 'delivered', content: 'stale private reply' }], afterCursor: 'after3' });
  await flush();
  assert.equal(f.state.snapshot().selectedId, 'g:BB');
  assert.equal(f.state.snapshot().messages.length, 1);
  assert.equal(f.state.snapshot().messages[0].content, 'current conversation');
  assert.equal(JSON.stringify(f.state.snapshot().items).includes('stale private reply'), false);
});


test('the explicit read button can override automatic backoff without sending a message', async t => {
  let attempts = 0;
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    if (++attempts === 1) return Promise.reject({ code: 'temporary' });
    return { items: [], afterCursor: 'cursor' };
  });
  await f.open(); await f.event('chat_ready');
  assert.equal(f.state.snapshot().updateError, 'temporary');
  await f.state.refreshMessages();
  assert.equal(attempts, 2); assert.equal(f.timer.now(), 1000);
  assert.equal(f.state.snapshot().updateError, null);
  assert.equal(f.calls.filter(call => call.u.pathname.endsWith('/send')).length, 0);
});


test('visibility and reconnect transitions rearm the absolute backoff deadline', async t => {
  let attempts = 0;
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    if (++attempts <= 2) return Promise.reject({ code: 'temporary' });
    return { items: [], afterCursor: 'cursor' };
  });
  await f.open(); await f.event('chat_ready');
  assert.equal(attempts, 1);
  await f.visible(false); await f.timer.advance(2000); await f.visible(true);
  assert.equal(attempts, 1);
  await f.timer.advance(2999); assert.equal(attempts, 1);
  await f.timer.advance(1); assert.equal(attempts, 2, 'visibility cannot lose the five-second retry');
  f.state.streamStatus('connecting');
  await f.timer.advance(2000); f.state.streamStatus('disconnected');
  await f.timer.advance(7999); assert.equal(attempts, 2);
  await f.timer.advance(1); assert.equal(attempts, 3, 'reconnection cannot lose or postpone the ten-second retry');
  assert.equal(f.state.snapshot().updateError, null);
  assert.equal(f.timer.count(), 1);
});


for (const first of ['foreground', 'quiet']) test(`a ready catchup clears foreground loading when ${first} list resolves first`, async t => {
  const resolvers = [];
  const f = fixture(t, u => u.pathname === '/api/chat/conversations' ? new Promise(resolve => { resolvers.push(resolve); }) : undefined);
  const opening = f.state.open(); await flush();
  assert.equal(f.state.snapshot().loading, true);
  f.state.streamStatus('connecting'); await f.event('chat_ready');
  assert.equal(resolvers.length, 2);
  const old = { items: [{ id: 'g:BB', displayName: 'stale foreground' }], nextCursor: null };
  const latest = { items: [{ id: 'g:AA', displayName: 'latest quiet' }], nextCursor: null };
  if (first === 'quiet') {
    resolvers[1](latest); await flush();
    assert.equal(f.state.snapshot().loading, false, 'authoritative quiet data releases the superseded foreground spinner');
    resolvers[0](old); await opening;
  } else {
    resolvers[0](old); await opening;
    assert.equal(f.state.snapshot().loading, false, 'foreground completion clears only its own loading token');
    resolvers[1](latest); await flush();
  }
  assert.equal(f.state.snapshot().loading, false);
  assert.equal(f.state.snapshot().items.length, 1);
  assert.equal(f.state.snapshot().items[0].id, 'g:AA', 'the list data version guard still rejects the old result');
});

test('a previous identity list cannot clear a new foreground loading token', async t => {
  const resolvers = [];
  const f = fixture(t, u => u.pathname === '/api/chat/conversations' ? new Promise(resolve => { resolvers.push(resolve); }) : undefined);
  const oldOpening = f.state.open(); await flush();
  f.state.close(); f.setIdentity('remote'); const newOpening = f.state.open(); await flush();
  assert.equal(resolvers.length, 2);
  resolvers[0]({ items: [{ id: 'g:BB' }], nextCursor: null }); await oldOpening;
  assert.equal(f.state.snapshot().loading, true);
  resolvers[1]({ items: [{ id: 'g:AA' }], nextCursor: null }); await newOpening;
  assert.equal(f.state.snapshot().loading, false);
  assert.equal(f.state.snapshot().items[0].id, 'g:AA');
});
