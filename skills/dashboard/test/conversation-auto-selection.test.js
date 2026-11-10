import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { createDocument, allNodes } from './helpers/conversation-dom.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const { createConversationPush } = await import('../public/js/wb/conversation-push.js');

// Pure page/controller boundary: runner-owned paths, fake DOM/clock/fetch; no DB, HTTP, PM2 or tmux.
for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) assert.ok(path.isAbsolute(process.env[key]));
const runnerRoot = path.dirname(process.env.HOME);
assert.match(path.basename(runnerRoot), /^zylos-tests-/);
assert.equal(process.env.ZYLOS_DIR, path.join(process.env.HOME, 'zylos'));
assert.equal(process.env.PM2_HOME, path.join(process.env.HOME, '.pm2'));
assert.equal(process.env.TMPDIR, path.join(runnerRoot, 'tmp'));
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const row = id => ({ id, sessionGroup: id === 'g:AA' ? 'dashboard:first' : 'dashboard:chosen', stamp: id === 'g:AA' ? 2 : 1 });

function fixture(t, { width = 1440 } = {}) {
  let time = 1_700_000_000_000, serial = 0, identity = 'local';
  const timers = new Map(), lists = [], detailReads = [], events = new Map();
  const original = { now: Date.now, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  let page, push;
  t.after(() => {
    try { push?.destroy(); page?.destroy(); } finally {
      timers.clear(); events.clear();
      Date.now = original.now; globalThis.setTimeout = original.setTimeout; globalThis.clearTimeout = original.clearTimeout;
    }
  });
  const clock = {
    setTimeout(fn, ms) { const id = ++serial; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    async due() {
      for (let count = 0; count < 30; count++) {
        const next = [...timers].find(([, value]) => value.at <= time);
        if (!next) return;
        timers.delete(next[0]); next[1].fn(); await flush();
      }
      assert.fail('timer drain exceeded 30 callbacks');
    }
  };
  Date.now = () => time;
  globalThis.setTimeout = clock.setTimeout;
  globalThis.clearTimeout = clock.clearTimeout;
  const document = createDocument();
  Object.assign(document, { hidden: false, visibilityState: 'visible', addEventListener() {}, removeEventListener() {}, querySelector() { return null; } });
  document.defaultView = { innerWidth: width, innerHeight: 900, addEventListener() {}, removeEventListener() {},
    requestAnimationFrame() { return 1; }, cancelAnimationFrame() {}, matchMedia() { return { matches: false }; },
    getComputedStyle() { return { minHeight: '32px' }; } };
  const root = document.createElement('div');
  const response = body => ({ ok: true, status: 200, json: async () => body });
  page = mountConversationPage({ root, document, storage: null, identity: () => identity,
    local: () => true, confirm: async () => true, fetch: async (url, options) => {
      if (url.startsWith('/api/chat/conversations?')) {
        assert.ok(lists.length < 8, 'list request log is bounded');
        const held = deferred(); lists.push(held); return held.promise.then(response);
      }
      if (url === '/api/session-mode') return response({ data: { sessionMode: 'multi' } });
      if (url.endsWith('/deletion')) return response({ operationId: 'delete-first', cutoffId: 1, messages: 1 });
      if (options?.method === 'DELETE') return response({ ok: true });
      if (url.includes('/messages?')) return response({ items: [{ id: 1, direction: 'out', content: 'hello' }], afterCursor: 'after', nextCursor: null });
      if (url.includes('/questions')) return response({ items: [], nextCursor: null });
      if (/\/conversations\/[^/?]+$/.test(url)) {
        const id = decodeURIComponent(url.split('/').at(-1));
        assert.ok(detailReads.length < 8, 'detail request log is bounded'); detailReads.push(id);
        return response({ conversation: { ...row(id), state: 'active' } });
      }
      return response({ items: [], nextCursor: null });
    } });
  push = createConversationPush({ onStatus: (...args) => page.streamStatus(...args), onEvent: (...args) => page.streamEvent(...args) });
  const source = { addEventListener(name, fn) { events.set(name, fn); }, removeEventListener(name) { events.delete(name); } };
  return { page, root, lists, detailReads, clock,
    selected: () => allNodes(root).filter(node => node.getAttribute?.('aria-current') === 'true').map(node => node.dataset.conversationId),
    async resolveList(index, ids = ['g:AA', 'g:BB']) { assert.ok(lists[index], `list ${index} exists`); lists[index].resolve({ items: ids.map(row), nextCursor: null, deletionAllowed: true }); await flush(); },
    async attach() { push.setSubscription(page.streamSubscription()); push.attach(source); await clock.due(); },
    async dirty() {
      const subscription = page.streamSubscription();
      events.get('chat_ready')?.({ data: JSON.stringify({ version: 1, ...subscription, ids: [] }) }); await flush();
    },
    setIdentity(value) { identity = value; }
  };
}

for (const order of ['initial-first', 'quiet-first']) {
  test(`desktop selects the first populated list when ${order} completes`, { timeout: 2000 }, async t => {
    const f = fixture(t), opening = f.page.open(); await flush();
    await f.attach(); assert.equal(f.lists.length, 2);
    if (order === 'quiet-first') { await f.resolveList(1); await f.resolveList(0); }
    else { await f.resolveList(0); await opening; assert.deepEqual(f.selected(), []); await f.resolveList(1); }
    await opening; await flush();
    assert.deepEqual(f.selected(), ['g:AA']); assert.ok(f.detailReads.length >= 1); assert.ok(f.detailReads.every(id => id === 'g:AA'));
  });
}

test('desktop waits through an empty initial list for the first populated list', { timeout: 2000 }, async t => {
  const f = fixture(t), opening = f.page.open(); await flush(); await f.resolveList(0, []); await opening;
  assert.deepEqual(f.selected(), []); await f.attach(); await f.dirty();
  await f.resolveList(1); assert.deepEqual(f.selected(), ['g:AA']); assert.ok(f.detailReads.length >= 1); assert.ok(f.detailReads.every(id => id === 'g:AA'));
});

test('a manually selected conversation survives later list refreshes', { timeout: 2000 }, async t => {
  const f = fixture(t), opening = f.page.open(); await flush(); await f.resolveList(0); await opening;
  const beforeManual = f.detailReads.length;
  f.root.querySelector('[data-conversation-id="g:BB"]').dispatch('click'); await flush();
  assert.deepEqual(f.selected(), ['g:BB']); await f.attach(); await f.dirty(); await f.resolveList(1);
  assert.deepEqual(f.selected(), ['g:BB']); assert.ok(f.detailReads.length > beforeManual); assert.ok(f.detailReads.slice(beforeManual).every(id => id === 'g:BB'));
});

test('opening an explicit group during the initial list never selects the first group', { timeout: 2000 }, async t => {
  const f = fixture(t), opening = f.page.open(); await flush();
  const explicit = f.page.openGroup('dashboard:chosen', { channel: 'dashboard' }); await flush();
  assert.equal(f.detailReads.length, 1); assert.notEqual(f.detailReads[0], 'g:AA');
  await f.resolveList(0); await opening; await explicit; await flush();
  assert.equal(f.detailReads.includes('g:AA'), false); assert.equal(f.selected().includes('g:AA'), false);
});

test('phone-width pages keep the first populated list unselected', { timeout: 2000 }, async t => {
  const f = fixture(t, { width: 390 }), opening = f.page.open(); await flush(); await f.attach();
  await f.resolveList(0); await opening; await f.resolveList(1);
  assert.deepEqual(f.selected(), []); assert.deepEqual(f.detailReads, []);
});

test('deleting the automatically selected conversation does not select another one', { timeout: 2000 }, async t => {
  const f = fixture(t), opening = f.page.open(); await flush(); await f.resolveList(0); await opening;
  assert.deepEqual(f.selected(), ['g:AA']); const beforeDelete = f.detailReads.length;
  f.root.querySelector('.conversation-delete').dispatch('click'); await flush();
  await f.resolveList(1, ['g:BB']); assert.deepEqual(f.selected(), []); assert.equal(f.detailReads.length, beforeDelete);
});

test('a response from a closed page cannot auto-select, and reopening can select', { timeout: 2000 }, async t => {
  const f = fixture(t), opening = f.page.open(); await flush(); f.page.close(); await f.resolveList(0); await opening;
  assert.deepEqual(f.selected(), []); assert.deepEqual(f.detailReads, []);
  f.setIdentity('remote'); const reopened = f.page.open(); await flush(); await f.resolveList(1); await reopened;
  assert.deepEqual(f.selected(), ['g:AA']); assert.ok(f.detailReads.length >= 1); assert.ok(f.detailReads.every(id => id === 'g:AA'));
});

test('switching instances without closing selects the new first conversation', { timeout: 2000 }, async t => {
  const f = fixture(t), opening = f.page.open(); await flush(); await f.resolveList(0, ['g:AA']); await opening;
  assert.deepEqual(f.selected(), ['g:AA']);
  const previousReads = f.detailReads.length;
  f.setIdentity('remote');
  const switched = f.page.open(); await flush();
  assert.deepEqual(f.selected(), [], 'the previous instance selection is cleared');
  await f.resolveList(1, ['g:BB']); await switched;
  assert.deepEqual(f.selected(), ['g:BB']);
  assert.ok(f.detailReads.length > previousReads);
  assert.ok(f.detailReads.slice(previousReads).every(id => id === 'g:BB'));
});

test('reopening the same instance selects its first newly available conversation', { timeout: 2000 }, async t => {
  const f = fixture(t), opening = f.page.open(); await flush(); await f.resolveList(0, []); await opening;
  assert.deepEqual(f.selected(), []);
  f.page.close();
  const reopened = f.page.open(); await flush(); await f.resolveList(1, ['g:BB']); await reopened;
  assert.deepEqual(f.selected(), ['g:BB']);
  assert.ok(f.detailReads.length > 0);
  assert.ok(f.detailReads.every(id => id === 'g:BB'));
});
