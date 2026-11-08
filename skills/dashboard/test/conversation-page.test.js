import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick } from './fixtures/workbench-dom.js';
import { createDocument as conversationDocument } from './helpers/conversation-dom.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');

for (const locale of ['en', 'zh']) {
  for (const { health, runtime, presence } of [
    { health: 'rate_limited', runtime: 'claude', presence: 'running' },
    { health: 'ok', runtime: 'claude', presence: 'running' },
    { health: 'rate_limited', runtime: 'claude', presence: 'not_running' },
    { health: 'ok', runtime: 'codex', presence: 'running' }
  ]) {
    test(`conversation page renders ${runtime} ${health} pending delivery while ${presence} in ${locale}`, { timeout: 2000 }, async t => {
      const translations = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
      const document = conversationDocument(), root = document.createElement('div');
      const sessionGroup = 'dashboard:limited', id = 'g:AA';
      const page = mountConversationPage({ root, document, t: key => translations[key] ?? key, fetch: async path => {
        const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
          : path === '/api/workbench/groups' ? { listKnown: true, rows: [{ sessionGroup, presence, target: { runtime } }],
            instance: { runtimeHealth: { claude: { health: runtime === 'codex' ? 'rate_limited' : health }, codex: { health: 'ok' } } },
            sources: { status: { ok: true, readAt: 1000 } } }
          : path.startsWith('/api/chat/conversations?') ? { items: [{ id, sessionGroup }], nextCursor: null }
          : path.includes('/messages?') ? { items: [{ id: 1, direction: 'in', status: 'pending', content: 'hello' },
            { id: 2, direction: 'in', status: 'delivered', content: 'already delivered' }], afterCursor: 'after', nextCursor: null }
          : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id, sessionGroup, state: 'active' } }
          : { items: [], nextCursor: null };
        return { ok: true, status: 200, json: async () => body };
      } });
      t.after(() => page.destroy());
      await page.openGroup(sessionGroup); await tick();
      const header = root.querySelector('.conversation-running');
      assert.equal(header.hidden, false);
      assert.equal(header.classList.contains('conversation-restricted'), health === 'rate_limited');
      assert.equal(header.textContent, translations[health === 'rate_limited' ? 'chat.page.rateLimited' : 'chat.page.running']);
      const pending = root.querySelector('[data-message-id="1"] .conversation-message-status');
      assert.ok(pending.textContent.includes(translations[health === 'rate_limited' ? 'chat.page.delivery.rateLimited' : 'chat.page.delivery.pending']));
      assert.ok(root.querySelector('[data-message-id="2"] .conversation-message-status').textContent.includes(translations['chat.page.delivery.delivered']));
    });
  }
}

// Only DOM ownership is needed here; layout remains covered by the browser case.
// No sockets, databases, storage, subprocesses or real network requests are used.
function pageDocument() {
  const document = createDocument();
  const createElement = document.createElement;
  document.createElement = tag => {
    const node = createElement(tag);
    Object.defineProperty(node, 'lastElementChild', { get: () => node.children.at(-1) });
    node.remove = () => {
      if (node.parentNode) node.parentNode.children = node.parentNode.children.filter(child => child !== node);
      node.parentNode = null;
    };
    node.insertBefore = (child, before) => {
      child.remove();
      const index = node.children.indexOf(before);
      node.children.splice(index < 0 ? node.children.length : index, 0, child);
      child.parentNode = node;
    };
    node.append = (...children) => children.forEach(child => node.insertBefore(child, null));
    node.replaceChildren = (...children) => {
      node.children.forEach(child => { child.parentNode = null; });
      node.children = [];
      node.append(...children);
    };
    node.querySelectorAll = selector => allNodes(node).slice(1).filter(child =>
      selector.startsWith('.') && child.classList.contains(selector.slice(1)));
    node.getBoundingClientRect = () => ({ top: 0, bottom: 0 });
    node.scrollTop = node.scrollHeight = node.clientHeight = 0;
    return node;
  };
  return document;
}

