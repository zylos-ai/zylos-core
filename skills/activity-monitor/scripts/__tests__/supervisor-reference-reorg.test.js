import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Unit fixture: queue, runtime, marker and old-file observations are in
// memory. No files, timers, children, live database, tmux or PM2 are used.
function fixture(mode = 'multi', kind = 'origin') {
  let now = 2_000_000;
  const group = mode === 'single' ? null : kind === 'origin' ? 'origin' : 'a';
  const scene = { sessionGroup: group, present: true, ready: true, runtime: 'claude',
    runId: 'reference-run', sessionId: 'reference-session', runDir: '/isolated/reference-run',
    state: 'idle', processRunning: true, usagePercent: 0 };
  const f = { controls: [], events: [], errors: [], prepareCalls: 0, shouldPropose: true,
    transition: null, marker: { held: false, stale: false } };
  const deps = {
    db: {
      getModeTransition: () => f.transition,
      listDrainFences: () => [],
      insertControl: (content, options) => {
        f.events.push(content === 'reference proposal' ? 'proposal' : 'sync');
        if (content === 'reference proposal' && f.proposalError) throw f.proposalError;
        const row = { content, ...options };
        f.controls.push(row);
        return { id: f.controls.length, ...row };
      },
    },
    requests: { read: () => [] },
    observeGroup: () => ({ ...scene }),
    readSyncMarker: () => f.marker,
    prepareReferenceReorg: () => {
      f.prepareCalls += 1;
      if (f.prepareError) throw f.prepareError;
      f.events.push(f.shouldPropose ? 'old-files-present' : 'old-files-absent');
      return f.shouldPropose;
    },
    prompts: { REFERENCE_REORG_PROMPT: 'reference proposal', ORIGIN_SYNC_PROMPT: 'origin sync',
      GROUP_SYNC_PROMPT: 'group sync', SYNC_BACKLOG_ALERT: () => 'backlog alert' },
    reportError: (cause, context) => f.errors.push({ cause, context }),
  };
  f.deps = deps;
  f.lifecycle = new SupervisorLifecycle(deps, { now: () => now });
  f.context = { configuration: { mode }, scenes: [{ ...scene }], fences: [], restartRequests: [], transition: null };
  f.range = { count: 60, nonempty: true, firstAt: now, firstConversationId: 1 };
  f.run = () => f.lifecycle.syncScope(scene, kind, f.range, f.context);
  f.advance = milliseconds => { now += milliseconds; };
  f.expectedSync = { content: kind === 'origin' ? 'origin sync' : 'group sync',
    sessionGroup: group, priority: 2, appendAckSuffix: false,
    ...(kind === 'origin' ? {} : { ackDeadlineAt: Math.floor((now + 300_000) / 1000) }) };
  return f;
}

for (const [mode, kind, group] of [['single', 'global', null], ['multi', 'origin', 'origin']]) {
  test(`${mode} queues a reference instruction before its ordinary Sync control`, async () => {
    const f = fixture(mode, kind);
    await f.run();
    assert.equal(f.prepareCalls, 1);
    assert.deepEqual(f.events, ['old-files-present', 'proposal', 'sync']);
    assert.deepEqual(f.controls, [
      { content: 'reference proposal', sessionGroup: group, priority: 3, appendAckSuffix: false },
      f.expectedSync,
    ]);
    assert.equal(f.errors.length, 0);
  });

  test(`${mode} queues reorganization on two consecutive eligible Sync requests`, async () => {
    const f = fixture(mode, kind);
    await f.run();
    // Keep the ordinary Sync interval unchanged; there is no separate interval
    // suppressing reorganization on the next eligible request.
    f.advance(600_000);
    await f.run();
    assert.equal(f.prepareCalls, 2);
    assert.deepEqual(f.events, ['old-files-present', 'proposal', 'sync', 'old-files-present', 'proposal', 'sync']);
    assert.equal(f.controls.length, 4);
    for (const index of [0, 2]) {
      assert.deepEqual(f.controls[index], {
        content: 'reference proposal', sessionGroup: group, priority: 3, appendAckSuffix: false,
      });
      assert.equal(f.controls[index + 1].content, f.expectedSync.content);
      assert.equal(f.controls[index + 1].sessionGroup, group);
      assert.equal(f.controls[index + 1].priority, 2);
    }
    assert.equal(f.errors.length, 0);
  });

  test(`${mode} leaves the ordinary Sync control unchanged when no old files remain`, async () => {
    const f = fixture(mode, kind);
    f.shouldPropose = false;
    await f.run();
    assert.equal(f.prepareCalls, 1);
    assert.deepEqual(f.events, ['old-files-absent', 'sync']);
    assert.deepEqual(f.controls, [f.expectedSync]);
    assert.equal(f.errors.length, 0);
  });
}

test('group Sync never checks or queues a reference reorganization proposal', async () => {
  const f = fixture('multi', 'group');
  await f.run();
  assert.equal(f.prepareCalls, 0);
  assert.deepEqual(f.events, ['sync']);
  assert.deepEqual(f.controls, [f.expectedSync]);
  assert.equal(f.errors.length, 0);
});

test('an old-file check failure is logged while the ordinary Sync control is still inserted', async () => {
  const f = fixture();
  f.prepareError = Object.assign(new Error('old-file stat failed'), { code: 'EACCES' });
  await f.run();
  assert.equal(f.prepareCalls, 1);
  assert.deepEqual(f.controls, [f.expectedSync]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].cause, f.prepareError);
  assert.equal(f.errors[0].context.phase, 'reference-reorganization');
});

test('proposal enqueue failure is logged and does not suppress the ordinary Sync control', async () => {
  const f = fixture();
  f.proposalError = Object.assign(new Error('proposal queue failed'), { code: 'QUEUE_FAILED' });
  await f.run();
  assert.equal(f.prepareCalls, 1);
  assert.deepEqual(f.events, ['old-files-present', 'proposal', 'sync']);
  assert.deepEqual(f.controls, [f.expectedSync]);
  assert.equal(f.errors.length, 1);
  assert.equal(f.errors[0].cause, f.proposalError);
  assert.equal(f.errors[0].context.phase, 'reference-reorganization');
});

for (const prompt of [undefined, '']) {
  test(`a ${prompt === undefined ? 'missing' : 'blank'} proposal prompt is logged without checking old files or blocking Sync`, async () => {
    const f = fixture();
    f.deps.prompts.REFERENCE_REORG_PROMPT = prompt;
    await f.run();
    assert.equal(f.prepareCalls, 0);
    assert.deepEqual(f.controls, [f.expectedSync]);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].context.phase, 'reference-reorganization');
  });
}

test('a failed before-write authority check prevents both proposal preparation and Sync insertion', async () => {
  const f = fixture();
  f.transition = { status: 'pending' };
  await f.run();
  assert.equal(f.prepareCalls, 0);
  assert.equal(f.controls.length, 0);
  assert.equal(f.events.length, 0);
});

test('a held Sync marker prevents proposal preparation', async () => {
  const f = fixture();
  f.marker = { held: true, stale: false };
  await f.run();
  assert.equal(f.prepareCalls, 0);
  assert.equal(f.controls.length, 0);
});

test('an empty Sync input does not prepare or enqueue a proposal', async () => {
  const f = fixture();
  f.range = { count: 0, nonempty: false, firstAt: null, firstConversationId: null };
  await f.run();
  assert.equal(f.prepareCalls, 0);
  assert.equal(f.controls.length, 0);
});
