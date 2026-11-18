import test from 'node:test';
import assert from 'node:assert/strict';
import { requestRotation, printRotationResult } from '../request-rotation.js';
import { IDENTITY_ROTATION_PROMPT, GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT, PRE_RECLAIM_SYNC_PROMPT } from '../sync-prompts.js';
import { fixture as storeFixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';

const bindingFor = group => JSON.stringify({ expectedRunId: `run-${group}`,
  tmuxTarget: { serverGeneration: 'server', sessionId: '$1', paneId: '%2' } });
function fixture({ mode = 'multi', keyPresent = true, group = 'origin', groups = ['origin', 'telegram:one'] } = {}) {
  const calls = [];
  return { calls, d: {
    env: group === null ? {} : { ZYLOS_SESSION_GROUP: group },
    readSessionMode: () => ({ mode, keyPresent }), getModeTransition: () => null,
    listGroupTmuxSessions: () => groups.map(sessionGroup => ({ sessionGroup })),
    readLiveIdentity: sessionGroup => ({ present: true, runId: `run-${sessionGroup}` }),
    buildTargetBinding: ({ sessionGroup, expectedRunId }) => {
      assert.equal(expectedRunId, `run-${sessionGroup}`);
      return bindingFor(sessionGroup);
    },
    insertControl: (text, options) => { calls.push({ text, options }); return { id: calls.length }; },
  } };
}

for (const mode of ['multi', 'single']) for (const group of ['origin', 'telegram:one']) {
  test(`${mode} identity rotation binds only the group in its session environment: ${group}`, async () => {
    const { calls, d } = fixture({ mode, group });
    assert.deepEqual(await requestRotation({}, d), { enqueued: [{ sessionGroup: group, id: 1 }], skipped: [] });
    assert.deepEqual(calls, [{ text: IDENTITY_ROTATION_PROMPT, options: {
      sessionGroup: group, targetBinding: bindingFor(group), priority: 2, requireIdle: true, appendAckSuffix: false,
    } }]);
  });
}

test('only an unkeyed instance without a session environment queues an unbound NULL control', async () => {
  const { calls, d } = fixture({ mode: 'single', keyPresent: false, group: null });
  d.readLiveIdentity = d.buildTargetBinding = () => assert.fail('legacy control stays unbound');
  assert.deepEqual(await requestRotation({}, d), { enqueued: [{ sessionGroup: null, id: 1 }], skipped: [] });
  assert.equal(calls[0].options.targetBinding, null);
  assert.equal(calls[0].options.sessionGroup, null);
});

test('keyed instances without a session group reject before queue writes', async () => {
  for (const mode of ['single', 'multi']) {
    const { calls, d } = fixture({ mode, group: null });
    await assert.rejects(requestRotation({}, d), { code: 'CONTROL_TARGET_REQUIRED' });
    assert.equal(calls.length, 0);
  }
});

test('absent own session never targets a different live session', async () => {
  for (const options of [{ group: 'origin', groups: ['telegram:one'] }, { keyPresent: false, group: null, groups: ['telegram:one'] }]) {
    const { calls, d } = fixture(options);
    assert.deepEqual(await requestRotation({}, d), { enqueued: [], skipped: [] });
    assert.equal(calls.length, 0);
  }
});

test('transition and failed scope observations prevent all enqueue', async () => {
  const f = fixture();
  f.d.getModeTransition = () => ({ runId: 'transition' });
  await assert.rejects(requestRotation({}, f.d), { code: 'TRANSITION_OPEN' });
  assert.equal(f.calls.length, 0);
  for (const method of ['readSessionMode', 'getModeTransition', 'listGroupTmuxSessions']) {
    const { calls, d } = fixture();
    d[method] = () => { throw Object.assign(new Error('failed'), { code: 'READ_FAILED' }); };
    await assert.rejects(requestRotation({}, d), { code: 'READ_FAILED' });
    assert.equal(calls.length, 0);
  }
});

test('rotation skips a changed or unready own target and never queues elsewhere', async () => {
  for (const code of ['TARGET_NOT_RUNNING', 'TARGET_MISMATCH', 'TARGET_NOT_READY', 'TARGET_SCOPE_MISMATCH', 'TARGET_RUNTIME_MISMATCH', 'TARGET_SNAPSHOT_UNKNOWN']) {
    const { calls, d } = fixture();
    d.buildTargetBinding = () => { throw Object.assign(new Error('rejected'), { code }); };
    assert.deepEqual(await requestRotation({}, d), { enqueued: [], skipped: [{ sessionGroup: 'origin', code }] });
    assert.equal(calls.length, 0);
  }
  for (const live of [{ present: false, runId: 'old' }, { present: true, runId: null }]) {
    const { calls, d } = fixture();
    d.readLiveIdentity = () => live;
    d.buildTargetBinding = () => assert.fail('absent run cannot be bound');
    assert.deepEqual(await requestRotation({}, d), { enqueued: [], skipped: [{ sessionGroup: 'origin', code: 'TARGET_NOT_RUNNING' }] });
    assert.equal(calls.length, 0);
  }
});

test('infrastructure or queue failures report committed IDs without retry', async () => {
  for (const method of ['buildTargetBinding', 'insertControl']) {
    const { calls, d } = fixture(); let attempts = 0;
    d[method] = () => { attempts++; throw Object.assign(new Error('busy'), { code: 'DB_BUSY' }); };
    await assert.rejects(requestRotation({}, d), error => {
      assert.equal(error.code, 'DB_BUSY'); assert.deepEqual(error.enqueued, []); return true;
    });
    assert.equal(attempts, 1); assert.equal(calls.length, 0);
  }
});

test('real control transactions supersede repeated native and legacy requests with exact scope/options', async t => {
  for (const [mode, keyPresent, group] of [['multi', true, 'origin'], ['single', true, 'origin'], ['single', false, null]]) {
    const { store, db } = storeFixture(t, { readConfig: () => ({ state: 'ok', config: keyPresent ? { session_mode: mode } : {} }) });
    const { d } = fixture({ mode, keyPresent, group });
    d.insertControl = store.insertControl; d.getModeTransition = store.getModeTransition;
    await requestRotation({}, d); await requestRotation({}, d);
    const rows = db.prepare('SELECT * FROM control_queue ORDER BY id').all();
    assert.equal(rows.length, 2); assert.equal(rows[0].status, 'superseded');
    const row = rows[1];
    assert.equal(row.status, 'pending'); assert.equal(row.session_group, group);
    assert.equal(row.target_binding, group === null ? null : bindingFor(group));
    assert.equal(row.priority, 2); assert.equal(row.require_idle, 1);
    assert.equal(row.ack_deadline_at, null); assert.equal(row.content, IDENTITY_ROTATION_PROMPT);
    if (group !== null) assert.equal(store.getOriginNeed(100, { sessionMode: mode }).controls.count, 0);
  }
});

test('background Sync prompts retain the skill result contract and identity retains its handoff', () => {
  for (const prompt of [GROUP_SYNC_PROMPT, ORIGIN_SYNC_PROMPT]) {
    assert.match(prompt, /^Read the zylos-memory skill and start a background (group |Origin )Sync as it specifies, then keep working and handle its result per its Parent result handling section\.$/);
  }
  assert.match(PRE_RECLAIM_SYNC_PROMPT, /Wait for it to finish before acknowledging/);
  assert.match(IDENTITY_ROTATION_PROMPT, /atomic replacement/);
  assert.match(IDENTITY_ROTATION_PROMPT, /\/clear.*\/exit/);
});

test('rotation CLI output includes the enqueue count and skipped scope', () => {
  const lines = [];
  printRotationResult({ enqueued: [], skipped: [{ sessionGroup: 'origin', code: 'TARGET_NOT_RUNNING' }] }, line => lines.push(line));
  assert.deepEqual(lines, ['OK: enqueued 0 rotation controls', 'SKIPPED: origin TARGET_NOT_RUNNING']);
});
