import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { SupervisorServerObservation } from '../supervisor-server-observation.js';
import { SupervisorServerHealth } from '../supervisor-server-health.js';
import { RestartRequestStore } from '../restart-request-store.js';

async function scenario(t, Observation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'supervisor-uncertainty-'));
  let failed = false, now = 1792000000000;
  const scene = { sessionGroup: 'telegram:occupied', runId: 'current-run', sessionId: 'current-session',
    runtime: 'claude', present: true, ready: true, processRunning: true, runDir: root,
    createdAt: now, tmuxTarget: { serverGeneration: '123:5', sessionId: '$1', paneId: '%1' } };
  const faults = [], actions = [], pending = [{ sessionGroup: 'telegram:waiting' }];
  const observe = () => { if (failed) throw Object.assign(new Error('unobservable'), { code: 'TMUX_UNAVAILABLE', cause: 'timeout' }); return [scene]; };
  const base = { connectionOptions: {}, observe, readIdentity(group) { return this.observeGroup(group); }, observeGroup: () => observe()[0], readRun: () => observe()[0], listRuns: observe,
    stop: () => { actions.push('stop'); }, bindTarget: () => { actions.push('bind'); } };
  const guard = new SupervisorServerHealth({ now: () => now, readProcessIdentity: () => failed ? { present: null } : { present: true, pid: 123, created: '1' },
    sendAlert: () => { actions.push('alert'); }, signalProcess: () => { actions.push('signal'); } });
  const scenes = new Observation(base, { guard, open: async () => ({ close() {} }), readGeneration: () => '123:5' });
  const db = { getModeTransition: () => null, listDrainFences: () => [], getDrainFence: () => null,
    listPendingSessionGroups: () => pending, getControlById: () => null,
    insertControl: () => { actions.push('control'); }, setDrainFence: () => { actions.push('fence'); },
    resolveSessionLaunchConfig: () => ({ runtime: 'claude', mode: 'default' }) };
  const supervisor = createSupervisor({ db, scenes, zylosDir: root, env: { ZYLOS_DIR: root }, now: () => now,
    readConfiguration: () => ({ mode: 'multi', runtime: 'claude', capacity: 1 }), readMode: () => ({ mode: 'multi' }),
    resolveTargetRuntime: () => 'claude', requestStore: new RestartRequestStore({ file: path.join(root, 'requests.json') }),
    checkAuth: () => { actions.push('auth'); return { status: 'uncertain' }; }, matchScreen: () => ({}), log: e => faults.push(e),
    loopOptions: { schedule: () => 1, cancel: () => {} } });
  t.after(async () => { await supervisor.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  const configuration = await supervisor.loop.deps.readConfiguration();
  for (const runtime of ['claude', 'codex']) {
    const store = supervisor.health.store(runtime), state = store.read(); state.health = 'unavailable'; store.write(state);
  }
  const healthBefore = ['claude', 'codex'].map(runtime => fs.readFileSync(supervisor.health.store(runtime).file, 'utf8'));
  const statusPath = path.join(root, 'agent-status.json'); fs.writeFileSync(statusPath, 'unchanged-status');
  await supervisor.loop.deps.observeExits(await scenes.observe());
  failed = true;
  const unknown = await scenes.observe();
  await assert.rejects(supervisor.lifecycle.checkEviction(unknown, { configuration,scenes:unknown,fences:[],restartRequests:[],transition:null }), {code:'TMUX_UNAVAILABLE'});
  assert.equal(unknown[0].present, true); assert.equal(unknown[0].runId, null); assert.equal(unknown[0].ready, false);
  await supervisor.loop.deps.observeExits(unknown);
  await supervisor.loop.deps.probeAndPublish(unknown[0], {});
  await supervisor.loop.deps.writeMetricsAndMaintain({scenes:unknown,fences:[]});
  while (supervisor.observer.preparations.size) await Promise.all([...supervisor.observer.preparations]);
  assert.deepEqual(actions, []);
  assert.deepEqual(['claude', 'codex'].map(runtime => fs.readFileSync(supervisor.health.store(runtime).file, 'utf8')), healthBefore);
  assert.equal(fs.readFileSync(statusPath, 'utf8'), 'unchanged-status');
  const metrics = fs.readFileSync(path.join(root, 'activity-monitor', 'pool-metrics.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(metrics.ready, 0); assert.equal(metrics.starting, 1); assert.equal(metrics.waiting, 1);
  assert.equal(supervisor.observer.probes.size, 0);
  const diagnosticPath = path.join(root, 'activity-monitor', 'supervisor-events.jsonl');
  const diagnostics = fs.existsSync(diagnosticPath) ? fs.readFileSync(diagnosticPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  assert.ok(!diagnostics.some(row => row.event === 'crash_detected'));
  assert.deepEqual(faults, []);
  await assert.rejects(scenes.readRun(scene.sessionGroup), { code: 'TMUX_UNAVAILABLE' });
}
test('composed unknown server preserves occupancy, and without exit or recovery actions', async t => {
  await scenario(t, SupervisorServerObservation);
});
