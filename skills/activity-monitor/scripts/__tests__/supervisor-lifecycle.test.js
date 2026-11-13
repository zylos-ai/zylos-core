import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupervisorLifecycle, evictionDemand, EVICTION_CHECK_ACK_TIMEOUT_MS, UPGRADE_CHECK_ACK_TIMEOUT_MS } from '../supervisor-lifecycle.js';
import { CONFIG_RECLAIM_PROMPT } from '../reclaim-prompts.js';
import { SessionActivity } from '../session-activity.js';
import { publishSessionStatus } from '../status-writer.js';
import { fixture as c4Fixture } from '../../../comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { createDelivery } from '../../../comm-bridge/scripts/router/delivery.js';
import { MANUAL_WAKE_PROMPT } from '../origin-prompts.js';

const scene = (sessionGroup = 'a', extra = {}) => ({ sessionGroup, present: true, ready: true,
  runId: `run-${sessionGroup}`, runtime: 'claude', sessionId: 'session-1', createdAt: 0,
  processRunning: true, state: 'idle', idleSince: 0, runDir: '/isolated/run',
  launchConfig: { runtime: 'claude', mode: 'default' }, ...extra });
function fixture(Class = SupervisorLifecycle) {
  const f = { now: 2_000_000, scenes: [scene()], fences: new Map(), requests: [], controls: [], events: [], stops: [], forgotten: [],
    conversations: 0, runningControls: 0, withoutDeadline: 0, lastActivity: 0, unsummarized: 0,
    transition: null, pending: [], marker: { held: false, stale: false }, markerReads: [],
    backlog: { total: 0, groups: [] }, expected: { runtime: 'claude', mode: 'default' },
    context: { configuration: { mode: 'multi', capacity: 1 } } };
  const configuration = f.context.configuration;
  Object.defineProperty(f, 'context', { get: () => ({ configuration, transition: f.transition,
    scenes: f.scenes.map(s => ({ ...s })), fences: [...f.fences].map(([sessionGroup, value]) => ({ sessionGroup, ...value })), restartRequests: [...f.requests] }) });
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
    observeGroup: group => f.scenes.find(s => s.sessionGroup === group || group === null && s.sessionGroup === 'origin') ?? { present: false },
    stop: s => { f.stops.push(s.runId); f.scenes = f.scenes.filter(x => x.runId !== s.runId); },
    intentionalStop: (group, runId) => { f.forgotten.push([group, runId]); },
    readSyncMarker: args => { f.markerReads.push(args); return f.marker; },
    groupRunDir: group => `/isolated/${group}`,
    requests: { read: () => f.requests, remove: id => { f.requests = f.requests.filter(r => r.requestId !== id); } },
    bindTarget: s => ({ expectedRunId: s.runId }),
    diagnostic: e => f.events.push(e),
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check', UPGRADE_RESTART_CHECK_PROMPT: 'upgrade check', PRE_RECLAIM_SYNC_PROMPT: 'prepare', PRE_RECLAIM_ORIGIN_SYNC_PROMPT: 'prepare origin', GROUP_SYNC_PROMPT: 'group sync', ORIGIN_SYNC_PROMPT: 'origin sync',
      ROTATION_PROMPT: () => 'rotate', CONFIG_RECLAIM_PROMPT: () => 'config', SYNC_BACKLOG_ALERT: reader => `alert:${reader}` },
  };
  f.lifecycle = new Class(f.deps, { now: () => f.now });
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
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context), 'done'); assert.equal(f.markerReads.length, 0); assert.deepEqual(f.forgotten,[['a','run-a']]);
  const g = fixture(), old = g.fence(); g.scenes[0].runId = 'replacement';
  assert.equal(await g.lifecycle.advanceReclaim(old, g.context), 'done'); assert.deepEqual(g.stops, []); assert.deepEqual(g.forgotten,[['a','run-a']]); assert.equal(g.scenes.length, 1);
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
  assert.equal(f.events.some(event => event.event === 'reclaim_cancelled'), false);
  f.db.countGlobalRunningConversations = () => 0;
  assert.equal(await f.lifecycle.advanceReclaim(row, f.context, { unfenced: true, singleAuth: true }), 'done');
  assert.deepEqual(f.forgotten, [[null, 'run-null']]);
  assert.deepEqual(f.markerReads.map(x => x.kind), ['global', 'global']);
});
// final conversation check preserves the reclaim fence.
async function finalRaceAssertion(Class) {
  const f = fixture(Class), row = f.fence('model_config'); let reads = 0;
  f.db.countRunningConversations = () => ++reads > 1 ? 1 : 0;
  await assert.rejects(f.lifecycle.advanceReclaim(row, f.context), { code: 'RECLAIM_INFLIGHT' });
  assert.equal(f.fences.size, 1); assert.deepEqual(f.stops, []);
  assert.equal(f.events.some(event => event.event === 'reclaim_cancelled'), false);
}
test('final conversation recheck', async () => {
  await finalRaceAssertion(SupervisorLifecycle);

});
test('ordinary final in-flight race records cancellation before cleanup and remains safe if diagnostics fail',async()=>{
 for(const reason of ['ttl','evict','upgrade','auth','mode_switch']){
  const f=fixture(),row=f.fence(reason);let reads=0;
  f.db.countRunningConversations=()=>++reads>1?1:0;
  f.deps.diagnostic=event=>{assert.equal(event.event,'reclaim_cancelled');assert.equal(event.reason,'inflight_after_idle');assert.equal(f.fences.has('a'),true);if(reason==='auth')throw new Error('diagnostic failed');f.events.push(event);};
  const reported=[];f.deps.reportError=error=>reported.push(error.message);
  await assert.rejects(f.lifecycle.advanceReclaim(row,f.context),{code:'RECLAIM_INFLIGHT'});
  assert.equal(f.fences.size,0);assert.deepEqual(f.stops,[]);
  assert.equal(f.lifecycle.ttlReset.has('a'),reason==='ttl');
  assert.deepEqual(reported,reason==='auth'?['diagnostic failed']:[]);
 }
});
// reclaim-policy: TTL preparation is cancellable; all real terminal statuses recheck.
test('TTL preparation cancels on new messages or replaced run without fencing', async () => {
  for (const change of ['message', 'replacement']) {
    const f = fixture(); f.unsummarized = 2;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
    assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare']);
    for (const control of f.controls) { assert.equal(control.requireIdle, true); assert.equal(control.appendAckSuffix, true); }
    if (change === 'message') f.lastActivity = f.now + 1; else f.scenes[0].runId = 'new';
    f.settle(); f.now += 10;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
  }
});
test('TTL preparation accepts terminal outcomes only after idle and same-run checks', async () => {
  for (const status of ['done', 'timeout', 'superseded', 'failed', 'cancelled']) {
    const f = fixture(); f.unsummarized = 1;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); f.settle(status);
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.get('a')?.reason, 'ttl');
  }
  const f = fixture(); f.unsummarized = 1;
  await f.lifecycle.checkTtl(f.scenes[0], f.context); f.settle(); f.scenes[0].state = 'busy';
  await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
});
test('completed TTL preparation waits through busy activity and idle confirmation without another Sync', async () => {
  for (const status of ['done', 'timeout', 'superseded', 'failed', 'cancelled']) {
    const f = fixture(); f.unsummarized = 1;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    const preparation = f.lifecycle.ttlPreparation.get('a');
    f.settle(status); f.scenes[0].state = 'busy';
    for (const elapsed of [1, 10_000, 90_000]) {
      f.now = preparation.at + elapsed;
      f.scenes[0].lastActivityAt = f.now;
      await f.lifecycle.checkTtl(f.scenes[0], f.context);
      assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation);
      assert.equal(f.fences.size, 0);
      assert.equal(f.controls.length, 2);
      assert.equal(f.lifecycle.ttlReset.has('a'), false);
    }
    f.scenes[0].state = 'idle'; f.scenes[0].idleSince = f.now;
    f.now += 2999;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation);
    assert.equal(f.fences.size, 0);
    f.now++;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.fences.get('a')?.reason, 'ttl');
    assert.equal(f.fences.get('a')?.runId, preparation.runId);
    assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation);
    assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare']);
    assert.equal(f.lifecycle.ttlReset.has('a'), false);
    assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), 'done');
    assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
  }
});
test('new C4 activity or a replacement run cancels completed TTL preparation while busy', async () => {
  for (const change of ['message', 'replacement']) {
    const f = fixture(); f.unsummarized = 1;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    f.settle(); f.scenes[0].state = 'busy';
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.lifecycle.ttlPreparation.has('a'), true);
    f.now += 10;
    if (change === 'message') f.lastActivity = f.now; else f.scenes[0].runId = 'replacement';
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
    assert.equal(f.fences.size, 0);
    assert.equal(f.controls.length, 2);
    assert.equal(f.lifecycle.ttlReset.has('a'), false);
  }
});
test('completed TTL preparation waits for every held Sync marker to release', async () => {
  for (const group of ['a', 'origin']) {
    for (const heldKind of group === 'origin' ? ['group', 'origin'] : ['group']) {
      const f = fixture(); f.scenes = [scene(group)]; f.unsummarized = 1;
      await f.lifecycle.checkTtl(f.scenes[0], f.context);
      const preparation = f.lifecycle.ttlPreparation.get(group);
      f.settle();
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
test('TTL excludes starting runs; TTL still must be expired at completion', async () => {
  const f = fixture();
  f.scenes = [scene('a', { ready: false })]; await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.controls.length, 0); assert.equal(f.fences.size, 0);
  f.scenes = [scene()]; f.unsummarized = 1; await f.lifecycle.checkTtl(f.scenes[0], f.context);
  f.controls[0].status = 'done'; f.context.configuration.hotTtlSeconds = 3000;
  await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
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
test('subagent events reset TTL and eviction clocks; stopped and expired children allow normal reclaim', async () => {
  for (const active of [true, false]) {
    const f = fixture(); f.context.configuration.hotTtlSeconds = 10; f.context.configuration.evictMinIdleSeconds = 5;
    const update = () => {
      f.scenes[0].lastSubagentActivityAt = f.now;
      f.scenes[0].activeSubagents = active ? [{ agentId: 'child', lastActivityAt: f.now }] : [];
    };
    update(); f.now += 9999;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
    update(); f.now += 4999;
    assert.equal((await f.lifecycle.evictionCandidates(f.scenes, f.context)).length, 0);
    f.now++;
    assert.equal((await f.lifecycle.evictionCandidates(f.scenes, f.context)).length, active ? 0 : 1);
    f.now += 4999;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
    f.now++;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.deepEqual(f.controls.map(control => control.content), ['check']); assert.equal(f.fences.size, 0);
    f.settle();
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.fences.get('a')?.reason, 'ttl');
    assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), 'done');
    assert.deepEqual(f.stops, ['run-a']);
  }
});
test('stopped child permits eviction at the minimum idle boundary before hot TTL expires', async () => {
  const f = fixture();
  f.context.configuration.evictMinIdleSeconds = 5; f.context.configuration.hotTtlSeconds = 30;
  f.scenes[0].activeSubagents = []; f.scenes[0].lastSubagentActivityAt = f.now - 4999;
  assert.equal(await f.lifecycle.beginReclaim(f.scenes[0], 'evict', f.context), false);
  assert.equal(f.fences.size, 0);
  const fence = f.fence('evict');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'cancelled');
  assert.equal(f.fences.size, 0); assert.equal(f.stops.length, 0);
  f.now++;
  assert.equal(f.now - f.scenes[0].lastSubagentActivityAt, 5000);
  assert.equal(await f.lifecycle.beginReclaim(f.scenes[0], 'evict', f.context), true);
  assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), 'done');
  assert.deepEqual(f.stops, ['run-a']); assert.equal(f.fences.size, 0);
});
test('pre-reclaim child activity retains completed preparation until child and main agent are idle', async () => {
  const f = fixture(); f.unsummarized = 1;
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  const preparation = f.lifecycle.ttlPreparation.get('a');
  f.settle();
  for (const elapsed of [1, 90_000]) {
    f.now = preparation.at + elapsed;
    f.scenes[0].lastSubagentActivityAt = f.now;
    f.scenes[0].lastActivityAt = f.now;
    f.scenes[0].activeSubagents = [{ agentId: 'sync-child', lastActivityAt: f.now }];
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation);
    assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 2);
  }
  f.scenes[0].activeSubagents = []; f.scenes[0].lastSubagentActivityAt = ++f.now;
  f.scenes[0].state = 'busy';
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation);
  f.scenes[0].state = 'idle'; f.scenes[0].idleSince = f.now;
  f.now += 2999; await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
  f.now++; await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.fences.get('a')?.reason, 'ttl'); assert.equal(f.controls.length, 2);
  assert.equal(f.lifecycle.ttlReset.has('a'), false);
  assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), 'done');
  assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
  assert.deepEqual(f.stops, ['run-a']);
});
test('preparing Sync child starting after the TTL fence delays stop without resetting preparation', async () => {
  for (const phase of ['sample', 'final']) {
    const f = fixture(); f.unsummarized = 1;
    await f.lifecycle.checkTtl(f.scenes[0], f.context); f.settle();
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    const preparation = f.lifecycle.ttlPreparation.get('a'), fence = f.fences.get('a');
    f.now++;
    const child = { activeSubagents: [{ agentId: 'sync-child', lastActivityAt: f.now }], lastSubagentActivityAt: f.now };
    if (phase === 'sample') Object.assign(f.scenes[0], child);
    else f.deps.observeGroup = () => ({ ...f.scenes[0], ...child });
    assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'waiting_idle');
    assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation); assert.equal(f.fences.get('a'), fence);
    assert.equal(f.lifecycle.ttlReset.has('a'), false); assert.equal(f.stops.length, 0);
    Object.assign(f.scenes[0], { activeSubagents: [], lastSubagentActivityAt: ++f.now });
    f.deps.observeGroup = () => f.scenes[0];
    assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
    assert.equal(f.lifecycle.ttlPreparation.has('a'), false); assert.equal(f.controls.length, 2);
  }
});
test('new C4 or replacement still cancels preparation while its child is active', async () => {
  for (const change of ['message', 'replacement']) {
    const f = fixture(); f.unsummarized = 1;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    f.settle(); f.now++;
    f.scenes[0].activeSubagents = [{ agentId: 'sync-child', lastActivityAt: f.now }];
    f.scenes[0].lastSubagentActivityAt = f.now;
    if (change === 'message') f.lastActivity = f.now; else f.scenes[0].runId = 'replacement';
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.lifecycle.ttlPreparation.has('a'), false); assert.equal(f.fences.size, 0);
    assert.equal(f.controls.length, 2);
  }
});
test('fresh subagent observations guard fence creation and final TTL or eviction stop only', async () => {
 for (const active of [true, false]) {
  for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'mode_switch', 'model_config']) {
    const guarded = ['ttl', 'evict'].includes(reason);
    const f = fixture(), original = { ...f.scenes[0] };
    f.scenes[0].activeSubagents = active ? [{ agentId: 'child', lastActivityAt: f.now }] : [];
    f.scenes[0].lastSubagentActivityAt = f.now;
    assert.equal(await f.lifecycle.beginReclaim(original, reason, f.context), !guarded);
    assert.equal(f.fences.size, guarded ? 0 : 1);
    const g = fixture(), fence = g.fence(reason);
    g.deps.observeGroup = () => ({ ...g.scenes[0], activeSubagents: active ? [{ agentId: 'child', lastActivityAt: g.now }] : [], lastSubagentActivityAt: g.now });
    assert.equal(await g.lifecycle.advanceReclaim(fence, g.context), guarded ? 'cancelled' : 'done');
    assert.equal(g.stops.length, guarded ? 0 : 1);
    const finalCancellations = g.events.filter(event => event.event === 'reclaim_cancelled');
    assert.equal(finalCancellations.length, guarded ? 1 : 0);
    if (guarded) assert.deepEqual(finalCancellations[0], { event: 'reclaim_cancelled', session_group: 'a', run_id: 'run-a', reason: 'subagent_activity' });
    assert.equal(g.lifecycle.ttlReset.has('a'), reason === 'ttl');
    const h = fixture(), row = h.fence(reason);
    h.scenes[0].activeSubagents = active ? [{ agentId: 'child', lastActivityAt: h.now }] : [];
    h.scenes[0].lastSubagentActivityAt = h.now;
    assert.equal(await h.lifecycle.advanceReclaim(row, h.context), guarded ? 'cancelled' : 'done');
    assert.equal(h.stops.length, guarded ? 0 : 1);
    const sampledCancellations = h.events.filter(event => event.event === 'reclaim_cancelled');
    assert.equal(sampledCancellations.length, guarded ? 1 : 0);
    if (guarded) assert.deepEqual(sampledCancellations[0], { event: 'reclaim_cancelled', session_group: 'a', run_id: 'run-a', reason: 'subagent_activity' });
    assert.equal(h.lifecycle.ttlReset.has('a'), reason === 'ttl');
  }
 }
});

