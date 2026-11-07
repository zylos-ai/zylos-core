import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick, deferred } from './fixtures/workbench-dom.js';
// Resolve the browser's shared static-schema URL to the identical source module.
const browserSchema = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountChat, messageText, errorKey } = await import('../public/js/wb/chat.js');
const labels = { 'chat.remoteDisabled': 'Remote disabled', 'chat.single': 'Switch to multi to chat' };
const t = key => labels[key] ?? key;
function fixture({ mode = 'multi', tab = 'mine', denied = false, rows = [], draft = false, malformedStatus = null, secondGroup = false, receipt = {}, translate = t } = {}) {
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
  const page = mountChat({ root, document, t: translate, fetch, endpoint: path => path });
  const button = key => allNodes(root).find(node => node.dataset.action === key);
  const select = async () => { allNodes(root).find(node => node.dataset.conversationId)?.dispatch('click'); await tick(); await tick(); };
  return { root, page, calls, button, select, tab, failMessages(id) { failedMessageId = id; }, failList() { listFailed = true; }, deny() { isDenied = true; }, holdMessage(pending) { pendingMessage = pending; } };
}

test('message text displays plain content and only the valid envelope fallback', () => {
  assert.equal(messageText('<script>text</script>', t), '<script>text</script>');
  assert.equal(messageText('[C4-JSON]\ninvalid', t), 'chat.invalidContent');
  const envelope = { version: 1, kind: 'message', messageId: 'message-one', fallbackText: 'Visible fallback', blocks: [] };
  assert.equal(messageText('[C4-JSON]\n' + JSON.stringify(envelope), t), 'Visible fallback');
});

test('page opens real state loads data and renders authoritative status without executable content', async () => {
  const f = fixture({ rows: [{ id: 1, direction: 'in', status: 'failed', delivery_action: 'delivered', content: '<img src=x>' },
    { id: 2, direction: 'out', status: 'delivered', content: 'Reply' }] });
  await f.page.open(); await f.select();
  assert.ok(f.root.textContent.includes('chat.state.failed'));
  assert.ok(f.root.textContent.includes('chat.state.stored'));
  assert.ok(f.root.textContent.includes('<img src=x>'));
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'IMG').length, 0);
  assert.ok(f.button('send'));
  const input = allNodes(f.root).find(node => node.tagName === 'TEXTAREA');
  input.value = 'typed'; input.dispatch('input');
  assert.equal(allNodes(f.root).find(node => node.tagName === 'TEXTAREA'), input);
  assert.equal(f.button('send').disabled, false);
  f.page.destroy(); assert.equal(f.root.children.length, 0);
});

test('single mode keeps history visible and hides creation sending and rename', async () => {
  const f = fixture({ mode: 'single', rows: [{ id: 1, direction: 'out', status: 'delivered', content: 'History' }] });
  await f.page.open(); await f.select();
  assert.ok(f.root.textContent.includes('History'));
  assert.ok(f.root.textContent.includes('Switch to multi'));
  assert.equal(f.button('create'), undefined); assert.equal(f.button('send'), undefined);
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'TEXTAREA').length, 0);
  f.page.destroy();
});

test('external tab has history but no write controls', async () => {
  const f = fixture(); await f.page.open(); f.button('external').dispatch('click'); await tick(); await f.select();
  assert.equal(f.button('create'), undefined); assert.equal(f.button('send'), undefined);
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'INPUT' || node.tagName === 'TEXTAREA').length, 0);
  assert.ok(f.calls.some(call => call.path.includes('tab=external')));
  f.page.destroy();
});

test('remote-disabled replaces the entire page with only its notice', async () => {
  const f = fixture({ denied: true }); await f.page.open();
  assert.equal(f.root.textContent, 'Remote disabled');
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'BUTTON').length, 0);
  f.page.destroy();
});


test('draft receipt offers rename and send without history refresh actions', async () => {
  const f = fixture({ draft: true }); await f.page.open(); await f.select();
  assert.ok(f.button('create')); assert.ok(f.button('send'));
  assert.equal(allNodes(f.root).filter(node => node.attributes.role === 'status').length, 0);
  assert.ok(f.root.textContent.includes('chat.rename'));
  assert.equal(f.button('refreshMessages'), undefined);
  assert.equal(f.root.textContent.includes('chat.state.not_stored'), false); assert.equal(f.button('refreshStatus'), undefined);
  f.page.destroy();
});

for (const status of [200, 502]) test(`unparseable send response ${status} preserves input and blocks retry pending reconciliation`, async () => {
  const f = fixture({ malformedStatus: status }); await f.page.open(); await f.select();
  const input = allNodes(f.root).find(node => node.tagName === 'TEXTAREA');
  input.value = 'Keep this message'; input.dispatch('input');
  allNodes(f.root).find(node => node.className === 'chat-composer').dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  assert.equal(allNodes(f.root).find(node => node.tagName === 'TEXTAREA').value, 'Keep this message');
  assert.ok(f.root.textContent.includes('chat.state.pending_reconciliation'));
  assert.equal(f.button('send'), undefined); assert.equal(f.button('retry').disabled, true);
  assert.equal(f.calls.filter(call => call.path.endsWith('/send')).length, 1);
  f.page.destroy();
});


