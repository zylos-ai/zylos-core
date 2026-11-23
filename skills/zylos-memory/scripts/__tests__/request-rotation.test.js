import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRotation } from '../request-rotation.js';
import { IDENTITY_ROTATION_PROMPT } from '../sync-prompts.js';
function bindingFor(sessionGroup) {
  return JSON.stringify({ expectedRunId: `run-${sessionGroup}`, tmuxTarget: { serverGeneration: 'server', sessionId: '$1', paneId: '%2' } });
}
function fixture(mode, groups, transition = null, keyPresent = mode !== null) {
  const calls = [];
  return { calls, d: {
    readSessionMode: () => ({ mode, keyPresent }),
    getModeTransition: () => transition,
    listGroupTmuxSessions: () => groups.map(sessionGroup => ({ sessionGroup })),
    readLiveIdentity: sessionGroup => ({ present: true, runId: `run-${sessionGroup}` }),
    buildTargetBinding: ({ sessionGroup, expectedRunId }) => {
      assert.equal(expectedRunId, `run-${sessionGroup}`);
      return bindingFor(sessionGroup);
    },
    insertControl: (text, options) => { calls.push({ text, options }); return { id: calls.length }; },
  } };
}
test('multi queues exactly each live group with idle, priority2 and no ack', async () => {
  const { calls, d } = fixture('multi', ['origin', 'telegram:one', 'lark:two']);
  const result = await requestRotation({}, d);
  assert.equal(result.enqueued.length, 3);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(calls.map(call => call.options.sessionGroup), ['origin', 'telegram:one', 'lark:two']);
  for (const call of calls) assert.deepEqual(call, { text: IDENTITY_ROTATION_PROMPT, options: { sessionGroup: call.options.sessionGroup, targetBinding: bindingFor(call.options.sessionGroup), priority: 2, requireIdle: true, appendAckSuffix: false } });
});
test('unkeyed single uses one NULL target only when its origin session exists', async () => {
  for (const mode of ['single', null]) {
    const { calls, d } = fixture(mode, ['origin', 'telegram:old'], null, false);
    await requestRotation({}, d);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.sessionGroup, null);
    assert.equal(calls[0].options.targetBinding, null);
  }
  for (const mode of ['single', 'multi']) {
    const { calls, d } = fixture(mode, []);
    assert.deepEqual(await requestRotation({}, d), { enqueued: [], skipped: [] });
    assert.equal(calls.length, 0);
  }
  const { calls, d } = fixture('single', ['telegram:old'], null, false);
  await requestRotation({}, d);
  assert.equal(calls.length, 0);
});
test('transition, bad config or failed observation prevent all enqueue', async () => {
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

test('real control transactions supersede repeat requests and preserve exact options', async t => {
  const { fixture: storeFixture } = await import('../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js');
  for (const mode of ['multi', 'single', null]) {
    const { store, db } = storeFixture(t, { readConfig: () => ({ state: 'ok', config: mode === null ? {} : { session_mode: mode } }) });
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
    assert.deepEqual(pending.map(r => r.session_group), mode === 'multi' ? ['origin', 'a', 'b'] : mode === 'single' ? ['origin'] : [null]);
    for (const r of pending) {
      assert.equal(r.target_binding, mode !== null ? bindingFor(r.session_group) : null);
      assert.equal(r.priority, 2);
      assert.equal(r.require_idle, 1);
      assert.equal(r.ack_deadline_at, null);
      assert.equal(r.content, IDENTITY_ROTATION_PROMPT);
    }
  }
});

test('an identity control left after its Origin exits does not create new Origin demand', async t => {
  const { fixture: storeFixture } = await import('../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js');
  let present = true;
  const { store, db } = storeFixture(t, {
    resolveTarget: () => present ? {
      runId: 'observed-run', runtime: 'claude', sessionGroup: 'origin',
      currentSession: { runId: 'observed-run' },
      tmuxTarget: { serverGeneration: 'server', sessionId: '$1', paneId: '%2' },
    } : null,
  });
  const { d } = fixture('multi', ['origin']);
  d.readLiveIdentity = () => ({ present, runId: present ? 'observed-run' : null });
  d.buildTargetBinding = store.buildTargetBinding;
  d.insertControl = store.insertControl;
  await requestRotation({}, d);
  present = false;
  const row = db.prepare('SELECT * FROM control_queue').get();
  assert.equal(row.status, 'pending');
  assert.equal(JSON.parse(row.target_binding).expectedRunId, 'observed-run');
  assert.deepEqual(store.getOriginNeed(Math.floor(Date.now() / 1000)).controls, { count: 0, oldestAt: null });
});
