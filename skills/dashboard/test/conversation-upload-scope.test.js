import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, visibleNodes, tick, deferred } from './helpers/conversation-dom.js';
const browserSchema = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');

// Real mounted page/state/upload controller with gated transports only; no HTTP, database, PM2 or tmux.
// Run for send completion, canonical conversation or tray ownership changes. t.after releases every gate and page resource.
async function fixture(t, sourceId, { failed = true } = {}) {
  const document = createDocument(), root = document.createElement('div'), uploads = [], calls = [], send = deferred();
  const refreshStarted = deferred(), refresh = deferred();
  let heldRefresh = null;
  class Upload extends EventTarget {
    upload = new EventTarget();
    open(method, url) { this.method = method; this.url = url; }
    send(body) { this.body = body; }
    abort() { this.aborted = true; this.dispatchEvent(new Event('abort')); }
    reply(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.dispatchEvent(new Event('load')); }
  }
  document.defaultView = { innerWidth: 390, FormData, URL,
    XMLHttpRequest: class { constructor() { const xhr = new Upload(); uploads.push(xhr); return xhr; } },
    addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  const page = mountConversationPage({ root, document, identity: () => 'instance-A',
    endpoint: path => '/origin-A' + path, draftScope: () => ({ authRoot: 'owner', instance: 'instance-A' }),
    fetch: async (url, options = {}) => {
      calls.push({ url, options }); const path = url.replace('/origin-A', '');
      const refreshKind = /\/conversations\/[^/]+$/.test(path) ? 'conversation'
        : /\/conversations\?/.test(path) ? 'list' : null;
      if (heldRefresh && refreshKind === heldRefresh) {
        heldRefresh = null;
        refreshStarted.resolve();
        await refresh.promise;
      }
      let body;
      if (path.endsWith('/send')) {
        body = await send.promise;
        if (body.httpStatus) return { ok: false, status: body.httpStatus, json: async () => body.body };
      }
      else if (path.endsWith('/uploads/config')) body = { maxUploadBytes: 20 * 1024 * 1024, maxAttachments: 20 };
      else if (path === '/api/session-mode') body = { data: { sessionMode: 'multi' } };
      else if (path.includes('/messages?')) body = { items: [], nextCursor: null, afterCursor: 'after' };
      else if (path.includes('/questions?') || path.includes('/status?')) body = { items: [], nextCursor: null };
      else if (/\/conversations\/[^/]+$/.test(path)) {
        const id = decodeURIComponent(path.split('/').at(-1)); body = { conversation: { id, state: id.startsWith('d:') ? 'draft' : 'active' } };
      } else body = { items: [{ id: sourceId, draft: sourceId.startsWith('d:') }, { id: 'g:B' }, { id: 'g:C' }], nextCursor: null };
      return { ok: true, status: 200, json: async () => body };
    } });
  t.after(() => { refresh.resolve(); send.resolve({ stored: false, preserveInput: true, conversationId: sourceId }); page.destroy(); });
  const settle = async () => { await tick(); await tick(); };
  const select = async id => { visibleNodes(root).find(node => node.dataset.conversationId === id).dispatch('click'); await settle(); };
  const tab = async name => { root.querySelector(`[data-action="${name}"]`).dispatch('click'); await settle(); };
  const items = () => root.querySelectorAll('.conversation-upload-tray [data-upload-id]');
  await page.open(); await select(sourceId);
  const chooser = root.querySelector('[data-action="chooseFiles"]');
  chooser.files = [new File(['ready'], 'ready.txt'), ...(failed ? [new File(['failed'], 'failed.txt')] : [])]; chooser.dispatch('change'); await settle();
  assert.equal(uploads.length, failed ? 2 : 1);
  uploads[0].reply(200, { id: 'ready-A', name: 'ready.txt', size: 5, mime: 'text/plain', kind: 'file' });
  if (failed) uploads[1].dispatchEvent(new Event('error'));
  await settle();
  assert.deepEqual(items().map(node => node.dataset.uploadState), failed ? ['ready', 'failed'] : ['ready']);
  return { root, page, uploads, calls, send, select, tab, items, settle,
    holdRefresh(kind) { heldRefresh = kind; }, refreshStarted, refresh };
}
for (const stored of [false, null, true]) {
  for (const promoted of [false, true]) {
    test(`held send stored=${stored} keeps attachments in the originating ${promoted ? 'canonical' : 'original'} group after navigation`, async t => {
      const sourceId = promoted ? 'd:A' : 'g:A', f = await fixture(t, sourceId);
      const input = f.root.querySelector('.chat-composer textarea'); input.value = 'Message A'; input.dispatch('input');
      f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
      const request = f.calls.find(call => call.url.endsWith('/send'));
      assert.equal(request.url, `/origin-A/api/chat/conversations/${encodeURIComponent(sourceId)}/send`);
      assert.deepEqual(JSON.parse(request.options.body).attachments, ['ready-A']);
      await f.select('g:B'); assert.equal(f.items().length, 0);
      const conversationId = promoted ? 'g:C' : 'g:A';
      f.send.resolve({ stored, preserveInput: stored !== true, conversationId }); await f.settle();
      assert.equal(f.items().length, 0, 'another selected conversation must never receive the completed send tray');
      await f.select(conversationId);
      assert.deepEqual(f.items().map(node => node.dataset.uploadState), stored === true ? ['failed'] : ['ready', 'failed']);
      const remaining = f.items().find(node => node.dataset.uploadState === 'failed');
      remaining.querySelector('[data-action="retryUpload"]').dispatch('click'); await f.settle();
      assert.equal(f.uploads.at(-1).url, `/origin-A/api/chat/conversations/${encodeURIComponent(conversationId)}/uploads`, 'retry uses the originating instance and authoritative canonical group');
    });
  }
}
for (const status of [409, 503]) test(`known canonical failure ${status} retains the originating attachment tray after navigation`, async t => {
  const f = await fixture(t, 'd:A');
  f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
  await f.select('g:B'); assert.equal(f.items().length, 0);
  f.send.resolve({ httpStatus: status, body: { conversationId: 'g:C', preserveInput: true, error: 'chat_head_failed' } }); await f.settle();
  assert.equal(f.items().length, 0);
  await f.select('g:C'); assert.deepEqual(f.items().map(node => node.dataset.uploadState), ['ready', 'failed']);
  f.items()[1].querySelector('[data-action="retryUpload"]').dispatch('click'); await f.settle();
  assert.equal(f.uploads.at(-1).url, '/origin-A/api/chat/conversations/g%3AC/uploads');
});
test('unknown transport outcome without canonical authority leaves all attachments in the source group', async t => {
  const f = await fixture(t, 'd:A');
  f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
  await f.select('g:B'); assert.equal(f.items().length, 0);
  f.send.reject(Error('connection interrupted')); await f.settle();
  assert.equal(f.items().length, 0);
  await f.select('d:A'); assert.deepEqual(f.items().map(node => node.dataset.uploadState), ['ready', 'failed']);
});

test('stored send clears ready attachments after leaving for external history and returning', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'g:A', { failed: false });
  const input = f.root.querySelector('.chat-composer textarea'); input.value = 'Message A'; input.dispatch('input');
  f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
  await f.tab('external');
  f.send.resolve({ stored: true, conversationId: 'g:A' }); await f.settle();
  await f.tab('mine'); await f.select('g:A');
  assert.equal(input.value, '');
  assert.equal(f.items().length, 0, 'an authoritative stored send must not leave attachments available to send again');
  assert.equal(f.root.querySelector('[data-action="send"]').disabled, true);
});