test('mounted conversation page forwards language headers without adding query parameters', async t => {
  for (const locale of ['zh', 'en']) {
    const document = pageDocument(), root = document.createElement('div'), reads = [];
    document.documentElement = { lang: locale };
    const sessionGroup = 'dashboard:locale-header', id = 'g:' + Buffer.from(sessionGroup).toString('hex').toUpperCase();
    const page = mountConversationPage({ root, document, fetch: async (path, options) => {
      if (path.startsWith('/api/chat/conversations?') || path.includes('/messages?')) reads.push({ path, options });
      const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
        : path.startsWith('/api/chat/conversations?') ? { items: [{ id, sessionGroup }], nextCursor: null }
        : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id, sessionGroup, state: 'active' } }
        : { items: [], nextCursor: null, afterCursor: 'after' };
      return { ok: true, status: 200, json: async () => body };
    } });
    t.after(() => page.destroy());
    assert.equal(await page.openGroup(sessionGroup), true);
    assert.ok(reads.some(row => row.path.includes('/messages?')));
    for (const row of reads) {
      assert.equal(new URL(row.path, 'http://fixture').searchParams.has('locale'), false);
      assert.equal(row.options.headers['X-Zylos-Locale'], locale);
    }
    page.destroy();
  }
});

for (const stop of ['close', 'destroy']) {
  test(`conversation page forwards the group request signal and aborts it on ${stop}`, { timeout: 2000 }, async t => {
    const document = pageDocument(), root = document.createElement('div');
    const sessionGroup = 'dashboard:page-signal', id = 'g:' + Buffer.from(sessionGroup).toString('hex').toUpperCase();
    let signal, aborts = 0;
    const page = mountConversationPage({ root, document, fetch: async (path, options) => {
      if (path === '/api/workbench/groups') {
        signal = options.signal;
        assert.ok(signal instanceof AbortSignal, 'the actual page request adapter passes an AbortSignal to fetch');
        return new Promise((resolve, reject) => signal.addEventListener('abort', () => {
          aborts++;
          reject(new Error('aborted'));
        }, { once: true }));
      }
      const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
        : path.startsWith('/api/chat/conversations?') ? { items: [{ id, sessionGroup }], nextCursor: null }
        : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id, sessionGroup, state: 'active' } }
        : { items: [], nextCursor: null, afterCursor: 'after' };
      return { ok: true, status: 200, json: async () => body };
    } });
    t.after(() => page.destroy());
    assert.equal(await page.openGroup(sessionGroup), true);
    assert.ok(signal, 'selecting an active conversation starts its optional group request');
    assert.equal(signal.aborted, false);
    page[stop]();
    await tick();
    assert.equal(signal.aborted, true);
    assert.equal(aborts, 1, 'the fetch transport observes cancellation exactly once');
  });
}


