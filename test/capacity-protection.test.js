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
  const context = () => ({ configuration: { mode: 'multi', capacity: 1 }, scenes: current.scenes.map(s => ({ ...s })),
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

// Integration boundary: real capacity publication -> lifecycle candidate and
// beginReclaim fencing. Run for pressure/selection/publication wiring; skip
// unrelated lifecycle changes. Runner isolates HOME/ZYLOS_DIR/PM2_HOME and
// short TMPDIR/TMUX_TMPDIR. Only this fixture's files and in-memory DB/scenes;
// no tmux, real database, PM2 or network. No background tasks survive a case.
test('pressure publishes first, reclaims one oldest eligible group even at capacity one, and rate limits notices', async () => {
  const f = fixture();
  let checks = 0;
  f.beforeReclaim(record => {
    checks++;
    const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'pool-capacity.json'), 'utf8'));
    assert.equal(saved.computedAt, record.computedAt);
    assert.equal(saved.k, record.k);
  });
  await f.tick(0); assert.equal(f.fences.size, 0); assert.equal(checks, 0);
  await f.tick(10000);
  assert.equal(checks, 1); assert.equal(f.fences.size, 1); assert.equal(f.fences.get('old').reason, 'evict');
  assert.equal(f.notices.filter(id => id === 'memory_reclaim').length, 1);
  const diagnostic = f.events.find(row => row.event === 'capacity_pressure_evict');
  assert.equal(diagnostic.usedBytes, 3900 * MiB); assert.equal(diagnostic.limitBytes, 4 * GiB);
  assert.equal(diagnostic.k, 1); assert.equal(diagnostic.session_group, 'old');
  f.fences.clear(); f.current.scenes = [scene('next')];
  await f.tick(10000); assert.equal(f.fences.get('next').reason, 'evict');
  assert.equal(f.events.filter(row => row.event === 'capacity_pressure_evict').length, 2);
  assert.equal(f.notices.filter(id => id === 'memory_reclaim').length, 1);
  f.fences.clear(); await f.tick(1800000);
  assert.equal(f.notices.filter(id => id === 'memory_reclaim').length, 2);
});

for (const reason of ['ttl', 'evict', 'upgrade', 'auth']) {
  // Same isolated capacity -> lifecycle boundary as above; each actual persisted
  // reclaim reason must suppress pressure selection, including Origin fences.
  test(`pressure respects an active ${reason} reclaim`, async () => {
    const f = fixture(); f.fences.set('origin', { sessionGroup: 'origin', reason, runId: 'run-origin' });
    await f.tick(0); await f.tick(10000);
    assert.equal(f.fences.size, 1); assert.equal(f.notices.length, 0);
    assert.equal(f.events.some(row => row.event === 'capacity_pressure_evict'), false);
  });
}

// Integration boundary: same real controller/lifecycle and in-memory authorities.
// Run for candidate eligibility and pressure gates; no services/children/network,
// runner-isolated HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/TMUX_TMPDIR, cleanup fixture files.
test('pressure leaves busy, young, unready, fenced and Origin sessions untouched and blocks transitions', async () => {
  for (const kind of ['busy', 'young', 'unready', 'fenced', 'origin', 'transition']) {
    const f = fixture();
    f.current.scenes = [scene(kind === 'origin' ? 'origin' : 'a', kind === 'busy' ? { state: 'busy' }
      : kind === 'young' ? { createdAt: f.time() - 1000 }
        : kind === 'unready' ? { ready: false } : {})];
    if (kind === 'fenced') f.fences.set('a', { sessionGroup: 'a', reason: 'model_config', runId: 'run-a' });
    if (kind === 'transition') f.current.transition = { phase: 'pending' };
    const before = f.fences.size;
    await f.tick(0); await f.tick(10000);
    assert.equal(f.fences.size, before, kind); assert.equal(f.notices.length, 0, kind);
  }
});

// Integration boundary: real controller and lifecycle with private fixture files/DB.
// Run for protection/notice gates; skip unrelated changes. Runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR; no tmux/PM2/network/live DB.
// Finite steps only; held callbacks are released and fixture cleanup is awaited.
test('fixed, fallback and below-line calculations break consecutive pressure observations', async () => {
  for (const kind of ['fixed', 'fallback', 'low']) {
    const f = fixture(); await f.tick(0);
    if (kind === 'fixed') f.setFixed(true);
    else f.setMemory(kind === 'fallback' ? null : { source: 'host', limitBytes: 4 * GiB, usedBytes: 1000 * MiB });
    await f.tick(10000); assert.equal(f.fences.size, 0);
    f.setFixed(false); f.setMemory({ source: 'host', limitBytes: 4 * GiB, usedBytes: 3900 * MiB });
    await f.tick(10000); assert.equal(f.fences.size, 0, kind);
    await f.tick(10000); assert.equal(f.fences.get('old').reason, 'evict', kind);
  }
});

// Integration boundary: real controller and lifecycle with private fixture files/DB.
// Run for protection/notice gates; skip unrelated changes. Runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR; no tmux/PM2/network/live DB.
// Finite steps only; held callbacks are released and fixture cleanup is awaited.
test('fixed mode never reclaims under repeated pressure but reports increasing cgroup OOM counters', async () => {
  const f = fixture(); f.setFixed(true);
  f.setMemory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 3900 * MiB, oomKills: 5 });
  await f.tick(0); assert.equal(f.notices.length, 0, 'first nonzero counter only establishes baseline');
  f.setMemory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 3900 * MiB, oomKills: 6 });
  await f.tick(10000); assert.equal(f.notices.join(','), 'oom_kill');
  f.setMemory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 3900 * MiB, oomKills: 7 });
  await f.tick(10000); assert.equal(f.notices.length, 1);
  assert.equal(f.events.filter(row => row.event === 'container_oom_kill').length, 2);
  await f.tick(1800000); assert.equal(f.notices.length, 1, 'unchanged counter is not an event');
  f.setMemory({ source: 'cgroup2', limitBytes: 4 * GiB, usedBytes: 3900 * MiB, oomKills: 8 });
  await f.tick(10000); assert.equal(f.notices.filter(id => id === 'oom_kill').length, 2);
  assert.equal(f.fences.size, 0);
});

