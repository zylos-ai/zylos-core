import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRotation, printRotationResult } from '../request-rotation.js';
import { IDENTITY_ROTATION_PROMPT, GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT, PRE_RECLAIM_SYNC_PROMPT, SYNC_BACKLOG_ALERT } from '../sync-prompts.js';
function bindingFor(sessionGroup) {
  return JSON.stringify({ expectedRunId: `run-${sessionGroup}`, tmuxTarget: { serverGeneration: 'server', sessionId: '$1', paneId: '%2' } });
}
function fixture(mode, groups, transition = null) {
  const calls = [];
  return { calls, d: {
    readSessionMode: () => ({ mode, keyPresent: mode !== null }),
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
test('single uses one NULL target only when its origin session exists', async () => {
  for (const mode of ['single', null]) {
    const { calls, d } = fixture(mode, ['origin', 'telegram:old']);
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
  const { calls, d } = fixture('single', ['telegram:old']);
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
test('partial queue failure reports committed IDs and never retries', async () => {
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
test('fixed prompts distinguish background work from reclaim wait and identity handoff', () => {
  for (const prompt of [GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT]) {
    assert.match(prompt, /Continue your current work while it runs/);
    assert.match(prompt, /In Claude, do not wait for it/);
    assert.match(prompt, /In Codex, before ending your turn, use the native agent tools to wait for this worker and read its terminal result/);
    assert.match(prompt, /a timeout or a Completed label alone is not a Sync outcome/);
    assert.match(prompt, /Report a failed Sync to the owner once through the existing channel route/);
    assert.match(prompt, /Successful Sync needs no extra owner message/);
  }
  assert.match(PRE_RECLAIM_SYNC_PROMPT, /Wait for it to finish before acknowledging/);
  assert.match(IDENTITY_ROTATION_PROMPT, /atomic replacement/);
  assert.match(IDENTITY_ROTATION_PROMPT, /\/clear.*\/exit/);
  assert.equal(SYNC_BACKLOG_ALERT('origin', 10, 20), SYNC_BACKLOG_ALERT('origin', 10, 20));
});

test('real control transactions supersede repeat requests and preserve exact options', async t => {
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
      assert.equal(r.target_binding, mode === 'multi' ? bindingFor(r.session_group) : null);
      assert.equal(r.priority, 2);
      assert.equal(r.require_idle, 1);
      assert.equal(r.ack_deadline_at, null);
      assert.equal(r.content, IDENTITY_ROTATION_PROMPT);
    }
  }
});


test('multi skips a changed or unready target and continues with the other groups', async () => {
  for (const code of ['TARGET_NOT_RUNNING', 'TARGET_MISMATCH', 'TARGET_NOT_READY', 'TARGET_SCOPE_MISMATCH', 'TARGET_RUNTIME_MISMATCH', 'TARGET_SNAPSHOT_UNKNOWN']) {
    const { calls, d } = fixture('multi', ['origin', 'telegram:one']);
    const build = d.buildTargetBinding;
    d.buildTargetBinding = options => {
      if (options.sessionGroup === 'origin') throw Object.assign(new Error('target rejected'), { code });
      return build(options);
    };
    const result = await requestRotation({}, d);
    assert.deepEqual(result.skipped, [{ sessionGroup: 'origin', code }]);
    assert.deepEqual(result.enqueued, [{ sessionGroup: 'telegram:one', id: 1 }]);
    assert.deepEqual(calls.map(call => call.options.targetBinding), [bindingFor('telegram:one')]);
  }
});

test('multi skips targets without a present run before attempting binding', async () => {
  for (const live of [{ present: false, runId: 'old' }, { present: true, runId: null }]) {
    const { calls, d } = fixture('multi', ['origin']);
    d.readLiveIdentity = () => live;
    d.buildTargetBinding = () => assert.fail('an absent run cannot be bound');
    assert.deepEqual(await requestRotation({}, d), {
      enqueued: [], skipped: [{ sessionGroup: 'origin', code: 'TARGET_NOT_RUNNING' }],
    });
    assert.equal(calls.length, 0);
  }
});

test('binding infrastructure errors abort with the IDs already committed', async () => {
  for (const code of ['TRANSITION_OPEN', 'TMUX_UNAVAILABLE', 'DB_BUSY']) {
    const { calls, d } = fixture('multi', ['origin', 'telegram:one', 'lark:two']);
    const build = d.buildTargetBinding;
    d.buildTargetBinding = options => {
      if (options.sessionGroup === 'telegram:one') throw Object.assign(new Error('binding failed'), { code });
      return build(options);
    };
    await assert.rejects(requestRotation({}, d), error => {
      assert.equal(error.code, code);
      assert.deepEqual(error.enqueued, [{ sessionGroup: 'origin', id: 1 }]);
      return true;
    });
    assert.equal(calls.length, 1);
  }
});

test('single does not inspect or bind a live target', async () => {
  const { calls, d } = fixture('single', ['origin']);
  d.readLiveIdentity = d.buildTargetBinding = () => assert.fail('single identity rotation stays unbound');
  assert.deepEqual(await requestRotation({}, d), { enqueued: [{ sessionGroup: null, id: 1 }], skipped: [] });
  assert.equal(calls[0].options.targetBinding, null);
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


test('rotation CLI output reports each skipped group after the enqueue count', async () => {
  const { d } = fixture('multi', ['origin', 'telegram:one', 'lark:two']);
  d.readLiveIdentity = sessionGroup => ({ present: sessionGroup === 'telegram:one', runId: `run-${sessionGroup}` });
  const lines = [];
  printRotationResult(await requestRotation({}, d), line => lines.push(line));
  assert.deepEqual(lines, [
    'OK: enqueued 1 rotation controls',
    'SKIPPED: origin TARGET_NOT_RUNNING',
    'SKIPPED: lark:two TARGET_NOT_RUNNING',
  ]);
  lines.length = 0;
  printRotationResult({ enqueued: [], skipped: [] }, line => lines.push(line));
  assert.deepEqual(lines, ['OK: enqueued 0 rotation controls']);
});
