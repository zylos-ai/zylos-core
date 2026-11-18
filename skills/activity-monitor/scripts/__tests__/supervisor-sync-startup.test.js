import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle } from '../supervisor-lifecycle.js';

// Real lifecycle methods with in-memory observations only: no processes,
// timers, database files, tmux, PM2 or network. Run for Sync trigger changes.
function fixture(mode = 'multi', configuration = {}) {
  const start = Date.parse('2026-11-13T02:00:00Z');
  const f = { now: start + 120000, firstAt: '2026-11-13 02:00:01', count: 2,
    controls: [], errors: [], events: [], held: false };
  f.scene = { sessionGroup: mode === 'single' ? null : 'a', present: true, ready: true,
    runtime: 'claude', runId: 'run-a', sessionId: 'session-a', createdAt: start,
    runDir: '/isolated/run', usagePercent: 0 };
  const range = () => ({ count: f.count, firstAt: f.firstAt, firstConversationId: 1 });
  const db = {
    getModeTransition: () => null, listDrainFences: () => [],
    getUnsummarizedRange: range, getGlobalUnsummarizedRange: range,
    getOriginSyncBacklog: () => ({ total: 0, groups: [] }),
    insertControl: (content, options) => { f.controls.push({ content, ...options }); },
  };
  f.context = { configuration: { mode, ...configuration }, scenes: [f.scene], fences: [], restartRequests: [], transition: null };
  f.lifecycle = new SupervisorLifecycle({ db, requests: { read: () => [] },
    observeGroup: group => f.context.scenes.find(scene => scene.sessionGroup === group),
    readSyncMarker: () => ({ held: f.held, stale: false }), groupRunDir: () => '/isolated/origin',
    prepareReferenceReorg: () => false, diagnostic: event => f.events.push(event),
    reportError: (cause, context) => f.errors.push({ cause, context }),
    prompts: { GROUP_SYNC_PROMPT: 'sync', ORIGIN_SYNC_PROMPT: 'origin', SYNC_BACKLOG_ALERT: () => 'alert',
      REFERENCE_REORG_PROMPT: 'reference proposal' },
  }, { now: () => f.now });
  f.check = async () => { await f.lifecycle.checkSync(f.context.scenes, f.context); f.now += 600000; };
  f.syncs = () => f.controls.filter(row => row.content === 'sync');
  f.key = JSON.stringify([mode === 'single' ? 'global' : 'group', f.scene.sessionGroup]);
  f.start = start;
  return f;
}

test('a backlog left by the previous run does not request Sync below the threshold', async () => {
  for (const mode of ['multi', 'single']) {
    const f = fixture(mode); f.count = 8; f.firstAt = '2026-11-13 01:00:00';
    await f.check(); await f.check();
    assert.equal(f.syncs().length, 0, `${mode}: an inherited backlog of 8 does not request Sync`);
  }
});

test('context usage near the rotation threshold does not request Sync below the backlog threshold', async () => {
  const f = fixture('multi', { rotationPolicy: { new_session_threshold: 70 } });
  f.count = 9; f.scene.usagePercent = 80; f.scene.model = 'opus';
  await f.check();
  assert.equal(f.syncs().length, 0, '80% context with 9 messages');
  f.count = 16; await f.check();
  assert.equal(f.syncs().length, 1, '80% context keeps the ordinary threshold');
  assert.deepEqual(f.events.find(row => row.event === 'sync_triggered').reason, ['threshold']);
});

test('fresh messages retain threshold, longest wait and marker gates', async () => {
  const threshold = fixture(); threshold.count = 15; await threshold.check(); assert.equal(threshold.syncs().length, 0);
  threshold.count = 16; await threshold.check(); assert.equal(threshold.syncs().length, 1);
  const lag = fixture(); lag.now = lag.start + 21600000 + 1000; await lag.check(); assert.equal(lag.syncs().length, 1);
  const marker = fixture(); marker.count = 16; marker.held = true; await marker.check();
  assert.equal(marker.syncs().length, 0); assert.equal(marker.lifecycle.syncSent.has(marker.key), false);
});

for (const [reason, setup] of [
  ['threshold', f => { f.count = 16; }],
  ['max_lag', f => { f.firstAt = f.start - 21600000; }],
]) {
  test(`Sync trigger records ${reason} with observed backlog and context`, async () => {
    const f = fixture(); setup(f); f.scene.usagePercent = 42; await f.check();
    const row = f.events.find(row => row.event === 'sync_triggered');
    assert.deepEqual(row.reason, [reason]); assert.equal(row.scope, 'a'); assert.equal(row.kind, 'group');
    assert.equal(row.backlog, f.count); assert.equal(row.contextPercent, f.scene.usagePercent);
    assert.ok(row.lag >= 0);
  });
}

test('Sync records simultaneous reasons without changing threshold or minimum interval', async () => {
  const f = fixture(); f.count = 16; f.firstAt = f.start - 21600000; f.scene.usagePercent = 99;
  await f.check();
  const row = f.events.find(row => row.event === 'sync_triggered');
  assert.deepEqual(row.reason, ['threshold', 'max_lag']);
  assert.equal(f.syncs().length, 1);
});

test('failed diagnostic metadata read never loses already inserted Sync bookkeeping', async () => {
  const f = fixture(); f.count = 16;
  f.lifecycle.d.db.getLatestContentCheckpoint = () => { throw new Error('diagnostic unavailable'); };
  await f.check();
  assert.equal(f.syncs().length, 1); assert.ok(f.lifecycle.syncSent.has(f.key));
  assert.equal(f.events.filter(row => row.event === 'sync_triggered').length, 1);
});


test('trigger checkpoint baseline precedes a worker publishing during enqueue', async () => {
  const f = fixture(); f.count = 16; let checkpoint = { id: 4 };
  f.lifecycle.d.db.getLatestContentCheckpoint = () => checkpoint;
  const insert = f.lifecycle.d.db.insertControl;
  f.lifecycle.d.db.insertControl = (...args) => { const result = insert(...args); checkpoint = { id: 5 }; return result; };
  await f.check();
  assert.equal(f.events.find(row => row.event === 'sync_triggered').checkpointId, 4);
});
