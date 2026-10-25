import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { HealthStore } from '../health-store.js';
import { readRuntimeHealth } from '../../../../cli/lib/session-state-reader.js';
function registered(reply) {
  assert.equal(reply.result, 'registered');
  assert.equal(Object.hasOwn(reply, 'attemptCount'), false);
  assert.equal(Object.hasOwn(reply, 'attemptAt'), false);
}
function scheduling(state) {
  const s = state.scheduling;
  return [s.restartFailureCount, s.lastRecoveryAt, s.lastDownCheckAt];
}

function fixture(t, create = createSupervisor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'health-table-')); let now = 1792000000000;
  const state = { current: [], controls: [], pending: [{ sessionGroup: 'telegram:a', retry_count: 2 }], matches: {}, stops: [] };
  const db = { getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listPendingSessionGroups: () => state.pending,
    insertControl: (content, options) => { state.controls.push({ id: state.controls.length + 1, content, ...options, status: 'pending' }); return state.controls.length; },
    getControlById: id => state.controls[id - 1],
  };
  const scenes = { observe: () => state.current, readIdentity(group) { return this.observeGroup(group); }, observeGroup: group => state.current.find(s => s.sessionGroup === group) ?? { present: false },
    listRuns: () => state.current, readRun: group => state.current.find(s => s.sessionGroup === group), readScreen: () => 'fixture screen',
    bindTarget: scene => ({ runId: scene.runId, runtime: scene.runtime }), stop: scene => { state.stops.push(scene.runId); } };
  const owner = create({ zylosDir: root, env: { ZYLOS_DIR: root }, now: () => now, db, scenes,
    readMode: () => ({ mode: 'multi' }), readConfiguration: () => ({ mode: 'multi', runtime: 'claude', capacity: 4 }),
    resolveTargetRuntime: () => 'claude', requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
    checkAuth: () => ({ status: 'uncertain' }), matchScreen: () => state.matches, loopOptions: { schedule: () => 1, cancel() {} } });
  t.after(async () => { await owner.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const store = owner.health.store('claude'), health = store.read(); health.health = 'rate_limited'; store.write(health);
  const scene = { sessionGroup: 'telegram:a', runtime: 'claude', runId: randomUUID(), sessionId: 'session-a',
    ready: true, present: true, processRunning: true, runDir: root, state: 'idle' };
  return { root, owner, store, state, scene, clock: seconds => { now = seconds * 1000; },
    prepared: async () => { while (owner.observer.preparations.size) await Promise.all([...owner.observer.preparations]); } };
}

test('IF-29 composed owner four result branches and stale identity preserve pending demand and retry budget', async t => {
  for (const [label, terminal, matches, expected, count] of [
    ['done', 'done', { rateLimit: { detected: true }, authFailure: { detected: true } }, 'ok', 0],
    ['rate-before-auth', 'failed', { rateLimit: { detected: true, cooldownUntil: 1792000200 }, authFailure: { detected: true } }, 'rate_limited', 0],
    ['auth', 'failed', { authFailure: { detected: true } }, 'auth_failed', 0],
    ['other', 'timeout', {}, 'unavailable', 1],
    ['stale', 'failed', { authFailure: { detected: true } }, 'rate_limited', 0],
  ]) {
    const f = fixture(t); f.state.current.push(f.scene); f.state.matches = matches;
    const demand = structuredClone(f.state.pending); const probe = f.owner.observer.requestProbe('claude', { force: true }); await f.prepared();
    assert.equal(f.state.controls.length, 1); const row = f.state.controls[0];
    assert.equal(row.sessionGroup, 'telegram:a'); assert.equal(row.targetBinding.runId, f.scene.runId); assert.equal(row.priority, 0); assert.equal(row.bypassState, true);
    const before = fs.readFileSync(f.store.file, 'utf8'); row.status = terminal;
    if (label === 'stale') f.state.current[0] = { ...f.scene, runId: randomUUID() };
    await f.owner.observer.pollProbe(f.owner.observer.probes.get('claude')); await probe;
    assert.equal(f.store.read().health, expected, label); assert.equal(f.store.read().scheduling.restartFailureCount, count, label);
    assert.deepEqual(f.state.pending, demand, label); assert.equal(f.state.controls.length, 1, label);
    if (label === 'stale') assert.equal(fs.readFileSync(f.store.file, 'utf8'), before);
    if (label === 'other') { await f.owner.observer.observeScene(f.scene); assert.deepEqual(f.state.stops, [f.scene.runId]); }
  }
});
async function appearance(t, create) {
  const f = fixture(t, create), state = f.store.read(); state.health = 'unavailable'; state.scheduling.restartFailureCount = 1; state.scheduling.lastRecoveryAt = 1792000000; f.store.write(state);
  f.clock(1792000060); const request = { version: 1, type: 'start_attempt', requestId: 'sa-1792000060000-123456789abc', runtime: 'claude', sessionGroup: f.scene.sessionGroup, runId: f.scene.runId };
  registered(await f.owner.health.registerStartAttempt(request));assert.deepEqual(scheduling(f.store.read()), [2, 1792000060, 0]);
  const expected = [2, 1792000060, 0], values = () => scheduling(f.store.read());
  f.state.current.push({ ...f.scene, ready: false }); await f.owner.observer.observeScene(f.state.current[0]); assert.deepEqual(values(), expected);
  f.state.current[0].ready = true; await f.owner.observer.observeScene(f.state.current[0]); assert.deepEqual(values(), expected);
  f.state.current = []; await f.owner.health.noteRunExited('claude', f.scene.runId); assert.deepEqual(values(), expected);
  f.clock(1792000359); assert.equal((await f.owner.health.registerStartAttempt({ ...request, runId: randomUUID() })).notBefore, 1792000360000);
}
test('DM-68 composed appearance/READY/exit retains attempt budget', async t => {
  await appearance(t, createSupervisor);

});
async function readerTrace(t, reader) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-reader-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = new HealthStore({ zylosDir: root, runtime: 'claude' }), state = store.read(); state.health = 'rate_limited'; store.write(state);
  fs.writeFileSync(path.join(root, 'activity-monitor/agent-status.json'), JSON.stringify({ health: 'rate_limited' }));
  const originalRead = fs.readFileSync, oldRoot = process.env.ZYLOS_DIR, accesses = [];
  let result;
  try {
    process.env.ZYLOS_DIR = root;
    fs.readFileSync = (file, ...args) => { accesses.push(String(file)); return originalRead(file, ...args); };
    result = reader('codex');
  } finally { fs.readFileSync = originalRead; if (oldRoot === undefined) delete process.env.ZYLOS_DIR; else process.env.ZYLOS_DIR = oldRoot; }
  assert.deepEqual(result, { missing: true });
  assert.deepEqual(accesses, [path.join(root, 'activity-monitor/runtime-health/codex.json')]);
}
test('DM-46 local F10 reader traces only requested missing runtime', async t => {
  await readerTrace(t, readRuntimeHealth);

});