// Boundary: actual activity/status projection, C4 SQLite and require_idle delivery;
// transport is injected, with no real tmux, runtime, PM2 or network. Run when child
// aggregation/reclaim guards change; unrelated UI changes may skip. Official runner
// isolates HOME/ZYLOS_DIR/PM2_HOME/TMPDIR; t.after closes all owned resources.
test('require_idle control delivers from unchanged main idle state while a background child blocks reclaim', async t => {
  const f = fixture(), c4 = c4Fixture(t, { now: () => f.now });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'child-idle-delivery-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const activity = new SessionActivity({ runDir: root, runId: 'run-a', sessionId: 'session-1', runtime: 'claude' });
  t.after(() => activity.close());
  const baseline = activity.read(f.now - 5000);
  activity.consume([{ run_id: 'run-a', session_id: 'session-1', runtime: 'claude', event: 'subagent_start', agent_id: 'child', ts: f.now - 1 }]);
  const sample = activity.read(f.now);
  for (const field of ['state', 'idleSince', 'lastActivityAt']) assert.equal(sample[field], baseline[field]);
  assert.deepEqual(sample.tools, baseline.tools); assert.equal(sample.activeSubagents.length, 1);
  Object.assign(f.scenes[0], sample);
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 0);
  assert.equal((await f.lifecycle.evictionCandidates(f.scenes, f.context)).length, 0);
  const status = publishSessionStatus({ statusFile: path.join(root, 'status.json'), scene: f.scenes[0], activity: sample, health: { health: 'ok' }, now: f.now });
  const target = { ready: true, runtime: 'claude', runId: 'run-a', serverGeneration: '1:1', sessionId: '$1', paneId: '%1' };
  const control = c4.store.insertControl('idle fixture', { sessionGroup: 'a', requireIdle: true, appendAckSuffix: true,
    ackDeadlineAt: Math.floor(f.now / 1000) + 300,
    targetBinding: { expectedRunId: 'run-a', tmuxTarget: { serverGeneration: '1:1', sessionId: '$1', paneId: '%1' } } });
  assert.equal(c4.store.claimControl(control.id), true);
  let sends = 0;
  const delivery = createDelivery({ db: c4.store, getSessionMode: () => 'multi', now: () => f.now, sleep: async () => {},
    openTmuxConnection: async () => ({ close() {}, command: async args => args.at(-1) === '#{cursor_x}' ? '2' : '0' }),
    resolveSessionTarget: async () => target, revalidateSessionTarget: async () => {},
    readSessionState: async () => ({ identity: target, status: { valid: true, value: status } }), readRuntimeHealth: () => ({ health: 'ok' }),
    getSessionAdapter: () => ({ sendText: async () => { sends++; }, sendKeys: async () => {}, captureScreen: async () => '❯ ' }),
  }, { periodicEnabled: false, captureEnabled: false });
  t.after(() => delivery.stop());
  const result = await delivery.deliverControl(c4.db.prepare('SELECT * FROM control_queue WHERE id=?').get(control.id));
  assert.equal(result.delivered, true); assert.equal(sends, 1);
  assert.equal(c4.db.prepare('SELECT status FROM control_queue WHERE id=?').pluck().get(control.id), 'running');
});
test('Origin idle TTL without backlog writes only the check control, then fences and reclaims; single has no TTL', async () => {
  const f = fixture(); f.scenes = [scene('origin')];
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.deepEqual(f.controls.map(control => control.content), ['check']); assert.equal(f.fences.size, 0);
  assert.equal(f.controls[0].sessionGroup, 'origin'); assert.equal(f.controls[0].targetBinding.expectedRunId, 'run-origin');
  f.settle();
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  const fence = f.fences.get('origin');
  assert.equal(fence.reason, 'ttl'); assert.equal(fence.runId, 'run-origin');
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
  assert.deepEqual(f.stops, ['run-origin']); assert.equal(f.controls.length, 1); assert.equal(f.fences.size, 0);
  const single = fixture(); single.context.configuration.mode = 'single'; single.scenes = [scene(null)];
  await single.lifecycle.checkTtl(single.scenes[0], single.context);
  assert.equal(await single.lifecycle.beginReclaim(single.scenes[0], 'ttl', single.context), false);
  assert.equal(single.controls.length, 0); assert.equal(single.fences.size, 0);
});
test('Origin TTL waits every preparation control and binds both Sync kinds to the same run', async () => {
  for (const summarized of [0, 2]) {
    const f = fixture(); f.scenes = [scene('origin')]; f.unsummarized = summarized;
    f.backlog = { total: 1, groups: [{ count: 1, pendingCheckpoints: 0 }] };
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.deepEqual(f.controls.map(control => control.content), summarized ? ['check', 'prepare', 'prepare origin'] : ['check', 'prepare origin']);
    for (const control of f.controls) {
      assert.equal(control.targetBinding.expectedRunId, 'run-origin');
      assert.equal(control.sessionGroup, 'origin'); assert.equal(control.requireIdle, true);
      assert.equal(control.appendAckSuffix, true); assert.equal(control.ackDeadlineAt, Math.floor((f.now + 300000) / 1000));
    }
    await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
    for (const control of f.controls.slice(0, -1)) {
      control.status = 'done';
      await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0);
    }
    f.controls.at(-1).status = 'timeout';
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.fences.get('origin')?.reason, 'ttl');
  }
});
test('Origin pending checkpoints alone require pre-reclaim Origin Sync', async () => {
  const f = fixture(); f.scenes = [scene('origin')];
  f.backlog = { total: 0, groups: [{ count: 0, pendingCheckpoints: 1 }] };
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare origin']); assert.equal(f.fences.size, 0);
});
test('partial Origin TTL preparation retries remaining Sync after all saved controls terminate', async () => {
  const f = fixture(); f.scenes = [scene('origin')]; f.unsummarized = 1;
  f.backlog = { total: 1, groups: [{ count: 1 }] };
  let binds = 0;
  f.deps.bindTarget = current => {
    if (++binds === 3) throw Object.assign(new Error('not ready'), { code: 'TARGET_NOT_READY' });
    return { expectedRunId: current.runId };
  };
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare']);
  assert.equal(f.lifecycle.ttlPreparation.get('origin').partial, true);
  await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.size, 0); assert.equal(binds, 3);
  f.settle(); f.unsummarized = 0;
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.fences.size, 0); assert.equal(f.lifecycle.ttlPreparation.has('origin'), false);
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare', 'check', 'prepare origin']);
  assert.equal(f.lifecycle.ttlPreparation.get('origin').partial, false);
  f.settle();
  await f.lifecycle.checkTtl(f.scenes[0], f.context); assert.equal(f.fences.get('origin')?.reason, 'ttl');
});
test('pre-reclaim database failure leaves preparation unsaved and retries from current backlog', async () => {
  const f = fixture(); f.scenes = [scene('origin')]; f.unsummarized = 1;
  f.backlog = { total: 1, groups: [{ count: 1 }] };
  const insert = f.db.insertControl;
  f.db.insertControl = (content, options) => { if (content === 'prepare origin') throw new Error('database unavailable'); return insert(content, options); };
  await assert.rejects(f.lifecycle.checkTtl(f.scenes[0], f.context), /database unavailable/);
  assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare']);
  assert.equal(f.lifecycle.ttlPreparation.has('origin'), false); assert.equal(f.fences.size, 0);
});
test('Origin Sync ownership delays TTL while outgoing activity or replacement cancels preparation', async () => {
  for (const change of ['marker', 'outbound', 'replacement']) {
    const f = fixture(); f.scenes = [scene('origin')]; f.backlog = { total: 1, groups: [{ count: 1 }] };
    await f.lifecycle.checkTtl(f.scenes[0], f.context); f.controls[0].status = 'done';
    if (change === 'marker') f.deps.readSyncMarker = ({ kind }) => ({ held: kind === 'origin', stale: false });
    if (change === 'outbound') { f.now++; f.lastActivity = f.now; }
    if (change === 'replacement') f.scenes[0].runId = 'replacement';
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.fences.size, 0); assert.equal(f.lifecycle.ttlPreparation.has('origin'), change === 'marker'); assert.deepEqual(f.stops, []);
  }
});
test('Origin never participates in eviction candidates or in-flight capacity discount', async () => {
  const f = fixture(); f.scenes = [scene('origin')]; f.pending = [{ sessionGroup: 'waiting' }];
  assert.equal(await f.lifecycle.beginReclaim(f.scenes[0], 'evict', f.context), false);
  const counts = evictionDemand([], f.pending, [{ sessionGroup: 'origin', reason: 'ttl' }], 1);
  assert.deepEqual(counts, { waiting: 1, free: 1, inflight: 0, need: 0 });
  assert.equal((await f.lifecycle.checkEviction(f.scenes, f.context)).need, 0); assert.equal(f.fences.size, 0);
});
// Session activity protects working idle gaps before preparation; completed
// preparation ignores its own Sync activity. Run for TTL/activity changes;
// unrelated manual restart or health-only changes may skip these cases.
test('recent session activity prevents TTL preparation during an idle tool gap', async () => {
  const f = fixture(); f.unsummarized = 1;
  f.scenes[0].lastActivityAt = f.now - 4000;
  f.scenes[0].idleSince = f.now - 4000;
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.controls.length, 0); assert.equal(f.fences.size, 0);
  assert.equal(f.lifecycle.ttlPreparation.size, 0);
});
test('old C4 and session activity still prepare and reclaim after TTL', async () => {
  const f = fixture(); f.unsummarized = 1;
  f.lastActivity = f.now - 1800001; f.scenes[0].lastActivityAt = f.lastActivity;
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.deepEqual(f.controls.map(control => control.content), ['check', 'prepare']);
  assert.equal(f.fences.size, 0);
  f.settle();
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.fences.get('a')?.reason, 'ttl');
});
test('missing or non-finite session activity preserves existing TTL eligibility', async () => {
  for (const value of [undefined, null, NaN, Infinity, -Infinity, '1999999', {}]) {
    const f = fixture();
    if (value !== undefined) f.scenes[0].lastActivityAt = value;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.deepEqual(f.controls.map(control => control.content), ['check']); assert.equal(f.fences.size, 0);
    f.settle();
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.fences.get('a')?.reason, 'ttl');
  }
});
test('pre-reclaim Sync activity retains preparation and reclaims the same idle run', async () => {
  for (const offset of [0, 5000]) {
    const f = fixture(); f.unsummarized = 1;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    const preparation = f.lifecycle.ttlPreparation.get('a');
    f.now += 10000;
    f.scenes[0].lastActivityAt = preparation.at + offset;
    f.scenes[0].idleSince = f.now - 4000;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation);
    assert.equal(f.controls.length, 2); assert.equal(f.fences.size, 0);
    f.settle();
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.fences.get('a')?.reason, 'ttl');
    assert.equal(f.fences.get('a')?.runId, 'run-a');
    assert.equal(f.lifecycle.ttlPreparation.get('a'), preparation);
    assert.equal(f.controls.length, 2);
    assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), 'done');
    assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
  }
});
test('new C4 activity still cancels preparation after pre-reclaim Sync activity', async () => {
  const f = fixture(); f.unsummarized = 1;
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  const preparation = f.lifecycle.ttlPreparation.get('a');
  f.now += 10000; f.scenes[0].lastActivityAt = preparation.at + 5000;
  f.lastActivity = preparation.at + 6000; f.settle();
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
  assert.equal(f.fences.size, 0);
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 2);
});
// Capacity pressure must use the shared activity clock, not a momentary idle
// sample. Run for eviction/config/activity changes; unrelated Sync changes may
// skip. These fixtures call the real lifecycle without spawning a live adapter.
test('capacity eviction skips a recent idle session and selects an older one', async () => {
  const f = fixture(); f.context.configuration.capacity = 2;
  f.scenes = [scene('recent', { lastActivityAt: f.now - 4000 }),
    scene('older', { lastActivityAt: f.now - 300001 })];
  f.pending = [{ sessionGroup: 'waiting' }];
  const first = await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(first.selected, 0); assert.equal(first.preparing, 1); assert.equal(f.fences.size, 0);
  assert.deepEqual(f.controls.map(control => [control.sessionGroup, control.content]), [['older', 'check']]);
  f.settle();
  const result = await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(result.selected, 1); assert.deepEqual([...f.fences.keys()], ['older']);
  assert.equal(f.fences.get('older').reason, 'evict'); assert.equal(f.controls.length, 1);
});
test('capacity eviction leaves new groups queued when every idle session is recent', async () => {
  const f = fixture(); f.context.configuration.capacity = 2;
  f.scenes = [scene('a', { lastActivityAt: f.now - 4000 }), scene('b', { lastActivityAt: f.now - 5000 })];
  f.pending = [{ sessionGroup: 'waiting' }];
  const result = await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(result.need, 1); assert.equal(result.selected, 0);
  assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 0); assert.equal(f.stops.length, 0);
});
test('capacity eviction still counts recent session activity during TTL preparation', async () => {
  const f = fixture(); f.scenes[0].lastActivityAt = f.now - 4000;
  f.lifecycle.ttlPreparation.set('a', { runId: 'run-a', at: f.now - 5000, controlIds: [1], partial: false });
  f.pending = [{ sessionGroup: 'waiting' }];
  const result = await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(result.selected, 0); assert.equal(f.fences.size, 0);
});
test('capacity eviction honors the default and configured minimum idle boundary', async () => {
  for (const seconds of [undefined, 10]) {
    for (const offset of [-1, 0, 1]) {
      const f = fixture();
      if (seconds !== undefined) f.context.configuration.evictMinIdleSeconds = seconds;
      f.scenes[0].lastActivityAt = f.now - ((seconds ?? 300) * 1000 + offset);
      f.pending = [{ sessionGroup: 'waiting' }];
      const first = await f.lifecycle.checkEviction(f.scenes, f.context);
      assert.equal(first.preparing, offset < 0 ? 0 : 1); assert.equal(f.fences.size, 0);
      f.settle();
      const result = await f.lifecycle.checkEviction(f.scenes, f.context);
      assert.equal(result.selected, offset < 0 ? 0 : 1);
      assert.equal(f.fences.size, offset < 0 ? 0 : 1);
    }
  }
});
test('all shared activity sources protect recent sessions from capacity eviction', async () => {
  for (const source of ['c4', 'created', 'reset', 'session']) {
    const f = fixture(), recent = f.now - 4000;
    if (source === 'c4') f.lastActivity = recent;
    if (source === 'created') f.scenes[0].createdAt = recent;
    if (source === 'reset') f.lifecycle.ttlReset.set('a', { runId: 'run-a', at: recent });
    if (source === 'session') f.scenes[0].lastActivityAt = recent;
    f.pending = [{ sessionGroup: 'waiting' }];
    const result = await f.lifecycle.checkEviction(f.scenes, f.context);
    assert.equal(result.selected, 0); assert.equal(f.fences.size, 0);
  }
});
test('capacity LRU includes session activity among otherwise eligible sessions', async () => {
  const f = fixture(); f.context.configuration.capacity = 2;
  f.scenes = [scene('a', { lastActivityAt: f.now - 400000 }), scene('b', { lastActivityAt: f.now - 500000 })];
  f.pending = [{ sessionGroup: 'waiting' }];
  await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.deepEqual(f.controls.map(control => control.sessionGroup), ['b']); f.settle();
  const result = await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(result.selected, 1); assert.deepEqual([...f.fences.keys()], ['b']);
});
test('LRU uses occupied slots and discounts only quota-releasing fences', async () => {
  const scenes = [scene('a'), scene('b', { ready: false }), scene('origin')];
  const pending = [{ sessionGroup: 'new' }, { sessionGroup: 'new' }, { sessionGroup: 'a' }];
  assert.deepEqual(evictionDemand(scenes.filter(s => s.sessionGroup !== 'origin').map(s => ({ sessionGroup: s.sessionGroup })), pending, [{ sessionGroup: 'a', reason: 'model_config' }], 2), { waiting: 1, free: 0, inflight: 0, need: 1 });
  const f = fixture(); f.scenes = scenes; f.context.configuration.capacity = 2; f.pending = pending;
  f.requests = [{ reason: 'manual_restart' }]; // Origin-only manual work cannot suspend ordinary pool eviction.
  await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.deepEqual(f.controls.map(control => control.sessionGroup), ['a']); f.settle();
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
  f.db.listRunEndings = () => [{ sessionGroup: 'a', endedAt: 1000 }];
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
test('absent Origin Sync is unbound and obeys its minimum interval', async () => {
  const f = fixture(); f.scenes = [];
  f.backlog = { total: 51, groups: [{ count: 51, firstAt: f.now - 1 }] };
  f.deps.observeGroup = () => { throw new Error('Origin Sync must not require a live scene'); };
  await f.lifecycle.checkSync(f.scenes, f.context);
  assert.deepEqual(f.markerReads, [{ runDir: '/isolated/origin', kind: 'origin', currentRunId: null }]);
  assert.deepEqual(f.controls.map(({ content, sessionGroup, priority, appendAckSuffix, targetBinding }) =>
    ({ content, sessionGroup, priority, appendAckSuffix, targetBinding })), [
    { content: 'origin sync', sessionGroup: 'origin', priority: 2, appendAckSuffix: false, targetBinding: undefined },
  ]);
  f.now += 599999; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 1);
  f.now += 60001; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 2);
});
test('Origin Sync gates skip backlog reads and recheck before writing', async () => {
  for (const gate of ['origin', '*', 'transition', 'manual']) {
    const f = fixture(); f.scenes = [];
    if (gate === 'transition') f.transition = { phase: 'cutover' };
    else if (gate === 'manual') f.requests = [{ reason: 'manual_restart' }];
    else f.fence('ttl', gate);
    f.db.getOriginSyncBacklog = () => { throw new Error('fenced Origin must not read backlog'); };
    await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 0);
  }
  const f = fixture(); f.scenes = []; f.backlog = { total: 51, groups: [] };
  f.deps.readSyncMarker = () => { f.fence('ttl', 'origin'); return { held: false, stale: false }; };
  await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 0);
});
test('Origin Sync blocks current ownership and accepts a stale marker', async () => {
  const f = fixture(); f.scenes = [scene('origin')];
  f.backlog = { total: 51, groups: [{ count: 51, firstAt: f.now - 1 }] };
  f.marker = { held: true, stale: false };
  await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls.length, 0);
  assert.deepEqual(f.markerReads, [{ runDir: '/isolated/origin', kind: 'origin', currentRunId: 'run-origin' }]);
  f.now += 60000; f.marker.stale = true;
  await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(f.controls[0].content, 'origin sync');
});
test('absent Origin lag alert is unbound and repeats only after six hours', async () => {
  const f = fixture(); f.scenes = []; f.now = 50_000_000;
  f.backlog = { total: 1, groups: [{ count: 1, firstAt: 1 }] };
  const alerts = () => f.controls.filter(control => control.content === 'alert:origin');
  await f.lifecycle.checkSync(f.scenes, f.context);
  assert.equal(alerts().length, 1); assert.equal(alerts()[0].sessionGroup, 'origin');
  assert.equal(alerts()[0].targetBinding, undefined); assert.equal(alerts()[0].appendAckSuffix, false);
  f.now += 21_599_999; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(alerts().length, 1);
  f.now += 60000; await f.lifecycle.checkSync(f.scenes, f.context); assert.equal(alerts().length, 2);
});
test('only present ready group readers produce their Sync and backlog alert', async () => {
  for (const absent of [{ present: false }, { ready: false }]) {
    const f = fixture(); f.now = 50_000_000; f.unsummarized = 801; f.scenes = [scene('a', absent)];
    f.db.getOriginSyncBacklog = () => ({ total: 0, groups: [] });
    const read = f.db.getUnsummarizedRange;
    f.db.getUnsummarizedRange = () => { throw new Error('absent reader must not be queried'); };
    await f.lifecycle.checkSync(f.scenes, f.context); assert.deepEqual(f.controls, []);
    f.db.getUnsummarizedRange = read; f.scenes = [scene('a')]; f.now += 60000;
    await f.lifecycle.checkSync(f.scenes, f.context);
    const alert = f.controls.find(control => control.content === 'alert:a');
    assert.equal(alert.sessionGroup, 'origin'); assert.equal(alert.targetBinding, undefined);
    assert.ok(f.controls.some(control => control.content === 'group sync' && control.sessionGroup === 'a'));
    f.now += 600000; await f.lifecycle.checkSync(f.scenes, f.context);
    assert.equal(f.controls.filter(control => control.content === 'alert:a').length, 1);
  }
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
test('single manual intent blocks both scene aliases before any fence exists', () => {
  const f = fixture(); f.context.configuration.mode = 'single';
  f.requests = [{ reason: 'manual_restart', requestId: 'manual-single', mode: 'single', expectedRunId: 'run-origin' }];
  assert.equal(f.fences.size, 0);
  assert.equal(f.lifecycle.allowed('origin', f.context), false);
  assert.equal(f.lifecycle.allowed(null, f.context), false);
  f.requests = [];
  assert.equal(f.lifecycle.allowed('origin', f.context), true);
  assert.equal(f.lifecycle.allowed(null, f.context), true);
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
test('manual wake failure retains the request and fence, alerts once and retries', async () => {
  const f = fixture(); f.scenes = [scene('origin')];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  const insert = f.db.insertControl;
  f.db.insertControl = () => { throw new Error('wake unavailable'); };
  for (let round = 0; round < 2; round++) {
    await assert.rejects(f.lifecycle.advanceManual(f.context), /wake unavailable/);
    assert.equal(f.fences.get('origin').reason, 'manual_restart'); assert.equal(f.requests.length, 1);
    assert.equal(f.controls.length, 0); assert.equal(f.events.some(event => event.event === 'manual_restart_done'), false);
  }
  assert.equal(f.events.filter(event => event.event === 'manual_restart_blocked').length, 1);
  assert.deepEqual(f.stops, ['run-origin']);
  f.db.insertControl = insert; await f.lifecycle.advanceManual(f.context);
  assert.equal(f.controls[0].content, MANUAL_WAKE_PROMPT); assert.equal(f.requests.length, 0); assert.equal(f.fences.size, 0);
});
test('ordinary manual completion clears its own fence without an Origin wake', async () => {
  const f = fixture(); f.scenes = [scene('a'), scene('origin')];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual-a', mode: 'multi', sessionGroup: 'a', expectedRunId: 'run-a' }];
  f.db.insertControl = () => { throw new Error('ordinary restart must not enqueue an Origin wake'); };
  await f.lifecycle.advanceManual(f.context);
  assert.deepEqual(f.stops, ['run-a']);
  assert.deepEqual(f.scenes.map(row => row.sessionGroup), ['origin']);
  assert.deepEqual(f.endings, [{ sessionGroup: 'a', runId: 'run-a', reason: 'manual_restart',
    clearFence: { expectedReason: 'manual_restart', expectedRunId: 'run-a' } }]);
  assert.deepEqual(f.controls, []); assert.equal(f.fences.size, 0); assert.deepEqual(f.requests, []);
});
test('single manual restart completes with no Origin wake', async () => {
  for (const present of [false, true]) {
    const f = fixture(); f.context.configuration.mode = 'single'; f.scenes = present ? [scene(null)] : [];
    f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'single', expectedRunId: 'run-null' }];
    f.db.insertControl = () => { throw new Error('single restart must not enqueue a wake'); };
    await f.lifecycle.advanceManual(f.context);
    assert.equal(f.requests.length, 0); assert.equal(f.fences.size, 0); assert.deepEqual(f.controls, []);
    assert.deepEqual(f.stops, present ? ['run-null'] : []);
  }
});
test('manual crash after clear removes request without recreating fence or selecting replacement', async () => {
  const f = fixture(); f.scenes = [scene('origin', { runId: 'replacement' })];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'old' }];
  f.db.setDrainFence = () => { throw new Error('must not recreate'); };
  await f.lifecycle.advanceManual(f.context); assert.equal(f.requests.length, 0); assert.deepEqual(f.stops, []); assert.deepEqual(f.forgotten,[['origin','old']]);
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
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.deepEqual(f.controls.map(control => control.content), ['check']); assert.equal(f.fences.size, 0);
  f.settle();
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
  assert.deepEqual(f.forgotten, [['origin', 'run-origin']]);
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


test('rotation binds ordinary, Origin and single prompts to the observed run', async () => {
  for (const [mode, group] of [['multi', 'a'], ['multi', 'origin'], ['single', null]]) {
    const f = fixture();
    f.context.configuration.mode = mode;
    f.scenes = [scene(group, { usagePercent: 90 })];
    await f.lifecycle.checkRotation(f.scenes[0], f.context);
    assert.equal(f.controls.length, 1);
    assert.equal(f.controls[0].sessionGroup, group);
    assert.equal(f.controls[0].targetBinding.expectedRunId, f.scenes[0].runId);
  }
});

test('rejected runtime bindings leave rotation and TTL retryable on the next round', async () => {
  for (const method of ['checkRotation', 'checkTtl']) {
    const f = fixture(), reported = [];
    f.unsummarized = 2; f.scenes[0].usagePercent = 90;
    f.deps.reportError = cause => reported.push(cause.code);
    f.deps.bindTarget = () => { throw Object.assign(new Error('not ready'), { code: 'TARGET_NOT_READY' }); };
    await f.lifecycle.each(f.scenes, s => f.lifecycle[method](s, f.context));
    assert.equal(f.controls.length, 0);
    assert.equal(f.lifecycle.rotationSent.size, 0);
    assert.equal(f.lifecycle.ttlPreparation.size, 0);
    assert.deepEqual(reported, []);
    f.deps.bindTarget = s => ({ expectedRunId: s.runId });
    await f.lifecycle.each(f.scenes, s => f.lifecycle[method](s, f.context));
    assert.equal(f.controls.length, method === 'checkTtl' ? 2 : 1);
    for (const control of f.controls) assert.equal(control.targetBinding.expectedRunId, f.scenes[0].runId);
  }
});

test('binding infrastructure errors reach the lifecycle error reporter without enqueueing', async () => {
  for (const method of ['checkRotation', 'checkTtl']) {
    const f = fixture(), reported = [];
    f.unsummarized = 2; f.scenes[0].usagePercent = 90;
    f.deps.reportError = cause => reported.push(cause.code);
    f.deps.bindTarget = () => { throw Object.assign(new Error('tmux unavailable'), { code: 'TMUX_UNAVAILABLE' }); };
    await f.lifecycle.each(f.scenes, s => f.lifecycle[method](s, f.context));
    assert.equal(f.controls.length, 0);
    assert.deepEqual(reported, ['TMUX_UNAVAILABLE']);
    assert.equal(f.lifecycle.rotationSent.size, 0);
    assert.equal(f.lifecycle.ttlPreparation.size, 0);
  }
});

// Boundary: real lifecycle producer, C4 persistence and delivery identity guard;
// tmux is stubbed. Run for rotation/TTL binding changes; unrelated machine tasks may skip.
test('persisted lifecycle prompts reject replacement runs and never count as Origin demand', async t => {
  for (const producer of ['ttl', 'rotation']) await t.test(producer, async t => {
    const c4 = c4Fixture(t), f = fixture();
    const group = producer === 'ttl' ? 'a' : 'origin';
    f.scenes = [scene(group, { usagePercent: 90 })]; f.unsummarized = 2;
    const tmuxTarget = { serverGeneration: '1:1', sessionId: '$1', paneId: '%1' };
    f.deps.bindTarget = s => ({ expectedRunId: s.runId, tmuxTarget });
    f.db.insertControl = (...args) => c4.store.insertControl(...args);
    f.db.getControlById = id => c4.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id);
    await f.lifecycle[producer === 'ttl' ? 'checkTtl' : 'checkRotation'](f.scenes[0], f.context);
    const row = c4.db.prepare('SELECT * FROM control_queue').get();
    assert.equal(JSON.parse(row.target_binding).expectedRunId, f.scenes[0].runId);
    assert.equal(c4.store.getOriginNeed().controls.count, 0);
    assert.equal(c4.store.claimControl(row.id), true);
    let sends = 0;
    const delivery = createDelivery({
      db: c4.store, getSessionMode: () => 'multi',
      openTmuxConnection: async () => ({ close() {} }),
      resolveSessionTarget: async () => ({ ...tmuxTarget, ready: true, runtime: 'claude', runId: 'replacement' }),
      getSessionAdapter: () => ({ sendText: () => { sends++; } }),
    }, { periodicEnabled: false });
    await delivery.deliverControl(row); await delivery.stop();
    assert.equal(sends, 0);
    const ended = f.db.getControlById(row.id);
    assert.equal(ended.status, 'timeout'); assert.equal(ended.last_error, 'STALE_TARGET');
    if (producer === 'ttl') {
      f.scenes[0] = scene(group, { runId: 'replacement', createdAt: f.now });
      await f.lifecycle.checkTtl(f.scenes[0], f.context);
      assert.equal(f.lifecycle.ttlPreparation.size, 0);
      await f.lifecycle.checkTtl(f.scenes[0], f.context);
      assert.equal(c4.db.prepare('SELECT COUNT(*) FROM control_queue').pluck().get(), 2);
      assert.equal(f.fences.size, 0);
      f.now += 1_800_001;
      await f.lifecycle.checkTtl(f.scenes[0], f.context);
      assert.equal(c4.db.prepare('SELECT COUNT(*) FROM control_queue').pluck().get(), 4);
      assert.equal(f.lifecycle.ttlPreparation.get(group).runId, 'replacement');
    }
  });
});

test('completed fenced reclaims record each reason while cancelled and single paths do not', async () => {
  for (const reason of ['ttl', 'evict', 'upgrade', 'auth', 'mode_switch', 'model_config']) {
    for (const present of [false, true]) {
      const f = fixture(), fence = f.fence(reason); if (!present) f.scenes = [];
      assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
      assert.deepEqual(f.endings, [{ sessionGroup: 'a', runId: 'run-a', reason, clearFence: true }]);
      assert.deepEqual(f.stops, present ? ['run-a'] : []);
    }
    const cancelled = fixture(), row = cancelled.fence(reason); cancelled.scenes[0].state = 'busy';
    await cancelled.lifecycle.advanceReclaim(row, cancelled.context); assert.equal(cancelled.endings, undefined);
  }
  const single = fixture(); single.context.configuration.mode = 'single'; single.scenes = [];
  await single.lifecycle.advanceReclaim({ sessionGroup: null, runId: 'single', reason: 'auth' }, single.context, { unfenced: true });
  assert.equal(single.endings, undefined);
});

test('replacement current-session identity clears only while unreadable or old identity still records', async () => {
  for (const ready of [{ runId: 'replacement' }, { runId: 'run-a' }, null]) {
    const f = fixture(), fence = f.fence('model_config'); f.scenes = [scene('a', { runId: 'replacement' })];
    let reads = 0; f.deps.readCurrentSession = () => { reads++; return ready; };
    await f.lifecycle.advanceReclaim(fence, f.context);
    assert.equal(reads, 1); assert.equal(f.fences.size, 0); assert.deepEqual(f.stops, []);
    assert.equal(f.endings?.length ?? 0, ready?.runId === 'replacement' ? 0 : 1);
  }
});

test('recording failure keeps the fence for two rounds then clears and throttles its fallback alert', async () => {
  const f = fixture(), alerts = []; f.deps.alert = event => alerts.push(event); f.scenes = [];
  f.db.recordRunEnd = () => { throw Object.assign(new Error('record failed'), { code: 'DB_BUSY' }); };
  let fence = f.fence('upgrade');
  const first = f.context;
  await assert.rejects(f.lifecycle.advanceReclaim(fence, first), { code: 'DB_BUSY' });
  await assert.rejects(f.lifecycle.advanceReclaim(fence, first), { code: 'DB_BUSY' });
  assert.equal(f.fences.size, 1, 'duplicate invocation in a round does not advance failure count');
  await assert.rejects(f.lifecycle.advanceReclaim(fence, f.context), { code: 'DB_BUSY' });
  assert.equal(f.fences.size, 1);
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
  await Promise.resolve(); assert.equal(f.fences.size, 0); assert.equal(alerts.length, 1);
  for (let iteration = 0; iteration < 2; iteration++) {
    fence = f.fence('upgrade');
    for (let round = 0; round < 2; round++) await assert.rejects(f.lifecycle.advanceReclaim(fence, f.context), { code: 'DB_BUSY' });
    await f.lifecycle.advanceReclaim(fence, f.context);
    assert.equal(alerts.length, 1);
  }
  f.now += 1800000; fence = f.fence('upgrade');
  for (let round = 0; round < 2; round++) await assert.rejects(f.lifecycle.advanceReclaim(fence, f.context), { code: 'DB_BUSY' });
  await f.lifecycle.advanceReclaim(fence, f.context); await Promise.resolve(); assert.equal(alerts.length, 2);
});

test('manual completion records conditionally and fence mismatch never enters fallback', async () => {
  const f = fixture(); f.scenes = [];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  f.fence('manual_restart', 'origin');
  await f.lifecycle.advanceManual(f.context);
  assert.deepEqual(f.endings, [{ sessionGroup: 'origin', runId: 'run-origin', reason: 'manual_restart', clearFence: { expectedReason: 'manual_restart', expectedRunId: 'run-origin' } }]);
  const g = fixture(); g.scenes = []; const fence = g.fence('manual_restart', 'origin');
  g.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  g.db.recordRunEnd = () => { throw Object.assign(new Error('mismatch'), { code: 'FENCE_MISMATCH' }); };
  g.deps.reportError = () => {};
  for (let round = 0; round < 5; round++) await g.lifecycle.advanceManual(g.context);
  assert.equal(g.fences.get('origin'), fence); assert.equal(g.requests.length, 1); assert.equal(g.lifecycle.runEndFailures.size, 0);
  assert.ok(g.events.some(event => event.event === 'manual_restart_blocked'));
});

test('continuation-only demand does not cause pool eviction', async () => {
  const f = fixture(); f.pending = [];
  f.db.listPendingContinuations = () => [{ sessionGroup: 'waiting', endedAt: 1 }];
  const result = await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(result.waiting, 0); assert.equal(result.need, 0); assert.equal(f.fences.size, 0);
});

test('transition and main reclaim passes count one failed completion per supervisor round', async () => {
  const f = fixture(), fence = f.fence('upgrade'); f.scenes = [];
  f.db.recordRunEnd = () => { throw Object.assign(new Error('record failed'), { code: 'DB_BUSY' }); };
  for (let round = 1; round <= 2; round++) {
    f.lifecycle.beginRound();
    await assert.rejects(f.lifecycle.advanceReclaim(fence, f.context), { code: 'DB_BUSY' });
    await assert.rejects(f.lifecycle.advanceReclaim(fence, f.context), { code: 'DB_BUSY' });
    assert.equal(f.lifecycle.runEndFailures.values().next().value.count, round);
    assert.equal(f.fences.size, 1);
  }
  f.lifecycle.beginRound();
  assert.equal(await f.lifecycle.advanceReclaim(fence, f.context), 'done');
  assert.equal(f.fences.size, 0);
});


test('manual recording fallback preserves conditional fence deletion after three failed rounds', async () => {
  const f = fixture(), alerts = [], cleared = [];
  f.scenes = [];
  f.requests = [{ reason: 'manual_restart', requestId: 'manual', mode: 'multi', expectedRunId: 'run-origin' }];
  f.fence('manual_restart', 'origin');
  f.db.recordRunEnd = () => { throw Object.assign(new Error('cannot record'), { code: 'DB_BUSY' }); };
  const clear = f.db.clearDrainFence;
  f.db.clearDrainFence = (group, condition) => { cleared.push({ group, condition }); return clear(group); };
  f.deps.alert = event => alerts.push(event);
  for (let round = 0; round < 2; round++) {
    f.lifecycle.beginRound(); await assert.rejects(f.lifecycle.advanceManual(f.context), { code: 'DB_BUSY' });
    assert.equal(f.fences.size, 1); assert.equal(f.requests.length, 1);
  }
  f.lifecycle.beginRound(); await f.lifecycle.advanceManual(f.context); await Promise.resolve();
  assert.deepEqual(cleared, [{ group: 'origin', condition: { expectedReason: 'manual_restart', expectedRunId: 'run-origin' } }]);
  assert.equal(f.fences.size, 0); assert.equal(f.requests.length, 0);
  assert.equal(alerts.filter(event => event.event === 'run_ending_record_failed').length, 1);
});

test('negative free occupancy evicts the required idle runs without changing held rows', async () => {
  const f=fixture(); f.context.configuration.capacity=3;
  f.scenes=[scene('a'),scene('b')]; f.pending=[{sessionGroup:'new'}];
  f.slots=[{sessionGroup:'a',state:'running'},{sessionGroup:'b',state:'running'},
    {sessionGroup:'held',state:'held'},{sessionGroup:'starting',state:'running'}];
  const first=await f.lifecycle.checkEviction(f.scenes,f.context);
  assert.deepEqual(first,{waiting:1,free:-1,inflight:0,need:2,selected:0,preparing:2});
  assert.deepEqual(f.controls.map(control=>control.sessionGroup),['a','b']); f.settle();
  const result=await f.lifecycle.checkEviction(f.scenes,f.context);
  assert.deepEqual(result,{waiting:1,free:-1,inflight:0,need:2,selected:2,preparing:0});
  assert.deepEqual([...f.fences.keys()],['a','b']);
  assert.equal(f.slots.find(row=>row.sessionGroup==='held').state,'held');
});

test('two concurrent model windows rotate independently and a setting change affects only its model', async () => {
  const f = fixture();
  const small = scene('small', { model: 'sonnet', contextWindow: 200000, usagePercent: 60 });
  const large = scene('large', { model: 'opus[1m]', contextWindow: 1000000, usagePercent: 45 });
  f.scenes = [small, large];
  f.context.configuration.rotationPolicy = { model_rotation_thresholds: { claude: { sonnet: 70, 'opus[1m]': 40 } } };
  f.context.configuration.defaultModels = { claude: 'haiku' };
  for (const item of f.scenes) await f.lifecycle.checkRotation(item, f.context);
  assert.deepEqual(f.controls.map(row => row.sessionGroup), ['large']);
  f.context.configuration.rotationPolicy.model_rotation_thresholds.claude.sonnet = 55;
  for (const item of f.scenes) await f.lifecycle.checkRotation(item, f.context);
  assert.deepEqual(f.controls.map(row => row.sessionGroup), ['large', 'small']);
});

test('early sync follows the same actual model threshold after instance defaults change', async () => {
  const f=fixture();
  f.context.configuration.rotationPolicy={model_rotation_thresholds:{claude:{sonnet:70,'opus[1m]':40}}};
  f.context.configuration.defaultModels={claude:'haiku'};
  const small=scene('small',{model:'sonnet',contextWindow:200000,usagePercent:40});
  const large=scene('large',{model:'claude-opus-4-6',contextWindow:1000000,usagePercent:40});
  f.scenes=[small,large];
  const range={count:1,firstAt:f.now,firstConversationId:1,nonempty:true};
  for(const item of [small,large]){
    f.lifecycle.syncRuns.set(JSON.stringify(['group',item.sessionGroup]),item.runId);
    await f.lifecycle.syncScope(item,'group',range,f.context);
  }
  assert.deepEqual(f.controls.map(row=>row.sessionGroup),['large']);
});

test('rotation uses an alias threshold only for sessions launched through that alias', async () => {
  const f = fixture();
  f.context.configuration.rotationPolicy = { model_rotation_thresholds: { claude: { 'opus[1m]': 30 } } };
  f.context.configuration.defaultModels = { claude: 'opus[1m]' };
  const alias = scene('alias', { model: 'claude-opus-5-5', contextWindow: 1000000, usagePercent: 35 });
  const fixed = scene('fixed', { model: 'claude-opus-4-6', contextWindow: 1000000, usagePercent: 35,
    launchConfig: { runtime: 'claude', mode: 'override', model: 'claude-opus-4-6[1m]' } });
  f.scenes = [alias, fixed];
  for (const item of f.scenes) await f.lifecycle.checkRotation(item, f.context);
  assert.deepEqual(f.controls.map(row => row.sessionGroup), ['alias']);
});

// Diagnostic-only capacity changes call the real lifecycle with bounded fake
// state. Run for eviction admission/reclaim diagnostics; unrelated runtime
// transport changes may skip. No process, socket, database or live marker opens.
test('capacity demand records unavailable eviction candidates for each waiting group', async () => {
  const f = fixture();
  f.scenes[0].state = 'busy';
  f.pending = [{ sessionGroup: 'waiting' }, { sessionGroup: 'waiting' }];
  const first = await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(first.selected, 0);
  const entry = f.events.find(event => event.event === 'capacity_eviction_checked');
  assert.equal(entry.session_group, 'waiting');
  assert.equal(entry.occupied_slots, 1);
  assert.equal(entry.pool_limit, 1);
  assert.equal(entry.candidate_count, 0);
  assert.equal(entry.no_evictable_candidate, true);
  await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(f.events.filter(event => event.event === 'capacity_eviction_checked').length, 1,
    'unchanged capacity evidence does not repeat every polling round');
  f.scenes[0].state = 'idle';
  await f.lifecycle.checkEviction(f.scenes, f.context);
  const changed = f.events.filter(event => event.event === 'capacity_eviction_checked').at(-1);
  assert.equal(changed.candidate_count, 1);
  assert.equal(changed.no_evictable_candidate, false);
  f.pending = [];
  await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(f.lifecycle.capacityWaitDiagnostics.size, 0);
});

test('reclaim start diagnostics distinguish demand from memory pressure without changing fences', async () => {
  for (const pressure of [false, true]) {
    const f = fixture();
    f.pending = [{ sessionGroup: 'waiting' }];
    let start;
    f.deps.diagnostic = event => {
      f.events.push(event);
      if (event.event === 'reclaim_started') {
        assert.equal(f.fences.get('a')?.reason, 'evict', 'diagnostic follows the confirmed fence write');
        start = event;
      }
    };
    if (pressure) assert.equal(await f.lifecycle.checkCapacityPressure(f.context), null);
    else assert.equal((await f.lifecycle.checkEviction(f.scenes, f.context)).preparing, 1);
    assert.equal(start, undefined, 'no reclaim starts before the check terminates'); f.settle();
    if (pressure) assert.equal((await f.lifecycle.checkCapacityPressure(f.context)).sessionGroup, 'a');
    else assert.equal((await f.lifecycle.checkEviction(f.scenes, f.context)).selected, 1);
    assert.equal(start.session_group, 'a');
    assert.equal(start.run_id, 'run-a');
    assert.equal(start.reason, 'evict');
    assert.equal(start.subreason, pressure ? 'memory_pressure' : 'capacity_demand');
    assert.equal(f.fences.get('a').reason, 'evict');
    assert.equal(f.stops.length, 0, 'start evidence does not imply the run has already stopped');
  }
});

test('eviction diagnostics do not report a reclaim start before a fence is saved', async () => {
  const f = fixture();
  f.pending = [{ sessionGroup: 'waiting' }];
  f.db.setDrainFence = () => {};
  await f.lifecycle.checkEviction(f.scenes, f.context); f.settle();
  assert.equal((await f.lifecycle.checkEviction(f.scenes, f.context)).selected, 0);
  assert.equal(f.events.some(event => event.event === 'reclaim_started'), false);
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

test('an unanswered eviction check stops waiting at its 60 second deadline', async () => {
  assert.equal(EVICTION_CHECK_ACK_TIMEOUT_MS, 60000);
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture(), asked = f.now;
    await evictionRound(f, path); f.controls[0].status = 'running';
    f.now = asked + 59999;
    await evictionRound(f, path);
    assert.equal(f.fences.size, 0, `${path}: still waiting one millisecond before the deadline`);
    f.now = asked + 60000;
    await evictionRound(f, path);
    assert.equal(f.fences.get('a')?.reason, 'evict', path);
    assert.equal(f.controls.length, 1, path);
  }
});

test('an answered eviction check waits for its turn to finish, bounded by the deadline', async () => {
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture(), asked = f.now;
    await evictionRound(f, path);
    f.now = asked + 10000; f.settle(); f.scenes[0].state = 'busy'; f.scenes[0].lastActivityAt = f.now;
    await evictionRound(f, path);
    assert.equal(f.fences.size, 0, path);
    f.now = asked + 20000; f.scenes[0].state = 'idle'; f.scenes[0].idleSince = asked + 12000;
    await evictionRound(f, path);
    assert.equal(f.fences.get('a')?.reason, 'evict', `${path}: the check's own activity is not new activity`);
  }
});

test('new activity during an eviction check abandons that group and another candidate is asked', async () => {
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture(['a', 'b']), asked = f.now;
    const messages = { a: 0, b: 0 };
    f.db.getLastActivity = group => ({ ts: messages[group] });
    await evictionRound(f, path);
    assert.deepEqual(f.controls.map(control => control.sessionGroup), ['a'], path);
    f.now = asked + 5000; messages.a = f.now; f.settle();
    await evictionRound(f, path);
    assert.equal(f.fences.size, 0, `${path}: a C4 message cancels the eviction of that group`);
    assert.deepEqual(f.controls.map(control => control.sessionGroup), ['a', 'b'], path);
    f.settle();
    await evictionRound(f, path);
    assert.deepEqual([...f.fences.keys()], ['b'], path);
  }
});

