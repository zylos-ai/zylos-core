import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorLifecycle, evictionDemand } from '../supervisor-lifecycle.js';

const scene = (sessionGroup = 'a', extra = {}) => ({ sessionGroup, present: true, ready: true,
  runId: `run-${sessionGroup}`, runtime: 'claude', sessionId: 'session-1', createdAt: 0,
  processRunning: true, state: 'idle', idleSince: 0, runDir: '/isolated/run',
  launchConfig: { runtime: 'claude', mode: 'default' }, ...extra });
function fixture(Class = SupervisorLifecycle) {
  const f = { now: 2_000_000, scenes: [scene()], fences: new Map(), requests: [], controls: [], events: [], stops: [],
    conversations: 0, runningControls: 0, withoutDeadline: 0, lastActivity: 0, unsummarized: 0,
    transition: null, pending: [], marker: { held: false, stale: false }, markerReads: [],
    backlog: { total: 0, groups: [] }, expected: { runtime: 'claude', mode: 'default' },
    context: { configuration: { mode: 'multi', capacity: 1 } } };
  const configuration = f.context.configuration;
  Object.defineProperty(f, 'context', { get: () => ({ configuration, transition: f.transition,
    scenes: f.scenes.map(s => ({ ...s })), fences: [...f.fences].map(([sessionGroup, value]) => ({ sessionGroup, ...value })), restartRequests: [...f.requests] }) });
  f.db = {
    getModeTransition: () => f.transition,
    getDrainFence: g => f.fences.get(g) ?? null,
    listDrainFences: () => [...f.fences].map(([sessionGroup, value]) => ({ sessionGroup, ...value })),
    setDrainFence: (g, value) => { if (!f.fences.has(g)) f.fences.set(g, { sessionGroup: g, ...value }); },
    clearDrainFence: g => f.fences.delete(g),
    countRunningConversations: () => f.conversations,
    countGlobalRunningConversations: () => f.conversations,
    countNonTerminalControls: () => ({ running: f.runningControls, runningWithoutDeadline: f.withoutDeadline }),
    expireStaleRunningControls: () => [],
    getLastActivity: () => ({ ts: f.lastActivity }),
    getUnsummarizedRange: () => ({ count: f.unsummarized, firstAt: f.unsummarized ? 1_000_000 : null }),
    getGlobalUnsummarizedRange: () => ({ count: f.unsummarized, firstAt: f.unsummarized ? 1_000_000 : null }),
    getOriginSyncBacklog: () => f.backlog,
    listPendingSessionGroups: () => f.pending,
    getControlById: id => f.controls.find(c => c.id === id),
    insertControl: (content, options) => { const row = { id: f.controls.length + 1, content, ...options, status: 'pending' }; f.controls.push(row); return row; },
    resolveSessionLaunchConfig: () => f.expected,
  };
  f.deps = { db: f.db, observe: () => f.scenes,
    observeGroup: group => f.scenes.find(s => s.sessionGroup === group) ?? { present: false },
    stop: s => { f.stops.push(s.runId); f.scenes = f.scenes.filter(x => x.runId !== s.runId); },
    readSyncMarker: args => { f.markerReads.push(args); return f.marker; },
    requests: { read: () => f.requests, remove: id => { f.requests = f.requests.filter(r => r.requestId !== id); } },
    bindTarget: s => ({ expectedRunId: s.runId }),
    diagnostic: e => f.events.push(e),
    prompts: { PRE_RECLAIM_SYNC_PROMPT: 'prepare', GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync',
      ROTATION_PROMPT: () => 'rotate', CONFIG_RECLAIM_PROMPT: () => 'config', SYNC_BACKLOG_ALERT: reader => `alert:${reader}` },
  };
  f.lifecycle = new Class(f.deps, { now: () => f.now });
  f.fence = (reason = 'ttl', group = 'a') => { const row = { sessionGroup: group, reason, runId: `run-${group}` }; f.fences.set(group, row); return row; };
  return f;
}

