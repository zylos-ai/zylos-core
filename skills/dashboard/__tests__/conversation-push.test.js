import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';

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
    if (url === '/api/instance') return { session_mode: { sessionMode: 'multi' } };
    if (u.pathname === '/api/conversations') return { items: [{ id: 'g:AA' }], nextCursor: null };
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

/** A live activity read as the server answers it: the group works (`running`) or is done, with these steps. */
