import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PoolCapacity } from '../skills/activity-monitor/scripts/pool-capacity.js';
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
  const notices = [], events = [], fences = new Map(), controls = [];
  const current = { scenes: [scene('young', { createdAt: 500_000 }), scene('old'), scene('origin'), scene('busy', { state: 'busy' })], transition: null };
  const db = { getModeTransition: () => current.transition, listDrainFences: () => [...fences.values()],
    getDrainFence: group => fences.get(group),
    setDrainFence: (group, row) => { if (!fences.has(group)) fences.set(group, { ...row, sessionGroup: group }); },
    getLastActivity: () => 0,
    insertControl: (content, options) => { const row = { id: controls.length + 1, content, ...options, status: 'pending' }; controls.push(row); return row; },
    getControlById: id => controls.find(row => row.id === id) };
  const lifecycle = new SupervisorLifecycle({ db, requests: { read: () => [] },
    observeGroup: group => current.scenes.find(s => s.sessionGroup === group) ?? { present: false },
    bindTarget: s => ({ expectedRunId: s.runId }),
    prompts: { PRE_RECLAIM_CHECK_PROMPT: 'check' } }, { now: () => now });
  const context = () => ({ configuration: { mode: 'multi', capacity: 1, evictMinIdleSeconds: current.evictMinIdleSeconds ?? 300 }, scenes: current.scenes.map(s => ({ ...s })),
    transition: current.transition, fences: [...fences.values()], restartRequests: [] });
  let beforeReclaim;
  const capacity = new PoolCapacity({ directory, readMemory: async () => memory, resolveBaseline: () => ({ k: 1, fixed }),
    notify: value => notices.push(value), log: row => events.push(row),
    reclaim: async record => {
      beforeReclaim?.(record);
      return lifecycle.checkCapacityPressure(context());
    }, ...options });
  return { capacity, directory, notices, events, fences, current, lifecycle, context, controls,
    acknowledge: () => { for (const row of controls) row.status = 'done'; },
    setMemory: value => memory = value, setFixed: value => fixed = value,
    beforeReclaim: fn => beforeReclaim = fn,
    tick: async advance => { now += advance; return capacity.tick({ mode: 'multi', now, scenes: current.scenes }); },
    time: () => now };
}

// Integration boundary for every case below: real controller publication and
// lifecycle candidate/fence paths, with private fixture files and in-memory DB.
// Run for protection, modes, fallback diagnostics, or shared eviction eligibility;
// skip unrelated lifecycle work. Runner proves fresh HOME/ZYLOS_DIR/PM2_HOME
// and short TMPDIR/TMUX_TMPDIR. No tmux/PM2/network/live DB. Held promises are
// released in finally; fixture cleanup is awaited after each finite case.
test('pressure publishes first and reclaims one oldest eligible ordinary group at capacity one', { timeout: 5000 }, async () => {
  const f = fixture(); let checks = 0;
  f.beforeReclaim(record => { checks++; const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'pool-capacity.json'), 'utf8')); assert.equal(saved.computedAt, record.computedAt); });
  await f.tick(0); assert.equal(f.notices.length, 0); assert.equal(checks, 0);
  await f.tick(10000); assert.equal(checks, 1); assert.equal(f.fences.size, 0);
  assert.deepEqual(f.controls.map(row => [row.sessionGroup, row.content]), [['old', 'check']]);
  assert.equal(f.events.some(row => row.event === 'capacity_pressure_evict'), false);
  f.acknowledge(); await f.tick(10000);
  assert.equal(checks, 2); assert.equal(f.fences.size, 1); assert.equal(f.fences.get('old').reason, 'evict');
  assert.equal(f.controls.length, 1); assert.deepEqual(f.notices, [undefined]);
  const event = f.events.find(row => row.event === 'capacity_pressure_evict');
  assert.equal(event.usedBytes, 3900 * MiB); assert.equal(event.limitBytes, 4 * GiB); assert.equal(event.k, 1); assert.equal(event.session_group, 'old');
});
for (const kind of ['busy', 'young', 'unready', 'fenced', 'origin', 'transition']) {
  test(`pressure leaves ${kind} sessions untouched while memory warning is independent`, { timeout: 5000 }, async () => {
    const f = fixture(); f.current.scenes = [scene(kind === 'origin' ? 'origin' : 'a', kind === 'busy' ? { state: 'busy' }
      : kind === 'young' ? { createdAt: f.time() - 1000 } : kind === 'unready' ? { ready: false } : {})];
    if (kind === 'fenced') f.fences.set('a', { sessionGroup: 'a', reason: 'model_config', runId: 'run-a' });
    if (kind === 'transition') f.current.transition = { phase: 'pending' };
    const before = f.fences.size; await f.tick(0); await f.tick(10000);
    assert.equal(f.fences.size, before); assert.deepEqual(f.notices, [undefined]);
  });
}
test('pressure does not fence a candidate that becomes busy before beginReclaim', { timeout: 5000 }, async () => {
  const f = fixture(); f.lifecycle.d.observeGroup = group => ({ ...f.current.scenes.find(s => s.sessionGroup === group), state: 'busy' });
  await f.tick(0); await f.tick(10000); assert.equal(f.fences.size, 0); assert.equal(f.controls.length, 0); assert.deepEqual(f.notices, [undefined]);
});