// persisted fences resume from facts; in-flight work is never guessed away.
test('reclaim waits conversations and controls, then stops the same run and clears', async () => {
  const f = fixture(), row = f.fence(); f.conversations = 1;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'waiting_inflight');
  f.conversations = 0; f.runningControls = 1;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'waiting_inflight');
  f.runningControls = 0;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done');
  assert.deepEqual(f.stops, ['run-a']); assert.equal(f.fences.size, 0);
});
test('mode-switch duplicate reclaim calls cannot shorten the 3s idle confirmation', async () => {
  const f = fixture();
  f.scenes[0].idleSince = f.now;
  const started = f.now;
  for (const elapsed of [0, 1, 2999]) {
    f.now = started + elapsed;
    const fence = f.fence('mode_switch'), context = f.context;
    // Coordinator gating and the loop may both visit the same fence in one
    // round. Neither repeated reads nor a renewed fence advance elapsed time.
    assert.equal(await f.lifecycle.advanceReclaim(fence, context), 'cancelled');
    assert.equal(await f.lifecycle.advanceReclaim(fence, context), 'changed');
    assert.deepEqual(f.stops, [], `must not stop after ${elapsed}ms of idle`);
  }
  f.now = started + 3000;
  const fence = f.fence('mode_switch'), context = f.context;
  assert.equal(await f.lifecycle.advanceReclaim(fence, context), 'done');
  assert.equal(await f.lifecycle.advanceReclaim(fence, context), 'changed');
  assert.deepEqual(f.stops, ['run-a']);
});
test('ordinary busy cancels with TTL reset; model_config busy retains its fence', async () => {
  for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'mode_switch', 'model_config']) {
    const f = fixture(), row = f.fence(reason); f.scenes[0].state = 'busy';
    assert.equal(await f.lifecycle.advanceReclaim(row, f.context), reason === 'model_config' ? 'waiting_idle' : 'cancelled');
    assert.equal(f.fences.size, reason === 'model_config' ? 1 : 0); assert.deepEqual(f.stops, []);
    if (reason === 'ttl') { await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0); }
  }
});
test('unknown process waits; failed observation retains its own fence', async () => {
  const f = fixture(), row = f.fence(); f.scenes[0].processRunning = undefined;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'unknown_process'); assert.equal(f.fences.size, 1);
  f.scenes[0].processRunning = true;
  f.deps.observeGroup = () => { throw Object.assign(new Error('unavailable'), { code: 'TMUX_UNAVAILABLE' }); };
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'TMUX_UNAVAILABLE' }); assert.equal(f.fences.size, 1);
  assert.ok(f.events.some(e => e.event === 'reclaim_observation_unavailable'));
});
test('exited runtime cleans residual tmux without idle or marker; replacement stays untouched', async () => {
  const f = fixture(), row = f.fence(); f.scenes[0].processRunning = false; f.scenes[0].state = 'busy';
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done'); assert.equal(f.markerReads.length, 0);
  const g = fixture(), old = g.fence(); g.scenes[0].runId = 'replacement';
  assert.equal(await g.lifecycle.advanceReclaim(old, g.context), 'done'); assert.deepEqual(g.stops, []); assert.equal(g.scenes.length, 1);
});
test('unconfirmed stop and failed DB reads cannot remove the durable fence', async () => {
  const f = fixture(), row = f.fence(); f.deps.stop = () => { throw Object.assign(new Error('stop failed'), { code: 'STOP_UNCONFIRMED' }); };
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'STOP_UNCONFIRMED' }); assert.equal(f.fences.size, 1);
  f.db.countRunningConversations = () => { throw Object.assign(new Error('busy'), { code: 'DB_BUSY' }); };
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'DB_BUSY' }); assert.equal(f.fences.size, 1);
});
test('restarting the lifecycle object completes crash-after-stop and preserves manual fences', async () => {
  const f = fixture(), row = f.fence(); f.scenes = [];
  f.lifecycle = new SupervisorLifecycle(f.deps, { now: () => f.now });
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done');
  const manual = f.fence('manual_restart', 'origin');
  assert.equal(await f.lifecycle.advanceReclaim(manual, f.context), 'ignored'); assert.equal(f.fences.size, 1);
});
test('Origin checks both Sync markers; stale markers permit reclaim', async () => {
  const f = fixture(); f.scenes = [scene('origin')]; const row = f.fence('upgrade', 'origin');
  f.deps.readSyncMarker = a => { f.markerReads.push(a); return { held: a.kind === 'origin', stale: false }; };
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'cancelled');
  assert.deepEqual(f.markerReads.map(x => x.kind), ['group', 'origin']);
  f.fence('upgrade', 'origin'); f.deps.readSyncMarker = () => ({ held: true, stale: true });
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done');
});
// no in single auth; deadline-less controls ignored and final race holds.
test('single auth ignores only deadline-less controls and retries a final count race', async () => {
  const f = fixture(); f.context.configuration.mode = 'single'; f.scenes = [scene(null)];
  f.runningControls = 1; f.withoutDeadline = 1;
  const row = { reason: 'auth', runId: 'run-null' }; let reads = 0;
  f.db.countGlobalRunningConversations = () => ++reads > 1 ? 1 : 0;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context, { unfenced: true, singleAuth: true }), 'waiting_inflight');
  assert.equal(f.fences.size, 0); assert.deepEqual(f.stops, []);
  f.db.countGlobalRunningConversations = () => 0;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context, { unfenced: true, singleAuth: true }), 'done');
  assert.deepEqual(f.markerReads.map(x => x.kind), ['global', 'global']);
});
// final conversation check preserves the reclaim fence.
async function finalRaceAssertion(Class) {
  const f = fixture(Class), row = f.fence('model_config'); let reads = 0;
  f.db.countRunningConversations = () => ++reads > 1 ? 1 : 0;
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'RECLAIM_INFLIGHT' });
  assert.equal(f.fences.size, 1); assert.deepEqual(f.stops, []);
}
test('final conversation recheck', async () => {
  await finalRaceAssertion(SupervisorLifecycle);

});
// reclaim-policy: TTL preparation is cancellable; all real terminal statuses recheck.
test('TTL preparation cancels on new messages or replaced run without fencing', async () => {
  for (const change of ['message', 'replacement']) {
    const f = fixture(); f.unsummarized = 2;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.controls.length, 1); assert.equal(f.fences.size, 0);
    assert.equal(f.controls[0].requireIdle, true); assert.equal(f.controls[0].appendAckSuffix, true);
    if (change === 'message') f.lastActivity = f.now + 1; else f.scenes[0].runId = 'new';
    f.controls[0].status = 'done'; f.now += 10;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
  }
});
test('TTL preparation accepts terminal outcomes only after idle and same-run checks', async () => {
  for (const status of ['done', 'timeout', 'superseded', 'failed', 'cancelled']) {
    const f = fixture(); f.unsummarized = 1;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); f.controls[0].status = status;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.get('a')?.reason, 'ttl');
  }
  const f = fixture(); f.unsummarized = 1;
  await f.lifecycle.checkTtl(f.scenes[0], f.context); f.controls[0].status = 'done'; f.scenes[0].state = 'busy';
  await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
});
test('TTL excludes Origin and starting runs; TTL still must be expired at completion', async () => {
  const f = fixture();
  for (const s of [scene('origin'), scene('a', { ready: false })]) { f.scenes = [s]; await f.lifecycle.checkTtl(s, f.context); }
  assert.equal(f.controls.length, 0); assert.equal(f.fences.size, 0);
  f.scenes = [scene()]; f.unsummarized = 1; await f.lifecycle.checkTtl(f.scenes[0], f.context);
  f.controls[0].status = 'done'; f.context.configuration.hotTtlSeconds = 3000;
  await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
});
test('LRU uses current occupied startup capacity and excludes model_config from in-flight discount', async () => {
  const scenes = [scene('a'), scene('b', { ready: false }), scene('origin')];
  const pending = [{ sessionGroup: 'new' }, { sessionGroup: 'new' }, { sessionGroup: 'a' }];
  assert.deepEqual(evictionDemand(scenes, pending, [{ sessionGroup: 'a', reason: 'model_config' }], 2), { waiting: 1, free: 0, inflight: 0, need: 1 });
  const f = fixture(); f.scenes = scenes; f.context.configuration.capacity = 2; f.pending = pending;
  f.requests = [{ reason: 'manual_restart' }]; // Origin-only manual work cannot suspend ordinary pool eviction.
  await f.lifecycle.checkEviction(f.scenes, f.context); assert.equal(f.fences.get('a')?.reason, 'evict');
  f.scenes = [scene('a', { state: 'busy' })]; f.fences.clear();
  await f.lifecycle.checkEviction(f.scenes, f.context); assert.equal(f.fences.size, 0);
});
// rotation only from current valid sample, and successful writes own the cooldown.
test('rotation cooldown follows successful write and run/session pair', async () => {
  const f = fixture(); f.scenes[0].usagePercent = null;
  await f.lifecycle.checkRotation(f.scenes[0], f.context); assert.equal(f.controls.length, 0);
  f.scenes[0].usagePercent = 75; const insert = f.db.insertControl;
  f.db.insertControl = () => { throw new Error('write failed'); };
  await assert.rejects(f.lifecycle.checkRotation(f.scenes[0], f.context));
  f.db.insertControl = insert;
  await f.lifecycle.checkRotation(f.scenes[0], f.context); await f.lifecycle.checkRotation(f.scenes[0], f.context); assert.equal(f.controls.length, 1);
  assert.equal(f.controls[0].bypassState, true); assert.equal(f.controls[0].appendAckSuffix, false);
  f.scenes[0].sessionId = 'session-2'; await f.lifecycle.checkRotation(f.scenes[0], f.context);
  assert.equal(f.controls.length, 2); assert.equal(f.events.some(e => e.event === 'rotate_done'), false);
});
// full immutable input comparison; no fence before acceptance.
test('configuration compares full input and never fabricates missing snapshot', async () => {
  const f = fixture(); f.scenes[0].launchConfig = null;
  await f.lifecycle.reconcileConfiguration(f.context); assert.equal(f.controls.length, 0); assert.equal(f.events[0].event, 'config_snapshot_unavailable');
  f.scenes[0].launchConfig = { runtime: 'claude', mode: 'override', model: 'm', effort: 'low' };
  f.expected = { runtime: 'claude', mode: 'override', model: 'm', effort: 'high' };
  await f.lifecycle.reconcileConfiguration(f.context); assert.equal(f.controls.length, 1); assert.equal(f.fences.size, 0);
  assert.equal(f.controls[0].priority, 1); assert.equal(f.controls[0].targetBinding.expectedRunId, 'run-a');
  f.expected = { ...f.scenes[0].launchConfig }; f.now += 300001;
  await f.lifecycle.reconcileConfiguration(f.context); assert.equal(f.controls.length, 1);
});
// trigger conditions: count>0, per-scope marker, minimum interval, Origin checkpoint age.
test('regular Sync new-run request obeys held marker and minimum interval', async () => {
  const f = fixture(); f.unsummarized = 1; f.marker = { held: true, stale: false };
  await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 0);
  f.marker.stale = true; f.now += 60000; await f.lifecycle.checkSync(f.scenes, f.context);
  assert.equal(f.controls.length, 1); assert.equal(f.controls[0].priority, 2); assert.equal(f.controls[0].appendAckSuffix, false);
  f.scenes[0].runId = 'new-run'; f.now += 60000; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 1);
  f.now += 600000; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 2);
});
test('Origin checkpoint-only backlog uses longest wait, never new-run or context shortcut or backlog alert', async () => {
  const f = fixture(); f.scenes = [scene('origin', { usagePercent: 99 })];
  f.backlog = { total: 0, groups: [{ count: 0, firstAt: null, pendingCheckpoints: 1, firstCheckpointAt: f.now - 1 }] };
  await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 0);
  f.now += 22_000_000; await f.lifecycle.checkSync(f.scenes, f.context);
  assert.deepEqual(f.controls.map(c => c.content), ['origin sync']);
  f.now += 23_000_000; await f.lifecycle.checkSync(f.scenes, f.context);
  assert.ok(f.controls.every(c => !c.content.startsWith('alert:')));
});
test('backlog alert routes to Origin, dedupes six hours, and holds during manual restart', async () => {
  const f = fixture(); f.unsummarized = 801; f.requests = [{ reason: 'manual_restart' }];
  await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.filter(c => c.content.startsWith('alert:')).length, 0);
  f.requests = []; f.now += 60000; await f.lifecycle.checkSync(f.scenes, f.context);
  const alerts = () => f.controls.filter(c => c.content.startsWith('alert:'));
  assert.equal(alerts().length, 1); assert.equal(alerts()[0].sessionGroup, 'origin');
  f.now += 600000; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(alerts().length, 1);
  f.now += 21_600_000; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(alerts().length, 2);
});
// immutable restart list and durable delete before diagnostic.
test('upgrade waits startup and unknown inventory; new run never joins original restart list', async () => {
  const f = fixture(); f.requests = [{ reason: 'upgrade', requestId: 'req', runIds: ['run-a'] }];
  f.scenes[0].ready = false; await f.lifecycle.advanceRestarts(f.context); assert.equal(f.fences.size, 0);
  f.scenes[0].runId = null; await assert.rejects(f.lifecycle.advanceRestarts(f.context), { code: 'INVALID_OBSERVATION' }); assert.equal(f.requests.length, 1);
  f.scenes[0].runId = 'new'; f.deps.diagnostic = () => { assert.equal(f.requests.length, 0); throw new Error('log failed'); };
  await f.lifecycle.advanceRestarts(f.context); assert.equal(f.requests.length, 0); assert.deepEqual(f.stops, []);
});
test('failed F9 deletion preserves restart and does not emit completion', async () => {
  const f = fixture(); f.scenes = []; f.requests = [{ reason: 'upgrade', requestId: 'req', runIds: ['run-a'] }];
  f.deps.requests.remove = () => { throw new Error('disk full'); };
  await assert.rejects(f.lifecycle.advanceRestarts(f.context)); assert.equal(f.requests.length, 1); assert.equal(f.events.length, 0);
});
// run identity, crash windows, no idle/control-ack wait, no replacement retarget.
test('manual stops requested Origin run immediately then waits only real conversation drain', async () => {
  const f = fixture(); f.scenes = [scene('origin', { state: 'busy' })];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  f.conversations = 1; f.runningControls = 1; f.marker.held = true;
  await f.lifecycle.advanceManual(f.context); assert.deepEqual(f.stops, ['run-origin']); assert.equal(f.requests.length, 1); assert.equal(f.fences.size, 1);
  f.scenes = [scene('origin', { runId: 'replacement' })]; f.conversations = 0;
  f.lifecycle = new SupervisorLifecycle(f.deps, { now: () => f.now });
  await f.lifecycle.advanceManual(f.context); assert.deepEqual(f.stops, ['run-origin']); assert.equal(f.requests.length, 0); assert.equal(f.fences.size, 0);
});
test('manual crash after clear removes request without recreating fence or selecting replacement', async () => {
  const f = fixture(); f.scenes = [scene('origin', { runId: 'replacement' })];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'old' }];
  f.db.setDrainFence = () => { throw new Error('must not recreate'); };
  await f.lifecycle.advanceManual(f.context); assert.equal(f.requests.length, 0); assert.deepEqual(f.stops, []);
});
test('manual mode, group-fence and global-fence conflicts preserve captured request', async () => {
  for (const conflict of ['mode', 'group', 'global']) {
    const f = fixture(); f.scenes = [scene('origin')];
    f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
    if (conflict === 'mode') f.context.configuration.mode = 'single';
    else f.fences.set(conflict === 'group' ? 'origin' : '*', { reason: 'auth', runId: 'other' });
    await f.lifecycle.advanceManual(f.context); assert.equal(f.requests.length, 1); assert.deepEqual(f.stops, []);
  }
});

