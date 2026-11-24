import { loadRuntimeContexts } from '../../../../cli/lib/model-rotation-thresholds.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle, evictionDemand } from '../supervisor-lifecycle.js';
import { MANUAL_WAKE_PROMPT } from '../origin-prompts.js';
import { groupMemoryDir } from '../../../../cli/lib/session-group-paths.js';

const contexts = await loadRuntimeContexts();

// Each fixture owns its persistent alert ledger and published state files.
// No fixture can inherit another case's incident claims or touch a live tree.
const fixtureRoots = [];
after(() => { for (const root of fixtureRoots) fs.rmSync(root, { recursive: true, force: true }); });

const scene = (sessionGroup = 'a', extra = {}) => ({ sessionGroup, present: true, ready: true,
  runId: `run-${sessionGroup}`, runtime: 'claude', sessionId: 'session-1', createdAt: 0,
  processRunning: true, state: 'idle', idleSince: 0, runDir: '/isolated/run',
  launchConfig: { runtime: 'claude', mode: 'default' }, ...extra });
// Above the default Sync threshold of 15, so a reclaim prepares a Sync.
const SYNC_DUE = 16;
function fixture(Class = SupervisorLifecycle) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-')); fixtureRoots.push(root);
  const env = { ...process.env, HOME: path.join(root, 'home'), ZYLOS_DIR: path.join(root, 'z'),
    PM2_HOME: path.join(root, 'pm2'), TMPDIR: path.join(root, 'tmp') };
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR']) {
    assert.ok(env[key].startsWith(root + path.sep)); fs.mkdirSync(env[key], { recursive: true });
  }
  const f = { now: 2_000_000, scenes: [scene()], fences: new Map(), requests: [], controls: [], events: [], stops: [], forgotten: [],
    conversations: 0, runningControls: 0, lastActivity: 0, unsummarized: 0,
    transition: null, pending: [], marker: { held: false, stale: false }, markerReads: [],
    backlog: { total: 0, groups: [] },
    context: { configuration: { contexts, mode: 'multi', capacity: 1, hotTtlSeconds: 1800 } } };
  const configuration = f.context.configuration;
  Object.defineProperty(f, 'context', { get: () => ({ configuration, transition: f.transition,
    scenes: f.scenes.map(s => ({ ...s })), fences: [...f.fences].map(([sessionGroup, value]) => ({ sessionGroup, ...value })), restartRequests: [...f.requests] }) });
  f.checkpoints = new Map(); f.cursors = new Map(); f.env = env;
  f.db = {
    listSlotOccupancy: () => f.slots ?? f.scenes.filter(s => s.sessionGroup !== 'origin' && s.present).map(s => ({ sessionGroup: s.sessionGroup, runId: s.runId, state: 'running', heldUntil: null, createdAt: 0 })),
    getModeTransition: () => f.transition,
    listRunEndings: () => [],
    getLastCompletedModeTransition: () => null,
    getDrainFence: g => f.fences.get(g) ?? null,
    listDrainFences: () => [...f.fences].map(([sessionGroup, value]) => ({ sessionGroup, ...value })),
    setDrainFence: (g, value) => { if (!f.fences.has(g)) f.fences.set(g, { sessionGroup: g, ...value }); },
    clearDrainFence: g => f.fences.delete(g),
    recordRunEnd: (g, options) => { f.endings ??= []; f.endings.push({ sessionGroup: g, ...options }); f.fences.delete(g); return { recorded: true }; },
    countRunningConversations: () => f.conversations,
    countGlobalRunningConversations: () => f.conversations,
    countNonTerminalControls: () => ({ running: f.runningControls }),
    expireStaleRunningControls: () => [],
    getLastActivity: () => ({ ts: f.lastActivity }),
    getUnsummarizedRange: () => ({ count: f.unsummarized, firstAt: f.unsummarized ? 1_000_000 : null, lastConversationId: f.unsummarized || null }),
    getGlobalUnsummarizedRange: () => ({ count: f.unsummarized, firstAt: f.unsummarized ? 1_000_000 : null }),
    getLatestContentCheckpoint: scope => f.checkpoints.get(scope) ?? null,
    getDeliveredFrontier: () => f.unsummarized,
    getOriginSyncCursor: scope => f.cursors.get(scope) ?? null,
    getOriginSyncBacklog: () => ({ ...f.backlog, groups: f.backlog.groups.map(row => ({
      sessionGroup: 'fixture-source', cursorFrom: 0, checkpointFrom: 0, ...row,
    })) }),
    listPendingSessionGroups: () => f.pending,
    getControlById: id => f.controls.find(c => c.id === id),
    insertControl: (content, options) => { const row = { id: f.controls.length + 1, content, ...options, status: 'pending' }; f.controls.push(row); return row; },
  };
  f.deps = { db: f.db, env, observe: () => f.scenes,
    observeGroup: group => f.scenes.find(s => s.sessionGroup === group || group === null && s.sessionGroup === 'origin') ?? { present: false },
    stop: s => { f.stops.push(s.runId); f.scenes = f.scenes.filter(x => x.runId !== s.runId); },
    intentionalStop: (group, runId) => { f.forgotten.push([group, runId]); },
    readSyncMarker: args => { f.markerReads.push(args); return f.marker; },
    groupRunDir: group => `/isolated/${group}`,
    requests: { read: () => f.requests, remove: id => { f.requests = f.requests.filter(r => r.requestId !== id); } },
    bindTarget: s => ({ expectedRunId: s.runId }),
    diagnostic: e => f.events.push(e),
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check', UPGRADE_RESTART_CHECK_PROMPT: 'upgrade check', PRE_RECLAIM_SYNC_PROMPT: 'prepare', PRE_RECLAIM_ORIGIN_SYNC_PROMPT: 'prepare origin', GROUP_SYNC_PROMPT: 'group sync', CLAUDE_GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync',
      ROTATION_PROMPT: () => 'rotate', SYNC_BACKLOG_ALERT: (kind, count, lag, scope) => `alert:${kind === 'group' ? scope : kind}` },
  };
  f.lifecycle = new Class(f.deps, { now: () => f.now });
  f.publishSyncFacts = () => {
    // Model the persisted result separately from control settlement. The real
    // proof reads these checkpoint/cursor observations and private state bytes.
    for (const preparation of [...f.lifecycle.ttlPreparation.values(), ...f.lifecycle.releasePreparation.values()]) {
      for (const { target } of preparation.syncs ?? []) {
        if (target.kind === 'origin') {
          for (const cursor of target.cursors) f.cursors.set(cursor.scope, {
            syncedId: cursor.syncedId + 1, checkpointId: cursor.checkpointId + 1,
          });
          continue;
        }
        const checkpoint = { id: (target.checkpointId ?? 0) + 1, end_conversation_id: target.end };
        f.checkpoints.set(target.scope, checkpoint);
        const directory = groupMemoryDir(target.scope, env); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'state.md'), `<!-- zylos-state v1 | scope=${target.scope} | synced_at=2026-11-17T00:00:00Z | coverage=${target.end} | inbox_committed= -->\n`);
      }
    }
  };
  f.settle = (status = 'done') => { for (const control of f.controls) control.status = status; };
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
  assert.deepEqual(f.stops, ['run-a']); assert.deepEqual(f.forgotten,[['a','run-a']]); assert.equal(f.fences.size, 0);
});
test('ordinary busy cancels with TTL reset', async () => {
  for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'mode_switch']) {
    const f = fixture(), row = f.fence(reason); f.scenes[0].state = 'busy';
    assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'cancelled');
    assert.equal(f.fences.size, 0); assert.deepEqual(f.stops, []);
    if (reason === 'ttl') { await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0); }
  }
});
test('unconfirmed stop and failed DB reads cannot remove the durable fence', async () => {
  const f = fixture(), row = f.fence(); f.deps.stop = () => { throw Object.assign(new Error('stop failed'), { code: 'STOP_UNCONFIRMED' }); };
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'STOP_UNCONFIRMED' }); assert.equal(f.fences.size, 1); assert.deepEqual(f.forgotten,[]);
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
// reclaim-policy: TTL preparation is cancellable; all real terminal statuses recheck.
test('TTL preparation cancels on new messages or replaced run without fencing', async () => {
  for (const change of ['message', 'replacement']) {
    const f = fixture(); f.unsummarized = SYNC_DUE;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
    assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare']);
    for (const control of f.controls) { assert.equal(control.requireIdle, true); assert.equal(control.appendAckSuffix, true); }
    if (change === 'message') f.lastActivity = f.now + 1; else f.scenes[0].runId = 'new';
    f.settle(); f.now += 10;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
  }
});
test('completed TTL preparation waits for every held Sync marker to release', async () => {
  for (const group of ['a', 'origin']) {
    for (const heldKind of group === 'origin' ? ['group', 'origin'] : ['group']) {
      const f = fixture(); f.scenes = [scene(group)]; f.unsummarized = SYNC_DUE;
      await f.lifecycle.checkTtl(f.scenes[0], f.context);
      const preparation = f.lifecycle.ttlPreparation.get(group);
      f.publishSyncFacts(); f.settle();
      f.deps.readSyncMarker = args => { f.markerReads.push(args); return { held: args.kind === heldKind, stale: false }; };
      for (const elapsed of [1, 90_000]) {
        f.now = preparation.at + elapsed; f.scenes[0].lastActivityAt = f.now;
        await f.lifecycle.checkTtl(f.scenes[0], f.context);
        assert.equal(f.lifecycle.ttlPreparation.get(group), preparation);
        assert.equal(f.fences.size, 0);
        assert.equal(f.controls.length, 2);
      }
      assert.ok(f.markerReads.some(args => args.kind === heldKind && args.currentRunId === preparation.runId));
      f.deps.readSyncMarker = () => ({ held: false, stale: false });
      await f.lifecycle.checkTtl(f.scenes[0], f.context);
      assert.equal(f.fences.get(group)?.reason, 'ttl');
      assert.equal(f.lifecycle.ttlPreparation.get(group), preparation);
      assert.equal(f.controls.length, 2);
      assert.equal(f.lifecycle.ttlReset.has(group), false);
      assert.equal(await f.lifecycle.advanceReclaim(f.fences.get(group), f.context), 'done');
      assert.equal(f.lifecycle.ttlPreparation.has(group), false);
    }
  }
});
test('active subagents block TTL preparation, direct fences and capacity selection without changing idle', async () => {
  const f = fixture(); f.unsummarized = 1;
  f.scenes[0].activeSubagents = [{ agentId: 'child', lastActivityAt: f.now - 1 }];
  f.scenes[0].lastSubagentActivityAt = f.now - 1;
  assert.equal(await f.lifecycle.idle(f.scenes[0], f.context), true);
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.controls.length, 0); assert.equal(f.fences.size, 0);
  // A recent child can stay active past the eviction minimum, until hot TTL.
  f.now += 300_000;
  assert.equal((await f.lifecycle.evictionCandidates(f.scenes, f.context)).length, 0);
  for (const reason of ['ttl', 'evict']) assert.equal(await f.lifecycle.beginReclaim(f.scenes[0], reason, f.context), false);
  assert.equal(f.fences.size, 0);
});

