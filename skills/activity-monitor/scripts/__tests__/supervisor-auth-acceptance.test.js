import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';

function variant(file, from, to, imports = {}) {
  const url = new URL(file, import.meta.url);
  let source = fs.readFileSync(url, 'utf8');
  if (from) {
    assert.equal(source.split(from).length, 2, 'mutant anchor must be unique');
    source = source.replace(from, to);
  }
  source = source.replace(/(from\s+['"])(\.[^'"]+)(['"])/g,
    (_, prefix, specifier, suffix) => prefix + (imports[specifier] ?? new URL(specifier, url).href) + suffix);
  return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
}
async function badOwner(kind) {
  const imports = {};
  if (kind === 'deadline') imports['./supervisor-lifecycle.js'] = variant('../supervisor-lifecycle.js',
    'controls.running - (withoutDeadline ? controls.runningWithoutDeadline : 0)', 'controls.running');
  if (kind === 'early') imports['./runtime-health.js'] = variant('../runtime-health.js',
    'if (confirmed.some(value => !value)) return false;', '// broken: ignore old target and auth fence');
  if (kind === 'limit') imports['./runtime-health.js'] = variant('../runtime-health.js',
    "state.health = state.rateLimitActive ? 'rate_limited' : 'ok';", "state.health = 'ok'; state.rateLimitActive = false;");
  return (await import(variant('../supervisor.js', null, null, imports))).createSupervisor;
}

// IF-28 / DM-63: exercise the composed owner and durable F10, with frozen
// scene/DB contracts. Actual M1 delivery and P07 marker execution are separate.
function fixture(t, { mode = 'multi', create = createSupervisor } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-auth-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const group = mode === 'single' ? null : 'lark:oc_b';
  const state = { now: 1000000, live: new Map(), fences: new Map(), checks: [], stops: [],
    running: 0, controls: 0, deadlineLess: 0, pending: true, d8Writes: 0 };
  const db = {
    getModeTransition: () => null, getDrainFence: g => state.fences.get(g) ?? null,
    listDrainFences: () => [...state.fences.values()],
    setDrainFence: (g, value) => { state.d8Writes++; state.fences.set(g, { sessionGroup: g, ...value }); },
    clearDrainFence: g => state.fences.delete(g),
    listPendingSessionGroups: () => state.pending ? [{ sessionGroup: group }] : [],
    countGlobalRunningConversations: () => state.running,
    countRunningConversations: () => state.running,
    countNonTerminalControls: () => ({ running: state.controls, runningWithoutDeadline: state.deadlineLess }),
    expireStaleRunningControls: () => [], getControlById: () => null,
  };
  const scenes = {
    observe: async () => [...state.live.values()],
    observeGroup: async g => state.live.get(g) ?? { present: false, sessionGroup: g },
    listRuns: async () => [...state.live.values()], readRun: async g => state.live.get(g),
    stop: async scene => { state.stops.push(scene.runId); state.live.delete(scene.sessionGroup); },
  };
  const add = (runtime = 'codex', sessionGroup = group, runId = 'old-run') => {
    const scene = { present: true, ready: true, processRunning: true, runtime,
      sessionGroup, runId, sessionId: runId, runDir: path.join(root, runId), state: 'idle', idleSince: 1 };
    state.live.set(sessionGroup, scene); return scene;
  };
  let supervisor;
  const reopen = async () => {
    await supervisor?.stop();
    supervisor = create({ db, scenes, zylosDir: root, env: { ZYLOS_DIR: root }, now: () => state.now,
      readMode: () => ({ mode }), readConfiguration: () => ({ mode, runtime: 'codex', capacity: 4 }),
      resolveTargetRuntime: () => 'codex', requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
      readSyncMarker: () => ({ held: false, stale: false }),
      checkAuth: async runtime => { state.checks.push(runtime); return { status: 'success' }; },
      loopOptions: { schedule: () => 1, cancel: () => {} },
    });
    await supervisor.loop.deps.readConfiguration();
    await supervisor.loop.deps.restore();
    return supervisor;
  };
  t.after(async () => supervisor?.stop());
  const tick = () => supervisor.loop.deps.writeMetricsAndMaintain({});
  const seed = (active = false, cooldown = 0) => {
    const store = supervisor.health.store('codex'), health = store.read();
    health.health = 'auth_failed'; health.reason = 'authentication_failed'; health.rateLimitActive = active;
    health.scheduling.cooldownUntil = cooldown; health.scheduling.restartFailureCount = 2;
    store.write(health);
  };
  return { root, state, group, add, reopen, tick, seed, get supervisor() { return supervisor; } };
}

