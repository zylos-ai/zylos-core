import { catchUpConversation } from './helpers/conversation-stream-catchup.js';
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
    event(name, extra = {}, subscription = state.streamSubscription()) { state.streamEvent(name, { version: 1, ids: [], ...subscription, ...extra }, subscription); return flush(); }
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

test('a live message stream still refreshes running activity every two seconds and returns to the normal fallback when it ends', async t => {
  let running = true, activityReads = 0;
  const f = fixture(t, (url, _options, now) => {
    if (!url.pathname.endsWith('/activity')) return;
    activityReads++;
    assert.deepEqual([...url.searchParams.keys()], ['tab'], 'the live activity is about the group: it names no message');
    return liveActivity(now, running, [{ kind: 'tool', label: { key: 'described', arg: `Activity read ${activityReads}` }, status: 'running', start: now, end: null }]);
  });
  await f.open(); await f.event('chat_ready');
  assert.equal(f.state.snapshot().streamState, 'live');
  const readyReads = activityReads;
  assert.ok(readyReads > 0, 'the real controller reads the activity endpoint');
  await f.timer.advance(1999); assert.equal(activityReads, readyReads);
  await f.timer.advance(1); assert.equal(activityReads, readyReads + 1);
  assert.equal(f.state.snapshot().activity.data.steps[0].label.arg, `Activity read ${readyReads + 1}`);
  running = false;
  await f.timer.advance(1999); assert.equal(activityReads, readyReads + 1);
  await f.timer.advance(1); assert.equal(activityReads, readyReads + 2);
  assert.equal(f.state.snapshot().activity.data.working.on, false);
  assert.equal(f.state.snapshot().streamState, 'live', 'activity polling retains the existing live message stream');
  const messageReads = f.reads().length;
  const listAt = f.calls.filter(call => call.u.pathname === '/api/chat/conversations').at(-1).at;
  await f.timer.advance(listAt + 30000 - f.timer.now() - 1);
  assert.equal(f.reads().length, messageReads, 'finished activity no longer schedules two-second reads');
  await f.timer.advance(1);
  assert.equal(f.reads().length, messageReads + 1, 'the existing thirty-second live fallback/list deadline resumes');
  // Work can start in the group at any time without a message from this page, so the slow poll reads it once.
  assert.equal(activityReads, readyReads + 3, 'finished activity is read only with the slow poll');
});

test('while the work after a stop settles the page keeps reading every two seconds, then the handled line ends it', async t => {
  let state = 'settling', activityReads = 0;
  const f = fixture(t, (url, _options, now) => {
    if (!url.pathname.endsWith('/activity')) return;
    activityReads++;
    return { ...liveActivity(now, false, []), awaiting: { id: 1, state, since: 0, delivered: 0 } };
  });
  await f.open(); await f.event('chat_ready');
  assert.equal(f.state.snapshot().streamState, 'live');
  const readyReads = activityReads;
  await f.timer.advance(1999); assert.equal(activityReads, readyReads);
  await f.timer.advance(1); assert.equal(activityReads, readyReads + 1, 'settling: the runtime may still take a queued message');
  state = 'handled';
  await f.timer.advance(2000); assert.equal(activityReads, readyReads + 2);
  await f.timer.advance(2000); assert.equal(activityReads, readyReads + 2, 'handled: nothing more can change soon');
});

/** A live activity read as the server answers it: the group works (`running`) or is done, with these steps. */
function liveActivity(now, running, steps) {
  return { now, from: 0, presence: 'running', steps, subtasks: [], awaiting: null, seenId: 2,
    working: running ? { on: true, since: 0, main: { since: 0, lastActivityAt: now }, tools: 0, subagents: null }
      : { on: false, since: null, main: null, tools: 0, subagents: null } };
}
function followUpActivity(now, running = true) {
  return liveActivity(now, running, [{ kind: 'tool', label: { key: 'runCommand' }, status: running ? 'running' : 'done', start: 600, end: running ? null : now }]);
}
function followUpMessages(url) {
  return { items: url.searchParams.get('direction') === 'before' ? [
    { id: 1, direction: 'in', content: 'hello', status: 'delivered' },
    { id: 2, direction: 'out', content: 'reply already sent', status: 'delivered' }
  ] : [], afterCursor: 'cursor', nextCursor: null };
}