// DM : malformed observations cannot authorize config reclamation.
test('config reconciliation rejects malformed snapshots and invalid expected input without controls', async () => {
  const f = fixture();
  const invalid = [null, [], { runtime: 'other', mode: 'default' }, { runtime: 'claude', mode: 'default', model: 'x' },
    ...['', ' ', 'a\0b'].map(model => ({ runtime: 'claude', mode: 'override', model, effort: 'high' })),
    ...['', ' ', 'xhigh', 'high\0'].map(effort => ({ runtime: 'claude', mode: 'override', model: 'x', effort })),
    { runtime: 'codex', mode: 'override', model: 'x', effort: 'max' }];
  for (const snapshot of invalid) {
    f.scenes[0].launchConfig = snapshot;
    await f.lifecycle.reconcileConfiguration(f.context);
    assert.equal(f.controls.length, 0); assert.equal(f.fences.size, 0);
  }
  assert.equal(f.events.filter(e => e.event === 'config_snapshot_unavailable').length, invalid.length);
  f.scenes[0].launchConfig = { runtime: 'claude', mode: 'default' };
  f.expected = { runtime: 'codex', mode: 'override', model: 'x', effort: 'max' };
  await assert.rejects(f.lifecycle.reconcileConfiguration(f.context), { code: 'INVALID_OBSERVATION' });
  assert.equal(f.controls.length, 0);
});