test('unstored draft promotion moves retained attachments to its canonical group after switching tabs', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'd:A');
  f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
  await f.tab('external');
  f.send.resolve({ stored: false, preserveInput: true, conversationId: 'g:C' }); await f.settle();
  await f.tab('mine'); await f.select('g:C');
  assert.deepEqual(f.items().map(node => node.dataset.uploadState), ['ready', 'failed']);
  f.items()[1].querySelector('[data-action="retryUpload"]').dispatch('click'); await f.settle();
  assert.equal(f.uploads.at(-1).url, '/origin-A/api/chat/conversations/g%3AC/uploads');
  await f.select('d:A'); assert.equal(f.items().length, 0, 'the old draft scope must no longer hold the promoted tray');
});

for (const phase of ['conversation', 'list']) test(`stored send clears its captured attachments when the page closes during ${phase} refresh`, { timeout: 5000 }, async t => {
  const f = await fixture(t, 'g:A', { failed: false });
  f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
  f.holdRefresh(phase);
  f.send.resolve({ stored: true, conversationId: 'g:A' });
  await f.refreshStarted.promise;
  f.page.close(); f.refresh.resolve(); await f.settle();
  await f.page.open(); await f.select('g:A');
  assert.equal(f.items().length, 0, 'closing a page during follow-up reads must preserve the authoritative send result');
  assert.equal(f.root.querySelector('[data-action="send"]').disabled, true);
});

test('stored receipt belonging to another send preserves the current input and captured attachments', { timeout: 5000 }, async t => {
  const f = await fixture(t, 'g:A');
  const input = f.root.querySelector('.chat-composer textarea'); input.value = 'My pending send'; input.dispatch('input');
  f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
  f.send.resolve({ stored: true, preserveInput: true, conversationId: 'g:A' }); await f.settle();
  assert.equal(input.value, 'My pending send');
  assert.deepEqual(f.items().map(node => node.dataset.uploadState), ['ready', 'failed']);
});

for (const status of [409, 503]) test(`known canonical failure ${status} retains promoted attachments when the page closes before its response`, { timeout: 5000 }, async t => {
  const f = await fixture(t, 'd:A');
  f.root.querySelector('.chat-composer').dispatch('submit', { preventDefault() {} }); await f.settle();
  f.page.close();
  f.send.resolve({ httpStatus: status, body: { conversationId: 'g:C', preserveInput: true, error: 'chat_head_failed' } }); await f.settle();
  await f.page.open(); await f.select('g:C');
  assert.deepEqual(f.items().map(node => node.dataset.uploadState), ['ready', 'failed']);
  f.items()[1].querySelector('[data-action="retryUpload"]').dispatch('click'); await f.settle();
  assert.equal(f.uploads.at(-1).url, '/origin-A/api/chat/conversations/g%3AC/uploads');
  await f.select('d:A'); assert.equal(f.items().length, 0);
});