test('a message arriving before the eviction check is answered abandons that group in the same round', async () => {
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture(['a', 'b']), asked = f.now;
    const messages = { a: 0, b: 0 };
    f.db.getLastActivity = group => ({ ts: messages[group] });
    await evictionRound(f, path);
    const [check] = f.controls;
    assert.equal(check.sessionGroup, 'a', path);
    f.now = asked + 5000; check.status = 'running'; messages.a = f.now;
    await evictionRound(f, path);
    assert.equal(check.status, 'running', `${path}: the check is still unanswered`);
    assert.equal(f.fences.size, 0, path);
    assert.equal(f.lifecycle.evictionPreparation.has('a'), false, `${path}: the slot is not held until the deadline`);
    assert.deepEqual(f.controls.map(control => control.sessionGroup), ['a', 'b'], `${path}: the next candidate is asked`);
  }
});

test('session activity after the eviction check deadline counts as new activity', async () => {
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture(), asked = f.now;
    await evictionRound(f, path);
    f.now = asked + 61000; f.scenes[0].lastActivityAt = asked + 60500;
    await evictionRound(f, path);
    assert.equal(f.fences.size, 0, path);
    assert.equal(f.lifecycle.evictionPreparation.size, 0, path);
  }
});

test('a pending eviction check is sent once and holds the demand while it waits', async () => {
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture(['a', 'b']), asked = f.now;
    for (const elapsed of [0, 1, 20000, 40000, 59999]) {
      f.now = asked + elapsed;
      const result = await evictionRound(f, path);
      if (path === 'capacity_demand') { assert.equal(result.selected, 0); assert.equal(result.preparing, 1); }
      else assert.equal(result, null);
      if (elapsed) f.controls[0].status = 'running';
    }
    assert.deepEqual(f.controls.map(control => control.sessionGroup), ['a'], `${path}: one check, no second group asked`);
    assert.equal(f.fences.size, 0, path);
  }
});