// TTL: invalid numeric source timestamps must not act as expired activity.
test('nonfinite activity timestamps cannot begin TTL or eviction reclamation', async () => {
  for (const timestamp of [NaN, Infinity, -Infinity]) {
    const f = fixture(); f.lastActivity = timestamp;
    await assert.rejects(f.lifecycle.checkTtl(f.scenes[0], f.context), { code: 'INVALID_OBSERVATION' });
    f.pending = [{ sessionGroup: 'waiting' }];
    await assert.rejects(f.lifecycle.checkEviction(f.scenes, f.context), { code: 'INVALID_OBSERVATION' });
    assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 0);
  }
});

// recovery / supervisor: orphan manual gates are preserved and alerted.
test('orphan manual fences retain both scopes and alert once per episode without blocking on delivery', async () => {
  const f = fixture(); const alerts = []; const releases = [];
  f.deps.alert = event => { alerts.push(event); return new Promise(resolve => { releases.push(resolve); }); };
  f.fence('manual_restart', '*'); f.fence('manual_restart', 'origin');
  await f.lifecycle.advanceManual(f.context); await f.lifecycle.advanceManual(f.context);
  assert.equal(f.fences.size, 2); assert.deepEqual(f.stops, []); assert.equal(alerts.length, 2);
  assert.equal(f.events.filter(e => e.event === 'manual_restart_orphan_fence').length, 2);
  releases.splice(0).forEach(resolve => resolve()); f.fences.clear(); await f.lifecycle.advanceManual(f.context);
  f.fence('manual_restart', 'origin'); await f.lifecycle.advanceManual(f.context);
  assert.equal(alerts.length, 3); releases.splice(0).forEach(resolve => resolve());
});

