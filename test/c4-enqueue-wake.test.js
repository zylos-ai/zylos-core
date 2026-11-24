import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { deferred, flush, routerFixture } from '../skills/comm-bridge/scripts/__tests__/helpers/router-fixture.js';
import { deliveryFixture } from '../skills/comm-bridge/scripts/__tests__/helpers/session-delivery-fixture.js';
import { notifyQueued } from '../skills/comm-bridge/scripts/router/wake-socket.js';

async function setup(t, notifyQueued) {
  const f = routerFixture(t, { notifyQueued });
  f.put('a', { runId: 'run-1', sessionId: 'session-1' });
  const terminal = deliveryFixture(t, { storage: { db: f.sqlite, store: f.db } });
  f.deps.deliverConversation = terminal.delivery.deliverConversation;
  const router = f.create();
  await router.initialize();
  await router.idle();
  return { ...f, router, terminal };
}

// Store commit → injected wake → ready lane → real delivery policy and ledger.
// Run for post-commit signaling or ready-lane dispatch changes. Skip unrelated
// changes. Use the isolated runner under a separate Unix user; no service,
// tmux or real runtime is started. SQLite and the clock are fixtures.
test('a committed inbound message wakes its ready lane without a poll', async t => {
  let f;
  const hints = [];
  f = await setup(t, group => {
    hints.push({ group, inTransaction: f.sqlite.inTransaction, status: f.db.getNextPending({ sessionGroups: [group] })?.status });
    f.router.wake(group);
  });
  const row = f.add();
  await flush();
  await f.router.idle();
  assert.deepEqual(hints, [{ group: 'a', inTransaction: false, status: 'pending' }]);
  assert.equal(f.router.state.round, 0);
  assert.equal(f.row(row.id).status, 'delivered');
  assert.equal(f.terminal.calls.filter(([kind]) => kind === 'paste').length, 1);
});

// Store commit → injected missing socket → retained queue row → poll → delivery.
// Run for wake transport or poll fallback changes. Skip unrelated changes.
// Same isolated runner and separate Unix user; no live socket or runtime.
test('a missing wake socket preserves the insert and the next poll delivers it', async t => {
  let hint;
  const f = await setup(t, group => {
    hint = notifyQueued(group, {
      createConnection() {
        const socket = new EventEmitter();
        socket.destroy = () => {};
        queueMicrotask(() => socket.emit('error', Object.assign(new Error('Missing socket'), { code: 'ENOENT' })));
        return socket;
      },
    });
    return hint;
  });
  const row = f.add();
  assert.equal(row.session_group, 'a');
  assert.equal(row.status, 'pending');
  assert.ok(hint);
  await hint;
  assert.equal(f.row(row.id).status, 'pending');
  assert.equal(f.router.state.round, 0);
  f.router.tick();
  await f.router.idle();
  assert.equal(f.router.state.round, 1);
  assert.equal(f.row(row.id).status, 'delivered');
  assert.equal(f.terminal.calls.filter(([kind]) => kind === 'paste').length, 1);
});

// Real claims, delivery policy and settlement for two same-group messages.
// Run for lane serialization or delivery completion changes. Skip unrelated
// changes. Same isolated runner and separate Unix user; no live terminal I/O.
test('a ready lane serializes two deliveries within the same poll round', async t => {
  const f = await setup(t);
  const first = f.add();
  const second = f.add();
  const hold = deferred();
  const deliver = f.deps.deliverConversation;
  const started = [];
  f.deps.deliverConversation = async row => {
    started.push(row.id);
    if (row.id === first.id) await hold.promise;
    assert.equal(f.db.countRunningConversations('a'), 1);
    return deliver(row);
  };
  try {
    f.router.tick();
    await flush();
    assert.deepEqual(started, [first.id]);
    assert.equal(f.row(first.id).status, 'running');
    assert.equal(f.row(second.id).status, 'pending');
  } finally {
    hold.resolve();
    await f.router.idle();
  }
  assert.equal(f.router.state.round, 1);
  assert.deepEqual(started, [first.id, second.id]);
  assert.equal(f.row(first.id).status, 'delivered');
  assert.equal(f.row(second.id).status, 'delivered');
});