test('an eviction check for a replaced run is dropped and the new run is asked again', async () => {
  for (const path of EVICTION_PATHS) {
    const f = evictionFixture();
    await evictionRound(f, path); f.settle();
    f.scenes[0].runId = 'run-a2';
    await evictionRound(f, path);
    assert.equal(f.fences.size, 0, path);
    assert.deepEqual(f.controls.map(control => control.targetBinding.expectedRunId), ['run-a', 'run-a2'], path);
  }
});

test('the eviction check deadline is injectable and validated separately from the TTL timeout', async () => {
  const f = evictionFixture();
  f.lifecycle = new SupervisorLifecycle(f.deps, { now: () => f.now, evictionAckTimeoutMs: 5000 });
  await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(f.controls[0].ackDeadlineAt, Math.floor((f.now + 5000) / 1000));
  f.now += 5000; f.controls[0].status = 'running';
  await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(f.fences.get('a')?.reason, 'evict');
  for (const evictionAckTimeoutMs of [0, -1, Infinity, NaN]) {
    assert.throws(() => new SupervisorLifecycle(f.deps, { evictionAckTimeoutMs }), TypeError);
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

test('an unanswered upgrade check stops waiting at its 60 second deadline', async () => {
  assert.equal(UPGRADE_CHECK_ACK_TIMEOUT_MS, 60000);
  const f = upgradeFixture(), asked = f.now;
  await f.lifecycle.advanceRestarts(f.context); f.controls[0].status = 'running';
  f.now = asked + 59999;
  await f.lifecycle.advanceRestarts(f.context);
  assert.equal(f.fences.size, 0, 'still waiting one millisecond before the deadline');
  f.now = asked + 60000;
  await f.lifecycle.advanceRestarts(f.context);
  assert.equal(f.fences.get('a')?.reason, 'upgrade');
  assert.equal(f.controls.length, 1);
});

test('new activity during the upgrade check does not cancel the restart', async () => {
  for (const answer of ['done', 'deadline']) {
    const f = upgradeFixture(), asked = f.now;
    await f.lifecycle.advanceRestarts(f.context);
    f.now = asked + 5000; f.lastActivity = f.now; f.scenes[0].lastActivityAt = f.now;
    f.scenes[0].lastSubagentActivityAt = f.now;
    await f.lifecycle.advanceRestarts(f.context);
    assert.equal(f.fences.size, 0, answer);
    if (answer === 'done') f.settle(); else { f.controls[0].status = 'running'; f.now = asked + 60000; }
    await f.lifecycle.advanceRestarts(f.context);
    assert.equal(f.fences.get('a')?.reason, 'upgrade', `${answer}: the upgrade still restarts`);
    assert.equal(f.controls.length, 1, answer);
  }
});

test('each upgrade run is checked once and groups do not wait for each other', async () => {
  const f = upgradeFixture(['a', 'b']), asked = f.now;
  for (const elapsed of [0, 1, 20000]) {
    f.now = asked + elapsed;
    await f.lifecycle.advanceRestarts(f.context);
  }
  assert.deepEqual(f.controls.map(control => control.sessionGroup), ['a', 'b']);
  assert.equal(f.fences.size, 0);
  f.controls[0].status = 'done'; f.controls[1].status = 'running';
  await f.lifecycle.advanceRestarts(f.context);
  assert.deepEqual([...f.fences.keys()], ['a'], 'the answered group restarts while the other still waits');
  // A restart cancelled by a busy session is begun again without a second check.
  f.scenes[0].state = 'busy';
  assert.equal(await f.lifecycle.advanceReclaim({ ...f.fences.get('a') }, f.context), 'cancelled');
  assert.equal(f.fences.size, 0);
  f.scenes[0].state = 'idle';
  await f.lifecycle.advanceRestarts(f.context);
  assert.deepEqual([...f.fences.keys()], ['a']);
  assert.deepEqual(f.controls.map(control => control.sessionGroup), ['a', 'b']);
  f.now = asked + 60000;
  await f.lifecycle.advanceRestarts(f.context);
  assert.deepEqual([...f.fences.keys()].sort(), ['a', 'b']);
  assert.equal(f.controls.length, 2);
});

test('the upgrade check deadline is injectable and validated separately', async () => {
  const f = upgradeFixture();
  f.lifecycle = new SupervisorLifecycle(f.deps, { now: () => f.now, upgradeAckTimeoutMs: 5000 });
  await f.lifecycle.advanceRestarts(f.context);
  assert.equal(f.controls[0].ackDeadlineAt, Math.floor((f.now + 5000) / 1000));
  f.now += 5000; f.controls[0].status = 'running';
  await f.lifecycle.advanceRestarts(f.context);
  assert.equal(f.fences.get('a')?.reason, 'upgrade');
  for (const upgradeAckTimeoutMs of [0, -1, Infinity, NaN]) {
    assert.throws(() => new SupervisorLifecycle(f.deps, { upgradeAckTimeoutMs }), TypeError);
  }
});

test('configuration restart still sends one control with the check and the five minute deadline', async () => {
  const f = fixture(); f.expected = { runtime: 'claude', mode: 'override', model: 'm', effort: 'high' };
  f.deps.prompts = { ...f.deps.prompts, CONFIG_RECLAIM_PROMPT };
  await f.lifecycle.reconcileConfiguration(f.context);
  assert.equal(f.controls.length, 1);
  const [control] = f.controls;
  assert.equal(control.content, CONFIG_RECLAIM_PROMPT);
  assert.match(control.content, /it will be interrupted by this restart[\s\S]*Create a wake-up only for a step of your own ongoing task[\s\S]*submit ready_for_config_reclaim/);
  assert.equal(control.ackDeadlineAt, Math.floor((f.now + 300000) / 1000));
  assert.equal(control.appendAckSuffix, true); assert.equal(control.priority, 1); assert.equal(control.bypassState, true);
  assert.equal(f.fences.size, 0);
  await f.lifecycle.reconcileConfiguration(f.context);
  assert.equal(f.controls.length, 1, 'no second control within the cooldown');
});

const deferRequest = (extra = {}) => ({ sessionGroup: 'a', expectedRunId: 'run-a', reason: 'background command', ...extra });

async function acceptTtlDeferral(f, reason = 'background command', expectedRunId = f.scenes[0].runId) {
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.lifecycle.ttlPreparation.has('a'), true);
  assert.deepEqual(await f.lifecycle.deferReclaim(deferRequest({ reason, expectedRunId }), f.context), { ok: true, result: 'accepted' });
  f.settle();
}

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

test('one accepted deferral cancels simultaneous TTL and eviction preparations', async () => {
  const f = fixture();
  await f.lifecycle.prepareEviction(f.scenes[0], f.context, 'capacity_demand');
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.lifecycle.evictionPreparation.has('a'), true);
  assert.equal(f.lifecycle.ttlPreparation.has('a'), true);
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).ok, true);
  assert.equal(f.lifecycle.evictionPreparation.has('a'), false);
  assert.equal(f.lifecycle.ttlPreparation.has('a'), false);
  f.settle(); await f.lifecycle.checkTtl(f.scenes[0], f.context);
  await f.lifecycle.prepareEviction(f.scenes[0], f.context, 'capacity_demand');
  assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 2);
});