// recovery must diagnose conflicts even when suppresses advanceManual.
test('manual fence diagnostics remain available during an active transition', async () => {
  const f = fixture(); f.fence('manual_restart', '*');
  f.transition = { phase: 'draining' };
  f.requests = [{ reason: 'manual_restart', requestId: 'manual-1', mode: 'multi', expectedRunId: 'run-origin' }];
  f.deps.observeGroup = () => { throw new Error('diagnostics cannot observe or stop targets'); };
  await f.lifecycle.checkManualFences({ ...f.context, transition: f.transition });
  assert.ok(f.events.some(e => e.event === 'manual_restart_orphan_fence'));
  assert.ok(f.events.some(e => e.event === 'manual_restart_blocked'));
  assert.equal(f.fences.size, 1); assert.equal(f.requests.length, 1); assert.deepEqual(f.stops, []);
});

// Review P2-1: no drain gate before the actual Sync reader is available.
test('reclaim preflight rejects unavailable or malformed Sync dependencies before fencing', async () => {
  for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'mode_switch', 'model_config']) {
    for (const unavailable of ['missing', 'throws', 'invalid']) {
      const f = fixture(); f.scenes[0].state = 'busy';
      f.deps.readSyncMarker = unavailable === 'missing' ? undefined : unavailable === 'invalid' ? () => null :
        () => { throw Object.assign(new Error(' unavailable'), { code: 'DEPENDENCY_UNAVAILABLE' }); };
      await assert.rejects(f.lifecycle.beginReclaim(f.scenes[0], reason, f.context), {
        code: unavailable === 'invalid' ? 'INVALID_OBSERVATION' : 'DEPENDENCY_UNAVAILABLE',
      });
      assert.equal(f.fences.size, 0); assert.deepEqual(f.stops, []);
    }
  }
  const f = fixture(); f.scenes = [scene('origin')];
  f.deps.readSyncMarker = ({ kind }) => {
    if (kind === 'origin') throw Object.assign(new Error('Origin reader unavailable'), { code: 'DEPENDENCY_UNAVAILABLE' });
    return { held: true, stale: false };
  };
  await assert.rejects(f.lifecycle.beginReclaim(f.scenes[0], 'upgrade', f.context), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(f.fences.size, 0);
});
test('TTL without backlog and restart requests cannot leave fences when is unavailable', async () => {
  const f = fixture(); f.scenes.push(scene('origin'));
  f.deps.readSyncMarker = () => { throw Object.assign(new Error(' unavailable'), { code: 'DEPENDENCY_UNAVAILABLE' }); };
  await assert.rejects(f.lifecycle.checkTtl(f.scenes[0], f.context), { code: 'DEPENDENCY_UNAVAILABLE' });
  f.requests = [{ reason: 'upgrade', requestId: 'upgrade', runIds: ['run-a', 'run-origin'] }];
  await assert.rejects(f.lifecycle.advanceRestarts(f.context), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(f.fences.size, 0); assert.equal(f.requests.length, 1); assert.deepEqual(f.stops, []);
});
test('available held marker permits fencing but never permits an idle stop', async () => {
  const f = fixture(); f.marker = { held: true, stale: false };
  assert.equal(await f.lifecycle.beginReclaim(f.scenes[0], 'upgrade', f.context), true);
  assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), 'cancelled');
  assert.deepEqual(f.stops, []); assert.equal(f.fences.size, 0);
});
test('Sync observation failure retains every reclaim fence', async () => {
  for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'mode_switch', 'model_config']) {
    const f = fixture(); await f.lifecycle.beginReclaim(f.scenes[0], reason, f.context);
    f.deps.readSyncMarker = () => { throw Object.assign(new Error('reader failed'), { code: 'DEPENDENCY_UNAVAILABLE' }); };
    await assert.rejects(f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), { code: 'DEPENDENCY_UNAVAILABLE' });
    assert.equal(f.fences.size, 1); assert.deepEqual(f.stops, []);
    assert.ok(f.events.some(e => e.event === 'reclaim_observation_unavailable'));
  }
});
async function retainedConfigAssertion(Class) {
  const f = fixture(Class), row = f.fence('model_config'), alerts = [];
  f.deps.alert = event => alerts.push(event);
  const observe = f.deps.observeGroup;
  f.deps.observeGroup = () => { throw Object.assign(new Error('tmux unavailable'), { code: 'TMUX_UNAVAILABLE' }); };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'TMUX_UNAVAILABLE' });
    assert.equal(f.fences.get('a'), row); assert.deepEqual(f.stops, []);
  }
  assert.equal(alerts.length, 1);
  assert.equal(f.events.some(e => e.event === 'reclaim_cancelled'), false);
  f.deps.observeGroup = observe;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done');
  assert.equal(f.fences.size, 0); assert.deepEqual(f.stops, ['run-a']);
}
test('model_config survives observation errors', async () => {
  await retainedConfigAssertion(SupervisorLifecycle);

});
test('observation failure cannot clear a replacement fence', async () => {
  const f = fixture(), row = f.fence();
  f.deps.readSyncMarker = () => {
    f.fences.set('a', { sessionGroup: 'a', runId: 'replacement', reason: 'auth' });
    throw Object.assign(new Error('reader failed'), { code: 'DEPENDENCY_UNAVAILABLE' });
  };
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'DEPENDENCY_UNAVAILABLE' });
  assert.equal(f.fences.get('a').runId, 'replacement'); assert.deepEqual(f.stops, []);
});
test('successful stop is not followed by a second runtime observation', async () => {
  const f = fixture(), row = f.fence(); let stopped = false, reads = 0;
  const observe = f.deps.observeGroup;
  f.deps.stop = () => { stopped = true; };
  f.deps.observeGroup = group => {
    reads++;
    assert.equal(stopped, false, 'caller observed after confirmed adapter stop');
    return observe(group);
  };
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done');
  assert.equal(reads, 1); assert.equal(f.fences.size, 0);
});

