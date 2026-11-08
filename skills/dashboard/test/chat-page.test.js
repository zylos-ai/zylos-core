import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, visibleNodes as allNodes, visibleText, tick, deferred } from './helpers/conversation-dom.js';
// Resolve the browser's shared static-schema URL to the identical source module.
const browserSchema = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const { conversationErrorKey: errorKey } = await import('../public/js/wb/conversation-content.js');
const labels = { 'chat.remoteDisabled': 'Remote disabled', 'chat.single': 'Switch to multi to chat' };
const t = key => labels[key] ?? key;
function fixture(testContext, { mode = 'multi', tab = 'mine', denied = false, rows = [], draft = false, malformedStatus = null, secondGroup = false, receipt = {}, translate = t } = {}) {
  const document = createDocument(), root = document.createElement('div'), calls = [];
  let isDenied = denied, pendingMessage = null, listFailed = false, failedMessageId = null;
  const fetch = async (path, options) => {
    calls.push({ path, options });
    if (failedMessageId && path.includes(encodeURIComponent(failedMessageId) + '/messages?')) return { ok: false, status: 503, json: async () => ({ error: 'chat_history_unavailable' }) };
    if (listFailed && path.startsWith('/api/chat/conversations?')) return { ok: false, status: 502, json: async () => ({ error: 'chat_history_unavailable' }) };
    if (pendingMessage && path.includes('/messages')) { const pending = pendingMessage; pendingMessage = null; return pending.promise; }
    if (path.endsWith('/send') && malformedStatus) return { ok: malformedStatus < 400, status: malformedStatus, json: async () => { throw new SyntaxError('invalid JSON'); } };
    let body = path.includes('session-mode') ? { data: { sessionMode: mode } }
      : path.includes('/messages') ? { items: rows, nextCursor: null, afterCursor: 'after' }
      : path.includes('/status') ? { items: rows }
      : /conversations\/[^/]+$/.test(path) ? { draft, stored: false, deliveryState: null, retryAllowed: true, preserveInput: false, pendingContent: null, error: null, ...receipt, conversation: { id: draft ? 'd:local' : 'g:AA', state: draft ? 'draft' : 'active', displayName: 'Example', pendingContent: receipt.pendingContent ?? null } }
      : { items: [{ id: draft ? 'd:local' : 'g:AA', display_name: 'Example', draft }, ...(secondGroup ? [{ id: 'g:BB', display_name: 'Second group', draft: false }] : [])], nextCursor: null };
    if (isDenied && path.includes('/api/chat/')) body = { error: 'remote_chat_disabled' };
    const forbidden = isDenied && path.includes('/api/chat/');
    return { ok: !forbidden, status: forbidden ? 403 : 200, json: async () => body };
  };
  const page = mountConversationPage({ root, document, t: translate, fetch, endpoint: path => path });
  testContext.after(() => page.destroy());
  const button = key => allNodes(root).find(node => node.dataset.action === key);
  const select = async () => { allNodes(root).find(node => node.dataset.conversationId)?.dispatch('click'); await tick(); await tick(); };
  return { root, page, calls, button, select, tab, failMessages(id) { failedMessageId = id; }, failList() { listFailed = true; }, deny() { isDenied = true; }, holdMessage(pending) { pendingMessage = pending; } };
}

test('mounted content keeps plain text inert and renders validated fallback and malformed-content notice', async testContext => {
  const envelope = { version: 1, kind: 'message', messageId: 'message-one', fallbackText: 'Visible fallback', blocks: [] };
  const f = fixture(testContext, { rows: [
    { id: 1, direction: 'out', status: 'delivered', content: '<script>plain text</script>' },
    { id: 2, direction: 'out', status: 'delivered', content: '[C4-JSON]\ninvalid' },
    { id: 3, direction: 'out', status: 'delivered', content: '[C4-JSON]\n' + JSON.stringify(envelope) }
  ] });
  await f.page.open(); await f.select();
  assert.ok(visibleText(f.root).includes('<script>plain text</script>'));
  assert.ok(visibleText(f.root).includes('chat.invalidContent'));
  assert.ok(visibleText(f.root).includes('Visible fallback'));
  assert.equal(allNodes(f.root).some(node => node.tagName === 'SCRIPT'), false);
});

test('create opens a named form without writing and cancel returns to the create action', async testContext => {
  const f = fixture(testContext);
  await f.page.open();
  f.button('create').dispatch('click');
  const form = f.root.querySelector('.conversation-create-form');
  assert.equal(form.hidden, false);
  const name = form.querySelector('input');
  assert.equal(name.getAttribute('aria-label'), 'chat.page.createName');
  name.value = 'A named conversation'; name.dispatch('input');
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
  f.button('page.cancel').dispatch('click');
  assert.equal(form.hidden, true); assert.equal(name.value, '');
  assert.ok(f.button('create'));
  assert.equal(f.calls.some(call => call.options.method === 'POST'), false);
});

