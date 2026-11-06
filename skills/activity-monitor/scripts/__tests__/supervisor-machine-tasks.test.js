import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { enqueueMachineControl } from '../machine-control.js';
import { SupervisorMachineTasks } from '../supervisor-machine-tasks.js';

test('all machine notices select Origin in multi and NULL single without fallback',async()=>{
  for(const mode of ['single','multi']) {
    let args;const result=await enqueueMachineControl(['enqueue','--content','notice','--priority','3','--no-ack-suffix'],{readMode:()=>({mode}),run:input=>{args=input;return {ok:false,output:'TRANSITION_OPEN'};}});
    assert.equal(result.ok,false);assert.equal(args.includes('--group'),mode==='multi');
    if(mode==='multi')assert.equal(args.at(-1),'origin');
  }
  await assert.rejects(enqueueMachineControl([],{readMode:()=>{throw new Error('unreadable');},run:()=>{throw new Error('must not run');}}),/unreadable/);
});
function fixture(t,{hour=3,config={},mode='multi',runtime='claude'}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'machine-tasks-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls={controls:[],scripts:[]};let now=new Date(2026,9,25,hour).getTime();
  const state={runtime,health:{health:'ok'},config:{usage_monitor_enabled:false,usage_alert_enabled:false,health_check_enabled:false,...config}};
  const tasks=new SupervisorMachineTasks({zylosDir:root,readMode:()=>({mode}),readConfig:()=>state.config,
    resolveTargetRuntime:group=>{assert.equal(group,'origin');return state.runtime;},readHealth:()=>state.health,now:()=>now,
    enqueue:async args=>{calls.controls.push(args);return {ok:true,output:'control 1'};},execute:async script=>{calls.scripts.push(path.basename(script));return '';}});
  t.after(()=>tasks.stop());return {root,calls,state,tasks,tick:context=>tasks.tick(context??{}),setNow:n=>now=n};
}
const settle=async tasks=>Promise.all([...tasks.pending.values()]);
test('daily maintenance runs at preserved hours and records success only after child finishes',async t=>{
  const f=fixture(t);let resolve;f.tasks.execute=script=>{f.calls.scripts.push(path.basename(script));return new Promise(r=>resolve=r);};
  await f.tick();await f.tick();assert.deepEqual(f.calls.scripts,['daily-commit.js']);assert.equal(f.tasks.state('daily-memory-commit-state'),null);
  resolve('');await settle(f.tasks);await f.tick();assert.equal(f.calls.scripts.length,1);assert.ok(f.tasks.state('daily-memory-commit-state').last_date);
  f.setNow(new Date(2026,9,25,6).getTime());f.tasks.execute=async script=>f.calls.scripts.push(path.basename(script));await f.tick();await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['daily-commit.js','upgrade-check.js']);
});
test('health and daily upgrade preserve gates; refusal does not mark delivered or retry without scope',async t=>{
  const f=fixture(t,{hour:5,config:{daily_upgrade_enabled:true,health_check_enabled:true}});
  f.tasks.enqueue=async args=>{f.calls.controls.push(args);return {ok:false,output:'TRANSITION_OPEN'};};
  await f.tick();await settle(f.tasks);assert.equal(f.calls.controls.length,2);
  assert.equal(f.tasks.state('daily-upgrade-state'),null);assert.equal(f.tasks.state('health-check-state'),null);
  f.tasks.enqueue=async args=>{f.calls.controls.push(args);return {ok:true,output:'control 1'};};await f.tick();await settle(f.tasks);
  assert.ok(f.tasks.state('daily-upgrade-state'));assert.ok(f.tasks.state('health-check-state'));assert.equal(f.calls.controls.length,4);
  await f.tick();await settle(f.tasks);assert.equal(f.calls.controls.length,4);
});
test('per-runtime account tasks remain single flight and read sampler rather than global usage files',async t=>{
  const f=fixture(t,{hour:10,config:{usage_monitor_enabled:true}});const samples=[];
  f.tasks.readUsage=async runtime=>{samples.push(runtime);return {sevenDay:{usedPercentage:30}};};
  await f.tick();await settle(f.tasks);
  // Claude preserves its startup delay; Codex can sample on the first eligible tick.
  assert.deepEqual(samples,['codex']);
  f.setNow(new Date(2026,9,25,11,1).getTime());await f.tick();await settle(f.tasks);
  assert.deepEqual(samples,['codex','claude','codex']);
});