// Review P2-4: replace the target between drain checks and the final stop guard.
async function replacementBeforeStopAssertion(Class) {
  const f = fixture(Class), row = f.fence(); let observations = 0;
  f.deps.observeGroup = () => {
    if (++observations === 1) f.scenes = [scene('a', { runId: 'replacement' })];
    return f.scenes[0] ?? { present: false };
  };
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done');
  assert.deepEqual(f.stops, [], 'stop must not target a replacement run');
  assert.equal(f.scenes[0].runId, 'replacement'); assert.equal(f.fences.size, 0);
}
test('final runId guard refuses replacement', async () => {
  await replacementBeforeStopAssertion(SupervisorLifecycle);

});

test('failed reclaim database observations retain the fence and alert once without waiting for channel I/O', async () => {
  for (const source of ['fence', 'conversations', 'controls', 'final-count']) {
    const f = fixture(), row = f.fence(), alerts = [], releases = [];
    f.deps.alert = event => { alerts.push(event); return new Promise(resolve => releases.push(resolve)); };
    const fail = () => { throw Object.assign(new Error('DB unavailable'), { code: 'DB_BUSY' }); };
    if (source === 'fence') f.db.getDrainFence = fail;
    if (source === 'conversations') f.db.countRunningConversations = fail;
    if (source === 'controls') f.db.countNonTerminalControls = fail;
    if (source === 'final-count') {
      let reads = 0; f.db.countRunningConversations = () => ++reads % 2 === 0 ? fail() : 0;
    }
    await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'DB_BUSY' });
    await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'DB_BUSY' });
    assert.equal(f.fences.size, 1); assert.deepEqual(f.stops, []);
    assert.equal(alerts.length, 1); assert.equal(alerts[0].event, 'reclaim_observation_unavailable');
    releases.forEach(resolve => resolve());
  }
});

