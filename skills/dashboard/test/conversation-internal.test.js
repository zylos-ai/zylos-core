import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick, visibleText } from './helpers/conversation-dom.js';
import { renderInternalMessage } from '../public/js/wb/conversation-internal.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const translations = locale => JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
const relay = (direction = 'in') => ({ id: 5, channel: 'internal', direction,
  content: '[internal] Yourself, from your "telegram:peer" session group, said: relay body',
  internal: { peerSessionGroup: 'telegram:peer', peerDisplayName: 'Peer room', peerExists: true, peerChannel: 'telegram', content: 'relay body' } });

// Pure product render/controller paths on injected DOM and in-memory fetch. No browser/network/storage or child processes.
for (const locale of ['en', 'zh']) for (const direction of ['out', 'in']) {
  test(`internal ${direction} uses the normal directional bubble and a localized peer label in ${locale}`, () => {
    const document = createDocument(), words = translations(locale), row = relay(direction), opened = [];
    const resource = renderInternalMessage({ document, row, t: key => words[key], onOpenPeer: (...args) => opened.push(args),
      timeText: '12:34', timeIso: '2026-01-01T12:34:00.000Z' });
    assert.equal(resource.node.querySelector('.conversation-internal-label').textContent, words[`chat.internal.${direction === 'out' ? 'sent' : 'received'}`]);
    assert.equal(resource.node.querySelector('.conversation-internal-label').textContent,
      locale === 'zh' ? direction === 'out' ? '发给' : '来自' : direction === 'out' ? 'To' : 'From');
    assert.equal(resource.node.classList.contains('chat-in'), direction === 'in');
    assert.equal(resource.node.classList.contains('chat-out'), direction === 'out');
    assert.ok(resource.node.querySelector('.conversation-message-body.conversation-internal-body'));
    assert.ok(resource.node.querySelector('.chat-message-content>.chat-message-text.conversation-internal-content'));
    assert.equal(resource.node.querySelector('.conversation-internal-content').textContent, 'relay body');
    assert.equal(resource.node.querySelector('.conversation-internal-peer').textContent, 'Peer room');
    assert.equal(resource.node.querySelector('.conversation-internal-peer').tagName, 'BUTTON');
    resource.node.querySelector('.conversation-internal-peer').dispatch('click');
    assert.deepEqual(opened, [['telegram:peer', 'telegram']]);
    assert.equal(resource.node.querySelector('.conversation-internal-raw').hidden, true);
    assert.equal(visibleText(resource.node).includes('[internal] Yourself'), false);
    assert.equal(resource.node.querySelector('time').dateTime, '2026-01-01T12:34:00.000Z');
    assert.equal(resource.node.querySelector('time').parentNode, resource.node.querySelector('.conversation-message-meta'));
    const spacer = resource.node.querySelector('.conversation-avatar');
    assert.equal(spacer.getAttribute('aria-hidden'), 'true');
    assert.equal(spacer.textContent, '');
    for (const selector of ['.chat-message-author', '.wb-ico', '[data-delivery-state]', 'input', 'textarea', 'canvas']) {
      assert.equal(resource.node.querySelector(selector), null, selector);
    }
    resource.update(row, { showTechnicalDetails: true });
    assert.equal(resource.node.querySelector('.conversation-internal-raw').hidden, direction === 'out');
    assert.equal(resource.node.querySelector('pre').textContent, row.content);
    resource.update(row);
    assert.equal(resource.node.querySelector('.conversation-internal-raw').hidden, true);
  });
}

