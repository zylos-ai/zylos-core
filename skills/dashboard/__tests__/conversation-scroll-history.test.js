import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument } from './helpers/conversation-dom.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const flush = async () => { for (let i = 0; i < 160; i++) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const rows = (start, count) => Array.from({ length: count }, (_, index) => ({ id: start + index, direction: 'out', channel: 'telegram', content: `message ${start + index}` }));

// Real page/state with injected DOM geometry, animation frames and fetch. The
// runner owns isolated paths; no HTTP/DB/browser/process or runtime starts.
// Page teardown owns controller timers; frame draining and request logs are bounded.
function fixture(t, { initial = rows(100, 10), cursor = 'older-1', older } = {}) {
  const document = createDocument(), root = document.createElement('div'), frames = new Map();
  // This page-only fixture has no Dashboard shell or bottom navigation.
  document.querySelector = selector => {
    assert.equal(selector, '#wb-mobile-nav', 'only the page layout shell lookup is expected');
    return null;
  };
  let serial = 0, stream, list, olderReads = 0, inFlight = 0, maxInFlight = 0;
  const requests = [];
  const makeElement = document.createElement;
  document.createElement = tag => {
    const node = makeElement(tag);
    node.getClientRects = () => [{ top: 0, bottom: 500 }];
    Object.defineProperty(node, 'isConnected', { get: () => { for (let at = node; at; at = at.parentNode) if (at === root) return true; return false; } });
    return node;
  };
  document.defaultView = { innerWidth: 390, innerHeight: 900, addEventListener() {}, removeEventListener() {},
    requestAnimationFrame(fn) { const id = ++serial; frames.set(id, fn); return id; },
    cancelAnimationFrame(id) { frames.delete(id); },
    getComputedStyle() { return { minHeight: '32px' }; } };
  const page = mountConversationPage({ root, document, storage: null, fetch: async path => {
    assert.ok(requests.length < 100, 'request history stays bounded'); requests.push(path);
    const url = new URL(path, 'http://fixture');
    let body, status = 200;
    if (path === '/api/session-mode') body = { data: { sessionMode: 'multi' } };
    else if (url.pathname === '/api/chat/conversations') body = { items: [{ id: 'g:AA', sessionGroup: 'dashboard:fixture', channel: url.searchParams.get('tab') === 'external' ? 'telegram' : 'dashboard' }], nextCursor: null };
    else if (url.pathname.endsWith('/messages')) {
      if (url.searchParams.has('cursor') && url.searchParams.get('direction') === 'before') {
        olderReads++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const result = await older?.({ count: olderReads, cursor: url.searchParams.get('cursor') });
          body = result?.body ?? result ?? { items: rows(90, 10), nextCursor: null };
          status = result?.status ?? 200;
        } finally { inFlight--; }
      } else body = { items: initial, nextCursor: cursor, afterCursor: 'after' };
    } else if (/\/conversations\/[^/]+$/.test(url.pathname)) body = { conversation: { id: 'g:AA', state: 'active', sessionGroup: 'dashboard:fixture' } };
    else body = { items: [], nextCursor: null };
    return { ok: status < 400, status, json: async () => body };
  } });
  stream = root.querySelector('.conversation-stream');
  list = root.querySelector('.conversation-message-list');
  stream.clientHeight = 500;
  Object.defineProperty(list, 'scrollHeight', { configurable: true, get: () => list.children.filter(node => node.classList.contains('conversation-message')).length * 100 });
  Object.defineProperty(stream, 'scrollHeight', { configurable: true, get: () => Math.max(stream.clientHeight, list.scrollHeight) });
  stream.getBoundingClientRect = () => ({ top: 0, bottom: 500 });
  const create = document.createElement;
  document.createElement = tag => {
    const node = create(tag);
    node.getBoundingClientRect = () => {
      const messages = list.children.filter(child => child.classList.contains('conversation-message'));
      const top = messages.indexOf(node) * 100 - stream.scrollTop;
      return { top, bottom: top + 100 };
    };
    return node;
  };
  t.after(() => { page.destroy(); frames.clear(); });
  const settle = async () => {
    for (let step = 0; step < 50; step++) {
      await flush();
      if (!frames.size) return;
      const pending = [...frames.values()]; frames.clear();
      for (const fn of pending) fn();
    }
    assert.fail('animation-frame draining exceeded 50 passes');
  };
  return { root, page, stream, list, requests, settle,
    get olderReads() { return olderReads; }, get maxInFlight() { return maxInFlight; },
    async open(tab) {
      await page.open();
      if (tab === 'external') { root.querySelector('[data-action="external"]').dispatch('click'); await flush(); }
      root.querySelector('[data-conversation-id="g:AA"]').dispatch('click');
      await settle();
    },
    async scroll(top) { stream.scrollTop = top; stream.dispatch('scroll'); await settle(); }
  };
}