test('Origin never participates in eviction candidates or in-flight capacity discount', async () => {
  const f = fixture(); f.scenes = [scene('origin')]; f.pending = [{ sessionGroup: 'waiting' }];
  assert.equal(await f.lifecycle.beginReclaim(f.scenes[0], 'evict', f.context), false);
  const counts = evictionDemand([], f.pending, [{ sessionGroup: 'origin', reason: 'ttl' }], 1);
  assert.deepEqual(counts, { waiting: 1, free: 1, inflight: 0, need: 0 });
  assert.equal((await f.lifecycle.checkEviction(f.scenes, f.context)).need, 0); assert.equal(f.fences.size, 0);
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
// trigger conditions: backlog above threshold, per-scope marker, minimum interval, Origin checkpoint age.
test('regular Sync obeys held marker and minimum interval across a run replacement', async () => {
  const f = fixture(); f.unsummarized = SYNC_DUE; f.marker = { held: true, stale: false };
  await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 0);
  f.marker.stale = true; f.now += 60000; await f.lifecycle.checkSync(f.scenes, f.context);
  assert.equal(f.controls.length, 1); assert.equal(f.controls[0].priority, 2); assert.equal(f.controls[0].appendAckSuffix, false);
  f.scenes[0].runId = 'new-run'; f.now += 60000; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 1);
  f.now += 600000; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 2);
});
// immutable restart list and durable delete before diagnostic.
test('upgrade waits startup and unknown inventory; new run never joins original restart list', async () => {
  const f = fixture(); f.requests = [{ reason: 'upgrade', requestId: 'req', runIds: ['run-a'] }];
  f.scenes[0].ready = false; await f.lifecycle.advanceRestarts(f.context); assert.equal(f.fences.size, 0);
  f.scenes[0].runId = null; await assert.rejects(f.lifecycle.advanceRestarts(f.context), { code: 'INVALID_OBSERVATION' }); assert.equal(f.requests.length, 1);
  f.scenes[0].runId = 'new'; f.deps.diagnostic = () => { assert.equal(f.requests.length, 0); throw new Error('log failed'); };
  await f.lifecycle.advanceRestarts(f.context); assert.equal(f.requests.length, 0); assert.deepEqual(f.stops, []);
});
// run identity, crash windows, no idle/control-ack wait, no replacement retarget.
test('manual stops requested Origin run immediately then waits only real conversation drain', async () => {
  const f = fixture(); f.scenes = [scene('origin', { state: 'busy' })];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  f.conversations = 1; f.runningControls = 1; f.marker.held = true;
  await f.lifecycle.advanceManual(f.context); assert.deepEqual(f.stops, ['run-origin']); assert.deepEqual(f.forgotten,[['origin','run-origin']]); assert.equal(f.requests.length, 1); assert.equal(f.fences.size, 1);
  f.scenes = [scene('origin', { runId: 'replacement' })]; f.conversations = 0;
  f.lifecycle = new SupervisorLifecycle(f.deps, { now: () => f.now });
  await f.lifecycle.advanceManual(f.context); assert.deepEqual(f.stops, ['run-origin']); assert.equal(f.requests.length, 0); assert.equal(f.fences.size, 0);
});
test('manual restart writes an unbound wake before clearing its fence and request', async () => {
  const f = fixture(); f.scenes = [scene('origin')];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  const insert = f.db.insertControl, record = f.db.recordRunEnd, remove = f.deps.requests.remove, order = [];
  f.db.insertControl = (content, options) => {
    assert.ok(f.fences.has('origin')); assert.equal(f.requests.length, 1);
    assert.equal(f.conversations, 0); assert.deepEqual(f.stops, ['run-origin']);
    order.push('wake'); return insert(content, options);
  };
  f.db.recordRunEnd = (group, options) => { order.push('clear'); return record(group, options); };
  f.deps.requests.remove = id => { order.push('remove'); return remove(id); };
  await f.lifecycle.advanceManual(f.context);
  assert.deepEqual(order, ['wake', 'clear', 'remove']);
  assert.deepEqual(f.controls, [{ id: 1, content: MANUAL_WAKE_PROMPT, sessionGroup: 'origin', priority: 2, appendAckSuffix: false, status: 'pending' }]);
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

test('LRU selects the oldest activity among multiple eligible idle groups regardless of enumeration order', async () => {
  for (const order of [['newer', 'oldest', 'middle'], ['middle', 'newer', 'oldest']]) {
    const f = fixture(); f.context.configuration.capacity = 3;
    f.scenes = order.map(group => scene(group)); f.pending = [{ sessionGroup: 'waiting' }];
    const activity = { oldest: 100, middle: 200, newer: 300 };
    f.db.getLastActivity = group => ({ ts: activity[group] });
    await f.lifecycle.checkEviction(f.scenes, f.context);
    assert.deepEqual(f.controls.map(control => control.sessionGroup), ['oldest']); f.settle();
    const result = await f.lifecycle.checkEviction(f.scenes, f.context);
    assert.equal(result.need, 1); assert.equal(result.selected, 1);
    assert.deepEqual([...f.fences.keys()], ['oldest']);
    assert.equal(f.fences.get('oldest').reason, 'evict');
    assert.equal(f.fences.get('oldest').runId, 'run-oldest');
    assert.deepEqual(f.stops, []);
  }
});

// Both eviction paths ask the selected group to check waiting work first and wait only briefly.
// Run for eviction, memory-pressure, or check-control changes; unrelated Sync changes may skip.
const EVICTION_PATHS = ['capacity_demand', 'memory_pressure'];
function evictionFixture(groups = ['a']) {
  const f = fixture();
  f.scenes = groups.map((group, index) => scene(group, { lastActivityAt: 1000 + index }));
  f.context.configuration.capacity = groups.length; f.pending = [{ sessionGroup: 'waiting' }];
  return f;
}
const evictionRound = (f, path) => path === 'memory_pressure'
  ? f.lifecycle.checkCapacityPressure(f.context) : f.lifecycle.checkEviction(f.scenes, f.context);

test('eviction sends a bound check first and fences only after the check is answered', async () => {
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture(), asked = f.now;
    await evictionRound(f, path);
    assert.equal(f.fences.size, 0, path);
    assert.equal(f.controls.length, 1, path);
    const [control] = f.controls;
    assert.equal(control.content, 'check'); assert.equal(control.sessionGroup, 'a');
    assert.deepEqual(control.targetBinding, { expectedRunId: 'run-a' });
    assert.equal(control.requireIdle, true); assert.equal(control.appendAckSuffix, true);
    assert.equal(control.ackDeadlineAt, Math.floor((asked + 60000) / 1000));
    f.now += 30000; control.status = 'running';
    await evictionRound(f, path);
    assert.equal(f.fences.size, 0, `${path}: no fence while the check is unanswered`);
    control.status = 'done';
    await evictionRound(f, path);
    assert.equal(f.fences.get('a')?.reason, 'evict', path);
    assert.equal(f.events.find(event => event.event === 'reclaim_started').subreason, path);
    assert.equal(f.controls.length, 1, path);
  }
});

// An upgrade restart asks each due run to check waiting work first, waits at most 60 seconds, and always restarts.
// Run for upgrade restart or check-control changes; unrelated Sync or eviction changes may skip.
function upgradeFixture(groups = ['a']) {
  const f = fixture();
  f.scenes = groups.map(group => scene(group));
  f.requests = [{ reason: 'upgrade', requestId: 'upgrade', runIds: groups.map(group => `run-${group}`) }];
  return f;
}

test('upgrade restart sends a bound check first and fences only after it is answered', async () => {
  const f = upgradeFixture(), asked = f.now;
  await f.lifecycle.advanceRestarts(f.context);
  assert.equal(f.fences.size, 0);
  assert.equal(f.controls.length, 1);
  const [control] = f.controls;
  assert.equal(control.content, 'upgrade check'); assert.equal(control.sessionGroup, 'a');
  assert.deepEqual(control.targetBinding, { expectedRunId: 'run-a' });
  assert.equal(control.requireIdle, true); assert.equal(control.appendAckSuffix, true);
  assert.equal(control.ackDeadlineAt, Math.floor((asked + 60000) / 1000));
  f.now = asked + 30000; control.status = 'running';
  await f.lifecycle.advanceRestarts(f.context);
  assert.equal(f.fences.size, 0, 'no fence while the check is unanswered');
  control.status = 'done';
  await f.lifecycle.advanceRestarts(f.context);
  assert.equal(f.fences.get('a')?.reason, 'upgrade');
  assert.equal(f.controls.length, 1);
});

const deferRequest = (extra = {}) => ({ sessionGroup: 'a', expectedRunId: 'run-a', reason: 'background command', ...extra });

test('accepted deferral immediately cancels TTL preparation and starts the entire idle interval again', async () => {
  const f = fixture();
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.lifecycle.ttlPreparation.has('a'), true);
  f.now += 60000;
  const acceptedAt = f.now;
  assert.deepEqual(await f.lifecycle.deferReclaim(deferRequest(), f.context), { ok: true, result: 'accepted' });
  f.settle();
  assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
  assert.equal(f.lifecycle.evictionPreparation.has('a'), false);
  assert.deepEqual(f.lifecycle.ttlReset.get('a'), { runId: 'run-a', at: acceptedAt });
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 1);
  f.now = acceptedAt + 1799999; await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.controls.length, 1);
  f.now = acceptedAt + 1800000; await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.controls.length, 2); assert.equal(f.fences.size, 0);
  const event = f.events.find(event => event.event === 'reclaim_deferred');
  assert.equal(event.session_group, 'a'); assert.equal(event.run_id, 'run-a');
  assert.equal(event.reason, 'background command'); assert.equal(Object.hasOwn(event, 'defer_until'), false);
});