test('internal peer updates preserve plain text and make missing counterparts inert', () => {
  const document = createDocument(), opened = [], row = relay();
  row.internal.peerDisplayName = '<img src=x onerror=alert(1)>';
  row.internal.content = '<script>attack()</script> [C4-JSON] {"blocks":[]}';
  const resource = renderInternalMessage({ document, row, onOpenPeer: (...args) => opened.push(args) });
  assert.equal(resource.node.querySelector('.conversation-internal-peer').textContent, row.internal.peerDisplayName);
  assert.equal(resource.node.querySelector('.conversation-internal-content').textContent, row.internal.content);
  assert.equal(resource.node.querySelector('img'), null);
  assert.equal(resource.node.querySelector('script'), null);
  const sameButton = resource.node.querySelector('.conversation-internal-peer');
  resource.update({ ...row, direction: 'out', internal: { ...row.internal, peerSessionGroup: 'dashboard:new', peerChannel: 'dashboard', peerDisplayName: 'New name' } });
  assert.equal(resource.node.classList.contains('chat-out'), true);
  assert.equal(resource.node.classList.contains('chat-in'), false);
  assert.equal(resource.node.querySelector('.conversation-internal-peer'), sameButton);
  sameButton.dispatch('click');
  assert.deepEqual(opened, [['dashboard:new', 'dashboard']]);
  resource.update({ ...row, internal: { ...row.internal, peerDisplayName: null, peerExists: false } });
  assert.equal(resource.node.classList.contains('chat-in'), true);
  assert.equal(resource.node.classList.contains('chat-out'), false);
  const missingPeer = resource.node.querySelector('.conversation-internal-peer');
  assert.equal(missingPeer.tagName, 'SPAN');
  assert.equal(missingPeer.textContent, 'telegram:peer');
  assert.equal(resource.node.querySelector('.conversation-internal-missing').hidden, false);
  missingPeer.dispatch('click');
  assert.equal(opened.length, 1);
});