test('page opens real state loads data and renders authoritative status without executable content', async testContext => {
  const f = fixture(testContext, { rows: [{ id: 1, direction: 'in', status: 'failed', delivery_action: 'delivered', content: '<img src=x>' },
    { id: 2, direction: 'out', status: 'delivered', content: 'Reply' }] });
  await f.page.open(); await f.select();
  assert.ok(visibleText(f.root).includes('chat.page.delivery.failed'));
  assert.equal(f.root.querySelector('[data-message-id="2"] .conversation-message-status').hidden, true, 'outbound agent messages do not show inbound delivery labels');
  assert.ok(visibleText(f.root).includes('<img src=x>'));
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'IMG').length, 0);
  assert.ok(f.button('send'));
  const input = allNodes(f.root).find(node => node.tagName === 'TEXTAREA');
  input.value = 'typed'; input.dispatch('input');
  assert.equal(allNodes(f.root).find(node => node.tagName === 'TEXTAREA'), input);
  assert.equal(f.button('send').disabled, false);
  f.page.destroy(); assert.equal(f.root.children.length, 0);
});

test('single mode keeps history and disabled creation and sending visible', async testContext => {
  const f = fixture(testContext, { mode: 'single', rows: [{ id: 1, direction: 'out', status: 'delivered', content: 'History' }] });
  await f.page.open(); await f.select();
  assert.ok(visibleText(f.root).includes('History'));
  assert.ok(visibleText(f.root).includes('Switch to multi'));
  assert.equal(f.button('create').disabled, true); assert.equal(f.button('send').disabled, true);
  assert.equal(allNodes(f.root).find(node => node.tagName === 'TEXTAREA').disabled, true);
  f.page.destroy();
});

test('external tab has history but no write controls', async testContext => {
  const f = fixture(testContext); await f.page.open(); f.button('external').dispatch('click'); await tick(); await f.select();
  assert.equal(f.button('create'), undefined); assert.equal(f.button('send'), undefined);
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'INPUT' || node.tagName === 'TEXTAREA').length, 0);
  assert.ok(f.calls.some(call => call.path.includes('tab=external')));
  f.page.destroy();
});

test('remote-disabled replaces the entire page with only its notice', async testContext => {
  const f = fixture(testContext, { denied: true }); await f.page.open();
  assert.ok(visibleText(f.root).includes('Remote disabled'));
  assert.equal(visibleText(f.root).includes('Private body'), false);
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'BUTTON').length, 0);
  f.page.destroy();
});


test('draft receipt offers rename and send without history refresh actions', async testContext => {
  const f = fixture(testContext, { draft: true }); await f.page.open(); await f.select();
  assert.ok(f.button('create')); assert.ok(f.button('send'));
  assert.equal(allNodes(f.root).some(node => node.classList.contains('conversation-receipt')), false);
  assert.ok(visibleText(f.root).includes('chat.rename'));
  assert.equal(f.button('refreshMessages'), undefined);
  assert.equal(visibleText(f.root).includes('chat.state.not_stored'), false); assert.equal(f.button('refreshStatus'), undefined);
  f.page.destroy();
});

for (const status of [200, 502]) test(`unparseable send response ${status} preserves input and blocks retry pending reconciliation`, async testContext => {
  const f = fixture(testContext, { malformedStatus: status }); await f.page.open(); await f.select();
  const input = allNodes(f.root).find(node => node.tagName === 'TEXTAREA');
  input.value = 'Keep this message'; input.dispatch('input');
  allNodes(f.root).find(node => node.classList.contains('chat-composer')).dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  assert.equal(allNodes(f.root).find(node => node.tagName === 'TEXTAREA').value, 'Keep this message');
  assert.ok(visibleText(f.root).includes('chat.page.receipt.pending_reconciliation'));
  assert.equal(f.button('send'), undefined); assert.equal(f.button('retry').disabled, true);
  assert.equal(f.calls.filter(call => call.path.endsWith('/send')).length, 1);
  f.page.destroy();
});


for (const operation of ['refresh', 'refreshMessages', 'select']) test(`remote closure during ${operation} removes previously loaded names and content`, async testContext => {
  const f = fixture(testContext, { rows: [{ id: 8, direction: 'out', status: 'delivered', content: 'Private body' }], secondGroup: true });
  await f.page.open(); await f.select();
  assert.ok(visibleText(f.root).includes('Example'));
  assert.ok(visibleText(f.root).includes('Private body'));
  f.deny();
  if (operation === 'select') { allNodes(f.root).find(node => node.dataset.conversationId === 'g:BB').dispatch('click'); await tick(); await tick(); }
  else { f.button(operation).dispatch('click'); await tick(); await tick(); }
  assert.ok(visibleText(f.root).includes('Remote disabled'));
  assert.equal(visibleText(f.root).includes('Private body'), false);
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'BUTTON').length, 0);
  f.page.redraw(); assert.ok(visibleText(f.root).includes('Remote disabled'));
  assert.equal(visibleText(f.root).includes('Private body'), false);
  await f.page.open(); assert.ok(visibleText(f.root).includes('Remote disabled'));
  assert.equal(visibleText(f.root).includes('Private body'), false);
  f.page.destroy();
});