// B2: read-only producers consume captured authorities; no extra F9/D8/tmux reads.
test('quiet lifecycle checks share sampled authorities without rereading runtime', async () => {
  const f = fixture(); f.scenes[0].createdAt = f.now; f.requests = [];
  const context = f.context;
  const unexpected = () => { throw new Error('unexpected fresh read during quiet round'); };
  f.db.getModeTransition = unexpected; f.db.listDrainFences = unexpected;
  f.deps.requests.read = unexpected; f.deps.observeGroup = unexpected;
  await f.lifecycle.checkManualFences(context); await f.lifecycle.advanceRestarts(context);
  await f.lifecycle.reconcileConfiguration(context); await f.lifecycle.checkRotation(context.scenes[0], context);
  await f.lifecycle.checkTtl(context.scenes[0], context); await f.lifecycle.checkEviction(context.scenes, context);
  await f.lifecycle.checkSync(context.scenes, context);
  assert.equal(f.controls.length, 0); assert.equal(f.stops.length, 0);
});

// B1/B2: a failed observation must not masquerade as absence or authorize writes.
test('failed scene snapshots preserve upgrade intent and block lifecycle producers', async () => {
  const f = fixture(); f.requests = [{ reason: 'upgrade', requestId: 'req', runIds: ['run-a'] }];
  f.scenes[0] = { ...f.scenes[0], present: false, observationError: Object.assign(new Error('unavailable'), { code: 'TMUX_UNAVAILABLE' }) };
  for (const action of [
    () => f.lifecycle.advanceRestarts(f.context), () => f.lifecycle.reconcileConfiguration(f.context),
    () => f.lifecycle.checkRotation(f.scenes[0], f.context), () => f.lifecycle.checkTtl(f.scenes[0], f.context),
    () => f.lifecycle.checkEviction(f.scenes, f.context), () => f.lifecycle.checkSync(f.scenes, f.context),
  ]) await assert.rejects(action(), { code: 'TMUX_UNAVAILABLE' });
  assert.equal(f.requests.length, 1); assert.equal(f.controls.length, 0); assert.equal(f.fences.size, 0);
});

// B4: execution identifies the run only; sessionId is an admission check.
test('manual execution ignores a later sessionId change and updates round snapshot after stop', async () => {
  const f = fixture(); f.scenes = [scene('origin', { sessionId: 'new-session' })];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  const context = f.context;
  await f.lifecycle.advanceManual(context);
  assert.deepEqual(f.stops, ['run-origin']); assert.equal(context.scenes[0].present, false);
  assert.deepEqual(context.fences, []); assert.deepEqual(context.restartRequests, []);
});