test('mounted conversation peer links navigate both tabs and retain raw technical details', async t => {
  const document = createDocument(), root = document.createElement('div'), calls = [];
  const mine = { sessionGroup: 'private:mine', channel: 'dashboard', displayName: 'My room' };
  const external = { sessionGroup: 'telegram:peer', channel: 'telegram', displayName: 'Telegram room' };
  for (const item of [mine, external]) item.id = 'g:' + Buffer.from(item.sessionGroup).toString('hex').toUpperCase();
  const mineRow = relay('out'), externalRow = relay('in');
  externalRow.internal = { ...externalRow.internal, peerSessionGroup: mine.sessionGroup, peerDisplayName: mine.displayName, peerChannel: 'dashboard' };
  let technical = false;
  const page = mountConversationPage({ root, document, technicalDetails: () => technical, fetch: async path => {
    calls.push(path);
    assert.ok(calls.length < 100, 'bounded page request log');
    const u = new URL(path, 'http://fixture');
    const item = u.pathname.includes(encodeURIComponent(external.id)) ? external : mine;
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : u.pathname === '/api/chat/conversations' ? { items: [u.searchParams.get('tab') === 'external' ? external : mine], nextCursor: null }
      : u.pathname.endsWith('/messages') ? { items: [item === external ? externalRow : mineRow], nextCursor: null, afterCursor: 'after' }
      : /\/conversations\/[^/]+$/.test(u.pathname) ? { conversation: { ...item, state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy());
  assert.equal(await page.openGroup(mine.sessionGroup, { channel: mine.channel }), true);
  const note = root.querySelector('.conversation-internal');
  assert.ok(note);
  technical = true; page.redraw();
  assert.equal(root.querySelector('.conversation-internal'), note);
  assert.equal(note.querySelector('pre').textContent, mineRow.content);
  assert.equal(note.querySelector('.conversation-internal-raw').hidden, true, 'outbound raw content would duplicate the body');
  note.querySelector('.conversation-internal-peer').dispatch('click');
  await tick(); await tick();
  assert.ok(calls.some(path => path.includes(encodeURIComponent(external.id) + '/messages?') && path.includes('tab=external')));
  assert.equal(root.querySelector('.conversation-internal-peer').textContent, mine.displayName);
  assert.equal(root.querySelector('.conversation-internal-raw').hidden, false, 'received raw content stays available');
  assert.equal(root.querySelector('pre').textContent, externalRow.content);
  const beforeReturn = calls.length;
  root.querySelector('.conversation-internal-peer').dispatch('click');
  await tick(); await tick();
  assert.ok(calls.slice(beforeReturn).some(path => path.includes(encodeURIComponent(mine.id) + '/messages?') && path.includes('tab=mine')));
  assert.equal(root.querySelector('.conversation-internal-peer').textContent, 'Peer room');
  assert.equal(allNodes(root).filter(node => node.classList.contains('conversation-internal')).length, 1);
});

for (const locale of ['en', 'zh']) for (const peerExists of [false, true]) {
  test(`origin internal peer uses the system assistant name without an unavailable warning in ${locale} (${peerExists})`, () => {
    const document = createDocument(), words = translations(locale), row = relay(), opened = [];
    row.internal = { ...row.internal, peerSessionGroup: 'origin', peerDisplayName: 'origin', peerExists };
    const resource = renderInternalMessage({ document, row, t: key => words[key], onOpenPeer: (...args) => opened.push(args) });
    const peer = resource.node.querySelector('.conversation-internal-peer');
    assert.equal(peer.textContent, words['wb.term.origin']);
    assert.equal(resource.node.querySelector('.conversation-internal-missing').hidden, true);
    assert.equal(peer.tagName, 'SPAN', 'origin has no conversation target, as in the workbench group detail');
    peer.dispatch('click');
    assert.equal(opened.length, 0);
  });
}

function mixedConversation(t, locale) {
  const document = createDocument(), root = document.createElement('div'), words = translations(locale), calls = [];
  const mine = { sessionGroup: 'dashboard:mixed', channel: 'dashboard', displayName: 'My room' };
  const external = { sessionGroup: 'lark:mixed', channel: 'lark', displayName: 'External room' };
  for (const item of [mine, external]) item.id = 'g:' + Buffer.from(item.sessionGroup).toString('hex').toUpperCase();
  const rows = [{ id: 1, direction: 'in', channel: 'openmax', content: 'external incoming', status: 'delivered' },
    { id: 2, direction: 'out', channel: 'telegram', content: 'external outgoing' },
    { ...relay('out'), id: 3 }, { ...relay('in'), id: 4 }];
  let technical = false;
  const translate = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), words[key] ?? key);
  const page = mountConversationPage({ root, document, t: translate, technicalDetails: () => technical, fetch: async path => {
    calls.push(path); assert.ok(calls.length < 100, 'the fixture request history stays bounded');
    const url = new URL(path, 'http://fixture');
    const item = url.pathname.includes(encodeURIComponent(external.id)) ? external : mine;
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : url.pathname === '/api/chat/conversations' ? { items: [url.searchParams.get('tab') === 'external' ? external : mine], nextCursor: null }
      : url.pathname.endsWith('/messages') ? { items: rows, nextCursor: null, afterCursor: 'after' }
      : /\/conversations\/[^/]+$/.test(url.pathname) ? { conversation: { ...item, state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy());
  return { root, page, rows, mine, external, setTechnical(value) { technical = value; page.redraw(); } };
}

// The same four rows are rendered through both real page tabs. These cases own
// labels, directional bubble classes and raw-message availability; browser cases
// own layout/colour. No HTTP, DB, runtime, children or independent timers start.
for (const locale of ['en', 'zh']) {
  test(`external mixed messages identify each row's channel or internal peer in ${locale}`, async t => {
    const f = mixedConversation(t, locale);
    await f.page.openGroup(f.external.sessionGroup, { channel: f.external.channel });
    const message = id => f.root.querySelector(`[data-message-id="${id}"]`);
    const author = id => message(id).querySelector('.chat-message-author');
    assert.equal(author(1).textContent, locale === 'zh' ? '收到 · OpenMax' : 'Received · OpenMax');
    assert.equal(author(2).textContent, locale === 'zh' ? '发出 → Telegram' : 'Sent → Telegram');
    for (const [id, incoming] of [[1, true], [2, false], [3, false], [4, true]]) {
      assert.equal(message(id).classList.contains('chat-in'), incoming);
      assert.equal(message(id).classList.contains('chat-out'), !incoming);
      assert.equal(message(id).classList.contains('conversation-internal'), id >= 3);
    }
    for (const id of [3, 4]) {
      assert.equal(message(id).querySelector('.conversation-internal-label').textContent,
        locale === 'zh' ? id === 3 ? '发出 →' : '收到 ←' : id === 3 ? 'Sent →' : 'Received ←');
      assert.equal(message(id).querySelector('.conversation-internal-peer').textContent, 'Peer room');
      assert.equal(message(id).querySelector('.conversation-internal-badge').textContent, locale === 'zh' ? '内部' : 'Internal');
    }
    for (const id of [1, 2]) {
      assert.equal(message(id).querySelector('.conversation-internal-badge'), null);
      assert.equal(message(id).querySelector('.conversation-internal-raw'), null, 'ordinary channel rows gain no raw-message entry');
    }
    const raw = message(4).querySelector('.conversation-internal-raw');
    assert.equal(raw.hidden, false, 'incoming internal raw is available with technical details off');
    assert.equal(raw.open, false, 'incoming raw starts folded');
    assert.equal(raw.querySelector('summary').textContent, locale === 'zh' ? '原始消息' : 'Original message');
    raw.open = true;
    assert.equal(raw.querySelector('pre').textContent, f.rows[3].content);
    assert.equal(message(3).querySelector('.conversation-internal-raw').hidden, true);
    const incomingAuthor = author(1), outgoingAuthor = author(2);
    f.rows[0].channel = 'feishu'; f.rows[1].channel = 'openmax'; f.page.redraw();
    assert.ok(author(1) === incomingAuthor); assert.ok(author(2) === outgoingAuthor);
    assert.equal(author(1).textContent, locale === 'zh' ? '收到 · Feishu' : 'Received · Feishu');
    assert.equal(author(2).textContent, locale === 'zh' ? '发出 → OpenMax' : 'Sent → OpenMax');
    await f.page.openGroup(f.mine.sessionGroup, { channel: f.mine.channel });
    assert.equal(author(1).textContent, locale === 'zh' ? '你' : 'You');
    assert.equal(author(2).textContent, 'AI');
    for (const [id, incoming] of [[1, true], [2, false], [3, false], [4, true]]) {
      assert.equal(message(id).classList.contains('chat-in'), incoming);
      assert.equal(message(id).classList.contains('chat-out'), !incoming);
      assert.equal(message(id).classList.contains('conversation-internal'), id >= 3);
    }
    for (const id of [3, 4]) {
      assert.equal(message(id).querySelector('.conversation-internal-label').textContent,
        locale === 'zh' ? id === 3 ? '发给' : '来自' : id === 3 ? 'To' : 'From');
      assert.equal(message(id).querySelector('.conversation-internal-badge'), null);
      assert.equal(message(id).querySelector('.conversation-internal-peer').textContent, 'Peer room');
      assert.equal(message(id).querySelector('.conversation-internal-raw').hidden, true);
    }
    f.setTechnical(true);
    assert.equal(message(4).querySelector('.conversation-internal-raw').hidden, false, 'mine retains the existing technical-only raw entry');
    assert.equal(message(3).querySelector('.conversation-internal-raw').hidden, true);
    f.setTechnical(false);
    assert.equal(message(4).querySelector('.conversation-internal-raw').hidden, true);
    await f.page.openGroup(f.external.sessionGroup, { channel: f.external.channel });
    assert.equal(author(1).textContent, locale === 'zh' ? '收到 · Feishu' : 'Received · Feishu');
    assert.equal(message(4).querySelector('.conversation-internal-badge').textContent, locale === 'zh' ? '内部' : 'Internal');
    assert.equal(message(4).querySelector('.conversation-internal-raw').hidden, false);
    assert.equal(message(4).querySelector('.conversation-internal-raw').open, false, 'a newly opened external view starts folded');
  });

  test(`internal message updates follow the current external or mine view in ${locale}`, () => {
    const document = createDocument(), words = translations(locale), row = relay();
    const resource = renderInternalMessage({ document, row, external: true, t: key => words[key] ?? key });
    const raw = resource.node.querySelector('.conversation-internal-raw');
    assert.equal(raw.hidden, false); assert.equal(raw.open, false);
    assert.equal(resource.node.querySelector('.conversation-internal-badge').textContent, locale === 'zh' ? '内部' : 'Internal');
    resource.update(row, { external: false });
    assert.equal(raw.hidden, true); assert.equal(resource.node.querySelector('.conversation-internal-badge'), null);
    assert.equal(resource.node.querySelector('.conversation-internal-label').textContent, locale === 'zh' ? '来自' : 'From');
    resource.update(row, { external: true });
    assert.equal(raw.hidden, false);
    assert.equal(resource.node.querySelector('.conversation-internal-label').textContent, locale === 'zh' ? '收到 ←' : 'Received ←');
    assert.equal(resource.node.querySelector('.conversation-internal-badge').textContent, locale === 'zh' ? '内部' : 'Internal');
    resource.update({ ...row, direction: 'out' }, { external: true });
    assert.equal(raw.hidden, true);
    assert.equal(resource.node.querySelector('.conversation-internal-label').textContent, locale === 'zh' ? '发出 →' : 'Sent →');
    resource.update(row, { external: false, showTechnicalDetails: true });
    assert.equal(raw.hidden, false); assert.equal(resource.node.querySelector('.conversation-internal-badge'), null);
  });
}
