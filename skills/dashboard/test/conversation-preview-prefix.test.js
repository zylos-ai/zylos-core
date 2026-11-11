import { catchUpConversation } from './helpers/conversation-stream-catchup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument } from './helpers/conversation-dom.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const flush = async () => { for (let i = 0; i < 120; i++) await Promise.resolve(); };

// Mounted page plus its real state controller: injected DOM/fetch only, no HTTP,
// database, children or runtime. Initial list metadata and message refresh are
// distinct paths; opening a detail must not replace the initial-list evidence.
function fixture(t, locale) {
  const words = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
  const document = createDocument(), root = document.createElement('div');
  const items = tab => [
    { id: 'g:IN', sessionGroup: `${tab === 'mine' ? 'dashboard' : 'telegram'}:incoming`, channel: tab === 'mine' ? 'dashboard' : 'telegram', preview: 'initial incoming', previewDirection: 'in' },
    { id: 'g:OUT', sessionGroup: `${tab === 'mine' ? 'dashboard' : 'telegram'}:outgoing`, channel: tab === 'mine' ? 'dashboard' : 'telegram', preview: 'initial outgoing', previewDirection: 'out' },
    { id: 'g:EMPTY', preview: '', previewDirection: 'in' },
    { id: 'draft:empty', draft: true, state: 'draft', preview: '', previewDirection: 'out' }
  ];
  const calls = [];
  let pending = [], messageReads = 0, listReads = 0;
  const page = mountConversationPage({ root, document, storage: null, t: key => words[key] ?? key,
    fetch: async (path) => {
      assert.ok(calls.length < 100, 'request history stays bounded'); calls.push(path);
      const url = new URL(path, 'http://fixture');
      let body;
      if (path === '/api/session-mode') body = { data: { sessionMode: 'multi' } };
      else if (url.pathname === '/api/chat/conversations') {
        listReads++; body = { items: items(url.searchParams.get('tab')), nextCursor: null };
      } else if (url.pathname.endsWith('/messages')) {
        messageReads++; body = { items: pending, afterCursor: 'after', nextCursor: null };
        pending = [];
      } else if (/\/conversations\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/').at(-1));
        body = { conversation: { ...items(url.searchParams.get('tab')).find(item => item.id === id), id, state: 'active' } };
      } else body = { items: [], nextCursor: null };
      return { ok: true, status: 200, json: async () => body };
    }
  });
  t.after(() => page.destroy());
  return { page, root, words,
    preview: id => root.querySelector(`[data-conversation-id="${id}"]`).querySelector('.chat-preview'),
    get messageReads() { return messageReads; }, get listReads() { return listReads; },
    async open(tab) {
      await page.open();
      if (tab === 'external') { root.querySelector('[data-action="external"]').dispatch('click'); await flush(); }
    },
    async select(id) { root.querySelector(`[data-conversation-id="${id}"]`).dispatch('click'); await flush(); },
    async receive(rows) {
      pending = rows;
      await catchUpConversation(page);
    }
  };
}

const prefixes = (locale, tab) => tab === 'external'
  ? locale === 'zh' ? { in: '收到：', out: '发出：' } : { in: 'Received: ', out: 'Sent: ' }
  : locale === 'zh' ? { in: '你：', out: '' } : { in: 'You: ', out: '' };

for (const locale of ['en', 'zh']) for (const tab of ['mine', 'external']) {
  test(`${tab} initial list previews distinguish directions in ${locale}`, { timeout: 2000 }, async t => {
    const f = fixture(t, locale), prefix = prefixes(locale, tab);
    await f.open(tab);
    assert.equal(f.messageReads, 0, 'initial preview assertions use list metadata before detail reads');
    assert.equal(f.preview('g:IN').textContent, prefix.in + 'initial incoming');
    assert.equal(f.preview('g:OUT').textContent, prefix.out + 'initial outgoing');
    assert.equal(f.preview('g:EMPTY').textContent, f.words['chat.page.noMessages']);
    assert.equal(f.preview('draft:empty').textContent, f.words['chat.page.blankPreview']);
  });

  test(`${tab} refreshed list previews follow the latest non-internal message in ${locale}`, { timeout: 2000 }, async t => {
    const f = fixture(t, locale), prefix = prefixes(locale, tab);
    await f.open(tab); await f.select('g:IN');
    assert.equal(f.messageReads, 1, 'selecting the detail loads an empty initial history');
    const preview = f.preview('g:IN'), listReads = f.listReads;
    for (const [index, direction] of ['in', 'out'].entries()) {
      const content = `refreshed ${direction}`;
      await f.receive([{ id: 10 + index * 2, direction, channel: tab === 'mine' ? 'dashboard' : 'telegram', content },
        { id: 11 + index * 2, direction: direction === 'in' ? 'out' : 'in', channel: 'internal', content: 'internal tail must not become the preview' }]);
      assert.equal(f.messageReads, index + 2, 'each update reads real message state');
      assert.equal(f.listReads, listReads + index + 1, 'automatic stream catchup rereads deliberately stale list metadata before message merging');
      assert.ok(f.preview('g:IN') === preview, 'message refresh retains the keyed list preview node');
      assert.equal(preview.textContent, prefix[direction] + content);
      assert.equal(f.preview('g:OUT').textContent, prefix.out + 'initial outgoing', 'another conversation is unchanged');
      assert.equal(f.preview('g:EMPTY').textContent, f.words['chat.page.noMessages']);
      assert.equal(f.preview('draft:empty').textContent, f.words['chat.page.blankPreview']);
    }
  });
}