test('deferral idle reset changes eviction order and enforces the 300 second minimum', async () => {
  const f = fixture(); f.scenes.push(scene('b')); f.context.configuration.capacity = 2;
  assert.deepEqual((await f.lifecycle.evictionCandidates(f.scenes, f.context)).map(s => s.sessionGroup), ['a', 'b']);
  await f.lifecycle.prepareEviction(f.scenes[0], f.context, 'capacity_demand');
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).ok, true);
  assert.equal(f.lifecycle.evictionPreparation.has('a'), false);
  f.now += 299999;
  assert.deepEqual((await f.lifecycle.evictionCandidates(f.scenes, f.context)).map(s => s.sessionGroup), ['b']);
  f.now += 1;
  assert.deepEqual((await f.lifecycle.evictionCandidates(f.scenes, f.context)).map(s => s.sessionGroup), ['b', 'a']);
  f.pending = [{ sessionGroup: 'c' }];
  await f.lifecycle.checkEviction(f.scenes, f.context);
  assert.equal(f.lifecycle.evictionPreparation.has('b'), true);
  assert.equal(f.lifecycle.evictionPreparation.has('a'), false);
});

test('four consecutive deferrals alert once, delivery resets the count, and four more alert again', async () => {
  const f = fixture(), alerts = []; f.deps.alert = event => alerts.push(event);
  for (let i = 1; i <= 5; i++) {
    await acceptTtlDeferral(f, `command ${i}`);
    assert.equal(f.lifecycle.reclaimDeferrals.get('a').count, i);
    assert.equal(alerts.length, i >= 4 ? 1 : 0);
    assert.equal(f.fences.size, 0); assert.equal(f.stops.length, 0);
    f.now += 1800000;
  }
  assert.deepEqual(f.lifecycle.reclaimDeferrals.get('a').reasons, ['command 1', 'command 2', 'command 3', 'command 4']);
  assert.deepEqual(alerts[0].reasons, ['command 1', 'command 2', 'command 3', 'command 4']);
  assert.match(alerts[0].message, /command 1.*command 2.*command 3.*command 4/);
  assert.equal(alerts[0].session_group ?? alerts[0].sessionGroup, 'a');
  await f.lifecycle.messageDelivered({ sessionGroup: 'a', runId: 'run-a' });
  assert.equal(f.lifecycle.reclaimDeferrals.has('a'), false);
  for (let i = 1; i <= 4; i++) {
    await acceptTtlDeferral(f, `new command ${i}`); f.now += 1800000;
  }
  assert.equal(alerts.length, 2);
  assert.deepEqual(alerts[1].reasons, ['new command 1', 'new command 2', 'new command 3', 'new command 4']);
  assert.equal(f.events.filter(event => event.event === 'reclaim_defer_alert').length, 2);
  assert.equal(f.stops.length, 0);
});