test('a delayed first activity read shortens the live fallback and settles follow-up work on the next two-second poll', async t => {
  let resolveFirst, running = true, activityReads = 0;
  const f = fixture(t, (url, _options, now) => {
    if (url.pathname.endsWith('/messages')) return followUpMessages(url);
    if (!url.pathname.endsWith('/activity')) return;
    activityReads++;
    return activityReads === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : followUpActivity(now, running);
  });
  await f.open();
  assert.equal(activityReads, 1);
  await f.event('chat_ready');
  assert.equal(activityReads, 1, 'ready catchup does not duplicate the outstanding initial activity request');
  assert.equal(f.state.snapshot().streamState, 'live');
  await f.timer.advance(1000);
  const messages = f.reads().length;
  resolveFirst(followUpActivity(f.timer.now())); await flush();
  assert.equal(f.state.snapshot().activity.data.working.on, true);
  await f.timer.advance(1999); assert.equal(f.reads().length, messages);
  running = false;
  await f.timer.advance(1);
  assert.equal(f.reads().length, messages + 1, 'the first slow live fallback is replaced by a two-second wait');
  assert.equal(activityReads, 2);
  assert.equal(f.state.snapshot().activity.data.working.on, false, 'completion is read without a click or push hint');
});

test('a delayed first activity result that is already finished keeps the thirty-second fallback', async t => {
  let resolveFirst, activityReads = 0;
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/messages')) return followUpMessages(url);
    if (url.pathname.endsWith('/activity')) {
      activityReads++;
      return new Promise(resolve => { resolveFirst = resolve; });
    }
  });
  await f.open(); await f.event('chat_ready');
  assert.equal(f.state.snapshot().streamState, 'live');
  assert.equal(activityReads, 1);
  const deadline = f.timer.now() + 30000;
  const messages = f.reads().length;
  await f.timer.advance(1000);
  resolveFirst(followUpActivity(f.timer.now(), false)); await flush();
  assert.equal(f.state.snapshot().activity.data.working.on, false);
  await f.timer.advance(deadline - f.timer.now() - 1);
  assert.equal(f.reads().length, messages, 'finished activity does not shorten the existing slow wait');
  await f.timer.advance(1);
  assert.equal(f.reads().length, messages + 1);
  assert.equal(activityReads, 2, 'finished work is read again only with the slow poll');
});

test('a delayed activity result keeps an already sooner poll deadline', async t => {
  let resolveFirst, activityReads = 0;
  const f = fixture(t, (url, _options, now) => {
    if (url.pathname.endsWith('/messages')) return followUpMessages(url);
    if (!url.pathname.endsWith('/activity')) return;
    return ++activityReads === 1 ? new Promise(resolve => { resolveFirst = resolve; }) : followUpActivity(now);
  });
  await f.open(); await f.event('chat_ready');
  f.state.streamStatus('disconnected');
  await f.timer.advance(3500);
  const messages = f.reads().length;
  resolveFirst(followUpActivity(f.timer.now())); await flush();
  await f.timer.advance(1499); assert.equal(f.reads().length, messages);
  await f.timer.advance(1);
  assert.equal(f.reads().length, messages + 1, 'the remaining 1.5-second wait is not reset to two seconds');
});

