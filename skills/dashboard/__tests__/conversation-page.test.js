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

function healthPage(t, { locale = 'en', health = 'ok', runtime = 'claude', presence = 'running', pending = true,
  wait = null, source, healthRecord, workbench, onSend } = {}) {
  const translations = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
  const document = conversationDocument(), root = document.createElement('div');
  const sessionGroup = 'dashboard:health', id = 'g:AA';
  const page = mountConversationPage({ root, document, t: key => translations[key] ?? key, fetch: async path => {
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path === '/api/workbench/groups' ? workbench?.() ?? { listKnown: true,
        rows: [{ sessionGroup, presence, target: { runtime }, wait }],
        instance: { runtimeHealth: { claude: { health: 'rate_limited' }, codex: { health: 'auth_failed' },
          [runtime]: healthRecord ?? { health, ...(source ? { source } : {}) } } },
        sources: { status: { ok: true, readAt: 1000 } } }
      : path.startsWith('/api/chat/conversations?') ? { items: [{ id, sessionGroup }], nextCursor: null }
      : path.endsWith('/send') ? onSend?.() ?? { stored: true, conversationId: id }
      : path.includes('/messages?') ? { items: [...((typeof pending === 'function' ? pending() : pending) ? [{ id: 1, direction: 'in', status: 'pending', content: 'hello' }] : []),
        { id: 2, direction: 'in', status: 'delivered', content: 'already delivered' }], afterCursor: 'after', nextCursor: null }
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id, sessionGroup, state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy());
  return { page, root, sessionGroup, translations };
}

for (const locale of ['en', 'zh']) {
  test(`sending to a healthy idle conversation keeps its running header in ${locale}`, { timeout: 2000 }, async t => {
    let stored = false, groupReads = 0, sends = 0;
    const f = healthPage(t, { locale, health: 'ok', pending: () => stored,
      onSend: () => { stored = true; sends++; return { stored: true, conversationId: 'g:AA' }; },
      workbench: () => {
        groupReads++;
        return { listKnown: true,
          rows: [{ sessionGroup: 'dashboard:health', presence: 'running', target: { runtime: 'claude' },
            live: { status: { valid: true, state: 'idle' } }, wait: stored ? { kind: 'unknown', reason: 'no_rule' } : null }],
          instance: { runtimeHealth: { claude: { health: 'ok' } } }, sources: { status: { ok: true, readAt: 1000 } } };
      } });
    await f.page.openGroup(f.sessionGroup); await tick();
    const header = f.root.querySelector('.conversation-running');
    assert.equal(header.textContent, f.translations['chat.page.running']);
    assert.equal(groupReads, 1);
    const input = f.root.querySelector('.conversation-input');
    input.value = 'new message'; input.dispatch('input');
    f.root.querySelector('.conversation-composer').dispatch('submit', { preventDefault() {} });
    await tick(); await tick();
    assert.equal(sends, 1);
    assert.equal(groupReads, 1, 'healthy sends do not sample a transient idle queue');
    assert.equal(header.hidden, false);
    assert.equal(header.textContent, f.translations['chat.page.running']);
    assert.equal(header.classList.contains('conversation-restricted'), false);
    assert.equal(header.classList.contains('conversation-waiting'), false);
    assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.pending']));
  });
  for (const [health, label] of [
    ['ok', 'running'], ['rate_limited', 'rateLimited'], ['recovering', 'recovering'],
    ['auth_failed', 'authFailed'], ['unavailable', 'unavailable'], ['down', 'down'],
    ['future_health', 'healthUnknown'], [null, 'healthUnknown']
  ]) for (const pending of [true, false]) {
    test(`conversation header renders ${health ?? 'unreadable health'} with ${pending ? 'pending' : 'no pending'} messages in ${locale}`, { timeout: 2000 }, async t => {
      const wait = pending && ['rate_limited', 'recovering'].includes(health) ? { kind: 'rate_wait', runtime: 'claude' } : null;
      const f = healthPage(t, { locale, health, pending, wait });
      await f.page.openGroup(f.sessionGroup); await tick();
      const header = f.root.querySelector('.conversation-running');
      assert.equal(header.hidden, false);
      assert.equal(header.classList.contains('conversation-restricted'), health !== 'ok');
      assert.ok(f.translations['chat.page.' + label], 'the locale defines the status label');
      assert.equal(header.textContent, f.translations['chat.page.' + label + (wait ? 'Pending' : '')]);
      assert.equal(header.textContent.includes(locale === 'zh' ? '恢复后自动投递' : 'delivery resumes after recovery'), wait?.kind === 'rate_wait');
      if (pending) {
        const status = f.root.querySelector('[data-message-id="1"] .conversation-message-status');
        const key = wait ? health === 'recovering' ? 'recovering' : 'rateLimited' : 'pending';
        assert.ok(f.translations['chat.page.delivery.' + key]);
        assert.ok(status.textContent.includes(f.translations['chat.page.delivery.' + key]));
      }
      assert.ok(f.root.querySelector('[data-message-id="2"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.delivered']));
    });
  }
  for (const runtime of ['claude', 'codex']) {
    test(`conversation header uses ${runtime} health independently of the other runtime in ${locale}`, { timeout: 2000 }, async t => {
      const f = healthPage(t, { locale, runtime, health: 'ok' });
      await f.page.openGroup(f.sessionGroup); await tick();
      const header = f.root.querySelector('.conversation-running');
      assert.equal(header.hidden, false);
      assert.equal(header.classList.contains('conversation-restricted'), false);
      assert.equal(header.textContent, f.translations['chat.page.running']);
      assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.pending']));
    });
  }
  for (const [health, wait] of [['rate_limited', null], ['ok', { kind: 'rate_wait', runtime: 'claude' }]]) {
    test(`conversation delivery follows server wait instead of ${health} health in ${locale}`, { timeout: 2000 }, async t => {
      const f = healthPage(t, { locale, health, wait });
      await f.page.openGroup(f.sessionGroup); await tick();
      const header = f.root.querySelector('.conversation-running');
      assert.equal(header.classList.contains('conversation-restricted'), true);
      assert.equal(header.textContent.includes(locale === 'zh' ? '恢复后自动投递' : 'delivery resumes after recovery'), wait !== null);
      assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations[wait ? 'chat.page.delivery.rateLimited' : 'chat.page.delivery.pending']));
    });
  }
  for (const presence of ['running', 'not_running']) {
    test(`a missing health source preserves ${presence} presence semantics in ${locale}`, { timeout: 2000 }, async t => {
      const f = healthPage(t, { locale, presence, pending: false,
        healthRecord: { source: 'missing', health: 'ok', publicHealth: 'ok', cooldownUntil: null, updatedAt: null } });
      await f.page.openGroup(f.sessionGroup); await tick();
      const header = f.root.querySelector('.conversation-running');
      assert.equal(header.hidden, presence !== 'running');
      assert.equal(header.classList.contains('conversation-restricted'), false);
      if (presence === 'running') assert.equal(header.textContent, f.translations['chat.page.running']);
    });
  }
  for (const [kind, label] of [['auth_wait', 'authFailed'], ['fenced', 'paused'], ['starting', 'starting'],
    ['start_failed', 'startFailed']]) {
    test(`server ${kind} wait cannot display a green running header in ${locale}`, async t => {
      const f = healthPage(t, { locale, health: 'ok', wait: { kind } });
      await f.page.openGroup(f.sessionGroup); await tick();
      const header = f.root.querySelector('.conversation-running');
      assert.equal(header.hidden, false);
      assert.equal(header.classList.contains('conversation-restricted'), true);
      assert.equal(header.textContent, f.translations['chat.page.' + label]);
      assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.pending']));
    });
  }
  for (const [presence, reason] of [['not_running', 'pool_occupancy_unreadable'], ['running', 'no_rule'],
    ['running', 'queue_summary_failed'], ['not_running', 'queue_summary_failed']]) {
    test(`healthy ${presence} group waiting for ${reason} has a neutral header in ${locale}`, { timeout: 2000 }, async t => {
      const f = healthPage(t, { locale, health: 'ok', presence, wait: { kind: 'unknown', reason } });
      await f.page.openGroup(f.sessionGroup); await tick();
      const header = f.root.querySelector('.conversation-running');
      assert.equal(header.hidden, false);
      assert.equal(header.classList.contains('conversation-restricted'), false);
      assert.equal(header.classList.contains('conversation-waiting'), true);
      assert.equal(header.textContent, f.translations['chat.page.waiting']);
      assert.ok(f.translations['chat.page.waiting']);
      assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.pending']));
    });
  }
  test(`a group waiting for capacity has a neutral queueing header in ${locale}`, { timeout: 2000 }, async t => {
    const f = healthPage(t, { locale, health: 'ok', presence: 'not_running', wait: { kind: 'pool_wait', position: 2 } });
    await f.page.openGroup(f.sessionGroup); await tick();
    const header = f.root.querySelector('.conversation-running');
    assert.equal(header.hidden, false);
    assert.equal(header.classList.contains('conversation-restricted'), false);
    assert.equal(header.classList.contains('conversation-waiting'), true);
    assert.equal(header.textContent, locale === 'zh' ? '排队中' : 'Queueing');
    assert.doesNotMatch(header.textContent, /pool|held|K|运行中|running/i);
    assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.pending']));
  });
  for (const [health, label] of [['rate_limited', 'rateLimited'], ['recovering', 'recovering'],
    ['auth_failed', 'authFailed'], ['unavailable', 'unavailable'], ['down', 'down'], [null, 'healthUnknown'], ['future_health', 'healthUnknown']]) {
    test(`unknown wait retains ${health ?? 'unreadable'} health status in ${locale}`, { timeout: 2000 }, async t => {
      const f = healthPage(t, { locale, health, wait: { kind: 'unknown', reason: 'no_rule' } });
      await f.page.openGroup(f.sessionGroup); await tick();
      const header = f.root.querySelector('.conversation-running');
      assert.equal(header.hidden, false);
      assert.equal(header.classList.contains('conversation-restricted'), true);
      assert.equal(header.classList.contains('conversation-waiting'), false);
      assert.equal(header.textContent, f.translations['chat.page.' + label]);
    });
  }
  test(`a queued wait cannot manufacture running presence in ${locale}`, async t => {
    const f = healthPage(t, { locale, health: 'ok', presence: 'not_running', wait: { kind: 'queued' } });
    await f.page.openGroup(f.sessionGroup); await tick();
    assert.equal(f.root.querySelector('.conversation-running').hidden, true);
  });
  test(`a non-running recovering group stays restricted without a delivery promise in ${locale}`, { timeout: 2000 }, async t => {
    const f = healthPage(t, { locale, presence: 'not_running', health: 'recovering', pending: false });
    await f.page.openGroup(f.sessionGroup); await tick();
    const header = f.root.querySelector('.conversation-running');
    assert.equal(header.hidden, false);
    assert.equal(header.classList.contains('conversation-restricted'), true);
    assert.equal(header.textContent, f.translations['chat.page.recovering']);
  });
  test(`a non-running group with unreadable health cannot claim running in ${locale}`, { timeout: 2000 }, async t => {
    const f = healthPage(t, { locale, presence: 'not_running', health: null, pending: false });
    await f.page.openGroup(f.sessionGroup); await tick();
    assert.equal(f.root.querySelector('.conversation-running').hidden, true);
  });
  for (const failure of ['request failure', 'unreadable source']) {
    test(`the conversation page clears restriction after ${failure} in ${locale}`, { timeout: 2000 }, async t => {
      let failed = false;
      const f = healthPage(t, { locale, workbench: () => {
        if (failed && failure === 'request failure') throw new Error('unavailable fixture');
        return { listKnown: true, rows: [{ sessionGroup: 'dashboard:health', presence: 'running', target: { runtime: 'claude' },
          wait: { kind: 'rate_wait', runtime: 'claude' } }], instance: { runtimeHealth: { claude: { health: 'recovering' } } },
        sources: { status: { ok: !failed, readAt: 1000 } } };
      } });
      await f.page.openGroup(f.sessionGroup); await tick();
      assert.equal(f.root.querySelector('.conversation-running').hidden, false);
      assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.recovering']));
      failed = true;
      await f.page.openGroup(f.sessionGroup); await tick();
      assert.equal(f.root.querySelector('.conversation-running').hidden, true);
      assert.ok(f.root.querySelector('[data-message-id="1"] .conversation-message-status').textContent.includes(f.translations['chat.page.delivery.pending']));
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

for (const allowed of [false, true]) test(`conversation list ${allowed ? 'shows' : 'hides'} delete actions from the server permission`, async t => {
  const document = pageDocument(), root = document.createElement('div');
  const page = mountConversationPage({ root, document, local: () => true, fetch: async path => {
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.startsWith('/api/chat/conversations?') ? { items: [{ id: 'g:AA', sessionGroup: 'dashboard:owned' }], nextCursor: null, deletionAllowed: allowed }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy()); await page.open();
  const actions = allNodes(root).filter(node => node.classList.contains('conversation-delete'));
  assert.equal(actions.length, 1);
  assert.equal(actions[0].hidden, !allowed);
});

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

for (const locale of ['en', 'zh']) test(`push updates preserve the editor and old reading position while localizing connection state in ${locale}`, async t => {
  const translations = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
  const document = conversationDocument(), root = document.createElement('div');
  let updated = false, subscription;
  const original = { id: 1, direction: 'in', status: 'pending', content: 'first message' };
  const page = mountConversationPage({ root, document, t: key => translations[key] ?? key,
    onStreamSubscription: value => { subscription = value; }, fetch: async path => {
      const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
        : path.startsWith('/api/chat/conversations?') ? { items: [{ id: 'g:AA', displayName: 'Push fixture' }], nextCursor: null }
        : path.includes('/messages?') ? { items: updated ? [original, { id: 2, direction: 'out', status: 'delivered', content: 'new reply' }] : [original], afterCursor: 'after', nextCursor: null }
        : path.includes('/status?') ? { items: updated ? [{ ...original, status: 'delivered' }] : [] }
        : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', state: 'active' } }
        : { items: [], nextCursor: null };
      return { ok: true, status: 200, json: async () => body };
    } });
  t.after(() => page.destroy()); await page.open();
  allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  const input = root.querySelector('.conversation-input'), message = root.querySelector('[data-message-id="1"]');
  input.value = 'keep editor'; input.dispatch('input'); input.focus(); input.selectionStart = 3;
  const stream = root.querySelector('.conversation-stream');
  stream.scrollHeight = 1000; stream.clientHeight = 200; stream.scrollTop = 100;
  page.streamStatus('connecting', subscription);
  assert.equal(root.querySelector('.conversation-push-status').textContent, translations['chat.page.push.connecting']);
  updated = true;
  page.streamEvent('chat_ready', { version: 1, ids: [], ...subscription }, subscription); await tick(); await tick();
  assert.equal(root.querySelector('.conversation-push-status').textContent, translations['chat.page.push.live']);
  assert.equal(root.querySelector('[data-message-id="1"]'), message);
  assert.equal(root.querySelector('.conversation-input'), input);
  assert.equal(document.activeElement, input); assert.equal(input.value, 'keep editor'); assert.equal(input.selectionStart, 3);
  assert.equal(stream.scrollTop, 100);
  assert.equal(root.querySelector('[data-action="latest"]').hidden, false);
  assert.ok(root.querySelector('[data-message-id="2"]'));
  assert.equal(message.querySelector('[data-delivery-state="delivered"]').hidden, false);
  page.streamStatus('disconnected', subscription);
  assert.equal(root.querySelector('.conversation-push-status').textContent, translations['chat.page.push.polling']);
  assert.equal(root.querySelector('.conversation-header [data-action="refreshMessages"]'), null); assert.equal(root.querySelector('.conversation-header [data-action="refreshStatus"]'), null);
  page.close(); assert.equal(subscription, null);
});


test('initial ready catchup releases the loading notice without manual header read controls', async t => {
  const document = conversationDocument(), root = document.createElement('div');
  const resolvers = []; let subscription;
  const page = mountConversationPage({ root, document, onStreamSubscription: value => { subscription = value; }, fetch: async path => {
    let body;
    if (path.startsWith('/api/chat/conversations?')) body = await new Promise(resolve => { resolvers.push(resolve); });
    else body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.includes('/messages?') ? { items: [{ id: 1, direction: 'in', status: 'pending', content: 'hello' }], afterCursor: 'after', nextCursor: null }
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy());
  const opening = page.open(); await tick();
  page.streamStatus('connecting', subscription);
  page.streamEvent('chat_ready', { version: 1, ids: [], ...subscription }, subscription); await tick();
  assert.equal(resolvers.length, 2);
  resolvers[1]({ items: [{ id: 'g:AA', displayName: 'Current data' }], nextCursor: null }); await tick(); await tick();
  allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  assert.equal(root.querySelector('.conversation-list-notice').hidden, true);
  for (const action of ['refreshMessages', 'refreshStatus']) assert.equal(root.querySelector(`.conversation-header [data-action="${action}"]`), null);
  resolvers[0]({ items: [{ id: 'g:BB', displayName: 'Stale data' }], nextCursor: null }); await opening;
  assert.equal(root.querySelector('.conversation-list-notice').hidden, true);
  for (const action of ['refreshMessages', 'refreshStatus']) assert.equal(root.querySelector(`.conversation-header [data-action="${action}"]`), null);
  assert.equal(allNodes(root).some(node => node.dataset.conversationId === 'g:BB'), false);
});


for (const locale of ['en', 'zh']) for (const retainedMessages of [0, 2]) for (const countsEstimated of [false, true]) {
  test(`completed deletion ${retainedMessages ? 'shows retained memory' : 'omits retention notice'} in ${locale} with ${countsEstimated ? 'estimated' : 'exact'} counts`, async t => {
    const document = conversationDocument(), root = document.createElement('div');
    document.documentElement = { lang: locale };
    const translations = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
    const translate = (key, args = {}) => (translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(args[name]));
    const result = { ok: true, pending: false, retainedMessages, groupDataRetained: retainedMessages > 0, countsEstimated };
    let deleted = false, writes = 0, identity = 'local-a';
    const page = mountConversationPage({ root, document, local: () => true, identity: () => identity,
      t: translate, confirm: async () => true, fetch: async (path, options = {}) => {
        let body;
        if (options.method === 'DELETE') { deleted = true; writes++; body = result; }
        else body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
          : path.endsWith('/deletion') ? { ok: true, operationId: 'retention-operation', cutoffId: 4, messages: 4, attachments: 0 }
          : path.startsWith('/api/chat/conversations?') ? { items: deleted ? [] : [{ id: 'g:AA', sessionGroup: 'dashboard:retention' }],
            nextCursor: null, deletionAllowed: true }
          : { items: [], nextCursor: null };
        return { ok: true, status: 200, json: async () => body };
      } });
    t.after(() => page.destroy());
    await page.open();
    root.querySelector('.conversation-delete').dispatch('click');
    await tick(); await tick();
    assert.equal(writes, 1, 'the mounted page performed the confirmed delete');
    const notice = root.querySelector('.conversation-deletion-notice');
    assert.equal(notice.hidden, retainedMessages === 0 && !countsEstimated);
    const expected = [retainedMessages ? translate('chat.delete.retained', { count: retainedMessages }) : '',
      countsEstimated ? translate('chat.delete.estimated') : ''].filter(Boolean).join(locale === 'zh' ? '' : ' ');
    assert.equal(notice.textContent, expected);
    if (retainedMessages) {
      identity = 'local-b';
      await page.open();
      assert.equal(notice.hidden, true, 'a completion from another instance is not shown');
      assert.equal(notice.textContent, '');
    }
  });
}