test('absent Origin does not prevent daily catch-up and once-per-date checks',async t=>{
  const f=fixture(t,{hour:6});f.state.health={missing:true};
  f.setNow(new Date(2026,9,25,6,30).getTime());
  await f.tick();await settle(f.tasks);await f.tick();await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['upgrade-check.js']);
  f.setNow(new Date(2026,9,26,6,10).getTime());await f.tick();await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['upgrade-check.js','upgrade-check.js']);
});
test('daily upgrade catches up for Claude and stays disabled for Codex',async t=>{
  for(const runtime of ['claude','codex']) {
    const f=fixture(t,{hour:7,runtime,config:{daily_upgrade_enabled:true,upgrade_check_enabled:false}});
    await f.tick();await settle(f.tasks);
    assert.equal(f.calls.controls.length,runtime==='claude'?1:0);
    assert.equal(Boolean(f.tasks.state('daily-upgrade-state')),runtime==='claude');
  }
});
test('disabled maintenance switches prevent work and runtime lookup',async t=>{
  const f=fixture(t,{hour:7,config:{upgrade_check_enabled:false,daily_upgrade_enabled:false,health_check_enabled:false,usage_monitor_enabled:false,usage_alert_enabled:false}});
  f.tasks.resolveTargetRuntime=()=>{throw new Error('not due');};
  await f.tick();await settle(f.tasks);
  assert.deepEqual(f.calls,{controls:[],scripts:[]});
  assert.equal(fs.existsSync(path.join(f.root,'activity-monitor')),false);
});
test('unhealthy target runtimes defer maintenance until same-day recovery',async t=>{
  for(const health of ['auth_failed','rate_limited']) {
    const f=fixture(t,{hour:7,config:{daily_upgrade_enabled:true,health_check_enabled:true}});
    f.state.health={health};await f.tick();await settle(f.tasks);
    assert.deepEqual(f.calls,{controls:[],scripts:[]});
    f.state.health={health:'ok'};await f.tick();await settle(f.tasks);
    assert.deepEqual(f.calls.scripts,['upgrade-check.js']);assert.equal(f.calls.controls.length,2);
  }
});
test('transitions defer all maintenance but preserve the exact-hour memory commit',async t=>{
  const f=fixture(t,{hour:3,config:{daily_upgrade_enabled:true,health_check_enabled:true,usage_monitor_enabled:true}});
  f.tasks.resolveTargetRuntime=()=>{throw new Error('transition must skip runtime reads');};
  await f.tick({transition:{phase:'cutover'}});await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['daily-commit.js']);assert.equal(f.calls.controls.length,0);
  assert.deepEqual(fs.readdirSync(path.join(f.root,'activity-monitor')),['daily-memory-commit-state.json']);
  f.setNow(new Date(2026,9,25,7).getTime());
  await f.tick({transition:{phase:'cutover'}});await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['daily-commit.js']);
  f.tasks.resolveTargetRuntime=()=>f.state.runtime;
  await f.tick();await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['daily-commit.js','upgrade-check.js']);assert.equal(f.calls.controls.length,2);
});
test('null round context fails closed including memory commit and retries next round',async t=>{
  const f=fixture(t);
  await f.tasks.tick(null);await settle(f.tasks);assert.deepEqual(f.calls,{controls:[],scripts:[]});
  assert.equal(fs.existsSync(path.join(f.root,'activity-monitor')),false);
  await f.tick();await settle(f.tasks);assert.deepEqual(f.calls.scripts,['daily-commit.js']);
});
test('single uses its target runtime without requiring a present session',async t=>{
  const f=fixture(t,{hour:6,mode:'single',runtime:'codex',config:{daily_upgrade_enabled:true,health_check_enabled:true}});
  f.state.health={missing:true};f.setNow(new Date(2026,9,25,6,30).getTime());
  await f.tick();await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['upgrade-check.js']);assert.equal(f.calls.controls.length,1);
  assert.match(f.calls.controls[0][2],/^System health check/);assert.equal(f.tasks.state('daily-upgrade-state'),null);
});
test('account alert timing is independent of absent sessions and uses active hours',async t=>{
  const f=fixture(t,{hour:7,config:{upgrade_check_enabled:false,usage_alert_enabled:true}});
  const samples=[];f.tasks.readUsage=async runtime=>{samples.push(runtime);return null;};
  await f.tick();await settle(f.tasks);assert.deepEqual(samples,[]);
  f.setNow(new Date(2026,9,25,8).getTime());await f.tick();await settle(f.tasks);
  assert.deepEqual(samples,['claude','codex']);assert.equal(f.calls.controls.length,0);
});