test('an old selection activity result cannot shorten the newly selected conversation fallback', async t => {
  let resolveFirst;
  const f = fixture(t, (url, _options, now) => {
    if (url.pathname.endsWith('/messages')) return followUpMessages(url);
    if (url.pathname === '/api/chat/conversations/g%3ABB') return { conversation: { id: 'g:BB', state: 'active' }, conversationId: 'g:BB', stored: true };
    if (!url.pathname.endsWith('/activity')) return;
    if (url.pathname.includes('g%3AAA')) return new Promise(resolve => { resolveFirst = resolve; });
    return liveActivity(now, false, []);
  });
  await f.open(); await f.event('chat_ready');
  await f.state.select('g:BB'); await f.event('chat_ready');
  const messages = f.reads().length;
  await f.timer.advance(1000);
  resolveFirst(followUpActivity(f.timer.now())); await flush();
  await f.timer.advance(2000);
  assert.equal(f.reads().length, messages);
  assert.equal(f.state.snapshot().selectedId, 'g:BB');
  assert.equal(f.state.snapshot().activity.data.working.on, false, 'the old selection\'s running work is not shown');
});

test('a first activity result arriving while hidden does not restart polling', async t => {
  let resolveFirst;
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/messages')) return followUpMessages(url);
    if (url.pathname.endsWith('/activity')) return new Promise(resolve => { resolveFirst = resolve; });
  });
  await f.open(); await f.event('chat_ready'); await f.visible(false);
  const messages = f.reads().length;
  resolveFirst(followUpActivity(f.timer.now())); await flush();
  assert.equal(f.timer.count(), 0);
  await f.timer.advance(60000);
  assert.equal(f.reads().length, messages);
});

test('a delayed first activity result preserves an active message-read retry deadline', async t => {
  let resolveFirst, failMessages = false;
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/messages')) {
      if (failMessages) throw { code: 'temporary_read_failure' };
      return followUpMessages(url);
    }
    if (url.pathname.endsWith('/activity')) return new Promise(resolve => { resolveFirst = resolve; });
  });
  await f.open(); failMessages = true; await f.event('chat_ready');
  assert.equal(f.state.snapshot().updateError, 'temporary_read_failure');
  await f.timer.advance(1000);
  const messages = f.reads().length;
  resolveFirst(followUpActivity(f.timer.now())); await flush();
  await f.timer.advance(3999); assert.equal(f.reads().length, messages);
  await f.timer.advance(1);
  assert.equal(f.reads().length, messages + 1, 'activity cannot bypass the existing five-second error backoff');
});