test('configured deferral alert threshold alerts on the second accepted request', async () => {
  const f = fixture(), alerts = []; f.deps.alert = event => alerts.push(event);
  f.context.configuration.reclaimDeferAlertCount = 2;
  await acceptTtlDeferral(f, 'first command');
  assert.equal(alerts.length, 0);
  assert.equal(f.events.filter(event => event.event === 'reclaim_defer_alert').length, 0);
  f.now += 1800000;
  await acceptTtlDeferral(f, 'second command');
  assert.equal(alerts.length, 1);
  assert.deepEqual(alerts[0].reasons, ['first command', 'second command']);
  assert.equal(f.events.filter(event => event.event === 'reclaim_defer_alert').length, 1);
});

test('generic activity and stale delivery notifications retain the consecutive deferral history', async () => {
  const f = fixture(); await acceptTtlDeferral(f, 'first');
  f.now += 1000; f.scenes[0].lastActivityAt = f.now; f.lastActivity = f.now;
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  await f.lifecycle.messageDelivered({ sessionGroup: 'a', runId: 'old-run' });
  await f.lifecycle.messageDelivered({ sessionGroup: 'b', runId: 'run-a' });
  assert.equal(f.lifecycle.reclaimDeferrals.get('a').count, 1);
  f.now += 1800000; await acceptTtlDeferral(f, 'second');
  assert.equal(f.lifecycle.reclaimDeferrals.get('a').count, 2);
  assert.deepEqual(f.lifecycle.reclaimDeferrals.get('a').reasons, ['first', 'second']);
});

