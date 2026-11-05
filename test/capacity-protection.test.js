import { test, afterEach } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolCapacity, writeCapacityAtomic } from '../skills/activity-monitor/scripts/pool-capacity.js';
import { SupervisorLifecycle } from '../skills/activity-monitor/scripts/supervisor-lifecycle.js';

const MiB = 1024 ** 2, GiB = 1024 ** 3;
const scene = (sessionGroup, extra = {}) => ({ sessionGroup, present: true, ready: true, state: 'idle',
  runId: `run-${sessionGroup}`, sessionId: 's', createdAt: 0, processRunning: true, idleSince: 0,
  runDir: '/fixture/run', ...extra });
const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-protection-'));
  cleanups.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  let now = 1_000_000, fixed = false, memory = { source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 3900 * MiB, oomKills: 0 };
  const notices = [], events = [], fences = new Map();
  const current = { scenes: [scene('young', { createdAt: 500_000 }), scene('old'), scene('origin'), scene('busy', { state: 'busy' })], transition: null };
  const db = { getModeTransition: () => current.transition, listDrainFences: () => [...fences.values()],
    getDrainFence: group => fences.get(group),
    setDrainFence: (group, row) => { if (!fences.has(group)) fences.set(group, { ...row, sessionGroup: group }); },
    getLastActivity: () => 0 };
  const lifecycle = new SupervisorLifecycle({ db, requests: { read: () => [] },
    observeGroup: group => current.scenes.find(s => s.sessionGroup === group) ?? { present: false },
    readSyncMarker: () => ({ held: false, stale: false }) }, { now: () => now });
  const context = () => ({ configuration: { mode: 'multi', capacity: 1, evictMinIdleSeconds: current.evictMinIdleSeconds ?? 300 }, scenes: current.scenes.map(s => ({ ...s })),
    transition: current.transition, fences: [...fences.values()], restartRequests: [] });
  let beforeReclaim;
  const capacity = new PoolCapacity({ directory, readMemory: async () => memory, resolveBaseline: () => ({ k: 1, fixed }),
    notify: id => notices.push(id), log: row => events.push(row),
    reclaim: async record => {
      beforeReclaim?.(record);
      return lifecycle.checkCapacityPressure(record, context());
    }, ...options });
  return { capacity, directory, notices, events, fences, current, lifecycle, context,
    setMemory: value => memory = value, setFixed: value => fixed = value,
    beforeReclaim: fn => beforeReclaim = fn,
    tick: async advance => { now += advance; return capacity.tick({ mode: 'multi', now, scenes: current.scenes }); },
    time: () => now };
}