test('a delayed activity result preserves failed post-send synchronization backoff', async t => {
  let resolveFirst, failMessages = false;
  const f = fixture(t, url => {
    if (url.pathname.endsWith('/messages')) {
      if (failMessages) throw { code: 'temporary_post_send_read_failure' };
      return followUpMessages(url);
    }
    if (url.pathname.endsWith('/activity')) return new Promise(resolve => { resolveFirst = resolve; });
  });
  await f.open(); await f.event('chat_ready');
  failMessages = true;
  f.state.setInput('save the follow-up log');
  await f.state.send();
  assert.equal(f.calls.filter(call => call.u.pathname.endsWith('/send')).length, 1);
  assert.equal(f.state.snapshot().updateError, 'temporary_post_send_read_failure');
  const messages = f.reads().length;
  resolveFirst(followUpActivity(f.timer.now())); await flush();
  assert.equal(f.state.snapshot().activity.data.working.on, true);
  await f.timer.advance(4999);
  assert.equal(f.reads().length, messages, 'the post-send five-second retry is not shortened by late activity');
  await f.timer.advance(1);
  assert.equal(f.reads().length, messages + 1, 'the failed post-send read retries at its original deadline');
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

test('stale scope, protocol and malformed hint ids cannot trigger reads or mark push ready', async t => {
  const f = fixture(t); await f.open(); const subscription = f.state.streamSubscription(), before = f.calls.length;
  for (const patch of [{ version: 2 }, { tab: 'external' }, { conversationId: 'g:BB' }, { ids: [-1] }, { ids: [1, 1] }, { ids: Array.from({ length: 101 }, (_, i) => i + 1) }]) await f.event('chat_ready', patch, subscription);
  assert.equal(f.calls.length, before); assert.equal(f.state.snapshot().streamState, 'polling');
  f.state.close(); f.setIdentity('remote'); await f.state.open();
  f.state.streamEvent('chat_ready', { version: 1, ids: [], ...subscription }, subscription); await flush();
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
  assert.equal(url.pathname, '/dashboard/fleet/Peer/api/stream'); assert.equal(url.searchParams.has('chat_ids'), false);
  assert.equal(url.searchParams.has('token'), false);
  const first = current = new FakeSource(); push.attach(first);
  const data = { version: 1, tab: 'mine', conversationId: 'g:AA', ids: [1, 3] };
  first.emit('chat_ready', data); assert.equal(events.length, 1);
  push.setSubscription({ ...sub, conversationId: 'g:BB' }); first.emit('chat_ready', data); assert.equal(events.length, 1);
  const second = current = new FakeSource(); push.attach(second); current = new FakeSource(); second.emit('chat_ready', { ...data, conversationId: 'g:BB' }); assert.equal(events.length, 1);
  push.destroy(); assert.equal(statuses.length, 2);
  assert.deepEqual(normalizeChatSubscription({ tab: 'external', conversationId: 'd:draft', ids: [1] }), { tab: 'external', conversationId: null });
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

test('a newly admitted ready stream immediately retries truth after unavailable polling failed', async t => {
  let attempts = 0;
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    if (++attempts === 1) return Promise.reject({ code: 'chat_history_unavailable' });
    return { items: [{ id: attempts, direction: 'out', content: 'recovered reply', status: 'delivered' }], afterCursor: 'cursor' };
  });
  await f.open(); await f.event('chat_ready');
  assert.equal(attempts, 1); assert.equal(f.state.snapshot().updateError, 'chat_history_unavailable');
  await f.event('chat_unavailable'); f.state.streamStatus('connecting');
  await f.timer.advance(1000);
  await f.event('chat_ready');
  assert.equal(attempts, 2, 'new admission retries before the old five-second deadline');
  assert.equal(f.reads().at(-1).at, 2000);
  assert.equal(f.state.snapshot().updateError, null);
  assert.equal(f.state.snapshot().messages.find(row => row.id === 2)?.content, 'recovered reply');
  await f.event('chat_messages_changed');
  assert.equal(attempts, 3, 'subsequent live hints immediately read committed truth');
  assert.equal(f.state.snapshot().messages.find(row => row.id === 3)?.content, 'recovered reply');
});

test('duplicate ready events on an already live stream preserve failed-read backoff', async t => {
  let attempts = 0;
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    if (++attempts === 1) return Promise.reject({ code: 'temporary' });
    return { items: [], afterCursor: 'cursor' };
  });
  await f.open(); await f.event('chat_ready');
  await f.timer.advance(1000); await f.event('chat_ready'); await f.event('chat_messages_changed');
  assert.equal(attempts, 1, 'same-stream ready and dirty hints cannot bypass the active deadline');
  await f.timer.advance(3999); assert.equal(attempts, 1);
  await f.timer.advance(1); assert.equal(attempts, 2);
  assert.equal(f.state.snapshot().updateError, null);
});

test('new stream admission catches up immediately after an older in-flight poll fails', async t => {
  let reject, attempts = 0;
  const pending = new Promise((_, fail) => { reject = fail; });
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    if (++attempts === 1) return pending;
    return { items: [{ id: 2, direction: 'out', content: 'fresh database reply', status: 'delivered' }], afterCursor: 'cursor2' };
  });
  await f.open(); await f.event('chat_ready');
  await f.event('chat_unavailable'); f.state.streamStatus('connecting'); await f.event('chat_ready');
  assert.equal(attempts, 1, 'new admission preserves single-flight ownership');
  reject({ code: 'chat_history_unavailable' }); await flush();
  assert.equal(attempts, 2, 'the ready catchup runs after the failed owner without waiting for its retry timer');
  assert.equal(f.timer.now(), 1000); assert.equal(f.state.snapshot().updateError, null);
  assert.equal(f.state.snapshot().messages.find(row => row.id === 2)?.content, 'fresh database reply');
});

