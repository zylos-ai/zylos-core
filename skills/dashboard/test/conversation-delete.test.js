import test from 'node:test';
import assert from 'node:assert/strict';
import { createConversationDeletion, deletionPath } from '../public/js/wb/conversation-delete.js';

const item = { id: 'g:ABC', sessionGroup: 'dashboard:example' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture(options = {}) {
  const calls = [], confirmations = [], removed = [];
  const controller = createConversationDeletion({
    available: () => true, t: (key, args) => JSON.stringify({ key, ...args }),
    request: async (path, options = {}) => { calls.push({ path, ...options }); return options.method
      ? { ok: true, counts: { messages: 4, attachments: 2 } }
      : { ok: true, operationId: 'operation-one', messages: 4, attachments: 2, draft: false }; },
    confirm: async (...args) => { confirmations.push(args); return true; },
    onDeleted: async id => removed.push(id), ...options,
  });
  return { controller, calls, confirmations, removed };
}

test('conversation deletion previews counts and confirms before one operation-bound delete', async () => {
  const f = fixture(); await f.controller.remove(item);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].path, '/api/workbench/groups/dashboard%3Aexample/deletion');
  assert.equal(f.confirmations.length, 1);
  assert.deepEqual(JSON.parse(f.confirmations[0][0]), { key: 'chat.delete.confirm', messages: 4, attachments: 2 });
  assert.deepEqual(f.calls[1].body, { confirmed: true, operationId: 'operation-one' });
  assert.deepEqual(f.removed, [item.id]);
});

test('cancelled confirmation never starts deletion', async () => {
  const f = fixture({ confirm: async () => false }); await f.controller.remove(item);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.removed, []);
});

test('draft confirmation is light and its request never fabricates a group', async () => {
  const calls = [], confirmations = [];
  const f = fixture({ request: async (path, options) => { calls.push({ path, options }); return options?.method ? { ok: true } : { ok: true, operationId: 'draft-op', draft: true }; },
    confirm: async text => { confirmations.push(JSON.parse(text)); return true; } });
  await f.controller.remove({ id: 'd:333' });
  assert.equal(calls[0].path, '/api/chat/drafts/333/deletion');
  assert.deepEqual(confirmations, [{ key: 'chat.delete.draftConfirm' }]);
});

test('Origin, unavailable and invalid targets do not even preview', async () => {
  const f = fixture();
  await f.controller.remove({ id: 'origin', sessionGroup: 'origin' });
  await f.controller.remove({ id: 'invalid' });
  assert.equal(f.calls.length, 0);
  assert.equal(deletionPath({ id: 'g:X', session_group: 'telegram:group' }), '/api/workbench/groups/telegram%3Agroup');
  const unavailable = fixture({ available: () => false }); await unavailable.controller.remove(item);
  assert.equal(unavailable.calls.length, 0);
});

test('duplicate clicks during a pending preview cannot start parallel operations', async () => {
  const wait = deferred(); let calls = 0;
  const f = fixture({ request: async (_path, options) => { calls++; return options?.method ? { ok: true } : wait.promise; } });
  const first = f.controller.remove(item); await f.controller.remove(item);
  assert.equal(calls, 1);
  wait.resolve({ ok: true, operationId: 'one' }); await first;
  assert.equal(calls, 2);
});

test('pending deletion retries reuse its confirmed operation without another preview or confirmation', async () => {
  const operations = []; let previews = 0, deletes = 0;
  const f = fixture({ request: async (_path, options) => {
    if (!options?.method) return { ok: true, operationId: ++previews === 1 ? 'same' : 'new' };
    operations.push(options.body.operationId); return ++deletes === 1 ? { ok: true, pending: true, operationId: 'same' } : { ok: true };
  } });
  await f.controller.remove(item); assert.equal(f.controller.status(item).state, 'pending');
  await f.controller.remove(item); assert.deepEqual(operations, ['same', 'same']);
  assert.equal(previews, 1); assert.equal(f.confirmations.length, 1);
  assert.deepEqual(f.removed, [item.id]);
});

test('lost delete replies retain the confirmed operation for a safe retry', async () => {
  const operations = []; let fails = true;
  const f = fixture({ request: async (_path, options) => {
    if (!options?.method) return { ok: true, operationId: fails ? 'original' : 'new-preview' };
    operations.push(options.body.operationId);
    if (fails) { fails = false; throw { code: 'connection_lost' }; }
    return { ok: true };
  } });
  await f.controller.remove(item); assert.equal(f.controller.status(item).state, 'error');
  await f.controller.remove(item); assert.deepEqual(operations, ['original', 'original']);
  assert.equal(f.confirmations.length, 1);
});

test('changing instance or closing the page during confirmation prevents delete', async () => {
  for (const invalidate of ['identity', 'close']) {
    let identity = 'local'; const wait = deferred(), calls = [];
    const f = fixture({ identity: () => identity, request: async (...args) => { calls.push(args); return { ok: true, operationId: 'one' }; }, confirm: () => wait.promise });
    const pending = f.controller.remove(item); await Promise.resolve();
    if (invalidate === 'identity') identity = 'remote'; else f.controller.invalidate();
    wait.resolve(true); await pending;
    assert.equal(calls.length, 1); assert.equal(f.removed.length, 0);
  }
});

test('malformed previews cannot cause an unbound delete', async () => {
  const f = fixture({ request: async () => ({ ok: true }) }); await f.controller.remove(item);
  assert.equal(f.controller.status(item).state, 'error'); assert.equal(f.removed.length, 0);
});

test('completed estimated counts reach the page result callback', async () => {
  let result;
  const f = fixture({ request: async (_path, options) => options?.method
    ? { ok: true, countsEstimated: true, counts: { messages: 1, attachments: 0, files: 0 } }
    : { ok: true, operationId: 'retry-result' },
    onDeleted: async (id, receipt) => { assert.equal(id, item.id); result = receipt; },
  });
  await f.controller.remove(item);
  assert.equal(result.countsEstimated, true);
});