test('late old successful message response cannot restore the remote-disabled DOM', async testContext => {
  const f = fixture(testContext, { rows: [{ id: 1, direction: 'out', status: 'delivered', content: 'Private body' }] });
  await f.page.open(); await f.select();
  const pending = deferred(); f.holdMessage(pending);
  f.button('refreshMessages').dispatch('click'); await tick();
  f.deny(); f.button('refresh').dispatch('click'); await tick(); await tick();
  assert.ok(visibleText(f.root).includes('Remote disabled'));
  assert.equal(visibleText(f.root).includes('Private body'), false);
  pending.resolve({ ok: true, status: 200, json: async () => ({ items: [{ id: 9, direction: 'out', status: 'delivered', content: 'Late secret' }], afterCursor: 'after' }) });
  await tick(); await tick();
  assert.ok(visibleText(f.root).includes('Remote disabled'));
  assert.equal(visibleText(f.root).includes('Private body'), false);
  f.page.destroy();
});


test('reopened not-stored draft restores saved input and shows a readable error', async testContext => {
  const f = fixture(testContext, { draft: true, receipt: { stored: false, preserveInput: true, pendingContent: 'Saved message', error: 'chat_core_unavailable' } });
  await f.page.open(); await f.select();
  assert.equal(allNodes(f.root).find(node => node.tagName === 'TEXTAREA').value, 'Saved message');
  assert.ok(visibleText(f.root).includes('chat.error.unavailable'));
  assert.equal(visibleText(f.root).includes('chat_core_unavailable'), false);
  f.page.destroy();
});

test('stored operations avoid a persistent receipt while unknown storage explains reconciliation', async testContext => {
  for (const locale of ['en', 'zh']) {
    const pack = JSON.parse(readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    for (const stored of [true, null]) {
      const f = fixture(testContext, { translate: key => pack[key] ?? key, receipt: { stored, deliveryState: 'pending_reconciliation', needsReconciliation: true, retryAllowed: false, preserveInput: true } });
      await f.page.open(); await f.select();
      const receipt = f.root.querySelector('.conversation-receipt');
      assert.equal(receipt.hidden, stored === true);
      if (stored === null) {
        assert.ok(visibleText(receipt).includes(pack['chat.page.receipt.pending_reconciliation']));
        assert.equal(f.button('retry')?.disabled, true);
      }
    }
  }
});

test('error mapping uses explanatory localized keys with a safe generic fallback', () => {
  assert.equal(errorKey('chat_conversation_started'), 'chat.error.conversationStarted');
  assert.equal(errorKey('chat_requires_multi'), 'chat.error.requiresMulti');
  assert.equal(errorKey('chat_auth_required'), 'chat.error.forbidden');
  assert.equal(errorKey('unexpected internal message'), 'chat.error.requestFailed');
});

test('stored notification errors do not invite retry in either language', async testContext => {
  for (const locale of ['en', 'zh']) {
    const pack = JSON.parse(readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    for (const code of ['UNHEALTHY_NOTIFY_FAILED', 'UNHEALTHY_NOTIFY_UNCERTAIN']) {
      const f = fixture(testContext, { translate: key => pack[key] ?? key, receipt: { stored: true, deliveryState: 'pending_reconciliation', needsReconciliation: true, retryAllowed: false, preserveInput: false, error: code } });
      await f.page.open(); await f.select();
      assert.equal(f.root.querySelector('.conversation-receipt').hidden, true, 'stored operation does not leave a receipt banner');
      assert.doesNotMatch(visibleText(f.root), locale === 'zh' ? /重试/ : /retry|try again/i);
      assert.equal(allNodes(f.root).some(node => node.attributes.role === 'alert'), false);
      f.page.destroy();
    }
  }
});

test('selected stored conversation still displays an unrelated list refresh failure', async testContext => {
  const f = fixture(testContext, { receipt: { stored: true, deliveryState: 'pending_reconciliation', error: 'UNHEALTHY_NOTIFY_FAILED', retryAllowed: false } });
  await f.page.open(); await f.select();
  assert.equal(allNodes(f.root).some(node => node.attributes.role === 'alert'), false);
  f.failList(); f.button('refresh').dispatch('click'); await tick(); await tick();
  const alert = allNodes(f.root).find(node => node.attributes.role === 'alert');
  assert.ok(alert); assert.equal(alert.textContent, 'chat.error.unavailable');
  assert.ok(visibleText(f.root).includes('Example'));
  f.page.destroy();
});

test('conversation query errors leave the screen when selecting another conversation', async testContext => {
  const f = fixture(testContext, { secondGroup: true }); await f.page.open(); f.failMessages('g:AA'); await f.select();
  assert.ok(allNodes(f.root).some(node => node.attributes.role === 'alert'));
  allNodes(f.root).find(node => node.dataset.conversationId === 'g:BB').dispatch('click'); await tick(); await tick();
  assert.equal(allNodes(f.root).some(node => node.attributes.role === 'alert'), false);
  allNodes(f.root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  assert.ok(allNodes(f.root).some(node => node.attributes.role === 'alert'));
  f.page.destroy();
});
