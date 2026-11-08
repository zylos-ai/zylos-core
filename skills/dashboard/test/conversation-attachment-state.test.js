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