// Integration boundary: real controller and lifecycle with private fixture files/DB.
// Run for protection/notice gates; skip unrelated changes. Runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR; no tmux/PM2/network/live DB.
// Finite steps only; held callbacks are released and fixture cleanup is awaited.
test('other memory sources never report OOM notifications', async () => {
  const f = fixture();
  for (const source of ['cgroup1', 'host', 'darwin']) {
    for (const oomKills of [0, 1]) {
      f.setMemory({ source, limitBytes: 4 * GiB, usedBytes: 1000 * MiB, oomKills });
      await f.tick(10000);
    }
  }
  assert.equal(f.notices.length, 0); assert.equal(f.events.some(row => row.event === 'container_oom_kill'), false);
});

// Integration boundary: real controller and lifecycle with private fixture files/DB.
// Run for protection/notice gates; skip unrelated changes. Runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR; no tmux/PM2/network/live DB.
// Finite steps only; held callbacks are released and fixture cleanup is awaited.
test('unreadable inputs and publication failures wait sixty seconds and have independent thirty-minute limits', async () => {
  const f = fixture( { publish: () => { throw Object.assign(new Error('private fixture failure'), { code: 'EACCES' }); } });
  f.setMemory(null);
  for (let i = 0; i <= 5; i++) await f.tick(i === 0 ? 0 : 10000);
  assert.equal(f.notices.length, 0);
  await f.tick(9000); assert.equal(f.notices.length, 0);
  await f.tick(1000);
  assert.equal(f.notices.join(','), 'inputs_unreadable,publish_failed');
  assert.equal(f.capacity.publishFailedSince, 1000000);
  await f.tick(1790000); assert.equal(f.notices.length, 2);
  await f.tick(10000); assert.equal(f.notices.length, 4);
});

// Integration boundary: real controller and lifecycle with private fixture files/DB.
// Run for protection/notice gates; skip unrelated changes. Runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR; no tmux/PM2/network/live DB.
// Finite steps only; held callbacks are released and fixture cleanup is awaited.
test('successful reads and publication reset failure durations without resetting the ID cooldown', async () => {
  let failing = true;
  const f = fixture( { publish: (file, record) => {
    if (failing) throw Object.assign(new Error('private failure'), { code: 'EACCES' });
    writeCapacityAtomic(file, record);
  } });
  f.setMemory(null); await f.tick(0); await f.tick(60000); assert.equal(f.notices.length, 2);
  failing = false; f.setMemory({ source: 'host', limitBytes: 4 * GiB, usedBytes: 1000 * MiB });
  await f.tick(10000); assert.equal(f.capacity.inputsUnreadableSince, null); assert.equal(f.capacity.publishFailedSince, null);
  failing = true; f.setMemory(null); await f.tick(10000); await f.tick(60000);
  assert.equal(f.notices.length, 2);
});

// Integration boundary: real controller and lifecycle with private fixture files/DB.
// Run for protection/notice gates; skip unrelated changes. Runner isolates HOME,
// ZYLOS_DIR, PM2_HOME and short TMPDIR/TMUX_TMPDIR; no tmux/PM2/network/live DB.
// Finite steps only; held callbacks are released and fixture cleanup is awaited.
test('single mode cancels pending late pressure callbacks and old failure durations', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = fixture( { reclaim: () => held });
  await f.tick(0);
  const pending = f.tick(10000);
  try {
    for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
    await f.capacity.tick({ mode: 'single', now: f.time() });
  } finally {
    release(scene('old')); await pending;
  }
  assert.equal(f.notices.length, 0); assert.equal(f.events.some(row => row.event === 'capacity_pressure_evict'), false);
  assert.equal(f.capacity.inputsUnreadableSince, null); assert.equal(f.capacity.publishFailedSince, null);
});

// Integration boundary: shared candidate selection -> real beginReclaim's fresh
// observation. Run for evict eligibility/reclaim changes; skip unrelated work.
// Runner isolates HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR; fixture files
// and in-memory DB only; no tmux/PM2/network. Each fixture is cleaned after case.
test('pressure does not fence a candidate that becomes busy before beginReclaim', async () => {
  const f = fixture();
  f.lifecycle.d.observeGroup = group => ({ ...f.current.scenes.find(scene => scene.sessionGroup === group), state: 'busy' });
  await f.tick(0); await f.tick(10000);
  assert.equal(f.fences.size, 0); assert.equal(f.notices.length, 0);
});

// Integration boundary: real controller's fixed/auto timer and notice consumer.
// Run for fixed-mode notice semantics; skip unrelated changes. Fresh isolated
// HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR; private files/in-memory DB,
// no tmux/PM2/network. Fixture cleanup is registered before calculations.
test('fixed unreadable inputs stay silent and automatic mode starts a new sixty-second failure duration', async () => {
  const f = fixture(); f.setFixed(true); f.setMemory(null);
  await f.tick(0); await f.tick(60000);
  assert.equal(f.notices.length, 0); assert.equal(f.capacity.inputsUnreadableSince, null);
  f.setFixed(false); await f.tick(10000);
  await f.tick(50000); await f.tick(9000); assert.equal(f.notices.length, 0);
  await f.tick(1000); assert.equal(f.notices.join(','), 'inputs_unreadable');
});