test('voluntary intent accepts busy, repeats by run and reclaims only after idle without TTL delay',async()=>{
 for(const group of ['a','origin']){
  const f=fixture();f.scenes=[scene(group,{createdAt:f.now-4000,state:'busy',idleSince:null})];
  assert.equal((await f.lifecycle.requestRelease(f.scenes[0],f.context)).result,'accepted');
  assert.equal((await f.lifecycle.requestRelease(f.scenes[0],f.context)).result,'already_accepted');
  await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);
  Object.assign(f.scenes[0],{state:'idle',idleSince:f.now-3000,lastSubagentActivityAt:f.now-1});
  await f.lifecycle.advanceReleases(f.context);assert.deepEqual(f.controls.map(c=>c.content),['check']);assert.equal(f.fences.size,0);f.settle();await f.lifecycle.advanceReleases(f.context);const row=f.fences.get(group);assert.equal(row.reason,'release');
  assert.equal(await f.lifecycle.advanceReclaim(row,f.context),'done');assert.equal(f.endings[0].reason,'release');assert.equal(f.controls.length,1);
 }
});
test('new delivered conversation or control cancels intent with new_work before fencing',async()=>{
 for(const identity of [{conversationId:7},{controlId:7}]){
  const f=fixture();f.scenes[0].state='busy';await f.lifecycle.requestRelease(f.scenes[0],f.context);
  await f.lifecycle.workDelivered({sessionGroup:'a',runId:'run-a',pastedAt:f.now+1,...identity});
  assert.equal(f.lifecycle.releasePreparation.size,0);assert.equal(f.events.at(-1).event,'reclaim_cancelled');assert.equal(f.events.at(-1).reason,'new_work');
  f.scenes[0].state='idle';await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);
 }
});

test('native single reclaims only after global conversations and Origin controls drain', async () => {
  const f = fixture(); f.context.configuration.mode = 'single'; f.scenes = [scene('origin')];
  let global = 1; const targets = [];
  f.db.countRunningConversations = () => { throw new Error('must count every conversation'); };
  f.db.countGlobalRunningConversations = () => global;
  f.db.countNonTerminalControls = target => { targets.push(target); return {running:f.runningControls}; };
  const fence = f.fence('upgrade', 'origin');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'waiting_inflight');
  global = 0; f.runningControls = 1;
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'waiting_inflight');
  f.runningControls = 0;
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
  assert.ok(targets.every(target => target.sessionGroup === 'origin'));
  assert.deepEqual(f.markerReads.map(row => row.kind), ['group','origin']);
  assert.equal(f.endings[0].sessionGroup, 'origin');
});