for (const operation of ['refresh', 'refreshMessages', 'select']) test(`remote closure during ${operation} removes previously loaded names and content`, async () => {
  const f = fixture({ rows: [{ id: 8, direction: 'out', status: 'delivered', content: 'Private body' }], secondGroup: true });
  await f.page.open(); await f.select();
  assert.ok(f.root.textContent.includes('Example'));
  assert.ok(f.root.textContent.includes('Private body'));
  f.deny();
  if (operation === 'select') { allNodes(f.root).find(node => node.dataset.conversationId === 'g:BB').dispatch('click'); await tick(); await tick(); }
  else { f.button(operation).dispatch('click'); await tick(); await tick(); }
  assert.equal(f.root.textContent, 'Remote disabled');
  assert.equal(allNodes(f.root).filter(node => node.tagName === 'BUTTON').length, 0);
  f.page.redraw(); assert.equal(f.root.textContent, 'Remote disabled');
  await f.page.open(); assert.equal(f.root.textContent, 'Remote disabled');
  f.page.destroy();
});


test('late old successful message response cannot restore the remote-disabled DOM', async () => {
  const f = fixture({ rows: [{ id: 1, direction: 'out', status: 'delivered', content: 'Private body' }] });
  await f.page.open(); await f.select();
  const pending = deferred(); f.holdMessage(pending);
  f.button('refreshMessages').dispatch('click'); await tick();
  f.deny(); f.button('refresh').dispatch('click'); await tick(); await tick();
  assert.equal(f.root.textContent, 'Remote disabled');
  pending.resolve({ ok: true, status: 200, json: async () => ({ items: [{ id: 9, direction: 'out', status: 'delivered', content: 'Late secret' }], afterCursor: 'after' }) });
  await tick(); await tick();
  assert.equal(f.root.textContent, 'Remote disabled');
  f.page.destroy();
});


test('reopened not-stored draft restores saved input and shows a readable error', async () => {
  const f = fixture({ draft: true, receipt: { stored: false, preserveInput: true, pendingContent: 'Saved message', error: 'chat_core_unavailable' } });
  await f.page.open(); await f.select();
  assert.equal(allNodes(f.root).find(node => node.tagName === 'TEXTAREA').value, 'Saved message');
  assert.ok(f.root.textContent.includes('chat.error.unavailable'));
  assert.equal(f.root.textContent.includes('chat_core_unavailable'), false);
  f.page.destroy();
});

test('stored delivery awaiting reconciliation and unknown storage display distinct status labels', async () => {
  for (const locale of ['en', 'zh']) {
    const pack = JSON.parse(readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    const displayed = [];
    for (const stored of [true, null]) {
      const f = fixture({ translate: key => pack[key] ?? key, receipt: { stored, deliveryState: 'pending_reconciliation', needsReconciliation: true, retryAllowed: false, preserveInput: true } });
      await f.page.open(); await f.select();
      displayed.push(allNodes(f.root).find(node => node.attributes.role === 'status').textContent);
      f.page.destroy();
    }
    assert.equal(displayed[0], pack['chat.state.stored_pending_reconciliation']);
    assert.equal(displayed[1], pack['chat.state.pending_reconciliation']);
    assert.notEqual(displayed[0], displayed[1]);
    assert.match(displayed[0], locale === 'zh' ? /已入库.*不要重发/ : /Stored.*do not resend/);
  }
});

test('error mapping uses explanatory localized keys with a safe generic fallback', () => {
  assert.equal(errorKey('chat_conversation_started'), 'chat.error.conversationStarted');
  assert.equal(errorKey('chat_requires_multi'), 'chat.error.requiresMulti');
  assert.equal(errorKey('chat_auth_required'), 'chat.error.forbidden');
  assert.equal(errorKey('unexpected internal message'), 'chat.error.requestFailed');
});

test('stored notification errors do not invite retry in either language', async () => {
  for (const locale of ['en', 'zh']) {
    const pack = JSON.parse(readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    for (const code of ['UNHEALTHY_NOTIFY_FAILED', 'UNHEALTHY_NOTIFY_UNCERTAIN']) {
      const f = fixture({ translate: key => pack[key] ?? key, receipt: { stored: true, deliveryState: 'pending_reconciliation', needsReconciliation: true, retryAllowed: false, preserveInput: false, error: code } });
      await f.page.open(); await f.select();
      assert.ok(f.root.textContent.includes(pack['chat.state.stored_pending_reconciliation']));
      assert.doesNotMatch(f.root.textContent, locale === 'zh' ? /重试/ : /retry|try again/i);
      assert.equal(allNodes(f.root).some(node => node.attributes.role === 'alert'), false);
      f.page.destroy();
    }
  }
});

test('selected stored conversation still displays an unrelated list refresh failure', async () => {
  const f = fixture({ receipt: { stored: true, deliveryState: 'pending_reconciliation', error: 'UNHEALTHY_NOTIFY_FAILED', retryAllowed: false } });
  await f.page.open(); await f.select();
  assert.equal(allNodes(f.root).some(node => node.attributes.role === 'alert'), false);
  f.failList(); f.button('refresh').dispatch('click'); await tick(); await tick();
  const alert = allNodes(f.root).find(node => node.attributes.role === 'alert');
  assert.ok(alert); assert.equal(alert.textContent, 'chat.error.unavailable');
  assert.ok(f.root.textContent.includes('Example'));
  f.page.destroy();
});

test('conversation query errors leave the screen when selecting another conversation', async () => {
  const f = fixture({ secondGroup: true }); await f.page.open(); f.failMessages('g:AA'); await f.select();
  assert.ok(allNodes(f.root).some(node => node.attributes.role === 'alert'));
  allNodes(f.root).find(node => node.dataset.conversationId === 'g:BB').dispatch('click'); await tick(); await tick();
  assert.equal(allNodes(f.root).some(node => node.attributes.role === 'alert'), false);
  allNodes(f.root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  assert.ok(allNodes(f.root).some(node => node.attributes.role === 'alert'));
  f.page.destroy();
});
