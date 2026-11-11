import test from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteAccess, REMOTE_ACCESS_REFUSED } from '../public/js/wb/remote-access.js';

// A remote view's tabs as app.js wires them: the viewed machine, its last state, the conversation tab and the open tab.
function view({ remote = true, state = {} } = {}) {
  const f = { remote, state, chatTab: { hidden: false }, active: 'overview', changes: 0, deferred: [] };
  f.access = createRemoteAccess({
    viewingRemote: () => f.remote,
    dashboardState: () => f.state,
    chatTab: () => f.chatTab,
    activeTab: () => f.active,
    openTab: name => { f.active = name; },
    onChange: () => { f.changes += 1; },
    defer: callback => f.deferred.push(callback)
  });
  f.flush = () => { for (const callback of f.deferred.splice(0)) callback(); };
  return f;
}

test('the local machine never depends on the remote access switch', () => {
  const f = view({ remote: false, state: { chat_allow_remote: false } });
  assert.equal(f.access.closed(), false);
  for (const name of ['chat', 'observer']) assert.equal(f.access.blocks(name), false);
  assert.equal(f.access.noteError(REMOTE_ACCESS_REFUSED), true, 'still recognised as the refusal');
  f.flush();
  assert.equal(f.access.closed(), false, 'a local page ignores a refusal');
  f.access.sync();
  assert.equal(f.chatTab.hidden, false);
});

test('a remote machine whose state says the switch is off hides conversations and the observer', () => {
  const f = view({ state: { chat_allow_remote: false } });
  assert.equal(f.access.closed(), true);
  assert.equal(f.access.blocks('chat'), true);
  assert.equal(f.access.blocks('observer'), true);
  assert.equal(f.access.blocks('memory'), false);
  assert.equal(f.access.blocks('overview'), false);
  f.active = 'chat';
  f.access.sync();
  assert.equal(f.chatTab.hidden, true);
  assert.equal(f.active, 'overview', 'the open conversation tab gives way to the overview');
  assert.equal(f.changes, 1, 'the observer entry is redrawn');
  f.active = 'memory';
  f.access.sync();
  assert.equal(f.active, 'memory', 'other tabs stay open');
});

test('an older machine without the field shows both tabs and lets its backend decide', () => {
  const f = view({ state: {} });
  assert.equal(f.access.closed(), false);
  f.chatTab.hidden = true;
  f.access.sync();
  assert.equal(f.chatTab.hidden, false);
  f.state = null;
  assert.equal(f.access.closed(), false);
});

test('a refusal met mid-browse hides the tabs once the current redraw is over', () => {
  const f = view({ state: { chat_allow_remote: true } });
  f.active = 'observer';
  assert.equal(f.access.noteError('auth_expired'), false);
  assert.equal(f.access.noteError(undefined), false);
  assert.equal(f.access.closed(), false);
  // The observer's lease request is refused over HTTP with the same code as conversations.
  assert.equal(f.access.noteError(REMOTE_ACCESS_REFUSED), true);
  assert.equal(f.access.closed(), true);
  assert.equal(f.chatTab.hidden, false, 'nothing changes inside the reporting redraw');
  f.access.refuse();
  assert.equal(f.deferred.length, 1, 'a repeated refusal is not queued twice');
  f.flush();
  assert.equal(f.chatTab.hidden, true);
  assert.equal(f.active, 'overview');
});

test('a later state with the switch on, or switching machines, forgets a refusal', () => {
  const f = view({ state: {} });
  f.access.refuse(); f.flush();
  assert.equal(f.access.closed(), true);
  f.access.noteState({ chat_allow_remote: false });
  f.access.noteState({});
  assert.equal(f.access.closed(), true, 'only an explicit "on" reopens');
  f.access.noteState({ chat_allow_remote: true });
  assert.equal(f.access.closed(), false);
  f.access.sync();
  assert.equal(f.chatTab.hidden, false);
  f.access.refuse(); f.flush();
  f.access.reset();
  assert.equal(f.access.closed(), false);
});