for (const tab of ['mine', 'external']) {
  test(`${tab} older history starts only within half a viewport and admits one request at a time`, { timeout: 2000 }, async t => {
    const pending = deferred(), f = fixture(t, { older: () => pending.promise });
    await f.open(tab);
    assert.equal(f.olderReads, 0);
    assert.equal(f.root.querySelector('[data-action="loadOlder"]'), null);
    for (const action of ['refreshMessages', 'refreshStatus']) assert.equal(f.root.querySelector(`.conversation-header [data-action="${action}"]`), null);
    await f.scroll(251); await f.scroll(250);
    assert.equal(f.olderReads, 0, 'half a viewport and farther do not trigger a read');
    await f.scroll(249);
    assert.equal(f.olderReads, 1);
    assert.equal(f.root.querySelector('.conversation-history-start-label').textContent, 'chat.page.olderLoading');
    await f.scroll(0); await f.scroll(10); await f.scroll(0);
    assert.equal(f.olderReads, 1, 'scrolls during an unresolved read do not start another');
    pending.resolve({ items: rows(90, 10), nextCursor: null }); await f.settle();
    assert.equal(f.maxInFlight, 1);
    assert.equal(f.root.querySelector('.conversation-history-start-label').textContent, 'chat.page.olderEnd');
    await f.scroll(0); await f.scroll(0);
    assert.equal(f.olderReads, 1, 'an exhausted cursor remains exhausted');
  });

  test(`${tab} short initial history fills one viewport then stops without reading every older page`, { timeout: 2000 }, async t => {
    const f = fixture(t, { initial: rows(100, 2), older: ({ count }) => count === 1
      ? { items: rows(98, 2), nextCursor: 'older-2' }
      : { items: rows(96, 2), nextCursor: 'older-3' } });
    await f.open(tab);
    assert.equal(f.olderReads, 2, 'two short pages extend 200px to 600px in a 500px viewport');
    assert.equal(f.maxInFlight, 1);
    assert.equal(f.list.querySelectorAll('.conversation-message').length, 6);
    assert.ok(f.stream.scrollHeight >= f.stream.clientHeight);
  });

  test(`${tab} an exactly full first viewport does not auto-read an older page`, { timeout: 2000 }, async t => {
    const f = fixture(t, { initial: rows(100, 5) });
    await f.open(tab);
    assert.equal(f.list.scrollHeight, f.stream.clientHeight);
    assert.equal(f.olderReads, 0, 'a full viewport already satisfies the initial fill requirement');
  });

  test(`${tab} an exhausted short first page shows the end and never requests older history`, { timeout: 2000 }, async t => {
    const f = fixture(t, { initial: rows(100, 2), cursor: null });
    await f.open(tab);
    assert.equal(f.root.querySelector('.conversation-history-start-label').textContent, 'chat.page.olderEnd');
    await f.scroll(0); await f.scroll(0);
    assert.equal(f.olderReads, 0);
  });

  test(`${tab} older-history failure stays latched until its retry control is clicked`, { timeout: 2000 }, async t => {
    const f = fixture(t, { older: ({ count }) => count === 1
      ? { status: 503, body: { error: 'chat_history_unavailable' } }
      : { items: rows(90, 10), nextCursor: null } });
    await f.open(tab); await f.scroll(0);
    assert.equal(f.olderReads, 1);
    const retry = f.root.querySelector('[data-action="retryOlder"]');
    assert.ok(retry); assert.equal(retry.hidden, false);
    assert.equal(retry.textContent, 'chat.page.olderRetry');
    for (let i = 0; i < 3; i++) await f.scroll(i);
    assert.equal(f.olderReads, 1, 'more near-top events never automatically retry a failed page');
    retry.dispatch('click'); await f.settle();
    assert.equal(f.olderReads, 2);
    assert.equal(f.list.querySelectorAll('.conversation-message').length, 20);
    assert.equal(f.root.querySelector('.conversation-history-start-label').textContent, 'chat.page.olderEnd');
  });
}
