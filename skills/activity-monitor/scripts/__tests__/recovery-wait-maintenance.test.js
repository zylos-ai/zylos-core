import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSupervisor } from '../supervisor.js';
import { RestartRequestStore } from '../restart-request-store.js';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-wait-'));
  const state = { now: 1800000000000, scenes: [], pending: [{sessionGroup:'telegram:demand'}],
    fences: [], transition: null, controls: [], stops: [], errors: [], authChecks: [] };
  const db = {
    getModeTransition: () => state.transition,
    getDrainFence: group => state.fences.find(fence => fence.sessionGroup === group) ?? null,
    listDrainFences: () => state.fences,
    listPendingSessionGroups: () => state.pending,
    listPendingContinuations: () => [],
    getOriginNeed: () => ({controls:{count:0},inbound:{oldestAt:null}}),
    insertControl: (content, options) => {
      const row = {id:state.controls.length + 1,status:'pending',content,...options};
      state.controls.push(row);
      return row;
    },
    getControlById: id => state.controls.find(row => row.id === id),
  };
  const scenes = {
    observe: () => state.scenes,
    readIdentity: group => state.scenes.find(scene => scene.sessionGroup === group) ?? {present:false},
    observeGroup: group => state.scenes.find(scene => scene.sessionGroup === group) ?? {present:false},
    listRuns: () => state.scenes,
    readRun: group => state.scenes.find(scene => scene.sessionGroup === group),
    readScreen: () => '',
    bindTarget: scene => ({runtime:scene.runtime,runId:scene.runId}),
    stop: scene => state.stops.push(scene.runId),
  };
  const owner = createSupervisor({db,scenes,zylosDir:root,env:{ZYLOS_DIR:root},now:() => state.now,
    readMode:() => ({mode:'multi'}),readConfiguration:() => ({mode:'multi',runtime:'claude'}),
    resolveTargetRuntime:() => 'claude',requestStore:new RestartRequestStore({file:path.join(root,'requests.json')}),
    matchScreen:() => ({}),checkAuth:runtime => { state.authChecks.push(runtime); return {status:'uncertain'}; },alert:() => {},
    log:error => state.errors.push(error),loopOptions:{schedule:() => 1,cancel(){}}});
  t.after(async () => { await owner.stop(); fs.rmSync(root,{recursive:true,force:true}); });
  const writeHealth = (health, scheduling = {}) => {
    const store = owner.health.store('claude'), value = store.read();
    value.health = health;
    value.scheduling = {...value.scheduling,...scheduling};
    store.write(value);
  };
  writeHealth('unavailable');
  const busyScene = (runId = randomUUID()) => {
    const sessionId = randomUUID(), runDir = path.join(root,runId);
    fs.mkdirSync(runDir);
    const scene = {sessionGroup:'telegram:worker',runtime:'claude',runId,sessionId,runDir,
      createdAt:state.now - 10000,present:true,processRunning:true,ready:true};
    fs.writeFileSync(path.join(runDir,'events.jsonl'),JSON.stringify({v:1,runtime:'claude',
      run_id:runId,session_id:sessionId,ts:state.now - 5000,event:'pre_tool',
      tool_use_id:'foreground-tool',tool:'Bash'}) + '\n');
    return scene;
  };
  const tick = async () => {
    await owner.loop.deps.writeMetricsAndMaintain({scenes:state.scenes,fences:state.fences,transition:state.transition});
    await Promise.all([...owner.observer.preparations]);
  };
  return {root,owner,state,writeHealth,busyScene,tick,start:() => owner.loop.deps.readConfiguration()};
}

// Composes the real maintenance callback, demand aggregation, health budget and
// SessionActivity reader. Run when recovery wait reconciliation or its placement
// changes; skip unrelated lifecycle/adapter work. All files are private fixtures;
// scenes/C4 are injected, scheduling is disabled, and owner.stop closes readers.
test('exited scenes clear a wait during backoff before an accepted start creates a new busy run', {timeout:5000}, async t => {
  const f = fixture(t); await f.start();
  f.state.scenes = [f.busyScene()];
  assert.equal(f.owner.readActivity(f.state.scenes[0]).state,'busy');
  await f.tick();
  const oldWait = f.state.now;
  assert.equal(f.owner.observer.recoveryWaits.get('claude'),oldWait);
  assert.equal(f.state.controls.length,0);
  const rejected = await f.owner.health.registerStartAttempt({version:1,type:'start_attempt',
    requestId:`sa-${f.state.now}-123456789abc`,runtime:'claude',sessionGroup:'telegram:worker',runId:randomUUID()});
  assert.equal(rejected.ok,false);
  assert.equal(rejected.code,'scene_present');

  f.writeHealth('unavailable',{restartFailureCount:4,lastRecoveryAt:f.state.now / 1000});
  f.state.now += 1000;
  f.state.scenes = [];
  assert.equal(await f.owner.observer.due('claude'),false);
  await f.tick();
  assert.equal(f.owner.observer.recoveryWaits.has('claude'),false);

  f.state.now = oldWait + 3600000;
  const runId = randomUUID();
  const reply = await f.owner.health.registerStartAttempt({version:1,type:'start_attempt',
    requestId:`sa-${f.state.now}-123456789abc`,runtime:'claude',sessionGroup:'telegram:worker',runId});
  assert.equal(reply.ok,true);
  assert.equal(reply.result,'registered');
  assert.equal(f.owner.health.store('claude').read().scheduling.lastRecoveryAt,f.state.now / 1000);

  f.state.now += 3600000;
  f.state.scenes = [f.busyScene(runId)];
  assert.equal(await f.owner.observer.due('claude'),true);
  await f.tick();
  assert.equal(f.state.controls.length,0,'an expired wait from the exited run cannot force a heartbeat');
  assert.equal(f.owner.observer.recoveryWaits.get('claude'),f.state.now);
  assert.equal(f.owner.health.associations.get('claude').runId,runId);
  assert.equal(f.state.stops.length,0);
  assert.equal(f.state.errors.length,0);
});

