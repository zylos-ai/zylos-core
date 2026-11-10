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
  test(`internal ${direction} uses a dedicated localized note in ${locale}`, () => {
    const document = createDocument(), words = translations(locale), row = relay(direction), opened = [];
    const resource = renderInternalMessage({ document, row, t: key => words[key], onOpenPeer: (...args) => opened.push(args),
      timeText: '12:34', timeIso: '2026-01-01T12:34:00.000Z' });
    assert.equal(resource.node.querySelector('.conversation-internal-label').textContent, words[`chat.internal.${direction === 'out' ? 'sent' : 'received'}`]);
    assert.equal(resource.node.querySelector('.conversation-internal-content').textContent, 'relay body');
    assert.equal(resource.node.querySelector('.conversation-internal-peer').textContent, 'Peer room');
    assert.equal(resource.node.querySelector('.conversation-internal-peer').tagName, 'BUTTON');
    resource.node.querySelector('.conversation-internal-peer').dispatch('click');
    assert.deepEqual(opened, [['telegram:peer', 'telegram']]);
    assert.equal(resource.node.querySelector('.conversation-internal-raw').hidden, true);
    assert.equal(visibleText(resource.node).includes('[internal] Yourself'), false);
    assert.equal(resource.node.querySelector('time').dateTime, '2026-01-01T12:34:00.000Z');
    for (const selector of ['.chat-message-author', '.conversation-avatar', '[data-delivery-state]', 'input', 'textarea', 'canvas']) {
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
  assert.equal(resource.node.querySelector('.conversation-internal-peer'), sameButton);
  sameButton.dispatch('click');
  assert.deepEqual(opened, [['dashboard:new', 'dashboard']]);
  resource.update({ ...row, internal: { ...row.internal, peerDisplayName: null, peerExists: false } });
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
