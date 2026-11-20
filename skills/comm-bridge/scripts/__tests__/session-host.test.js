import test from 'node:test';
import assert from 'node:assert/strict';
import Database from '../sqlite-driver.js';
import * as schema from '../c4-schema.js';
import { guardDatabase } from '../sqlite-schema.js';
import { createStore } from '../c4-v2-store.js';

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  guardDatabase(db, schema);
  let mode = 'multi';
  const store = createStore(db, {
    validateComponent: name => name === 'chat',
    readSessionMode: () => ({ keyPresent: true, mode }),
    now: () => 1700000000000,
  });
  const attach = (source, target) => store.attachSessionHost(source, target, 'origin');
  return { store, attach, setMode: next => { mode = next; } };
}

test('hosted destinations resolve to their host and a cycle leaves every existing relationship in place', t => {
  const { store, attach } = fixture(t);
  attach('chat:c', 'chat:x');
  assert.equal(attach('chat:a', 'chat:c').target, 'chat:x');
  assert.throws(() => attach('chat:x', 'chat:c'), {
    code: 'HOST_CYCLE', message: 'Hosting would create a cycle. Detach the existing relationship first.',
  });
  assert.equal(store.getSessionHost('chat:c'), 'chat:x');
  assert.equal(store.getSessionHost('chat:a'), 'chat:x');
  assert.equal(store.getSessionHost('chat:x'), null);
});

test('internal and external input use the host without moving earlier rows', t => {
  const { store, attach } = fixture(t);
  const source = 'chat:a', target = 'chat:b';
  const inbound = content => store.insertConversation('in', 'chat', 'room', content, { groupName: 'a' });
  const earlier = inbound('before hosting');
  assert.equal(store.claimConversation(earlier.id), true);
  assert.equal(store.markDelivered(earlier.id), true);
  attach(source, target);
  const pair = store.insertInternalMessage('origin', source, 'internal work');
  assert.equal(pair.outRow.endpoint_id, source);
  assert.equal(pair.inRow.session_group, target);
  const hosted = inbound('after hosting');
  assert.equal(hosted.session_group, target);
  assert.equal(store.claimConversation(hosted.id), true);
  assert.equal(store.markDelivered(hosted.id), true);
  assert.equal(store.detachSessionHost(source), true);
  const delivered = group => store.getDeliveredSince(group, 0, { limit: 4 }).map(row => row.id);
  assert.deepEqual(delivered(source), [earlier.id]);
  assert.deepEqual(delivered(target), [hosted.id]);
});

test('single mode skips hosting for incoming messages while preserving relationships for multi mode', t => {
  const { store, attach, setMode } = fixture(t);
  attach('chat:a', 'chat:b');
  setMode('single');
  assert.equal(store.getSessionHost('chat:a'), null);
  assert.equal(store.insertConversation('in', 'chat', 'room', 'single inbound', { groupName: 'a' }).session_group, 'chat:a');
  setMode('multi');
  assert.equal(store.getSessionHost('chat:a'), 'chat:b');
});
