import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRotation, printRotationResult } from '../request-rotation.js';
import { IDENTITY_ROTATION_PROMPT, GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT, PRE_RECLAIM_SYNC_PROMPT, SYNC_BACKLOG_ALERT } from '../sync-prompts.js';
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
test('background Sync prompts point to the skill result rules; reclaim Sync and identity prompts keep their waits', () => {
  assert.match(GROUP_SYNC_PROMPT, /background group Sync/);
  assert.match(ORIGIN_SYNC_PROMPT, /background Origin Sync/);
  for (const prompt of [GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT]) {
    assert.match(prompt, /^Read the zylos-memory skill and start a background (group |Origin )Sync as it specifies, then keep working and handle its result per its Parent result handling section\.$/);
    // The rules themselves live once, in the skill's Parent result handling section.
    assert.doesNotMatch(prompt, /In Codex|Completed label|final result|owner|internal message|no longer exists/);
  }
  assert.match(PRE_RECLAIM_SYNC_PROMPT, /Wait for it to finish before acknowledging/);
  assert.match(IDENTITY_ROTATION_PROMPT, /atomic replacement/);
  assert.match(IDENTITY_ROTATION_PROMPT, /\/clear.*\/exit/);
  assert.equal(SYNC_BACKLOG_ALERT('origin', 10, 20), SYNC_BACKLOG_ALERT('origin', 10, 20));
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

test('unkeyed single does not inspect or bind a live target', async () => {
  const { calls, d } = fixture('single', ['origin'], null, false);
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

test('native single queues one bound Origin control independent of the caller environment', async () => {
  const { calls, d } = fixture('single', ['origin']);
  Object.defineProperty(d, 'env', { get: () => assert.fail('rotation does not inspect caller environment') });
  assert.deepEqual(await requestRotation({}, d), { enqueued: [{ sessionGroup: 'origin', id: 1 }], skipped: [] });
  assert.deepEqual(calls, [{ text: IDENTITY_ROTATION_PROMPT, options: {
    sessionGroup: 'origin', targetBinding: bindingFor('origin'), priority: 2, requireIdle: true, appendAckSuffix: false,
  } }]);
});

test('keyed rotation does not require a caller group and uses every listed live group', async () => {
  const { calls, d } = fixture('multi', ['origin', 'telegram:one']);
  d.env = {};
  assert.deepEqual(await requestRotation({}, d), {
    enqueued: [{ sessionGroup: 'origin', id: 1 }, { sessionGroup: 'telegram:one', id: 2 }], skipped: [],
  });
  assert.equal(calls.length, 2);
});