test('starting scenes and closed gates clear waits on a tick when recovery is not due', {timeout:5000}, async t => {
  for (const gate of ['starting','group fence','global fence','mode transition']) {
    await t.test(gate,async t => {
      const f = fixture(t); await f.start(); f.state.scenes = [f.busyScene()];
      await f.tick();
      assert.equal(f.owner.observer.recoveryWaits.has('claude'),true);
      f.writeHealth('unavailable',{restartFailureCount:4,lastRecoveryAt:f.state.now / 1000});
      f.state.now += 1000;
      if (gate === 'starting') f.state.scenes[0].ready = false;
      if (gate === 'group fence') f.state.fences = [{sessionGroup:'telegram:worker'}];
      if (gate === 'global fence') f.state.fences = [{sessionGroup:'*'}];
      if (gate === 'mode transition') f.state.transition = {phase:'gating'};
      assert.equal(await f.owner.observer.due('claude'),false);
      await f.tick();
      assert.equal(f.owner.observer.recoveryWaits.has('claude'),false);
      f.state.fences = []; f.state.transition = null; f.state.scenes[0].ready = true;
      f.state.now += 3600000;
      await f.tick();
      assert.equal(f.state.controls.length,0);
      assert.equal(f.owner.observer.recoveryWaits.get('claude'),f.state.now);
      assert.equal(f.state.stops.length,0);
      assert.equal(f.state.errors.length,0);
    });
  }
});

test('absent demand and terminal health clear waits during ordinary maintenance', {timeout:5000}, async t => {
  for (const reason of ['no demand','ok','auth_failed']) {
    await t.test(reason,async t => {
      const f = fixture(t); await f.start(); f.state.scenes = [f.busyScene()];
      await f.tick();
      assert.equal(f.owner.observer.recoveryWaits.has('claude'),true);
      if (reason === 'no demand') f.state.pending = [];
      else f.writeHealth(reason);
      await f.tick();
      assert.equal(f.owner.observer.recoveryWaits.has('claude'),false);
      assert.equal(f.state.controls.length,0);
      assert.equal(f.state.stops.length,0);
      assert.equal(f.state.errors.length,0);
    });
  }
});

test('an uninterrupted busy wait forces the next due heartbeat after thirty minutes', {timeout:5000}, async t => {
  const f = fixture(t); await f.start(); f.state.scenes = [f.busyScene()];
  await f.tick();
  const oldWait = f.state.now;
  f.state.now += 1800000;
  await f.tick();
  assert.equal(f.state.controls.length,1);
  assert.equal(f.state.controls[0].targetBinding.runId,f.state.scenes[0].runId);
  assert.equal(f.state.controls[0].ackDeadlineAt,f.state.now / 1000 + 120);
  assert.equal(f.owner.observer.recoveryWaits.get('claude'),oldWait);
  assert.equal(f.state.stops.length,0);
  assert.equal(f.state.errors.length,0);
});

// Same isolated maintenance composition as above. Run for maintenance error
// boundaries; skip unrelated adapters. No processes, services or live files.
test('failed wait reconciliation reports the error and preserves later maintenance', {timeout:5000}, async t => {
  const f = fixture(t); await f.start();
  f.writeHealth('auth_failed');
  const demand = [];
  f.owner.observer.reconcileRecoveryWaits = async () => { throw new Error('wait read failed'); };
  f.owner.observer.driveDemand = runtime => demand.push(runtime);
  await f.tick();
  assert.deepEqual(demand, ['claude']);
  assert.deepEqual(f.state.errors, [{error:'wait read failed',phase:'recovery-wait'}]);
  const file = path.join(f.root,'activity-monitor','pool-metrics.jsonl');
  const metrics = fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(metrics.length,1);
  assert.equal(metrics[0].waiting,1);
  assert.deepEqual(f.state.authChecks,['claude']);
  assert.equal(f.state.stops.length,0);
});
