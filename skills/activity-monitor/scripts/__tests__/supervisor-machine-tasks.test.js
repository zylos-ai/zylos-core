import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { enqueueMachineControl } from '../machine-control.js';
import { SupervisorMachineTasks } from '../supervisor-machine-tasks.js';

test('IF-17 all machine notices select Origin in multi and NULL single without fallback',async()=>{
  for(const mode of ['single','multi']) {
    let args;const result=await enqueueMachineControl(['enqueue','--content','notice','--priority','3','--no-ack-suffix'],{readMode:()=>({mode}),run:input=>{args=input;return {ok:false,output:'TRANSITION_OPEN'};}});
    assert.equal(result.ok,false);assert.equal(args.includes('--group'),mode==='multi');
    if(mode==='multi')assert.equal(args.at(-1),'origin');
  }
  await assert.rejects(enqueueMachineControl([],{readMode:()=>{throw new Error('unreadable');},run:()=>{throw new Error('must not run');}}),/unreadable/);
});
function fixture(t,{hour=3,config={}}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'machine-tasks-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls={controls:[],scripts:[]};let now=new Date(2026,9,25,hour).getTime();
  const state={origin:{present:true,ready:true,runtime:'claude',state:'idle',idleSince:now-60000},config:{usage_monitor_enabled:false,usage_alert_enabled:false,health_check_enabled:false,...config}};
  const tasks=new SupervisorMachineTasks({zylosDir:root,readMode:()=>({mode:'multi'}),readConfig:()=>state.config,
    readOriginState:()=>state.origin,readHealth:()=>({health:'ok'}),now:()=>now,
    enqueue:async args=>{calls.controls.push(args);return {ok:true,output:'control 1'};},execute:async script=>{calls.scripts.push(path.basename(script));return '';}});
  t.after(()=>tasks.stop());return {root,calls,state,tasks,setNow:n=>now=n};
}
const settle=async tasks=>Promise.all([...tasks.pending.values()]);
test('T07 daily maintenance runs at preserved hours and records success only after child finishes',async t=>{
  const f=fixture(t);let resolve;f.tasks.execute=script=>{f.calls.scripts.push(path.basename(script));return new Promise(r=>resolve=r);};
  await f.tasks.tick();await f.tasks.tick();assert.deepEqual(f.calls.scripts,['daily-commit.js']);assert.equal(f.tasks.state('daily-memory-commit-state'),null);
  resolve('');await settle(f.tasks);await f.tasks.tick();assert.equal(f.calls.scripts.length,1);assert.ok(f.tasks.state('daily-memory-commit-state').last_date);
  f.setNow(new Date(2026,9,25,6).getTime());f.tasks.execute=async script=>f.calls.scripts.push(path.basename(script));await f.tasks.tick();await settle(f.tasks);
  assert.deepEqual(f.calls.scripts,['daily-commit.js','upgrade-check.js']);
});
test('T07 health and daily upgrade preserve gates; refusal does not mark delivered or retry without scope',async t=>{
  const f=fixture(t,{hour:5,config:{daily_upgrade_enabled:true,health_check_enabled:true}});
  f.tasks.enqueue=async args=>{f.calls.controls.push(args);return {ok:false,output:'TRANSITION_OPEN'};};
  await f.tasks.tick();await settle(f.tasks);assert.equal(f.calls.controls.length,2);
  assert.equal(f.tasks.state('daily-upgrade-state'),null);assert.equal(f.tasks.state('health-check-state'),null);
  f.tasks.enqueue=async args=>{f.calls.controls.push(args);return {ok:true,output:'control 1'};};await f.tasks.tick();await settle(f.tasks);
  assert.ok(f.tasks.state('daily-upgrade-state'));assert.ok(f.tasks.state('health-check-state'));assert.equal(f.calls.controls.length,4);
  await f.tasks.tick();await settle(f.tasks);assert.equal(f.calls.controls.length,4);
});
test('T08 per-runtime account tasks remain single flight and read sampler rather than global usage files',async t=>{
  const f=fixture(t,{hour:10,config:{usage_monitor_enabled:true}});const samples=[];
  f.tasks.readUsage=async runtime=>{samples.push(runtime);return {sevenDay:{usedPercentage:30}};};
  await f.tasks.tick();await settle(f.tasks);
  // Claude preserves its startup delay; Codex can sample on the first eligible tick.
  assert.deepEqual(samples,['codex']);
  f.setNow(new Date(2026,9,25,11,1).getTime());await f.tasks.tick();await settle(f.tasks);
  assert.deepEqual(samples,['codex','claude','codex']);
});
