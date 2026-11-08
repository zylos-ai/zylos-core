import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, visibleNodes, tick } from './helpers/conversation-dom.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
const shared = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(shared, context);
  return next(specifier, context);
} });
const { mountConversationPage, disposeMissingMessages } = await import('../public/js/wb/conversation-page.js');
const { renderConversationContent } = await import('../public/js/wb/conversation-content.js');
// Real page -> content renderer -> Chart resource. Injected transport and Chart only; no network/DB/tmux/PM2.
// Run on page resource ownership changes. t.after destroys page and all timers on every outcome.
const content = title => CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'chart-message', fallbackText: 'Traffic', blocks: [
  { id: 'traffic', type: 'time_series', schemaVersion: 1, fallbackText: 'Traffic table', data: { title, xType: 'category', series: [
    { key: 'a', label: 'A', points: [{ x: 'one', y: 1 }] }
  ] } }
] });
async function fixture(t, { initialContent = content('First'), initialTz } = {}) {
  const document = createDocument(), root = document.createElement('div'), instances = [];
  let value = initialContent, blocked = false, tz = initialTz;
  class Chart {
    constructor(canvas, config) { assert.ok(allNodes(root).includes(canvas), 'canvas attached before Chart creation'); this.disposals = 0; this.data = config.data; this.options = config.options; instances.push(this); }
    resize() {} update() {} destroy() { this.disposals++; }
  }
  document.defaultView = { Chart, innerWidth: 390, addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  const page = mountConversationPage({ root, document, fetch: async p => {
    let data;
    if (blocked) return { ok: false, status: 403, json: async () => ({ error: 'remote_chat_disabled' }) };
    if (p.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: value }], nextCursor: null, afterCursor: 'after', ...(tz === undefined ? {} : { tz }) };
    else if (p.includes('/questions?') || p.includes('/status?')) data = { items: [], nextCursor: null };
    else if (p.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/\/g%3A(?:AA|BB)$/.test(p)) data = { conversation: { id: p.endsWith('AA') ? 'g:AA' : 'g:BB', state: 'active' } };
    else data = { items: [{ id: 'g:AA' }, { id: 'g:BB' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  t.after(() => page.destroy()); await page.open();
  const select = async id => { visibleNodes(root).find(n => n.dataset.conversationId === id).dispatch('click'); await tick(); await tick(); };
  await select('g:AA');
  return { page, root, instances, select, setContent(v) { value = v; }, setTz(v) { tz = v; }, block() { blocked = true; },
    async refresh() { visibleNodes(root).find(n => n.dataset.action === 'refreshMessages').dispatch('click'); await tick(); await tick(); } };
}
test('page mounts attached chart once, keeps it on polling and disposes changed content including replacement with plain text', async t => {
  const f = await fixture(t); assert.equal(f.instances.length, 1);
  await f.refresh(); assert.equal(f.instances.length, 1); assert.equal(f.instances[0].disposals, 0);
  f.setContent(content('Changed')); await f.refresh();
  assert.equal(f.instances.length, 2); assert.equal(f.instances[0].disposals, 1);
  f.setContent('Plain content replaces chart'); await f.refresh();
  assert.equal(f.instances[1].disposals, 1); assert.equal(f.root.querySelector('canvas'), null);
  f.page.destroy(); assert.equal(f.instances[1].disposals, 1);
});
test('conversation switch disposes old chart, and final destroy disposes current chart exactly once', async t => {
  const f = await fixture(t); await f.select('g:BB');
  assert.equal(f.instances.length, 2); assert.equal(f.instances[0].disposals, 1);
  f.page.destroy(); f.page.destroy(); assert.equal(f.instances[1].disposals, 1);
});
test('remote closure releases chart resources immediately and final destroy does not repeat disposal', async t => {
  const f = await fixture(t); f.block(); await f.refresh();
  assert.equal(f.instances[0].disposals, 1); assert.equal(f.root.querySelector('canvas'), null);
  f.page.destroy(); assert.equal(f.instances[0].disposals, 1);
});


test('message ids disappearing from a snapshot release their chart and DOM while retained ids remain mounted', () => {
  const document = createDocument(), root = document.createElement('div'), instances = [];
  document.defaultView = { Chart: class {
    constructor(canvas) {
      assert.ok(allNodes(root).includes(canvas));
      this.disposals = 0; instances.push(this);
    }
    resize() {} update() {} destroy() { this.disposals++; }
  } };
  const messages = new Map();
  for (const id of ['12', '13']) {
    const node = document.createElement('article'); node.dataset.messageId = id;
    const resource = renderConversationContent({ document, row: { id, direction: 'out', content: content('Chart ' + id) } });
    node.append(resource); root.append(node); resource.mount();
    messages.set(id, { node, resource });
  }
  assert.equal(instances.length, 2);
  const removedNode = messages.get('12').node, retainedNode = messages.get('13').node;
  try {
    disposeMissingMessages(messages, new Set(['13']));
    assert.equal(messages.has('12'), false);
    assert.equal(messages.get('13').node, retainedNode);
    assert.equal(removedNode.parentNode, null);
    assert.equal(root.children.length, 1);
    assert.equal(root.firstElementChild, retainedNode);
    assert.equal(instances[0].disposals, 1);
    assert.equal(instances[1].disposals, 0);
    disposeMissingMessages(messages, new Set(['13']));
    assert.equal(instances[0].disposals, 1);
    assert.equal(instances[1].disposals, 0);
  } finally {
    disposeMissingMessages(messages, new Set());
  }
  assert.equal(messages.size, 0);
  assert.equal(instances[0].disposals, 1);
  assert.equal(instances[1].disposals, 1);
});

const daily = CONTENT_PREFIX + JSON.stringify({ version: 1, kind: 'message', messageId: 'daily-message', fallbackText: 'Daily', blocks: [
  { id: 'daily', type: 'time_series', schemaVersion: 1, fallbackText: 'Daily table', data: { title: 'Daily', xType: 'date', series: [
    { key: 'a', label: 'A', points: [{ x: Date.UTC(2026, 10, 1, 16), y: 1 }, { x: '2026-11-05', y: 2 }] }
  ] } }
] });
const localDay = stamp => { const d = new Date(stamp); return [d.getMonth() + 1, d.getDate(), d.getHours()]; };
// Real page -> state -> content -> chart resource with the time zone the message history reports. The process zone
// stands in for the browser's and is set apart from the instance zone, so only the reported zone can give the result.
test('daily chart points use the instance time zone from the message history, not the browser zone, and follow a change', async t => {
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = 'America/Los_Angeles';
  const f = await fixture(t, { initialContent: daily, initialTz: 'Asia/Shanghai' });
  assert.equal(f.instances.length, 1);
  assert.deepEqual(f.instances[0].data.datasets[0].data.map(point => localDay(point.x)), [[11, 2, 0], [11, 5, 0]]);
  f.setTz('UTC'); await f.refresh();
  assert.equal(f.instances.length, 1, 'the same chart is redrawn');
  assert.deepEqual(f.instances[0].data.datasets[0].data.map(point => localDay(point.x)), [[11, 1, 0], [11, 5, 0]]);
  f.setTz('Asia/Shanghai'); await f.refresh();
  assert.deepEqual(f.instances[0].data.datasets[0].data.map(point => localDay(point.x)), [[11, 2, 0], [11, 5, 0]]);
  f.setTz(null); await f.refresh();
  assert.equal(f.instances.length, 1, 'the same chart is redrawn when the zone becomes unknown');
  assert.deepEqual(f.instances[0].data.datasets[0].data.map(point => localDay(point.x)), [[11, 1, 0], [11, 5, 0]],
    'a zone that can no longer be read falls back to UTC');
});

test('a message history without a time zone (an older instance) reads daily points in UTC', async t => {
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = 'Asia/Shanghai';
  const f = await fixture(t, { initialContent: daily });
  assert.deepEqual(f.instances[0].data.datasets[0].data.map(point => localDay(point.x)), [[11, 1, 0], [11, 5, 0]]);
});
