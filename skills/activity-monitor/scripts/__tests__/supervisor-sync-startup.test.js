import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Real lifecycle methods with in-memory observations only: no processes,
// timers, database files, tmux, PM2 or network. Run for Sync trigger changes.
function fixture(mode = 'multi') {
  const start = Date.parse('2026-11-13T02:00:00Z');
  const f = { now: start + 120000, firstAt: '2026-11-13 02:00:01', count: 2,
    endings: [], completed: null, reads: [], controls: [], errors: [], held: false };
  f.scene = { sessionGroup: mode === 'single' ? null : 'a', present: true, ready: true,
    runtime: 'claude', runId: 'run-a', sessionId: 'session-a', createdAt: start,
    runDir: '/isolated/run', usagePercent: 0 };
  const range = () => ({ count: f.count, firstAt: f.firstAt, firstConversationId: 1 });
  const db = {
    listRunEndings: groups => { f.reads.push(['endings', groups]); if (f.fail === 'endings') throw new Error('read failed'); return f.endings; },
    getLastCompletedModeTransition: () => { f.reads.push(['transition']); if (f.fail === 'transition') throw new Error('read failed'); return f.completed; },
    getModeTransition: () => null, listDrainFences: () => [],
    getUnsummarizedRange: range, getGlobalUnsummarizedRange: range,
    getOriginSyncBacklog: () => ({ total: 0, groups: [] }),
    insertControl: (content, options) => { f.controls.push({ content, ...options }); },
  };
  f.context = { configuration: { mode }, scenes: [f.scene], fences: [], restartRequests: [], transition: null };
  f.lifecycle = new SupervisorLifecycle({ db, requests: { read: () => [] },
    observeGroup: group => f.context.scenes.find(scene => scene.sessionGroup === group),
    readSyncMarker: () => ({ held: f.held, stale: false }), groupRunDir: () => '/isolated/origin',
    reportError: cause => f.errors.push(cause),
    prompts: { GROUP_SYNC_PROMPT: 'sync', ORIGIN_SYNC_PROMPT: 'origin', SYNC_BACKLOG_ALERT: () => 'alert' },
  }, { now: () => f.now });
  f.check = async () => { await f.lifecycle.checkSync(f.context.scenes, f.context); f.now += 600000; };
  f.syncs = () => f.controls.filter(row => row.content === 'sync');
  f.key = JSON.stringify([mode === 'single' ? 'global' : 'group', f.scene.sessionGroup]);
  f.start = start;
  return f;
}

test('new conversation and already summarized previous run wait for ordinary triggers', async () => {
  for (const endings of [[], [{ sessionGroup: 'a', endedAt: Date.parse('2026-11-13T02:00:00Z') / 1000 }]]) {
    const f = fixture(); f.endings = endings;
    await f.check();
    assert.equal(f.syncs().length, 0);
    assert.equal(f.lifecycle.syncRuns.has(f.key), false);
    f.scene.sessionId = 'after-clear'; await f.check(); assert.equal(f.syncs().length, 0);
  }
});

test('evicted backlog and accepted end-record window request once per run', async () => {
  for (const seconds of [0, 1, 2]) {
    const f = fixture(); f.count = 8; f.firstAt = '2026-11-13 02:00:00';
    f.endings = [{ sessionGroup: 'a', endedAt: f.start / 1000 + seconds }];
    await f.check(); await f.check();
    assert.equal(f.syncs().length, 1);
    assert.equal(f.lifecycle.syncRuns.get(f.key), 'run-a');
    f.scene.sessionId = 'after-clear'; await f.check();
    assert.equal(f.syncs().length, 1, 'clear keeps the same run');
  }
});

test('latest multi transition includes single backlog but excludes messages after switching', async () => {
  for (const oldEnding of [false, true]) for (const [firstAt, expected] of [
    ['2026-11-13 01:59:59', 1], ['2026-11-13 02:00:01', 0],
  ]) {
    const f = fixture(); f.firstAt = firstAt;
    if (oldEnding) f.endings = [{ sessionGroup: 'a', endedAt: f.start / 1000 - 30 }];
    f.completed = { target_mode: 'multi', updated_at: f.start / 1000 };
    await f.check(); assert.equal(f.syncs().length, expected);
  }
  const f = fixture(); f.completed = { target_mode: 'single', updated_at: f.start / 1000 + 10 };
  await f.check(); assert.equal(f.syncs().length, 0);
  const later = fixture(); later.completed = { target_mode: 'multi', updated_at: later.start / 1000 };
  later.endings = [{ sessionGroup: 'a', endedAt: later.start / 1000 + 1 }];
  await later.check(); assert.equal(later.syncs().length, 1, 'later ending wins over transition');
});

test('ready groups share one batch of boundary reads and use only their own ending', async () => {
  const f = fixture();
  f.context.scenes.push({ ...f.scene, sessionGroup: 'b', runId: 'run-b' },
    { ...f.scene, sessionGroup: 'starting', ready: false }, { ...f.scene, sessionGroup: 'absent', present: false });
  f.endings = [{ sessionGroup: 'b', endedAt: f.start / 1000 + 1 }];
  await f.check();
  assert.deepEqual(f.reads, [['endings', ['a', 'b']], ['transition']]);
  assert.deepEqual(f.syncs().map(row => row.sessionGroup), ['b']);
});

test('either boundary read failure leaves startup retryable while other conditions still work', async () => {
  for (const failure of ['endings', 'transition']) {
    const f = fixture(); f.endings = [{ sessionGroup: 'a', endedAt: f.start / 1000 + 1 }]; f.fail = failure;
    await f.check(); assert.equal(f.syncs().length, 0); assert.equal(f.lifecycle.syncRuns.has(f.key), false);
    f.fail = null; await f.check(); assert.equal(f.syncs().length, 1);
    const g = fixture(); g.fail = failure; g.count = 16;
    await g.check(); assert.equal(g.syncs().length, 1, 'threshold does not depend on boundary reads');
  }
});

test('single compares UTC message text with millisecond tmux creation without multi reads', async () => {
  for (const [firstAt, expected] of [['2026-11-13 01:59:59', 1], ['2026-11-13 02:00:00', 1], ['2026-11-13 02:00:01', 0]]) {
    const f = fixture('single'); f.firstAt = firstAt;
    await f.check(); assert.equal(f.syncs().length, expected); assert.deepEqual(f.reads, []);
  }
});

test('fresh messages retain threshold longest-wait context and marker gates', async () => {
  const threshold = fixture(); threshold.count = 15; await threshold.check(); assert.equal(threshold.syncs().length, 0);
  threshold.count = 16; await threshold.check(); assert.equal(threshold.syncs().length, 1);
  const lag = fixture(); lag.now = lag.start + 21600000 + 1000; await lag.check(); assert.equal(lag.syncs().length, 1);
  const context = fixture(); context.scene.usagePercent = 80; await context.check(); assert.equal(context.syncs().length, 1);
  const marker = fixture(); marker.count = 16; marker.held = true; await marker.check();
  assert.equal(marker.syncs().length, 0); assert.equal(marker.lifecycle.syncRuns.has(marker.key), false);
});