// B2: later consumers must see a replacement discovered by the mutation guard.
test('reclaim replacement revalidation updates the shared round snapshot', async () => {
  const f = fixture(), row = f.fence(), context = f.context;
  f.deps.observeGroup = () => scene('a', { runId: 'replacement' });
  assert.equal(await f.lifecycle.advanceReclaim(row, context), 'done');
  assert.equal(context.scenes[0].runId, 'replacement'); assert.equal(context.scenes[0].present, true);
  assert.deepEqual(context.fences, []); assert.deepEqual(f.stops, []);
});

test('unreadable intent blocks new lifecycle writes while authoritative D8 reclaim completes', async () => {
  const f = fixture(), fence = f.fence(), context = f.context;
  context.restartRequestsError = new Error('corrupt F9'); f.unsummarized = 20;
  assert.deepEqual(await f.lifecycle.checkManualFences(context), []);
  await f.lifecycle.advanceRestarts(context); await f.lifecycle.reconcileConfiguration(context);
  await f.lifecycle.checkRotation(context.scenes[0], context); await f.lifecycle.checkTtl(context.scenes[0], context);
  await f.lifecycle.checkSync(context.scenes, context);
  assert.equal(f.controls.length, 0);
  assert.equal(await f.lifecycle.advanceReclaim(fence, context), 'done');
  assert.deepEqual(f.stops, ['run-a']); assert.equal(f.fences.size, 0);
});

// B4 / supervisor: replacement races after the round snapshot, before the guarded stop.
test('manual replacement after fence acquisition is preserved without calling stop', async () => {
  const f = fixture(); f.scenes = [scene('origin')];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  const context = f.context, setFence = f.db.setDrainFence;
  f.db.setDrainFence = (group, value) => { setFence(group, value); f.scenes = [scene('origin', { runId: 'replacement' })]; };
  await f.lifecycle.advanceManual(context);
  assert.deepEqual(f.stops, []); assert.equal(f.scenes[0].runId, 'replacement');
  assert.equal(context.scenes[0].runId, 'replacement');
  assert.equal(f.requests.length, 0); assert.equal(f.fences.size, 0);
  assert.equal(f.events.at(-1).event, 'manual_restart_done');
});

test('manual adapter RUNID_MISMATCH after fresh observation completes old request and preserves replacement', async () => {
  const f = fixture(); f.scenes = [scene('origin')];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  const context = f.context;
  f.deps.stop = target => { f.stops.push(target.runId); f.scenes = [scene('origin', { runId: 'replacement' })]; throw Object.assign(new Error('run replaced before adapter stop'), { code: 'RUNID_MISMATCH' }); };
  await f.lifecycle.advanceManual(context);
  assert.deepEqual(f.stops, ['run-origin']); assert.equal(f.scenes[0].runId, 'replacement');
  assert.equal(f.requests.length, 0); assert.equal(f.fences.size, 0);
  assert.equal(f.events.at(-1).event, 'manual_restart_done');
});

test('C3 unavailable capacity defers eviction; malformed resolved capacity remains an error',async()=>{
 const f=fixture();delete f.context.configuration.capacity;
 f.context.configuration.capacityUnavailable=true;
 const read=f.db.listPendingSessionGroups;f.db.listPendingSessionGroups=()=>{throw new Error('eviction must be deferred');};
 assert.equal(await f.lifecycle.checkEviction(f.scenes,f.context),undefined);
 f.db.listPendingSessionGroups=read;f.context.configuration.capacityUnavailable=false;
 for(const capacity of [undefined,null,0,-1,1.5,'2']) {
  f.context.configuration.capacity=capacity;
  await assert.rejects(f.lifecycle.checkEviction(f.scenes,f.context),{code:'CONFIG_UNREADABLE'});
 }
});

test('LRU selects the oldest activity among multiple eligible idle groups regardless of enumeration order', async () => {
  for (const order of [['newer', 'oldest', 'middle'], ['middle', 'newer', 'oldest']]) {
    const f = fixture(); f.context.configuration.capacity = 3;
    f.scenes = order.map(group => scene(group)); f.pending = [{ sessionGroup: 'waiting' }];
    const activity = { oldest: 100, middle: 200, newer: 300 };
    f.db.getLastActivity = group => ({ ts: activity[group] });
    const result = await f.lifecycle.checkEviction(f.scenes, f.context);
    assert.equal(result.need, 1); assert.equal(result.selected, 1);
    assert.deepEqual([...f.fences.keys()], ['oldest']);
    assert.equal(f.fences.get('oldest').reason, 'evict');
    assert.equal(f.fences.get('oldest').runId, 'run-oldest');
    assert.deepEqual(f.stops, []);
  }
});
