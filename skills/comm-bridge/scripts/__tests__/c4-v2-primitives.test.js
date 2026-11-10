import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './c4-v2-test-helpers.js';
import { parseSessionGroup, composeSessionGroup } from '../c4-db.js';
test('pure group parsing is case sensitive, splits once, rejects reserved and malformed inputs', () => {
  for (const invalid of ['', '*', 'void', 'internal', 'origin:x', 'A:x', 'a:', 'a:-b', 'a:x/y', 'a:'+'x'.repeat(96), null]) assert.equal(parseSessionGroup(invalid), null);
  for (const value of ['origin', 'abc', 'a:A:b', 'a:abc', 'a:'+'x'.repeat(95)]) assert.ok(parseSessionGroup(value));
  assert.deepEqual(parseSessionGroup('a:A:b'), { namespace: 'a', groupName: 'A:b' });
  assert.equal(composeSessionGroup('a'), 'a');
  assert.throws(() => composeSessionGroup('a', ''), { code: 'SESSION_GROUP_INVALID' });
  assert.throws(() => composeSessionGroup('a', 'a'.repeat(96)), { code: 'SESSION_GROUP_TOO_LONG' });
});
test('namespace and message transaction rolls back allocation on invalid group and preserves identity', t => {
  const { db, store: s } = fixture(t);
  assert.throws(() => s.insertConversation('in', 'Foo', 'e', 'hello', { groupName: '' }), { code: 'SESSION_GROUP_INVALID' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 0);
  const row = s.insertConversation('in', 'Foo', 'e', 'hello', { groupName: 'A' });
  assert.equal(row.session_group, 'foo:A');
  assert.deepEqual(s.listGroupHeads(), [{ sessionGroup: 'foo:A', headId: row.id }]);
  assert.equal(s.ensureChannelNamespace('foo').namespace, 'foo-2');
  assert.equal(s.ensureChannelNamespace('origin').namespace, 'origin-2');
  assert.equal(s.getComponentByNamespace('foo'), 'Foo');
  assert.throws(() => s.registerChannelNamespace('Other', 'foo'), { code: 'NAMESPACE_CONFLICT' });
  assert.equal(s.insertConversation('out', 'Foo', 'e', 'reply').session_group, 'foo');
  assert.equal(s.insertConversation('out', 'Foo', 'e', 'reply', { groupName: 'unknown' }).session_group, 'foo:unknown');
  assert.equal(s.insertConversation('out', 'Foo', 'new-endpoint', 'reply', { groupName: 'unknown' }).session_group, 'foo:unknown');
});
test('claim fence and late callback guards, atomic failure increments', t => {
  const { store: s } = fixture(t);
  const a = s.insertConversation('in', 'foo', 'e', 'a');
  assert.equal(s.getNextPending().id, a.id);
  s.setDrainFence('foo', { reason: 'ttl', runId: 'r' });
  assert.equal(s.claimConversation(a.id), false); assert.equal(s.getNextPending(), null);
  s.clearDrainFence('foo'); assert.equal(s.claimConversation(a.id), true);
  assert.deepEqual(s.failDelivery(a.id), { changed: true, status: 'pending', retryCount: 1 });
  assert.equal(s.markDelivered(a.id, { sessionId: 'late' }), false);
  assert.equal(s.claimConversation(a.id), true);
  assert.deepEqual(s.failDelivery(a.id), { changed: true, status: 'failed', retryCount: 2 });
  assert.deepEqual(s.failDelivery(a.id), { changed: false, status: 'failed', retryCount: 2 });
});
test('internal messages commit both directions and heads, or roll back everything', t => {
  const { db, store: s } = fixture(t, { validateComponent: name => name !== 'missing' });
  const before = s.insertConversation('in', 'foo', 'e', 'seed');
  const pair = s.insertInternalMessage('origin', 'foo', 'hello\nworld', { sessionId: 'sid' });
  assert.equal(pair.outRow.content, 'hello\nworld');
  assert.equal(pair.outRow.endpoint_id, 'foo');
  assert.equal(pair.outRow.status, 'delivered');
  assert.equal(pair.outRow.session_id, 'sid');
  assert.equal(pair.inRow.content, '[internal] Yourself, from your "origin" session group, said: hello\nworld');
  assert.equal(pair.inRow.endpoint_id, 'origin');
  assert.equal(pair.inRow.status, 'pending');
  assert.equal(pair.inRow.session_id, null);
  const heads = s.listGroupHeads();
  assert.deepEqual(heads, [{ sessionGroup: 'foo', headId: pair.inRow.id }, { sessionGroup: 'origin', headId: pair.outRow.id }]);
  db.exec("CREATE TRIGGER reject_internal BEFORE INSERT ON conversations WHEN NEW.direction='in' AND NEW.channel='internal' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => s.insertInternalMessage('foo', 'origin', 'fail'), { code: 'DB_WRITE_FAILED' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM conversations').get().n, 3);
  assert.deepEqual(s.listGroupHeads(), heads);
  for (const [sender, target, content, code] of [
    [null, 'foo', 'x', 'NO_SENDER_GROUP'], ['missing', 'foo', 'x', 'UNKNOWN_SENDER_GROUP'],
    ['origin', 'missing', 'x', 'UNKNOWN_TARGET_GROUP'], ['origin', 'origin', 'x', 'SELF_TARGET'],
    ['origin', 'foo', ' \n', 'EMPTY_CONTENT'],
  ]) assert.throws(() => s.insertInternalMessage(sender, target, content), { code });
  assert.ok(before.id < pair.outRow.id);
});
test('ordinary message APIs cannot create internal or final inbound states or accept a complete group override', t => {
  const { db, store: s } = fixture(t);
  for (const options of [{ status: 'delivered' }, { status: 'running' }, { status: 'switch_absorbed' }, { sessionGroup: 'origin' }]) {
    assert.throws(() => s.insertConversation('in', 'foo', null, 'x', options), { code: 'INVALID_ARGS' });
  }
  assert.throws(() => s.insertConversation('out', 'foo', null, 'x', { status: 'pending' }), { code: 'INVALID_ARGS' });
  assert.throws(() => s.insertConversation('out', 'foo', null, 'x', { senderGroup: 'origin' }), { code: 'INVALID_ARGS' });
  assert.throws(() => s.insertConversation('in', 'internal', 'origin', 'x'), { code: 'INVALID_ARGS' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 0);
  assert.equal(s.insertConversation('in', 'foo', null, 'x', { status: 'failed' }).status, 'failed');
});

test('internal messages create new targets only for installed namespace owners', t => {
  const installed = new Set(['chat', 'fresh', 'renamed']);
  const { db, store: s } = fixture(t, { validateComponent: name => installed.has(name) });
  s.ensureChannelNamespace('chat');
  const pair = s.insertInternalMessage('origin', 'chat:new-person', 'deliver this');
  assert.equal(pair.inRow.session_group, 'chat:new-person');
  assert.equal(pair.inRow.status, 'pending');
  assert.equal(s.getNextPending({ sessionGroups: ['chat:new-person'] }).id, pair.inRow.id);
  assert.equal(s.listGroupHeads().some(head => head.sessionGroup === 'chat:new-person'), true);
  const fresh = s.insertInternalMessage('origin', 'fresh:person', 'first contact');
  assert.equal(s.getChannelNamespace('fresh').namespace, 'fresh');
  assert.equal(fresh.inRow.session_group, 'fresh:person');
  const count = () => db.prepare('SELECT count(*) AS n FROM conversations').get().n;
  const before = count();
  installed.delete('chat');
  for (const group of ['chat:new-person', 'unknown:x', '', '*', 'fresh:-bad']) {
    assert.throws(() => s.insertInternalMessage('origin', group, 'refused'), { code: 'UNKNOWN_TARGET_GROUP' });
  }
  s.registerChannelNamespace('renamed', 'custom');
  assert.throws(() => s.insertInternalMessage('origin', 'renamed:new', 'refused'), { code: 'UNKNOWN_TARGET_GROUP' });
  assert.equal(s.getChannelNamespace('renamed').namespace, 'custom');
  assert.equal(count(), before);
});

test('new internal target allocation rolls back if its second row fails', t => {
  const { db, store: s } = fixture(t, { validateComponent: name => name === 'fresh' });
  db.exec("CREATE TRIGGER reject_new_internal BEFORE INSERT ON conversations WHEN NEW.direction='in' AND NEW.channel='internal' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => s.insertInternalMessage('origin', 'fresh:new', 'hello'), { code: 'DB_WRITE_FAILED' });
  for (const table of ['conversations', 'group_heads', 'channel_namespaces']) {
    assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, table);
  }
});

test('dashboard origin is a fixed address in both directions without topic registration', t => {
  const { db, store: s } = fixture(t, { validateComponent: name => name === 'dashboard' });
  for (const direction of ['in', 'out']) {
    const record = s.insertConversation(direction, 'dashboard', 'origin', 'origin message', { groupName: 'origin' });
    assert.equal(record.session_group, 'origin');
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 0);
  assert.equal(s.listGroupHeads().some(head => head.sessionGroup === 'dashboard:origin'), false);
  assert.equal(s.insertConversation('in', 'dashboard', 'other', 'ordinary', { groupName: 'other' }).session_group, 'dashboard:other');
});