test('replacement run starts a fresh deferral history and actual reclaim removes it', async () => {
  const f = fixture(); await acceptTtlDeferral(f, 'old run command');
  f.scenes[0].runId = 'replacement-run'; f.scenes[0].createdAt = f.now;
  f.now += 1800000; await acceptTtlDeferral(f, 'new run command', 'replacement-run');
  assert.deepEqual(f.lifecycle.reclaimDeferrals.get('a'), { runId: 'replacement-run', count: 1, reasons: ['new run command'], alerted: false });
  await f.lifecycle.messageDelivered({ sessionGroup: 'a', runId: 'run-a' });
  assert.equal(f.lifecycle.reclaimDeferrals.get('a').count, 1);
  f.now += 1800000;
  await f.lifecycle.checkTtl(f.scenes[0], f.context); f.settle();
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal(f.fences.get('a').reason, 'ttl');
  assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'), f.context), 'done');
  assert.deepEqual(f.stops, ['replacement-run']);
  assert.equal(f.lifecycle.reclaimDeferrals.has('a'), false);
  f.scenes.push(scene('a', { runId: 'next-run', createdAt: f.now }));
  f.now += 1800000;
  await acceptTtlDeferral(f, 'next run command', 'next-run');
  assert.deepEqual(f.lifecycle.reclaimDeferrals.get('a'), { runId: 'next-run', count: 1, reasons: ['next run command'], alerted: false });
});