test('new readiness while hidden preserves one immediate catchup when visible again', async t => {
  let attempts = 0;
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    if (++attempts === 1) return Promise.reject({ code: 'chat_history_unavailable' });
    return { items: [], afterCursor: 'cursor' };
  });
  await f.open(); await f.event('chat_ready'); await f.event('chat_unavailable');
  await f.visible(false); f.state.streamStatus('connecting'); await f.event('chat_ready');
  assert.equal(attempts, 1, 'hidden readiness only marks dirty');
  await f.visible(true);
  assert.equal(attempts, 2, 'visible restoration catches up before the failed owner deadline');
  assert.equal(f.timer.now(), 1000); assert.equal(f.state.snapshot().updateError, null);
});

for (const changed of ['scope', 'epoch']) test(`a ready catchup waiting on an old poll cannot cross a changed ${changed}`, async t => {
  let reject, attempts = 0;
  const pending = new Promise((_, fail) => { reject = fail; });
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    attempts++; return pending;
  });
  await f.open(); await f.event('chat_ready');
  await f.event('chat_unavailable'); f.state.streamStatus('connecting'); await f.event('chat_ready');
  if (changed === 'scope') await f.state.setTab('external'); else f.state.close();
  reject({ code: 'chat_history_unavailable' }); await flush();
  assert.equal(attempts, 1, 'the old admitted scope cannot start another truth request');
});

