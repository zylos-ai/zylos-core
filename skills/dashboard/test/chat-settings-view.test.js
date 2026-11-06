import test from 'node:test';
import assert from 'node:assert/strict';
import { mountChatSettings } from '../public/js/wb/chat-settings.js';
import { documentFixture } from './fixtures/settings-dom.js';
import { deferred } from './fixtures/workbench-dom.js';

function fixture(options = {}) {
  const document = documentFixture(), root = document.createElement('div');
  const writes = [];
  const view = mountChatSettings(root, {
    local: () => true,
    read: async () => ({ allowRemote: false }),
    write: async body => { writes.push(body); return body; },
    ...options,
  });
  return { root, view, writes, checkbox: root.querySelector('input'), status: root.querySelector('[role="status"]') };
}

test('local conversation setting loads saved state and saves through its independent control', async () => {
  const f = fixture();
  assert.equal(f.checkbox.disabled, true);
  await f.view.refresh();
  assert.equal(f.root.querySelector('#settings-chat').hidden, false);
  assert.equal(f.checkbox.checked, false);
  assert.equal(f.checkbox.disabled, false);
  f.checkbox.checked = true;
  await f.checkbox.dispatch('change');
  assert.deepEqual(f.writes, [{ allowRemote: true }]);
  assert.equal(f.checkbox.checked, true);
  assert.equal(f.status.textContent, 'wb.settings.chatSaved');
});

test('remote views neither load nor write local conversation settings', async () => {
  let reads = 0;
  const f = fixture({ local: () => false, read: async () => { reads++; return { allowRemote: true }; } });
  await f.view.refresh();
  f.checkbox.checked = true;
  await f.checkbox.dispatch('change');
  assert.equal(f.root.querySelector('#settings-chat').hidden, true);
  assert.equal(f.checkbox.disabled, true);
  assert.equal(f.checkbox.checked, false);
  assert.equal(reads, 0);
  assert.equal(f.writes.length, 0);
});

test('conversation setting read failure leaves its control disabled', async () => {
  for (const read of [async () => { throw Error('403'); }, async () => ({})]) {
    const f = fixture({ read });
    await f.view.refresh();
    assert.equal(f.checkbox.disabled, true);
    assert.equal(f.status.textContent, 'wb.settings.chatReadFailed');
    assert.equal(f.writes.length, 0);
  }
});

test('conversation setting save failure restores the last saved value', async () => {
  for (const write of [async () => { throw Error('500'); }, async () => ({})]) {
    const f = fixture({ read: async () => ({ allowRemote: true }), write });
    await f.view.refresh();
    f.checkbox.checked = false;
    await f.checkbox.dispatch('change');
    assert.equal(f.checkbox.checked, true);
    assert.equal(f.checkbox.disabled, false);
    assert.equal(f.status.textContent, 'wb.settings.chatSaveFailed');
  }
});

test('conversation settings invalidate delayed reads when leaving the local page', async () => {
  let local = true;
  const pending = deferred(), f = fixture({ local: () => local, read: () => pending.promise });
  const refresh = f.view.refresh();
  local = false;
  f.view.invalidate();
  pending.resolve({ allowRemote: true });
  await refresh;
  assert.equal(f.root.querySelector('#settings-chat').hidden, true);
  assert.equal(f.checkbox.checked, false);
  assert.equal(f.checkbox.disabled, true);
  assert.equal(f.status.hidden, true);
});

test('conversation setting serializes saves and ignores a delayed result after page invalidation', async () => {
  const pending = deferred(), writes = [];
  const f = fixture({ write: body => { writes.push(body); return pending.promise; } });
  await f.view.refresh();
  f.checkbox.checked = true;
  const save = f.checkbox.dispatch('change');
  assert.equal(f.checkbox.disabled, true);
  await f.checkbox.dispatch('change');
  assert.equal(writes.length, 1);
  f.view.invalidate();
  pending.resolve({ allowRemote: true });
  await save;
  assert.equal(f.root.querySelector('#settings-chat').hidden, true);
  assert.equal(f.checkbox.checked, false);
  assert.equal(f.checkbox.disabled, true);
  assert.equal(f.status.hidden, true);
});
