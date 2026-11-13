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
    state: 'idle', processRunning: true, usagePercent: 0, createdAt: 0, idleSince: 0 };
  const f = { controls: [], events: [], errors: [], prepareCalls: 0, shouldPropose: true,
    transition: null, marker: { held: false, stale: false } };
  const deps = {
    db: {
      getModeTransition: () => f.transition,
      listDrainFences: () => [],
      getLastActivity: () => 0,
      getUnsummarizedRange: () => ({ count: 0, firstAt: null }),
      getGlobalUnsummarizedRange: () => f.range,
      getOriginSyncBacklog: () => ({ total: f.range.count,
        groups: [{ count: f.range.count, firstAt: f.range.firstAt, pendingCheckpoints: 0 }] }),
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
    groupRunDir: () => scene.runDir,
    bindTarget: () => ({ expectedRunId: scene.runId }),
    readSyncMarker: () => f.marker,
    prepareReferenceReorg: () => {
      f.prepareCalls += 1;
      if (f.prepareError) throw f.prepareError;
      f.events.push(f.shouldPropose ? 'old-files-present' : 'old-files-absent');
      return f.shouldPropose;
    },
    prompts: { REFERENCE_REORG_PROMPT: 'reference proposal', ORIGIN_SYNC_PROMPT: 'origin sync',
      GROUP_SYNC_PROMPT: 'group sync', SYNC_BACKLOG_ALERT: () => 'backlog alert',
      PRE_RECLAIM_CHECK_PROMPT: 'reclaim check', PRE_RECLAIM_ORIGIN_SYNC_PROMPT: 'reclaim origin sync' },
    reportError: (cause, context) => f.errors.push({ cause, context }),
  };
  f.deps = deps;
  f.lifecycle = new SupervisorLifecycle(deps, { now: () => now });
  f.context = { configuration: { mode }, scenes: [{ ...scene }], fences: [], restartRequests: [], transition: null };
  f.range = { count: 60, nonempty: true, firstAt: now, firstConversationId: 1 };
  f.run = () => f.lifecycle.syncScope(scene, kind, f.range, f.context);
  f.periodic = () => f.lifecycle.checkSync([scene], f.context);
  f.scene = scene;
  f.restart = () => { f.lifecycle = new SupervisorLifecycle(deps, { now: () => now }); };
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

  test(`${mode} does not repeat a proposal on consecutive eligible Sync requests`, async () => {
    const f = fixture(mode, kind);
    await f.run();
    f.advance(600_000);
    await f.run();
    assert.equal(f.prepareCalls, 1);
    assert.deepEqual(f.events, ['old-files-present', 'proposal', 'sync', 'sync']);
    assert.equal(f.controls.length, 3);
    for (const control of f.controls.slice(1)) {
      assert.equal(control.content, f.expectedSync.content);
      assert.equal(control.sessionGroup, group);
      assert.equal(control.priority, 2);
    }
    assert.equal(f.errors.length, 0);
  });

  test(`${mode} periodic checks propose with no due Sync and deduplicate the current session`, async () => {
    const f = fixture(mode, kind);
    f.range = { count: 1, nonempty: true, firstAt: 2_000_000, firstConversationId: 1 };
    f.lifecycle.syncRuns.set(JSON.stringify([kind, group]), f.scene.runId);
    if (mode === 'multi') {
      await f.lifecycle.checkTtl(f.scene, f.context);
      assert.deepEqual(f.controls.map(row => row.content), ['reclaim check', 'reclaim origin sync']);
    }
    for (let round = 0; round < 3; round++) {
      await f.periodic();
      f.advance(60_000);
    }
    assert.equal(f.prepareCalls, 1);
    const proposals = f.controls.filter(row => row.content === 'reference proposal');
    assert.equal(proposals.length, 1);
    assert.equal(proposals[0].sessionGroup, group);
    assert.equal(proposals[0].priority, 3);
    assert.equal(proposals[0].appendAckSuffix, false);
    assert.equal(f.controls.some(row => ['group sync', 'origin sync'].includes(row.content)), false,
      'only the pre-reclaim path sends Sync; ordinary Sync never becomes due');
  });

  test(`${mode} periodic checks do not require any unsummarized input`, async () => {
    const f = fixture(mode, kind);
    f.range = { count: 0, nonempty: false, firstAt: null };
    await f.periodic();
    assert.deepEqual(f.controls.map(row => row.content), ['reference proposal']);
  });

  test(`${mode} periodic checks skip absent old files and notice them on a later check`, async () => {
    const f = fixture(mode, kind);
    f.range = { count: 0, nonempty: false, firstAt: null };
    f.shouldPropose = false;
    await f.periodic();
    assert.equal(f.controls.length, 0);
    f.shouldPropose = true;
    f.advance(60_000);
    await f.periodic();
    assert.equal(f.prepareCalls, 2);
    assert.deepEqual(f.controls.map(row => row.content), ['reference proposal']);
  });

  test(`${mode} a replaced run or session and a Supervisor restart allow a fresh proposal`, async () => {
    const f = fixture(mode, kind);
    f.range = { count: 0, nonempty: false, firstAt: null };
    await f.periodic();
    f.scene.sessionId = 'next-session';
    f.advance(60_000);
    await f.periodic();
    f.scene.runId = 'next-run';
    f.advance(60_000);
    await f.periodic();
    f.restart();
    await f.periodic();
    assert.equal(f.prepareCalls, 4);
    assert.equal(f.controls.length, 4);
    assert.ok(f.controls.every(row => row.content === 'reference proposal'));
    assert.equal(f.lifecycle.referenceReorgSent.size, 1, 'only the latest identity is retained');
  });

  test(`${mode} periodic old-file errors preserve Sync and a later check retries`, async () => {
    const f = fixture(mode, kind);
    f.prepareError = new Error('old-file check failed');
    await f.periodic();
    assert.deepEqual(f.controls, [f.expectedSync]);
    assert.equal(f.errors.length, 1);
    assert.equal(f.errors[0].cause, f.prepareError);
    assert.ok(f.errors.every(row => row.context.phase === 'reference-reorganization'));
    f.prepareError = null;
    f.advance(60_000);
    await f.periodic();
    assert.equal(f.controls.filter(row => row.content === 'reference proposal').length, 1);
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

test('an absent Origin can receive one proposal without a due Sync', async () => {
  const f = fixture();
  f.scene.present = false;
  f.range = { count: 0, nonempty: false, firstAt: null };
  await f.periodic();
  f.advance(60_000);
  await f.periodic();
  assert.equal(f.prepareCalls, 1);
  assert.deepEqual(f.controls, [
    { content: 'reference proposal', sessionGroup: 'origin', priority: 3, appendAckSuffix: false },
  ]);
  f.scene.present = true;
  f.advance(60_000);
  await f.periodic();
  assert.equal(f.controls.length, 1, 'the first live Origin inherits its queued unbound proposal');
  f.scene.runId = 'replacement-run';
  f.advance(60_000);
  await f.periodic();
  assert.equal(f.controls.length, 2, 'a later run can request cleanup again');
});

for (const observation of ['absent', 'not-ready', 'error']) {
  test(`a temporarily ${observation} Origin does not reset a known session proposal`, async () => {
    const f = fixture();
    f.range = { count: 0, nonempty: false, firstAt: null };
    await f.periodic();
    for (let round = 0; round < 2; round++) {
      f.scene.present = observation !== 'absent';
      f.scene.ready = false;
      if (observation === 'error') f.scene.observationError = new Error('identity unavailable');
      f.advance(60_000);
      await f.periodic();
      delete f.scene.observationError;
      f.scene.present = true;
      f.scene.ready = true;
      f.advance(60_000);
      await f.periodic();
    }
    assert.equal(f.prepareCalls, 1);
    assert.equal(f.controls.length, 1, 'the unchanged actual session receives no repeated proposal');
  });
}

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

test('a held Sync marker blocks Sync without suppressing the independent proposal', async () => {
  const f = fixture();
  f.marker = { held: true, stale: false };
  await f.run();
  assert.equal(f.prepareCalls, 1);
  assert.deepEqual(f.controls.map(row => row.content), ['reference proposal']);
});

test('an empty Sync input still checks and queues the independent proposal', async () => {
  const f = fixture();
  f.range = { count: 0, nonempty: false, firstAt: null, firstConversationId: null };
  await f.run();
  assert.equal(f.prepareCalls, 1);
  assert.deepEqual(f.controls.map(row => row.content), ['reference proposal']);
});