test('deferral independently checks the preparation run and the live run against the request', async () => {
  for (const [preparedRun, liveRun] of [['run-a', 'run-b'], ['run-b', 'run-a']]) {
    const f = fixture(); f.scenes[0].runId = preparedRun;
    await f.lifecycle.checkTtl(f.scenes[0], f.context);
    assert.equal(f.lifecycle.ttlPreparation.get('a').runId, preparedRun);
    f.scenes[0].runId = liveRun;
    assert.deepEqual(await f.lifecycle.deferReclaim(deferRequest({ expectedRunId: 'run-b' }), f.context),
      { ok: false, result: 'rejected', reason: 'run_changed' }, `${preparedRun} preparation, ${liveRun} live run`);
    assert.equal(f.lifecycle.reclaimDeferrals.has('a'), false);
    assert.equal(f.lifecycle.ttlReset.has('a'), false);
  }
});

test('deferral rejects absent preparation, changed run, started reclaim, expired capacity check and restarts', async () => {
  const f = fixture();
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'no_preparation');
  f.lifecycle.upgradePreparation.set('run-a', { controlId: 1, deadline: f.now + 60000 });
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'no_preparation');
  f.lifecycle.upgradePreparation.clear(); f.lifecycle.configurationSent.set('run-a', f.now);
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'no_preparation');
  f.lifecycle.configurationSent.clear();
  await f.lifecycle.checkTtl(f.scenes[0], f.context);
  assert.equal((await f.lifecycle.deferReclaim(deferRequest({ expectedRunId: 'other' }), f.context)).reason, 'run_changed');
  f.fence(); assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'reclaim_started'); f.fences.clear();
  f.fence('upgrade', '*'); assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'reclaim_started'); f.fences.clear();
  f.requests = [{ reason: 'upgrade', runIds: ['run-a'] }];
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'restart_pending'); f.requests = [];
  f.requests = [{ reason: 'manual_restart', mode: 'multi', sessionGroup: 'a', expectedRunId: 'run-a' }];
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'restart_pending'); f.requests = [];
  f.expected = { runtime: 'codex', mode: 'default' };
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'restart_pending');
  f.expected = f.scenes[0].launchConfig;
  f.transition = { target: 'single' };
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).reason, 'restart_pending'); f.transition = null;
  assert.equal(f.lifecycle.reclaimDeferrals.has('a'), false, 'rejections do not count');
  assert.equal((await f.lifecycle.deferReclaim(deferRequest(), f.context)).ok, true, 'obsolete config notification does not block a matching configuration');
  const g = fixture(); await g.lifecycle.prepareEviction(g.scenes[0], g.context, 'capacity_demand');
  await g.lifecycle.checkTtl(g.scenes[0], g.context);
  g.now += EVICTION_CHECK_ACK_TIMEOUT_MS;
  assert.equal((await g.lifecycle.deferReclaim(deferRequest(), g.context)).reason, 'preparation_expired');
  assert.equal(g.lifecycle.evictionPreparation.has('a'), true);
  assert.equal(g.lifecycle.ttlPreparation.has('a'), true, 'a simultaneous TTL preparation cannot bypass the capacity deadline');
  assert.equal(g.lifecycle.reclaimDeferrals.has('a'), false);
});

test('voluntary intent accepts busy, repeats by run and reclaims only after idle without TTL delay',async()=>{
 for(const group of ['a','origin']){
  const f=fixture();f.scenes=[scene(group,{createdAt:f.now-4000,state:'busy',idleSince:null})];
  assert.equal((await f.lifecycle.requestRelease(f.scenes[0],f.context)).result,'accepted');
  assert.equal((await f.lifecycle.requestRelease(f.scenes[0],f.context)).result,'already_accepted');
  await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);
  Object.assign(f.scenes[0],{state:'idle',idleSince:f.now-3000,lastSubagentActivityAt:f.now-1});
  await f.lifecycle.advanceReleases(f.context);const row=f.fences.get(group);assert.equal(row.reason,'release');
  assert.equal(await f.lifecycle.advanceReclaim(row,f.context),'done');assert.equal(f.endings[0].reason,'release');assert.equal(f.controls.length,0);
 }
});
test('voluntary release keeps intent while active children or the requesting turn remain busy',async()=>{
 const f=fixture();f.scenes[0].activeSubagents=[{lastActivityAt:f.now}];
 assert.equal((await f.lifecycle.requestRelease(f.scenes[0],f.context)).result,'accepted');
 for(let n=0;n<3;n++){await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);assert.equal(f.lifecycle.releasePreparation.size,1);}
 f.scenes[0].activeSubagents=[];await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.get('a').reason,'release');
});
test('release waits bound Sync controls and their tail without another pre-reclaim check',async()=>{
 for(const group of ['a','origin']){
  const f=fixture();f.scenes=[scene(group)];f.unsummarized=1;if(group==='origin')f.backlog={total:0,groups:[{pendingCheckpoints:1}]};
  await f.lifecycle.requestRelease(f.scenes[0],f.context);await f.lifecycle.advanceReleases(f.context);
  assert.deepEqual(f.controls.map(c=>c.content),group==='origin'?['prepare','prepare origin']:['prepare']);
  assert.equal(f.fences.size,0);
  for(const c of f.controls){assert.equal(c.targetBinding.expectedRunId,`run-${group}`);await f.lifecycle.workDelivered({sessionGroup:group,runId:`run-${group}`,pastedAt:f.now+1,controlId:c.id});}
  assert.equal(f.lifecycle.releasePreparation.size,1);
  f.settle();f.scenes[0].state='busy';await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);
  f.scenes[0].state='idle';f.marker={held:true,stale:false};await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);
  f.marker={held:false,stale:false};await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.get(group).reason,'release');
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
test('older delivery, another run and delivery after the fence cannot cancel a registered release',async()=>{
 const f=fixture();await f.lifecycle.requestRelease(f.scenes[0],f.context);
 await f.lifecycle.workDelivered({sessionGroup:'a',runId:'run-a',pastedAt:f.now-1,conversationId:1});
 await f.lifecycle.workDelivered({sessionGroup:'a',runId:'replacement',pastedAt:f.now+1,conversationId:2});
 assert.equal(f.lifecycle.releasePreparation.size,1);await f.lifecycle.advanceReleases(f.context);
 await f.lifecycle.workDelivered({sessionGroup:'a',runId:'run-a',pastedAt:f.now+1,conversationId:3});
 assert.equal(f.fences.get('a').reason,'release');assert.equal(f.events.some(e=>e.event==='reclaim_cancelled'),false);
});
test('supervisor reconstruction discards intent and ordinary TTL remains the fallback',async()=>{
 const f=fixture();await f.lifecycle.requestRelease(f.scenes[0],f.context);
 const reopened=new SupervisorLifecycle(f.deps,{now:()=>f.now});await reopened.advanceReleases(f.context);
 assert.equal(reopened.releasePreparation.size,0);assert.equal(f.fences.size,0);
 await reopened.checkTtl(f.scenes[0],f.context);assert.deepEqual(f.controls.map(c=>c.content),['check']);
});
test('release fence cancels busy or child activity and rechecks idle immediately before stop',async()=>{
 for(const change of [{state:'busy'},{activeSubagents:[{lastActivityAt:2_000_000}]}]){
  const f=fixture();await f.lifecycle.requestRelease(f.scenes[0],f.context);await f.lifecycle.advanceReleases(f.context);
  const row=f.fences.get('a');Object.assign(f.scenes[0],change);assert.equal(await f.lifecycle.advanceReclaim(row,f.context),'cancelled');assert.equal(f.stops.length,0);
 }
 const f=fixture();await f.lifecycle.requestRelease(f.scenes[0],f.context);await f.lifecycle.advanceReleases(f.context);f.deps.observeGroup=()=>({...f.scenes[0],state:'busy'});
 assert.equal(await f.lifecycle.advanceReclaim(f.fences.get('a'),f.context),'cancelled');assert.equal(f.stops.length,0);
});
test('release intent forgets absent and replacement runs without another observed group',async()=>{
 for(const replacement of [false,true]){
  const f=fixture();await f.lifecycle.requestRelease(f.scenes[0],f.context);f.scenes=replacement?[scene('a',{runId:'replacement'})]:[];
  await f.lifecycle.advanceReleases(f.context);assert.equal(f.lifecycle.releasePreparation.size,0);assert.equal(f.events.at(-1).reason,'run_changed');
 }
});

test('a real tracked request tool registers intent and normal post-tool idle completes it',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'release-tool-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const f=fixture(), activity=new SessionActivity({runDir:root,runId:'run-a',sessionId:'session-1',runtime:'claude',startedAt:0});t.after(()=>activity.close());
 const row=(event,ts)=>({run_id:'run-a',session_id:'session-1',runtime:'claude',event,ts,tool_use_id:'release-command',tool:'Bash'});
 activity.consume([row('pre_tool',f.now)]);Object.assign(f.scenes[0],activity.read(f.now));
 assert.equal(f.scenes[0].state,'busy');assert.equal((await f.lifecycle.requestRelease(f.scenes[0],f.context)).result,'accepted');
 await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);
 activity.consume([row('post_tool',f.now+1),row('stop',f.now+2)]);f.now+=3002;Object.assign(f.scenes[0],activity.read(f.now));
 await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.size,0);
 f.now+=3000;Object.assign(f.scenes[0],activity.read(f.now));await f.lifecycle.advanceReleases(f.context);assert.equal(f.fences.get('a').reason,'release');
});
