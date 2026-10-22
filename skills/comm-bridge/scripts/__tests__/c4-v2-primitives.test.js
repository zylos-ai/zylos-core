import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { guardDatabase } from '../sqlite-schema.js';
import * as owner from '../c4-schema.js';
import { createStore } from '../c4-v2-store.js';
import { parseSessionGroup, composeSessionGroup } from '../c4-db.js';
function fixture(t, dependencies = {}) {
  const db = new Database(':memory:'); t.after(() => db.close()); guardDatabase(db, owner);
  const store = createStore(db, { validateComponent: () => true, readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true, ...dependencies });
  return { db, store };
}
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
  assert.equal(s.insertConversation('out', 'Foo', 'e', 'reply').session_group, 'foo:A');
  assert.equal(s.insertConversation('out', 'Foo', 'e', 'reply', { groupName: 'unknown' }).session_group, 'foo');
});
test('message/head failure rolls back all three writes using a real SQL trigger', t => {
  const { db, store: s } = fixture(t);
  db.exec("CREATE TRIGGER reject_head BEFORE INSERT ON group_heads BEGIN SELECT RAISE(ABORT,'fixture'); END");
  assert.throws(() => s.insertConversation('in', 'new', 'e', 'hello'), { code: 'DB_WRITE_FAILED' });
  for (const table of ['conversations', 'channel_namespaces', 'group_heads']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0);
});
test('launch config reads F1 once and both overrides in one snapshot, single ignores overrides', t => {
  let reads = 0;
  const { db, store: s } = fixture(t, { readConfig: () => { reads++; return { state: 'ok', config: { runtime: reads % 2 ? 'claude' : 'codex' } }; } });
  s.insertConversation('in', 'foo', 'e', 'hello');
  s.setSessionRuntimeConfig({ sessionGroup: 'foo', runtime: 'codex' });
  s.setSessionModelConfig({ sessionGroup: 'foo', runtime: 'codex', model: 'm', effort: 'high' });
  assert.deepEqual(s.resolveSessionLaunchConfig({ sessionGroup: 'foo', sessionMode: 'multi' }), { runtime: 'codex', mode: 'override', model: 'm', effort: 'high' });
  assert.equal(reads, 1); assert.equal(db.inTransaction, false);
  assert.deepEqual(s.resolveSessionLaunchConfig({ sessionGroup: 'foo', sessionMode: 'single' }), { runtime: 'codex', mode: 'default' });
  assert.equal(reads, 2);
  assert.equal(s.setSessionRuntimeConfig({ sessionGroup: 'foo', runtime: 'codex' }).changed, false);
  s.resetSessionRuntimeConfig({ sessionGroup: 'foo' });
  assert.equal(s.getSessionModelConfig({ sessionGroup: 'foo', runtime: 'codex' }).mode, 'override');
  assert.throws(() => s.setSessionModelConfig({ sessionGroup: 'foo', runtime: 'codex', model: 'm' }), { code: 'MODEL_PAIR_REQUIRED' });
  assert.throws(() => s.setSessionRuntimeConfig({ sessionGroup: 'foo:absent', runtime: 'codex' }), { code: 'SESSION_GROUP_NOT_FOUND' });
});
test('unreadable F1 cannot silently become defaults', t => {
  const { store: s } = fixture(t, { readConfig: () => ({ state: 'error', error: new Error('bad') }) });
  assert.throws(() => s.resolveSessionLaunchConfig({ sessionMode: 'single' }), { code: 'CONFIG_UNREADABLE' });
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
test('expiry is strict, conditional and preserves retry count', t => {
  const { db, store: s } = fixture(t, { now: () => Date.UTC(2026, 0, 1, 1) });
  const row = s.insertConversation('in', 'system', null, 'pending');
  db.prepare("UPDATE conversations SET timestamp='2026-01-01 00:30:00' WHERE id=?").run(row.id);
  assert.equal(s.expirePending(row.id, 1800), false);
  assert.equal(s.expirePending(row.id, 1799), true);
  assert.equal(s.expirePending(row.id, 1799), false);
  assert.equal(db.prepare('SELECT retry_count FROM conversations').get().retry_count, 0);
});
test('coverage cannot skip a pending gap and no-content does not hide content', t => {
  const { store: s } = fixture(t);
  const a = s.insertConversation('in', 'foo', 'e', 'a'), b = s.insertConversation('out', 'foo', 'e', 'b');
  assert.equal(s.getDeliveredFrontier('foo'), a.id - 1);
  assert.throws(() => s.createCheckpoint('foo', b.id, 'summary'), { code: 'CHECKPOINT_GAP' });
  s.claimConversation(a.id); s.markDelivered(a.id, { sessionId: 's' });
  const cp = s.createCheckpoint('foo', b.id, 'summary');
  const c = s.insertConversation('out', 'foo', 'e', 'c');
  s.createCheckpoint('foo', c.id, null, { noContent: true });
  assert.equal(s.getLatestContentCheckpoint('foo').id, cp.id);
  assert.equal(s.getCoverageEnd('foo'), c.id);
  assert.throws(() => s.createCheckpoint('foo', c.id + 1, 'bad'), { code: 'CHECKPOINT_BEYOND_HEAD' });
  assert.throws(() => s.advanceOriginSyncCursor('foo', { syncedId: c.id + 1, checkpointId: cp.id }), { code: 'CURSOR_INVALID' });
});
test('transition is atomic, replay-stable and complete removes only its global fence', t => {
  const { store: s } = fixture(t);
  const a = s.insertConversation('in', 'foo', 'e', 'a');
  const { runId } = s.beginModeTransition('single', 'multi');
  assert.throws(() => s.beginModeTransition('single', 'multi'), { code: 'TRANSITION_OPEN' });
  assert.throws(() => s.absorbForTransition(runId), { code: 'TRANSITION_PRECONDITION' });
  s.setDrainFence('*');
  const first = s.absorbForTransition(runId);
  assert.deepEqual(first.absorbedIds, [a.id]);
  s.insertConversation('in', 'bar', 'e', 'new');
  assert.deepEqual(s.absorbForTransition(runId), first);
  s.setModeTransitionPhase(runId, 'cutover');
  s.setModeTransitionPhase(runId, 'complete');
  assert.equal(s.getDrainFence('*'), null);
  assert.equal(s.getLastCompletedModeTransition().run_id, runId);
});
test('targeted controls are isolated and fences reject stale claims', t => {
  const { store: s } = fixture(t);
  assert.throws(() => s.insertControl('x'), { code: 'CONTROL_TARGET_REQUIRED' });
  assert.throws(() => s.insertControl('x', { sessionGroup: 'foo' }), { code: 'ACK_DEADLINE_REQUIRED' });
  const a = s.insertControl('x', { sessionGroup: 'foo', appendAckSuffix: false });
  const b = s.insertControl('x', { sessionGroup: 'bar', appendAckSuffix: false });
  assert.equal(b.superseded_count, 0);
  s.setDrainFence('foo', { reason: 'ttl', runId: 'r' });
  assert.equal(s.claimControl(a.id), false);
  assert.equal(s.claimControl(b.id), true);
  assert.deepEqual(s.countNonTerminalControls({ sessionGroup: 'bar' }), { pending: 0, running: 1, runningWithoutDeadline: 1 });
  assert.equal(s.expirePendingControls({ allSessionGroups: true }).length, 1);
  assert.equal(s.expireControlById(b.id).last_error, 'MANUAL_EXPIRED');
});
test('internal messages commit both directions and heads, or roll back everything', t => {
  const { db, store: s } = fixture(t);
  const before = s.insertConversation('in', 'foo', 'e', 'seed');
  const pair = s.insertInternalMessage('origin', 'foo', 'hello\nworld', { sessionId: 'sid' });
  assert.equal(pair.outRow.content, 'hello\nworld');
  assert.equal(pair.outRow.endpoint_id, 'foo');
  assert.equal(pair.outRow.status, 'delivered');
  assert.equal(pair.outRow.session_id, 'sid');
  assert.equal(pair.inRow.content, '[internal] origin said: hello\nworld');
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
  assert.throws(() => s.insertConversation('in', 'internal', 'origin', 'x'), { code: 'INVALID_ARGS' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM channel_namespaces').get().n, 0);
  assert.equal(s.insertConversation('in', 'foo', null, 'x', { status: 'failed' }).status, 'failed');
});
test('invalid F1 mode is not silently used as a baseline', t => {
  const { store: s } = fixture(t, { readConfig: () => ({ state: 'ok', config: { session_mode: 'broken' } }) });
  assert.throws(() => s.resolveSessionLaunchConfig({ sessionMode: 'single' }), { code: 'CONFIG_UNREADABLE' });
});
test('target binding validates scope, run, runtime and readiness in contract order', t => {
  const live = { runId: 'r', runtime: 'codex', sessionGroup: 'foo', currentSession: { runId: 'r', sessionId: 'sid' }, tmuxTarget: { serverGeneration: '123:456', sessionId: '$1', paneId: '%2' } };
  let calls = 0;
  const { store: s } = fixture(t, { resolveTarget: () => { calls++; return live; } });
  s.insertConversation('in', 'foo', 'e', 'seed');
  const options = { sessionGroup: 'foo', expectedRunId: 'r', expectedRuntime: 'codex', expectedSessionId: 'sid' };
  assert.deepEqual(JSON.parse(s.buildTargetBinding(options)), { expectedRunId: 'r', tmuxTarget: live.tmuxTarget, expectedSessionId: 'sid' });
  assert.equal(calls, 1);
  assert.throws(() => s.buildTargetBinding({ ...options, tmuxTarget: live.tmuxTarget }), { code: 'INVALID_ARGS' });
  assert.throws(() => s.buildTargetBinding({ ...options, sessionGroup: null }), { code: 'CONTROL_TARGET_REQUIRED' });
  assert.throws(() => s.buildTargetBinding({ ...options, expectedRunId: 'old' }), { code: 'TARGET_MISMATCH', runId: 'r' });
  live.runtime = 'unknown';
  assert.throws(() => s.buildTargetBinding(options), { code: 'TARGET_SNAPSHOT_UNKNOWN' });
  live.runtime = 'claude';
  assert.throws(() => s.buildTargetBinding(options), { code: 'TARGET_RUNTIME_MISMATCH' });
  live.runtime = 'codex'; live.sessionGroup = 'bar';
  assert.throws(() => s.buildTargetBinding(options), { code: 'TARGET_SCOPE_MISMATCH' });
  live.sessionGroup = 'foo'; live.currentSession.runId = 'old';
  assert.throws(() => s.buildTargetBinding(options), { code: 'TARGET_NOT_READY' });
  live.currentSession.runId = 'r'; live.currentSession.sessionId = 'new';
  assert.throws(() => s.buildTargetBinding(options), { code: 'STALE_TARGET' });
  s.beginModeTransition('multi', 'single');
  assert.throws(() => s.buildTargetBinding(options), { code: 'TRANSITION_OPEN' });
});
