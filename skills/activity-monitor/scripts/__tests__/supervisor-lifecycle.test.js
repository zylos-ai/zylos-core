import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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
  f.db = {
    getModeTransition: () => f.transition,
    getDrainFence: g => f.fences.get(g) ?? null,
    listDrainFences: () => [...f.fences.values()],
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
    observeFixedTarget: r => ({ present: f.scenes.some(s => s.runId === r.expectedRunId) }),
    stopFixedTarget: r => { f.stops.push(r.expectedRunId); f.scenes = f.scenes.filter(s => s.runId !== r.expectedRunId); },
    prompts: { PRE_RECLAIM_SYNC_PROMPT: 'prepare', GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync',
      ROTATION_PROMPT: () => 'rotate', CONFIG_RECLAIM_PROMPT: () => 'config', SYNC_BACKLOG_ALERT: reader => `alert:${reader}` },
  };
  f.lifecycle = new Class(f.deps, { now: () => f.now });
  f.fence = (reason = 'ttl', group = 'a') => { const row = { sessionGroup: group, reason, runId: `run-${group}` }; f.fences.set(group, row); return row; };
  return f;
}

// P05 T05 / IF-32: persisted fences resume from facts; in-flight work is never guessed away.
test('reclaim waits conversations and controls, then stops the same run and clears', async () => {
  const f = fixture(), row = f.fence(); f.conversations = 1;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'waiting_inflight');
  f.conversations = 0; f.runningControls = 1;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'waiting_inflight');
  f.runningControls = 0;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done');
  assert.deepEqual(f.stops, ['run-a']); assert.equal(f.fences.size, 0);
});
test('ordinary busy cancels with TTL reset; model_config busy retains its fence', async () => {
  for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'mode_switch', 'model_config']) {
    const f = fixture(), row = f.fence(reason); f.scenes[0].state = 'busy';
    assert.equal(await f.lifecycle.advanceReclaim(row, f.context), reason === 'model_config' ? 'waiting_idle' : 'cancelled');
    assert.equal(f.fences.size, reason === 'model_config' ? 1 : 0); assert.deepEqual(f.stops, []);
    if (reason === 'ttl') { await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0); }
  }
});
test('unknown process and observation errors retain the fence', async () => {
  const f = fixture(), row = f.fence(); f.scenes[0].processRunning = undefined;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'unknown_process'); assert.equal(f.fences.size, 1);
  f.deps.observeGroup = () => { throw Object.assign(new Error('unavailable'), { code: 'TMUX_UNAVAILABLE' }); };
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'TMUX_UNAVAILABLE' }); assert.equal(f.fences.size, 1);
});
test('exited runtime cleans residual tmux without idle or marker; replacement stays untouched', async () => {
  const f = fixture(), row = f.fence(); f.scenes[0].processRunning = false; f.scenes[0].state = 'busy';
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done'); assert.equal(f.markerReads.length, 0);
  const g = fixture(), old = g.fence(); g.scenes[0].runId = 'replacement';
  assert.equal(await g.lifecycle.advanceReclaim(old, g.context), 'done'); assert.deepEqual(g.stops, []); assert.equal(g.scenes.length, 1);
});
test('unconfirmed stop and failed DB reads cannot remove the durable fence', async () => {
  const f = fixture(), row = f.fence(); f.deps.stop = () => {};
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
// IF-28: no D8 in single auth; deadline-less controls ignored and final race holds.
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
// P05 T05: known-bad missing final conversation check must fail the invariant assertion.
async function finalRaceAssertion(Class) {
  const f = fixture(Class), row = f.fence('model_config'); let reads = 0;
  f.db.countRunningConversations = () => ++reads > 1 ? 1 : 0;
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'RECLAIM_INFLIGHT' });
  assert.equal(f.fences.size, 1); assert.deepEqual(f.stops, []);
}
test('final conversation recheck and known-bad control', async () => {
  await finalRaceAssertion(SupervisorLifecycle);
  const source = await fs.readFile(new URL('../supervisor-lifecycle.js', import.meta.url), 'utf8');
  const mutated = source.replace('if (again.conversations !== 0 || again.controls !== 0)', 'if (false)')
    .replace("'./launch-config-shape.js'", JSON.stringify(new URL('../launch-config-shape.js', import.meta.url).href));
  assert.notEqual(source, mutated);
  const bad = await import(`data:text/javascript;base64,${Buffer.from(mutated).toString('base64')}`);
  await assert.rejects(finalRaceAssertion(bad.SupervisorLifecycle), { code: 'ERR_ASSERTION' });
});
// P05 T05 reclaim-policy: TTL preparation is cancellable; all real terminal statuses recheck.
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
  for (const status of ['done', 'timeout', 'superseded']) {
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
// P05 T06: rotation only from current valid sample, and successful writes own the cooldown.
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
  assert.equal(f.controls.length, 2); assert.ok(f.events.some(e => e.event === 'rotate_done'));
});
// P05 T06 / IF10-7d: full immutable input comparison; no fence before acceptance.
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
// P05 T06 / M5 trigger conditions: count>0, per-scope marker, minimum interval, Origin checkpoint age.
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
// P05 T07 / IF-34: immutable restart list and durable delete before diagnostic.
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
// P05 T07 / IF-36: fixed object, crash windows, no idle/control-ack wait, no replacement retarget.
test('manual stops fixed original immediately then waits only real conversation drain', async () => {
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

// IF-35 / DM F2: malformed observations cannot authorize config reclamation.
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

// T05 TTL: invalid numeric source timestamps must not act as expired activity.
test('nonfinite activity timestamps cannot begin TTL or eviction reclamation', async () => {
  for (const timestamp of [NaN, Infinity, -Infinity]) {
    const f = fixture(); f.lastActivity = timestamp;
    await assert.rejects(f.lifecycle.checkTtl(f.scenes[0], f.context), { code: 'INVALID_OBSERVATION' });
    f.pending = [{ sessionGroup: 'waiting' }];
    await assert.rejects(f.lifecycle.checkEviction(f.scenes, f.context), { code: 'INVALID_OBSERVATION' });
    assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 0);
  }
});

// T01/T08 recovery / M4 2.12: orphan manual gates are preserved and alerted.
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

// T01 recovery must diagnose conflicts even when D9 suppresses advanceManual.
test('manual fence diagnostics remain available during an active transition', async () => {
  const f = fixture(); f.fence('manual_restart', '*');
  f.transition = { phase: 'draining' };
  f.requests = [{ reason: 'manual_restart', requestId: 'manual-1', mode: 'multi', expectedRunId: 'run-origin' }];
  f.deps.observeFixedTarget = () => { throw new Error('diagnostics cannot observe or stop targets'); };
  await f.lifecycle.checkManualFences({ ...f.context, transition: f.transition });
  assert.ok(f.events.some(e => e.event === 'manual_restart_orphan_fence'));
  assert.ok(f.events.some(e => e.event === 'manual_restart_blocked'));
  assert.equal(f.fences.size, 1); assert.equal(f.requests.length, 1); assert.deepEqual(f.stops, []);
});
