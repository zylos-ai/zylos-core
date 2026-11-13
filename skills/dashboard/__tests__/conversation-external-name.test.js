import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { tick } from './fixtures/workbench-dom.js';
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

const groupId = value => 'g:' + Buffer.from(value).toString('hex').toUpperCase();
const NAMED = 'lark:group-oc_team', PLAIN = 'lark:dm-oc_peer';

// The real conversation page and controller with a fake fetch; no database,
// HTTP listener, child process, PM2 or tmux. Run for conversation header,
// list naming or push refresh changes; skip for server-only changes.
function externalPage(t) {
  const translations = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
  const document = conversationDocument(), root = document.createElement('div');
  Object.assign(document, { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
  // The list response is what the server sends for the external tab: the stored
  // display name, or the session group when none is set.
  const names = { [NAMED]: 'Product team', [PLAIN]: PLAIN };
  const row = (group, stamp) => ({ id: groupId(group), session_group: group, channel: 'lark', display_name: names[group], stamp, preview: 'hello' });
  const lists = [];
  const translate = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value ?? ''), translations[key] ?? key);
  const page = mountConversationPage({ root, document, groupLinks: {}, t: translate, fetch: async path => {
    if (path.startsWith('/api/chat/conversations?')) lists.push(path);
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.startsWith('/api/chat/conversations?') ? { items: path.includes('tab=external') ? [row(NAMED, 2), row(PLAIN, 1)] : [], nextCursor: null }
      : path.includes('/messages?') ? { items: [], afterCursor: 'after', nextCursor: null }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy());
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  const push = async name => {
    const subscription = page.streamSubscription();
    page.streamEvent(name, { version: 1, ids: [], ...subscription }, subscription);
    await settle();
  };
  return { page, root, names, lists, settle, push,
    title: () => root.querySelector('h2').textContent,
    listNames: () => [...root.querySelectorAll('.conversation-list-item')].map(node => node.textContent) };
}

test('an external conversation header and list show the display name and otherwise the session group', { timeout: 2000 }, async t => {
  const f = externalPage(t);
  assert.equal(await f.page.openGroup(NAMED, { channel: 'lark' }), true);
  await f.settle();
  assert.equal(f.title(), 'Product team');
  assert.ok(f.listNames().some(text => text.includes('Product team')));
  assert.ok(f.listNames().some(text => text.includes(PLAIN)));
  assert.equal(await f.page.openGroup(PLAIN, { channel: 'lark' }), true);
  await f.settle();
  assert.equal(f.title(), PLAIN);
});

test('a pushed name change renames and clears the open external conversation header', { timeout: 2000 }, async t => {
  const f = externalPage(t);
  assert.equal(await f.page.openGroup(NAMED, { channel: 'lark' }), true);
  await f.push('chat_ready');
  assert.equal(f.title(), 'Product team');
  const before = f.lists.length;
  f.names[NAMED] = 'Renamed team';
  await f.push('chat_messages_changed');
  assert.ok(f.lists.length > before, 'the name change reads the external list again');
  assert.equal(f.title(), 'Renamed team');
  assert.ok(f.listNames().some(text => text.includes('Renamed team')));
  f.names[NAMED] = NAMED;
  await f.push('chat_messages_changed');
  assert.equal(f.title(), NAMED);
});