test('a message hint alongside manual status still reads new message truth', async t => {
  const f = fixture(t, u => u.pathname.endsWith('/messages') && u.searchParams.get('direction') === 'after'
    ? { items: [{ id: 2, direction: 'out', status: 'delivered', content: 'combined reply' }], afterCursor: 'after2' } : undefined);
  await f.open();
  const event = f.event('chat_messages_changed');
  const manual = f.state.refreshStatus();
  await event; await manual;
  assert.equal(f.reads().length, 2);
  assert.equal(f.state.snapshot().messages.find(row => row.id === 2)?.content, 'combined reply');
  assert.ok(f.calls.filter(call => call.u.pathname.endsWith('/status')).length >= 1);
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


test('a new stream admission can catch up through automatic backoff without sending a message', async t => {
  let attempts = 0;
  const f = fixture(t, u => {
    if (!u.pathname.endsWith('/messages') || u.searchParams.get('direction') !== 'after') return;
    if (++attempts === 1) return Promise.reject({ code: 'temporary' });
    return { items: [], afterCursor: 'cursor' };
  });
  await f.open(); await f.event('chat_ready');
  assert.equal(f.state.snapshot().updateError, 'temporary');
  await catchUpConversation(f.state);
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

for (const accelerated of [false, true]) test(`reconnect churn preserves the ${accelerated ? 'two' : 'five'} second fallback deadline`, { timeout: 2000 }, async t => {
  const f = fixture(t); await f.open();
  if (accelerated) { f.state.setInput('send once'); await f.state.send(); }
  await f.event('chat_ready');
  const started = f.timer.now(), interval = accelerated ? 2000 : 5000;
  const baseline = f.reads().length;
  f.state.streamStatus('disconnected');
  for (let elapsed = 100; elapsed < interval; elapsed += 100) {
    await f.timer.advance(100);
    f.state.streamStatus(elapsed % 200 ? 'connecting' : 'disconnected');
  }
  await f.timer.advance(99);
  assert.equal(f.reads().length, baseline, 'reconnect transitions cannot move the original deadline earlier');
  await f.timer.advance(1);
  assert.equal(f.reads().length, baseline + 1, 'reconnect transitions cannot postpone fallback');
  assert.equal(f.reads().at(-1).at, started + interval);
  for (let elapsed = 100; elapsed <= interval * 2; elapsed += 100) {
    await f.timer.advance(100);
    f.state.streamStatus(elapsed % 200 ? 'connecting' : 'disconnected');
  }
  const automatic = f.reads().slice(baseline);
  assert.equal(automatic.length, 3);
  for (let i = 0; i < automatic.length; i++) assert.equal(automatic[i].at, started + interval * (i + 1));
});

test('pending row changes keep the canonical conversation subscription and existing source', { timeout: 2000 }, async t => {
  let delivered = false;
  const f = fixture(t, u => u.pathname.endsWith('/status')
    ? { items: [{ id: 1, status: delivered ? 'delivered' : 'pending' }] } : undefined);
  await f.open();
  const changes = [], events = [];
  const push = createConversationPush({ onSubscriptionChange: sub => changes.push(sub), onEvent: (...args) => events.push(args) });
  t.after(() => push.destroy());
  push.setSubscription(f.state.streamSubscription());
  const source = new FakeSource(); push.attach(source);
  f.state.setInput('another message'); await f.state.send();
  push.setSubscription(f.state.streamSubscription());
  delivered = true; await f.state.refreshStatus();
  push.setSubscription(f.state.streamSubscription());
  assert.equal(changes.length, 1, 'pending and terminal row sets do not change the subscription');
  assert.deepEqual(f.state.streamSubscription(), { tab: 'mine', conversationId: 'g:AA' });
  assert.equal(new URL(push.streamUrl('/api/stream'), 'http://fixture').searchParams.has('chat_ids'), false);
  source.emit('chat_delivery_changed', { version: 1, tab: 'mine', conversationId: 'g:AA', ids: [1] });
  assert.equal(events.length, 1, 'the attached source remains active after sending and delivery');
});

for (const initiallyLive of [false, true]) for (const accelerated of [false, true]) {
  test(`chat unavailability retains the application source and ${accelerated ? 'two' : 'five'} second polling after ${initiallyLive ? 'a live chat' : 'chat admission'}`, { timeout: 2000 }, async t => {
    const f = fixture(t); await f.open();
    if (accelerated) { f.state.setInput('one send'); await f.state.send(); }
    const changes = [], source = new FakeSource(); let ordinary = 0;
    const push = createConversationPush({ onSubscriptionChange: subscription => changes.push(subscription),
      onStatus: (status, subscription) => f.state.streamStatus(status, subscription),
      onEvent: (name, data, subscription) => f.state.streamEvent(name, data, subscription) });
    t.after(() => push.destroy());
    push.setSubscription(f.state.streamSubscription()); push.attach(source);
    source.addEventListener('state_change', () => ordinary++);
    const metadata = { version: 1, ...f.state.streamSubscription(), ids: [] };
    if (initiallyLive) { source.emit('chat_ready', metadata); await flush(); assert.equal(f.state.snapshot().streamState, 'live'); }
    const before = f.reads().length, started = f.timer.now(), interval = accelerated ? 2000 : 5000;
    source.emit('chat_unavailable', metadata); await flush();
    assert.equal(f.state.snapshot().streamState, 'polling');
    push.setSubscription(f.state.streamSubscription());
    assert.equal(changes.length, 1, 'chat-only degradation keeps the same application stream subscription');
    source.emit('state_change', { ordinary: true });
    assert.equal(ordinary, 1, 'ordinary events remain on the attached source');
    await f.timer.advance(interval - 1); assert.equal(f.reads().length, before);
    await f.timer.advance(1); assert.equal(f.reads().length, before + 1);
    assert.equal(f.reads().at(-1).at, started + interval);
    assert.equal(f.state.snapshot().streamState, 'polling');
    assert.equal(changes.length, 1);
  });
}

test('a failed dirty list catchup retries that list at its backoff deadline', { timeout: 2000 }, async t => {
  let lists = 0;
  const f = fixture(t, url => {
    if (url.pathname !== '/api/chat/conversations') return;
    if (++lists === 2) throw { code: 'temporary_list_failure' };
  });
  await f.open(); assert.equal(lists, 1);
  await f.event('chat_messages_changed'); assert.equal(lists, 2);
  assert.equal(f.state.snapshot().updateError, 'temporary_list_failure');
  await f.timer.advance(4999); assert.equal(lists, 2);
  await f.timer.advance(1); assert.equal(lists, 3, 'failed dirty scope is retried without waiting for the thirty-second list interval');
  assert.equal(f.state.snapshot().updateError, null);
  assert.equal(f.calls.filter(call => call.u.pathname.endsWith('/send')).length, 0);
});