test('IF-28 composed multi auth captures only affected runtime, retains F10 until old target and D8 are gone, rechecks after restart', async t => {
  const f = fixture(t); await f.reopen(); f.seed(); f.add(); f.add('claude', 'lark:other', 'claude-run');
  await f.tick();
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
  assert.deepEqual(f.supervisor.health.authTargets('codex').map(s => s.runId), ['old-run']);
  assert.equal(f.state.fences.get(f.group).reason, 'auth'); assert.deepEqual(f.state.stops, []);
  await f.reopen();
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
  assert.equal(f.supervisor.health.authRecoveries.size, 0);
  // The persisted auth fence excludes this pending group from recovery demand.
  // Resume its reclaim first; checkAuth must run again before health is released.
  await f.tick(); assert.deepEqual(f.state.checks, ['codex']);
  const fence = f.state.fences.get(f.group);
  f.state.running = 1;
  assert.equal(await f.supervisor.lifecycle.advanceReclaim(fence, { configuration: { mode: 'multi' } }), 'waiting_inflight');
  await f.tick(); assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed');
  f.state.running = 0;
  assert.equal(await f.supervisor.lifecycle.advanceReclaim(fence, { configuration: { mode: 'multi' } }), 'done');
  await f.tick();
  assert.deepEqual(f.state.checks, ['codex', 'codex']);
  assert.deepEqual(f.state.stops, ['old-run']); assert.equal(f.state.live.get('lark:other').runId, 'claude-run');
  assert.equal(f.supervisor.health.store('codex').read().health, 'ok'); assert.equal(f.state.fences.size, 0);
});

test('IF-28 composed single auth preserves blocking through in-flight work and restart; deadline-less control does not prevent cleanup', async t => {
  const f = fixture(t, { mode: 'single' }); await f.reopen(); f.seed(); f.add();
  f.state.running = 1; await f.tick();
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed'); assert.deepEqual(f.state.stops, []);
  await f.reopen(); await f.tick(); assert.deepEqual(f.state.checks, ['codex', 'codex']);
  f.state.running = 0; f.state.controls = 1; await f.tick();
  assert.equal(f.supervisor.health.store('codex').read().health, 'auth_failed'); assert.deepEqual(f.state.stops, []);
  f.state.deadlineLess = 1; await f.tick();
  assert.equal(f.supervisor.health.store('codex').read().health, 'ok'); assert.deepEqual(f.state.stops, ['old-run']);
  assert.equal(f.state.d8Writes, 0); assert.equal(f.state.fences.size, 0);
});

for (const [label, active, cooldown, expected] of [
  ['unexpired', true, 1500, 1500], ['expired', true, 900, 0], ['zero', true, 0, 0], ['no-limit', false, 0, 0],
]) test(`DM-63 composed auth recovery after F10 reopen retains ${label} rate-limit facts`, async t => {
  const f = fixture(t); await f.reopen(); f.seed(active, cooldown); await f.reopen();
  const before = f.supervisor.health.store('codex').read();
  assert.equal(before.health, 'auth_failed'); assert.equal(before.rateLimitActive, active);
  assert.equal(before.scheduling.cooldownUntil, cooldown);
  await f.tick();
  const after = f.supervisor.health.store('codex').read();
  assert.equal(after.health, active ? 'rate_limited' : 'ok'); assert.equal(after.rateLimitActive, active);
  assert.equal(after.scheduling.cooldownUntil, expected);
});

for (const kind of ['early', 'deadline', 'limit']) test(`IF-28 / DM-63 composed assertions reject ${kind} rule removal`, async t => {
  const verify = async create => {
    const f = fixture(t, { create, mode: kind === 'deadline' ? 'single' : 'multi' });
    await f.reopen(); f.seed(kind === 'limit', kind === 'limit' ? 1500 : 0);
    if (kind !== 'limit') f.add();
    if (kind === 'deadline') { f.state.controls = 1; f.state.deadlineLess = 1; }
    await f.tick();
    const health = f.supervisor.health.store('codex').read();
    if (kind === 'early') { assert.equal(health.health, 'auth_failed'); assert.deepEqual(f.state.stops, []); }
    if (kind === 'deadline') { assert.equal(health.health, 'ok'); assert.deepEqual(f.state.stops, ['old-run']); }
    if (kind === 'limit') { assert.equal(health.health, 'rate_limited'); assert.equal(health.scheduling.cooldownUntil, 1500); }
  };
  await verify(createSupervisor);
  await assert.rejects(verify(await badOwner(kind)), { code: 'ERR_ASSERTION' });
});

test('DM-47 composed owners keep current and legacy caches inside their own root', async t => {
  const a = fixture(t), b = fixture(t); await a.reopen(); await b.reopen();
  a.supervisor.router.writeNegativeCache('codex', 'unavailable', 'runtime_unavailable');
  b.supervisor.router.writeNegativeCache('codex', 'rate_limited', 'rate_limit');
  assert.equal(a.supervisor.router.cachePath('codex'), path.join(a.root, 'activity-monitor/message-router-probe-cache/codex.json'));
  assert.equal(a.supervisor.router.readNegativeCache('codex', 'unavailable', 'runtime_unavailable').health, 'unavailable');
  b.supervisor.router.clearCache('codex');
  assert.ok(a.supervisor.router.readNegativeCache('codex', 'unavailable', 'runtime_unavailable'));
  const legacyA = path.join(a.root, 'activity-monitor/message-router-probe-cache.json');
  const legacyB = path.join(b.root, 'activity-monitor/message-router-probe-cache.json');
  fs.writeFileSync(legacyA, 'old-a'); fs.writeFileSync(legacyB, 'old-b');
  await a.reopen(); assert.equal(fs.existsSync(legacyA), false); assert.equal(fs.readFileSync(legacyB, 'utf8'), 'old-b');
});