// Integration boundary for every case below: real controller publication and
// lifecycle candidate/fence paths, with private fixture files and in-memory DB.
// Run for protection, modes, failure timing, or shared eviction eligibility;
// skip unrelated lifecycle work. Runner proves fresh HOME/ZYLOS_DIR/PM2_HOME
// and short TMPDIR/TMUX_TMPDIR. No tmux/PM2/network/live DB. Held promises are
// released in finally; fixture cleanup is awaited after each finite case.
test('pressure publishes first and reclaims one oldest eligible ordinary group at capacity one', async () => {
  const f = fixture(); let checks = 0;
  f.beforeReclaim(record => { checks++; const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'pool-capacity.json'), 'utf8')); assert.equal(saved.computedAt, record.computedAt); });
  await f.tick(0); assert.equal(f.notices.length, 0); assert.equal(checks, 0);
  await f.tick(10000); assert.equal(checks, 1); assert.equal(f.fences.size, 1); assert.equal(f.fences.get('old').reason, 'evict');
  assert.deepEqual(f.notices, ['memory_low']);
  const event = f.events.find(row => row.event === 'capacity_pressure_evict');
  assert.equal(event.usedBytes, 3900 * MiB); assert.equal(event.limitBytes, 4 * GiB); assert.equal(event.k, 1); assert.equal(event.session_group, 'old');
});
for (const reason of ['ttl', 'evict', 'upgrade', 'auth']) {
  test(`pressure respects an ordinary group's active ${reason} reclaim`, async () => {
    const f = fixture(); f.fences.set('other', { sessionGroup: 'other', reason, runId: 'run-other' });
    await f.tick(0); await f.tick(10000); assert.equal(f.fences.size, 1); assert.deepEqual(f.notices, ['memory_low']);
    assert.equal(f.events.some(row => row.event === 'capacity_pressure_evict'), false);
  });
}
for (const reason of ['auth', 'upgrade']) {
  test(`Origin ${reason} reclaim does not block reclaim of an ordinary idle group`, async () => {
    const f = fixture(); f.fences.set('origin', { sessionGroup: 'origin', reason, runId: 'run-origin' });
    await f.tick(0); await f.tick(10000); assert.equal(f.fences.get('old')?.reason, 'evict'); assert.equal(f.fences.size, 2);
  });
}
test('other reclaim reasons do not block pressure and fenced candidates are excluded', async () => {
  const f = fixture(); f.fences.set('old', { sessionGroup: 'old', reason: 'model_config', runId: 'run-old' });
  await f.tick(0); await f.tick(10000);
  assert.equal(f.fences.get('old').reason, 'model_config'); assert.equal(f.fences.get('young')?.reason, 'evict');
});
for (const kind of ['busy', 'young', 'unready', 'fenced', 'origin', 'transition']) {
  test(`pressure leaves ${kind} sessions untouched while memory warning is independent`, async () => {
    const f = fixture(); f.current.scenes = [scene(kind === 'origin' ? 'origin' : 'a', kind === 'busy' ? { state: 'busy' }
      : kind === 'young' ? { createdAt: f.time() - 1000 } : kind === 'unready' ? { ready: false } : {})];
    if (kind === 'fenced') f.fences.set('a', { sessionGroup: 'a', reason: 'model_config', runId: 'run-a' });
    if (kind === 'transition') f.current.transition = { phase: 'pending' };
    const before = f.fences.size; await f.tick(0); await f.tick(10000);
    assert.equal(f.fences.size, before); assert.deepEqual(f.notices, ['memory_low']);
  });
}
test('pressure uses the effective configured minimum idle duration', async () => {
  const f = fixture(); f.current.evictMinIdleSeconds = 3000; f.current.scenes = [scene('a')];
  await f.tick(0); await f.tick(10000); assert.equal(f.fences.size, 0); assert.deepEqual(f.notices, ['memory_low']);
});
for (const [usedMiB, expected] of [[3840, 1], [3584, 0]]) {
  test(`pressure boundary at ${usedMiB} MiB has the specified result`, async () => {
    const f = fixture(); f.setMemory({ source: 'host', limitBytes: 4 * GiB, usedBytes: usedMiB * MiB });
    await f.tick(0); await f.tick(10000); assert.equal(f.fences.size, expected); assert.equal(f.notices.length, expected);
  });
}
test('memory warning persists without candidates, after cancelled reclaim, and has its own thirty-minute cooldown', async () => {
  const f = fixture(); f.current.scenes = [scene('busy', { state: 'busy' })];
  await f.tick(0); assert.equal(f.notices.length, 0); await f.tick(10000); assert.deepEqual(f.notices, ['memory_low']);
  f.current.scenes = [scene('a')]; f.lifecycle.d.observeGroup = () => scene('a', { state: 'busy' });
  await f.tick(10000); assert.equal(f.fences.size, 0); assert.equal(f.notices.length, 1);
  await f.tick(1790000); assert.equal(f.notices.length, 2);
});
test('fallback and below-line readings break pressure count while fixed mode warns without reclaim', async () => {
  for (const kind of ['fallback', 'low']) {
    const f = fixture(); await f.tick(0); f.setMemory(kind === 'fallback' ? null : { source: 'host', limitBytes: 4 * GiB, usedBytes: 1000 * MiB });
    await f.tick(10000); assert.equal(f.notices.length, 0);
    f.setMemory({ source: 'host', limitBytes: 4 * GiB, usedBytes: 3900 * MiB });
    await f.tick(10000); assert.equal(f.fences.size, 0); assert.equal(f.notices.length, 0);
    await f.tick(10000); assert.equal(f.fences.get('old')?.reason, 'evict'); assert.deepEqual(f.notices, ['memory_low']);
  }
  const f = fixture(); f.setFixed(true); await f.tick(0); await f.tick(10000);
  assert.equal(f.fences.size, 0); assert.deepEqual(f.notices, ['memory_low']);
});
for (const fixed of [false, true]) {
  test(`OOM increments and publication failures only write diagnostics in ${fixed ? 'fixed' : 'automatic'} mode`, async () => {
    const f = fixture({ publish: () => { throw Object.assign(new Error('private failure'), { code: 'EACCES' }); } });
    f.setFixed(fixed); f.setMemory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1000 * MiB, oomKills: 5 });
    await f.tick(0); assert.equal(f.events.some(row => row.event === 'container_oom_kill'), false);
    f.setMemory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 1000 * MiB, oomKills: 6 });
    await f.tick(60000); assert.equal(f.events.filter(row => row.event === 'container_oom_kill').length, 1);
    assert.equal(f.events.filter(row => row.event === 'capacity_publish_failed').length, 2); assert.equal(f.notices.length, 0);
  });
}
test('other memory sources never produce OOM diagnostics', async () => {
  const f = fixture(); for (const source of ['cgroup1', 'host', 'darwin']) for (const oomKills of [0, 1]) {
    f.setMemory({ source, limitBytes: 4 * GiB, usedBytes: 1000 * MiB, oomKills }); await f.tick(10000);
  }
  assert.equal(f.notices.length, 0); assert.equal(f.events.some(row => row.event === 'container_oom_kill'), false);
});
test('unreadable inputs wait sixty seconds and retain cooldown across recovery', async () => {
  const f = fixture(); f.setMemory(null); await f.tick(0);
  for (let i = 0; i < 5; i++) await f.tick(10000);
  await f.tick(9000); assert.equal(f.notices.length, 0); await f.tick(1000); assert.deepEqual(f.notices, ['inputs_unreadable']);
  f.setMemory({ source: 'host', limitBytes: 4 * GiB, usedBytes: 1000 * MiB }); await f.tick(10000); assert.equal(f.capacity.inputsUnreadableSince, null);
  f.setMemory(null); await f.tick(10000); await f.tick(60000); assert.equal(f.notices.length, 1);
  await f.tick(1720000); assert.equal(f.notices.length, 2);
});
test('single cutover clears an existing failure duration and pressure observation before returning to multi', async () => {
  const f = fixture(); f.setMemory(null); await f.tick(0); assert.notEqual(f.capacity.inputsUnreadableSince, null);
  await f.capacity.tick({ mode: 'single', now: f.time() }); assert.equal(f.capacity.inputsUnreadableSince, null);
  await f.tick(60000); assert.equal(f.notices.length, 0); await f.tick(50000); await f.tick(9000); assert.equal(f.notices.length, 0);
  await f.tick(1000); assert.deepEqual(f.notices, ['inputs_unreadable']);
  const g = fixture(); await g.tick(0); await g.capacity.tick({ mode: 'single', now: g.time() });
  await g.tick(10000); assert.equal(g.fences.size, 0); assert.equal(g.notices.length, 0);
  await g.tick(10000); assert.equal(g.fences.get('old')?.reason, 'evict');
});
test('fixed unreadable inputs stay silent and automatic mode starts a fresh failure duration', async () => {
  const f = fixture(); f.setFixed(true); f.setMemory(null); await f.tick(0); await f.tick(60000);
  assert.equal(f.notices.length, 0); assert.equal(f.capacity.inputsUnreadableSince, null);
  f.setFixed(false); await f.tick(10000); await f.tick(50000); await f.tick(9000); assert.equal(f.notices.length, 0);
  await f.tick(1000); assert.deepEqual(f.notices, ['inputs_unreadable']);
});
test('publication completion rechecks the epoch before memory warnings or reclaim', async () => {
  let release, publishing = false;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture({ publish: async (file, record) => { if (record.computedAt > 1000000) { publishing = true; await held; } writeCapacityAtomic(file, record); } });
  await f.tick(0); const pending = f.tick(10000);
  try { for (let i = 0; i < 20 && !publishing; i++) await new Promise(resolve => setImmediate(resolve)); assert.equal(publishing, true);
    await f.capacity.tick({ mode: 'single', now: f.time() });
  } finally { release(); await pending; }
  assert.equal(f.fences.size, 0); assert.equal(f.notices.length, 0); assert.equal(f.capacity.pressureCount, 0);
});
test('pressure does not fence a candidate that becomes busy before beginReclaim', async () => {
  const f = fixture(); f.lifecycle.d.observeGroup = group => ({ ...f.current.scenes.find(s => s.sessionGroup === group), state: 'busy' });
  await f.tick(0); await f.tick(10000); assert.equal(f.fences.size, 0); assert.deepEqual(f.notices, ['memory_low']);
});
test('demand eviction does not fence a candidate that becomes busy before beginReclaim', async () => {
  const f = fixture(); f.current.scenes = [scene('a')]; f.lifecycle.d.observeGroup = () => scene('a', { state: 'busy' });
  const context = f.context(); f.lifecycle.d.db.listPendingSessionGroups = () => [{ sessionGroup: 'waiting' }];
  const result = await f.lifecycle.checkEviction(context.scenes, context); assert.equal(result.selected, 0); assert.equal(f.fences.size, 0);
});
