import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator } from '../runtime-health.js';
import { SupervisorHealthObserver } from '../supervisor-health-observer.js';

const WAIT_MS = 30 * 60 * 1000;

// Real observer, coordinator and health files; screen, activity and C4 rows are
// bounded in-memory inputs. No dispatcher, model API, tmux or service is used.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-busy-'));
  let now = 1800000000000, transition = null, matches = {};
  let scenes = [], nextId = 1;
  const activity = new Map(), controls = [], stops = [], fences = new Set(), errors = [];
  const coordinator = new RuntimeHealthCoordinator({ zylosDir: root, now: () => now,
    resolveTargetRuntime: () => 'claude', listScenes: () => scenes, checkAuth: () => ({status:'failure'}) });
  const observer = new SupervisorHealthObserver({ coordinator, now: () => now,
    listScenes: () => scenes,
    readIdentity: group => scenes.find(scene => scene.sessionGroup === group),
    readState: scene => activity.get(scene.runId), readScreen: () => '', matchScreen: () => matches,
    getModeTransition: () => transition, getDrainFence: group => fences.has(group),
    buildTargetBinding: scene => ({ runId: scene.runId }),
    insertControl: (content, options) => {
      const row = { id: nextId++, content, ...options, status: 'pending' };
      controls.push(row); return row;
    },
    getControlById: id => controls.find(row => row.id === id),
    stop: scene => { stops.push(scene); return true; }, log: error => errors.push(error) });
  coordinator.probeInFlight = runtime => observer.probeInFlight(runtime);
  t.after(async () => { await observer.shutdown(); fs.rmSync(root, { recursive: true, force: true }); });
  const setHealth = (health, budget = {}) => {
    const state = coordinator.store('claude').read();
    state.health = health; state.reason = ''; Object.assign(state.scheduling, budget);
    coordinator.store('claude').write(state);
  };
  setHealth('unavailable');
  const state = (scene, value = {}) => activity.set(scene.runId, {
    state: value.tools?.length ? 'busy' : 'idle', sessionId: scene.sessionId,
    lastActivityAt: now - 5000, transcriptMtimeMs: null, idleSince: now - 2000, events: [],
    healthIdentity: { session_id: scene.sessionId, claude_pid: 42 }, ...value,
    tools: (value.tools ?? []).map(tool => ({ name: 'Bash', startedAt: now, input: {}, ...tool })) });
  const add = (group, value = {}) => {
    const scene = { sessionGroup: group, runtime: 'claude', runId: randomUUID(),
      sessionId: randomUUID(), ready: true, present: true, processRunning: true };
    scenes.push(scene); state(scene, value); return scene;
  };
  const prepare = async (options) => {
    const result = observer.requestProbe('claude', options);
    await Promise.all([...observer.preparations]);
    assert.equal(errors.length, 0);
    return { result, probe: observer.probes.get('claude'), row: controls.at(-1) };
  };
  return { root, coordinator, observer, controls, stops, fences, add, state, setHealth, prepare,
    now: () => now, advance: ms => { now += ms; },
    scenes: () => scenes, setScenes: value => { scenes = value; },
    setTransition: value => { transition = value; }, setMatches: value => { matches = value; },
    health: () => coordinator.store('claude').read(),
    bytes: () => fs.readFileSync(coordinator.store('claude').file, 'utf8'),
    reconcile: (demand = new Map([['claude', new Set(['telegram:a'])]])) => observer.reconcileRecoveryWaits(demand, scenes),
    waitAt: () => observer.recoveryWaits.get('claude') };
}

async function terminal(f, pending, status = 'timeout', elapsed = 120000) {
  f.advance(elapsed); pending.row.status = status; await f.observer.tick(); return pending.result;
}

for (const health of ['rate_limited', 'unavailable', 'recovering', 'down']) {
  test(`${health} waits for idle without inserting controls or changing health and association`, { timeout: 5000 }, async t => {
    const f = fixture(t); f.setHealth(health);
    const scene = f.add('origin', { state: 'busy', tools: [{ id: 'foreground', name: 'Bash', startedAt: f.now() }] });
    const linked = { sessionGroup: scene.sessionGroup, runId: scene.runId };
    f.coordinator.associations.set('claude', linked);
    const before = f.bytes(), started = f.now();
    assert.equal((await (await f.prepare()).result).noTarget, true);
    f.advance(10000); assert.equal((await (await f.prepare()).result).noTarget, true);
    assert.equal(f.waitAt(), started); assert.equal(f.controls.length, 0);
    assert.equal(f.bytes(), before); assert.equal(f.coordinator.associations.get('claude'), linked);
    assert.equal(f.stops.length, 0);
    f.state(scene); const pending = await f.prepare();
    assert.equal(f.controls.length, 1); assert.equal(pending.row.targetBinding.runId, scene.runId);
    assert.equal((await terminal(f, pending, 'done', 1000)).recovered, true);
    assert.equal(f.health().health, 'ok'); assert.equal(f.waitAt(), undefined);
  });
}

test('thirty minute fallback keeps idle first and Origin first within busy candidates', { timeout: 5000 }, async t => {
  for (const idle of [false, true]) await t.test(String(idle), { timeout: 5000 }, async t => {
    const f = fixture(t); f.add('lark:a', { state: 'busy' });
    const ordinary = f.add('feishu:b', { state: 'busy' }); f.add('origin', { state: 'busy' });
    await (await f.prepare()).result; f.advance(WAIT_MS - 1);
    await (await f.prepare()).result; assert.equal(f.controls.length, 0);
    f.advance(1); if (idle) f.state(ordinary);
    const p = await f.prepare(); assert.equal(p.row.sessionGroup, idle ? 'feishu:b' : 'origin');
    assert.equal(p.row.ackDeadlineAt, f.now() / 1000 + 120);
    f.state(f.scenes().find(s => s.runId === p.probe.scene.runId), { tools: [{ id: 'foreground' }] });
    await f.observer.tick(); assert.equal((await terminal(f, p)).classification, 'other');
    assert.equal(f.stops.length, 1); assert.equal(f.stops[0].runId, p.probe.scene.runId);
    assert.equal(f.waitAt(), undefined);
  });
});

