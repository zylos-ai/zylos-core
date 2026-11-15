import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick } from './helpers/conversation-dom.js';
import { createConversationDeletion } from '../public/js/wb/conversation-delete.js';
import { createLiveArea } from '../public/js/wb/conversation-activity.js';
const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href, context);
  return next(specifier, context);
} });
const { createAnnotationUi } = await import('../public/js/wb/chat-annotations.js');
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const pack = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
const t = (key, params = {}) => Object.entries(params).reduce((value, [name, text]) => value.replaceAll(`{${name}}`, String(text)), pack[key] ?? key);
const lookup = key => pack[key] ?? key;
const flush = async () => { for (let i = 0; i < 12; i++) await tick(); };
// In-memory injected DOM and request responses only: no HTTP, database, browser or running instance.
for (const count of [1, 2]) {
  test(`annotation button renders ${count} annotation(s) in accessible name and title`, () => {
    const document = createDocument(), root = document.createElement('div');
    const state = { tab: 'mine', canWrite: true, annotations: Array.from({ length: count }, () => ({})) };
    const ui = createAnnotationUi({ document, t, root, composer: root, composeBox: root, narrow: () => false, snapshot: () => state });
    ui.update(state);
    assert.equal(ui.count.getAttribute('aria-label'), `${count} annotation${count === 1 ? '' : 's'}`);
    assert.equal(ui.count.title, `${count} annotation${count === 1 ? '' : 's'}; open the list`);
    ui.destroy();
  });
  test(`subtask row renders ${count} step(s) in text and title`, () => {
    const area = createLiveArea({ document: createDocument(), t: lookup });
    area.update({ under: 'in', subtasks: [{ id: 'a', start: 0, steps: count, label: { key: 'named', arg: 'Review' } }] }, { now: 1000 });
    const expected = ` · running 1 s · ${count} step${count === 1 ? '' : 's'}`;
    assert.ok(area.node.textContent.endsWith(expected));
    assert.ok(allNodes(area.node).find(node => node.tagName === 'BUTTON').title.endsWith(expected));
  });
}
for (const messages of [1, 2]) for (const attachments of [0, 1, 2]) test(`deletion confirmation renders ${messages} message(s) and ${attachments} attachment(s) independently`, async () => {
  let rendered;
  const deletion = createConversationDeletion({ t, available: () => true,
    request: async () => ({ operationId: 'preview', cutoffId: 3, messages, attachments }),
    confirm: async message => { rendered = message; return false; } });
  await deletion.remove({ id: 'g:AA', sessionGroup: 'dashboard:a' });
  assert.ok(rendered.includes(`It shows ${messages} message${messages === 1 ? '' : 's'} and ${attachments} removable attachment${attachments === 1 ? '' : 's'}.`));
});

async function pageFixture(context, { retained = 1, translate = t } = {}) {
  const document = createDocument(), root = document.createElement('div');
  document.defaultView = { innerWidth: 1000, setTimeout, clearTimeout, setInterval, clearInterval, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {},
    FormData: class { append() {} }, XMLHttpRequest: class { upload = { addEventListener() {}, removeEventListener() {} }; addEventListener() {} removeEventListener() {} open() {} send() {} abort() {} },
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} } };
  let deleted = false, rows = [{ id: 1, direction: 'out', status: 'delivered', content: 'Hello' }];
  const item = { id: 'g:AA', sessionGroup: 'dashboard:a', display_name: 'Conversation' };
  const page = mountConversationPage({ root, document, t: translate, local: () => true, confirm: async () => true, fetch: async (path, options = {}) => {
    let data;
    if (options.method === 'DELETE') { deleted = true; data = { ok: true, retainedMessages: retained, groupDataRetained: true }; }
    else if (path.endsWith('/deletion-preview')) data = { operationId: 'preview', cutoffId: 1, messages: 1, attachments: 1 };
    else if (path.endsWith('/uploads/config')) data = { maxUploadBytes: 1024, maxAttachments: 20 };
    else if (path.includes('/messages?')) data = { items: rows, nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/questions?') || path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/instance')) data = { session_mode: 'multi' };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { ...item, state: 'active' }, stored: false };
    else data = { items: deleted ? [] : [item], nextCursor: null, canWrite: true, deletionAllowed: true };
    return { ok: true, status: 200, json: async () => data };
  } });
  context.after(() => page.destroy());
  await page.open();
  allNodes(root).find(node => node.dataset.conversationId === item.id)?.dispatch('click');
  await flush();
  return { root, page, setRows(value) { rows = value; }, find: cls => allNodes(root).find(node => node.classList.contains(cls)) };
}
for (const count of [1, 2]) {
  test(`upload tray renders ${count} pending attachment(s)`, async context => {
    const f = await pageFixture(context, { translate: lookup });
    const input = allNodes(f.root).find(node => node.tagName === 'INPUT' && node.type === 'file');
    input.files = Array.from({ length: count }, (_, n) => Object.assign(new Blob(['hi'], { type: 'text/plain' }), { name: `file${n}.txt` }));
    input.dispatch('change'); await flush();
    assert.equal(f.find('conversation-upload-label').textContent, `${count} pending attachment${count === 1 ? '' : 's'}`);
  });
  test(`deletion completion renders ${count} retained message(s)`, async context => {
    const f = await pageFixture(context, { retained: count });
    allNodes(f.root).find(node => node.classList.contains('conversation-delete')).dispatch('click'); await flush();
    assert.ok(f.root.textContent.includes(`${count} message${count === 1 ? ' remains' : 's remain'}; conversation memory has been retained.`));
  });
  test(`unread button renders ${count} new message(s)`, async context => {
    const f = await pageFixture(context, { translate: lookup });
    const stream = f.find('conversation-stream'); stream.scrollHeight = 1000; stream.clientHeight = 100; stream.scrollTop = 0;
    f.setRows(Array.from({ length: count + 1 }, (_, n) => ({ id: n + 1, direction: 'out', status: 'delivered', content: `Message ${n}` })));
    const sub = f.page.streamSubscription();
    f.page.streamEvent('chat_ready', { version: 1, ...sub, ids: [] }, sub); await flush();
    const latest = allNodes(f.root).find(node => node.dataset.action === 'latest');
    assert.equal(latest.hidden, false);
    assert.equal(latest.textContent, `${count} new message${count === 1 ? '' : 's'}`);
    assert.equal(latest.getAttribute('aria-label'), latest.textContent);
  });
}