test('page reconciliation disposes charts owned by a message that leaves its snapshot', async t => {
  const document = conversationDocument(), root = document.createElement('div');
  const charts = [];
  document.defaultView = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Chart: class {
    constructor(canvas) { this.canvas = canvas; this.destroyCalls = 0; charts.push(this); }
    resize() {}
    destroy() { this.destroyCalls++; }
  } };
  const content = '[C4-JSON]\n' + JSON.stringify({ version: 1, kind: 'message', messageId: 'chart-message', fallbackText: 'A single chart', blocks: [
    { id: 'series', type: 'time_series', schemaVersion: 1, fallbackText: 'first: 1', data: { xType: 'category', series: [
      { key: 'first', label: 'First', points: [{ x: 'first', y: 1 }] }
    ] } }
  ] });
  const removedRow = { id: 10, direction: 'out', content }, retainedRow = { id: 20, direction: 'out', content };
  const page = mountConversationPage({ root, document, fetch: async path => {
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.startsWith('/api/chat/conversations?') ? { items: [{ id: 'g:AA', displayName: 'Charts' }], nextCursor: null }
      : path.includes('/messages?') ? { items: [removedRow, retainedRow], nextCursor: null, afterCursor: 'after' }
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy());
  await page.open();
  allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click');
  await tick(); await tick();
  assert.equal(charts.length, 2, 'the actual mounted page owns both chart resources');
  const removedNode = root.querySelector('[data-message-id="10"]');
  const retainedNode = root.querySelector('[data-message-id="20"]');
  assert.ok(removedNode); assert.ok(retainedNode);
  // The state deliberately merges history and exposes the same row objects to
  // its page snapshot. Change a fixture-owned row identity to exercise a missing
  // id on that real snapshot, without replacing the state or page reconciler.
  removedRow.id = 11;
  page.redraw();
  assert.equal(charts[0].destroyCalls, 1, 'missing message chart is destroyed by page reconciliation');
  assert.equal(charts[1].destroyCalls, 0, 'retained message chart stays alive');
  assert.equal(root.querySelector('[data-message-id="10"]'), null);
  assert.equal(removedNode.parentNode, null);
  assert.equal(root.querySelector('[data-message-id="20"]'), retainedNode);
  page.redraw();
  assert.equal(charts[0].destroyCalls, 1, 'a later reconciliation does not dispose twice');
  page.destroy();
  assert.equal(charts[0].destroyCalls, 1);
  assert.equal(charts[1].destroyCalls, 1);
});

test('attachment metadata recovery retains the message anchor focused form and chart instance', async t => {
  const fs = await import('node:fs');
  const envelope = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url))).formQuestion;
  const form = envelope.blocks[0];
  form.data.fields.push({ key: 'visible_note', type: 'text', label: 'Visible note' });
  envelope.blocks.unshift(
    { id: 'image', type: 'x-zylos.image', schemaVersion: 1, fallbackText: 'Photo', data: { attachmentId: 'att_recover', nameSnapshot: 'photo.png' } },
    { id: 'chart', type: 'time_series', schemaVersion: 1, fallbackText: 'One: 1', data: { xType: 'category', series: [{ key: 'one', label: 'One', points: [{ x: 'one', y: 1 }] }] } }
  );
  const document = conversationDocument(), root = document.createElement('div'), create = document.createElement, charts = [];
  document.createElement = tag => { const node = create(tag); node.removeAttribute = name => { delete node.attributes[name]; }; return node; };
  document.defaultView = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, Chart: class {
    constructor(canvas) { this.canvas = canvas; this.destroyCalls = 0; charts.push(this); }
    resize() {}
    destroy() { this.destroyCalls++; }
  } };
  const row = { id: 10, direction: 'out', content: '[C4-JSON]\n' + JSON.stringify(envelope), attachments: [{ name: 'photo.png', kind: 'image', available: false }] };
  const question = { c4Id: '10', messageId: envelope.messageId, interruptId: envelope.interruptId, questionSummary: envelope.questionSummary,
    status: 'paused', constraints: { block: form, interrupt: envelope.interrupt } };
  const page = mountConversationPage({ root, document, fetch: async path => {
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.startsWith('/api/chat/conversations?') ? { items: [{ id: 'g:AA', displayName: 'Media and form' }], nextCursor: null }
      : path.includes('/messages?') ? { items: [row], nextCursor: null, afterCursor: 'after' }
      : path.includes('/questions?') ? { items: [question], nextCursor: null }
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy()); await page.open();
  allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  const message = root.querySelector('[data-message-id="10"]');
  const control = message.querySelector('[data-field-key="visible_note"] input');
  const chart = message.querySelector('canvas');
  assert.ok(control); assert.equal(charts.length, 1);
  control.value = 'Retain this input'; control.dispatch('input'); control.focus(); control.selectionStart = 5;
  assert.equal(message.querySelector('[data-action="downloadAttachment"]'), null);
  // Fixture-owned history data gets new metadata, exercising the real page's
  // metadata-only reconciliation without replacing its controller or renderer.
  row.attachments = [{ id: 'att_recover', name: 'latest-photo.png', kind: 'image', size: 3, available: true }];
  page.redraw();
  assert.equal(root.querySelector('[data-message-id="10"]'), message, 'the original message remains eligible as the scroll anchor');
  assert.equal(message.querySelector('[data-field-key="visible_note"] input'), control);
  assert.equal(document.activeElement, control); assert.equal(control.selectionStart, 5); assert.equal(control.value, 'Retain this input');
  assert.equal(message.querySelector('canvas'), chart); assert.equal(charts.length, 1); assert.equal(charts[0].destroyCalls, 0);
  assert.ok(message.querySelector('[data-action="downloadAttachment"]')); assert.match(message.textContent, /latest-photo.png/);
  page.destroy(); assert.equal(charts[0].destroyCalls, 1);
});
