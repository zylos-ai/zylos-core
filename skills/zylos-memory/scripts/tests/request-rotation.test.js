import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRotation } from '../request-rotation.js';
import { IDENTITY_ROTATION_PROMPT, GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT, PRE_RECLAIM_SYNC_PROMPT, SYNC_BACKLOG_ALERT } from '../sync-prompts.js';
function fixture(mode, groups, transition = null) {
  const calls = [];
  return { calls, d: {
    readSessionMode: () => ({ mode, keyPresent: mode !== null }),
    getModeTransition: () => transition,
    listGroupTmuxSessions: () => groups.map(sessionGroup => ({ sessionGroup })),
    insertControl: (text, options) => { calls.push({ text, options }); return { id: calls.length }; },
  } };
}
test('IF44: multi queues exactly each live group with idle, priority2 and no ack', async () => {
  const { calls, d } = fixture('multi', ['origin', 'telegram:one', 'lark:two']);
  const result = await requestRotation({}, d);
  assert.equal(result.enqueued.length, 3);
  assert.deepEqual(calls.map(call => call.options.sessionGroup), ['origin', 'telegram:one', 'lark:two']);
  for (const call of calls) assert.deepEqual(call, { text: IDENTITY_ROTATION_PROMPT, options: { sessionGroup: call.options.sessionGroup, priority: 2, requireIdle: true, appendAckSuffix: false } });
});
test('IF44: single uses one NULL target only when its origin session exists', async () => {
  for (const mode of ['single', null]) {
    const { calls, d } = fixture(mode, ['origin', 'telegram:old']);
    await requestRotation({}, d);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.sessionGroup, null);
  }
  for (const mode of ['single', 'multi']) {
    const { calls, d } = fixture(mode, []);
    assert.deepEqual(await requestRotation({}, d), { enqueued: [] });
    assert.equal(calls.length, 0);
  }
  const { calls, d } = fixture('single', ['telegram:old']);
  await requestRotation({}, d);
  assert.equal(calls.length, 0);
});
test('IF44: transition, bad config or failed observation prevent all enqueue', async () => {
  const f = fixture('multi', ['origin'], { runId: 'transition' });
  await assert.rejects(requestRotation({}, f.d), { code: 'TRANSITION_OPEN' });
  assert.equal(f.calls.length, 0);
  for (const method of ['readSessionMode', 'getModeTransition', 'listGroupTmuxSessions']) {
    const { calls, d } = fixture('multi', ['origin']);
    d[method] = () => { throw Object.assign(new Error('failed'), { code: 'READ_FAILED' }); };
    await assert.rejects(requestRotation({}, d), { code: 'READ_FAILED' });
    assert.equal(calls.length, 0);
  }
});
test('IF44: partial queue failure reports committed IDs and never retries', async () => {
  const { d } = fixture('multi', ['origin', 'a', 'b']);
  let count = 0;
  d.insertControl = () => { if (++count === 2) throw Object.assign(new Error('rejected'), { code: 'FENCE_ACTIVE' }); return { id: 99 }; };
  await assert.rejects(requestRotation({}, d), error => {
    assert.equal(error.code, 'FENCE_ACTIVE');
    assert.deepEqual(error.enqueued, [{ sessionGroup: 'origin', id: 99 }]);
    return true;
  });
  assert.equal(count, 2);
});
test('P07 fixed prompts distinguish background work from reclaim wait and identity handoff', () => {
  assert.match(GROUP_SYNC_PROMPT, /Do not wait/);
  assert.match(ORIGIN_SYNC_PROMPT, /Do not wait/);
  assert.match(PRE_RECLAIM_SYNC_PROMPT, /Wait for it to finish before acknowledging/);
  assert.match(IDENTITY_ROTATION_PROMPT, /atomic replacement/);
  assert.match(IDENTITY_ROTATION_PROMPT, /\/clear.*\/exit/);
  assert.equal(SYNC_BACKLOG_ALERT('origin', 10, 20), SYNC_BACKLOG_ALERT('origin', 10, 20));
});

test('IF44: real control transactions supersede repeat requests and preserve exact options', async t => {
  const { fixture: storeFixture } = await import('../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js');
  for (const mode of ['multi', 'single']) {
    const { store, db } = storeFixture(t, { readConfig: () => ({ state: 'ok', config: { session_mode: mode } }) });
    const { d } = fixture(mode, mode === 'multi' ? ['origin', 'a', 'b'] : ['origin']);
    d.insertControl = store.insertControl;
    d.getModeTransition = store.getModeTransition;
    await requestRotation({}, d);
    await requestRotation({}, d);
    const rows = db.prepare('SELECT * FROM control_queue ORDER BY id').all();
    const expected = mode === 'multi' ? 3 : 1;
    assert.equal(rows.filter(r => r.status === 'superseded').length, expected);
    const pending = rows.filter(r => r.status === 'pending');
    assert.equal(pending.length, expected);
    assert.deepEqual(pending.map(r => r.session_group), mode === 'multi' ? ['origin', 'a', 'b'] : [null]);
    for (const r of pending) {
      assert.equal(r.priority, 2);
      assert.equal(r.require_idle, 1);
      assert.equal(r.ack_deadline_at, null);
      assert.equal(r.content, IDENTITY_ROTATION_PROMPT);
    }
  }
});
