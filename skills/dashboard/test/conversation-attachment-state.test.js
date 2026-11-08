import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { createConversationState } = await import('../public/js/wb/conversation-state.js');

// Controller requests are fixture objects; no network, filesystem or background clock.
async function fixture(t, sendResult = { stored: true }, initial = []) {
  const calls = []; let read = 0;
  const state = createConversationState({ setTimeout: () => 1, clearTimeout() {}, request: async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/session-mode') return { data: { sessionMode: 'multi' } };
    if (path.endsWith('/send')) return typeof sendResult === 'function' ? sendResult(options) : sendResult;
    if (path.includes('/messages?')) return { items: read++ ? [] : initial, nextCursor: null, afterCursor: 'after',
      attachmentUpdates: read > 1 ? [{ id: 1, attachments: [{ id: 'file', name: 'note.txt', kind: 'file', available: true }] }] : [] };
    if (path.includes('?')) return { items: [], nextCursor: null };
    return { conversation: { id: 'g:A', state: 'active' } };
  } });
  t.after(() => state.destroy()); await state.open(); await state.select('g:A');
  return { state, calls };
}
for (const stored of [true, false, null]) test(`attachment-only send returns the existing ${stored} storage outcome`, async t => {
  const f = await fixture(t, { stored, preserveInput: stored !== true });
  assert.equal(f.state.snapshot().input, '');
  const result = await f.state.send({ attachments: ['ready-file'] });
  assert.equal(result.stored, stored);
  const sent = f.calls.find(call => call.path.endsWith('/send'));
  assert.deepEqual(sent.options.body, { content: '', attachments: ['ready-file'] });
  assert.equal(f.state.snapshot().retryRequired, stored === null);
});
test('empty text without ready attachments remains unsendable', async t => {
  const f = await fixture(t); await f.state.send();
  assert.equal(f.calls.filter(call => call.path.endsWith('/send')).length, 0);
  f.state.setInput('hello'); await f.state.send();
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/send')).options.body, { content: 'hello' });
});
test('send captures attachment ids before a later editor change', async t => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, () => pending), ids = ['first'];
  const sending = f.state.send({ attachments: ids }); ids.push('later');
  release({ stored: false, preserveInput: true }); await sending;
  assert.deepEqual(f.calls.find(call => call.path.endsWith('/send')).options.body.attachments, ['first']);
});
test('incremental history rechecks unavailable attachments and applies metadata without a new message', async t => {
  const f = await fixture(t, undefined, [{ id: 1, direction: 'out', content: 'file', attachments: [{ name: 'note.txt', kind: 'file', available: false }] }]);
  await f.state.refreshMessages();
  const requests = f.calls.filter(call => call.path.includes('/messages?'));
  assert.equal(new URL(requests.at(-1).path, 'http://fixture').searchParams.get('recheckIds'), '1');
  assert.equal(f.state.snapshot().messages.length, 1);
  assert.equal(f.state.snapshot().messages[0].attachments[0].available, true);
});

test('bounded attachment rechecks rotate across all loaded missing rows and retry a failed batch', async t => {
  const rows = Array.from({ length: 205 }, (_, i) => ({ id: i + 1, direction: 'out', content: 'file',
    attachments: [{ name: `file-${i + 1}`, kind: 'file', available: false }] }));
  const batches = []; let fail = true;
  const state = createConversationState({ setTimeout: () => 1, clearTimeout() {}, request: async path => {
    if (path === '/api/session-mode') return { data: { sessionMode: 'multi' } };
    if (path.includes('/messages?')) {
      const params = new URL(path, 'http://fixture').searchParams;
      if (params.get('direction') === 'after') {
        const ids = params.get('recheckIds').split(',').map(Number); batches.push(ids);
        assert.ok(ids.length > 0 && ids.length <= 100);
        if (fail) { fail = false; throw { code: 'chat_request_failed' }; }
        return { items: [], nextCursor: null, afterCursor: 'after', attachmentUpdates: ids.includes(1)
          ? [{ id: 1, attachments: [{ id: 'restored', name: 'file-1', kind: 'file', available: true }] }] : [] };
      }
      const end = Number(params.get('cursor') || rows.length), start = Math.max(0, end - 50);
      return { items: rows.slice(start, end), nextCursor: start ? String(start) : null, afterCursor: 'after' };
    }
    if (path.includes('?')) return { items: [], nextCursor: null };
    return { conversation: { id: 'g:A', state: 'active' } };
  } });
  t.after(() => state.destroy()); await state.open(); await state.select('g:A');
  for (let i = 0; i < 4; i++) await state.loadOlder();
  assert.equal(state.snapshot().messages.length, 205);
  for (let i = 0; i < 4; i++) await state.refreshMessages();
  assert.equal(batches[0].join(','), batches[1].join(','), 'failed reads do not advance the recheck cursor');
  assert.equal(new Set(batches.flat()).size, 205, 'older missing rows participate despite permanently missing newer rows');
  assert.equal(state.snapshot().messages[0].attachments[0].available, true);
});
