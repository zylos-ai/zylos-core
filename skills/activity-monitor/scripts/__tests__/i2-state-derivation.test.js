import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {SessionActivity} from '../session-activity.js';
import {publishSessionStatus} from '../status-writer.js';
import {publishContextSample} from '../context-monitor.js';
import {RuntimeHealthCoordinator} from '../runtime-health.js';
import {SupervisorHealthObserver} from '../supervisor-health-observer.js';
import {appendEvent, rotateEventLog} from '../../../../cli/lib/event-log.js';

function fixture(t,runtime) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'i2-state-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let clock=1792000000000;
 const scene={sessionGroup:'origin',runtime,runId:'r',sessionId:'s',ready:true,present:true};
 const activity=new SessionActivity({runDir:root,runId:'r',sessionId:'s',runtime,startedAt:clock});
 t.after(()=>activity.close());
 const row=(event,more={})=>({v:1,run_id:'r',session_id:'s',runtime,ts:clock,event,...more});
 const health=new RuntimeHealthCoordinator({zylosDir:root,now:()=>clock,readMode:()=> 'multi',resolveTargetRuntime:()=>runtime,listScenes:()=>[scene]});
 const captures=[],interrupts=[],stops=[],errors=[];
 const observer=new SupervisorHealthObserver({coordinator:health,now:()=>clock,listScenes:()=>[scene],readIdentity:()=>scene,
  readState:()=>activity.read(clock),readMode:()=> 'multi',readScreen:()=>{captures.push(clock);return '> Ready for your next request';},matchScreen:()=>({}),
  resolveToolRule:()=>({watchdog:{enabled:true,maxRuntimeSec:10,interruptKey:'Escape',interruptGraceSec:5,cooldownSec:2}}),
  interrupt:()=>{interrupts.push(clock);return {ok:true};},stop:()=>{stops.push(clock);return true;},log:error=>errors.push(error)});
 t.after(()=>observer.shutdown());
 const publish=()=>publishSessionStatus({statusFile:path.join(root,'agent-status.json'),scene,activity:activity.read(clock),health:health.store(runtime).read(),now:clock});
 return {root,activity,row,observer,captures,interrupts,stops,errors,publish,get now(){return clock;},advance:ms=>clock+=ms,
  delivered:()=>observer.notifyDelivered({...scene,pastedAt:clock}),
  freshStatus:()=>publishContextSample({session_id:'s',context_window:{used_percentage:1}},{env:{ZYLOS_DIR:root,ZYLOS_RUN_ID:'r'},now:clock})};
}
function assertActive(f) {
 const state=f.publish();
 assert.equal(state.state,'busy','a visible prompt must not complete a tool');
 assert.equal(state.active_tools,1);
 assert.deepEqual(state.active_tool_details.map(tool=>tool.id),['active']);
 assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.root,'agent-status.json'))),JSON.parse(JSON.stringify(state)));
}
for(const runtime of ['claude','codex']) {
 test(`P05 state derivation: ${runtime} prompt screen, fresh statusline and interrupt cannot complete a tool`,async t=>{
  const f=fixture(t,runtime);f.activity.consume([f.row('pre_tool',{tool_use_id:'active',tool:'Bash'})]);
  f.delivered();f.advance(5000);f.freshStatus();await f.observer.tick();
  assert.equal(f.captures.length,1);assertActive(f);
  f.advance(5000);await f.observer.tick();assert.equal(f.interrupts.length,1);assertActive(f);
  f.advance(5000);f.freshStatus();await f.observer.tick();assert.equal(f.stops.length,0);assertActive(f);
  f.advance(1);await f.observer.tick();assert.equal(f.stops.length,1);assertActive(f);
  // Positive evidence is an actual hook, independently of a screen or statusline.
  f.activity.consume([f.row('post_tool',{tool_use_id:'active'})]);f.advance(3001);
  assert.equal(f.publish().active_tools,0);assert.equal(f.publish().state,'idle');assert.deepEqual(f.errors,[]);
 });
 test(`P05 state derivation negative control: ${runtime} screen-clears-tools is rejected by the same F4 assertion`,async t=>{
  const f=fixture(t,runtime);f.activity.consume([f.row('pre_tool',{tool_use_id:'active',tool:'Bash'})]);
  assertActive(f);
  const capture=f.observer.readScreen;
  f.observer.readScreen=()=>{const screen=capture();f.activity.tools.clear();return screen;};
  f.delivered();f.advance(5000);await f.observer.tick();assert.equal(f.captures.length,1);
  assert.throws(()=>assertActive(f),{code:'ERR_ASSERTION'});
 });
 test(`P05 state derivation: ${runtime} continuous rotations and disappearing directory preserve factual tools`,t=>{
  const f=fixture(t,runtime),log=path.join(f.root,'events.jsonl');
  appendEvent(log,f.row('pre_tool',{tool_use_id:'a',tool:'Bash'}));
  assert.equal(f.activity.read(f.now).tools.length,1);
  for(let i=0;i<3;i++){
   rotateEventLog(log,{maxBytes:0,now:1000+i});f.advance(1);
   appendEvent(log,f.row('pre_tool',{tool_use_id:`b${i}`,tool:'Read'}));
  }
  appendEvent(log,f.row('post_tool',{tool_use_id:'a'}));
  assert.deepEqual(f.activity.read(f.now).tools.map(tool=>tool.id),['b0','b1','b2']);
  const moved=`${f.root}-moved`;fs.renameSync(f.root,moved);t.after(()=>fs.rmSync(moved,{recursive:true,force:true}));
  assert.deepEqual(f.activity.read(f.now).tools.map(tool=>tool.id),['b0','b1','b2']);
  assert.equal(f.activity.reader.fd,null);
  appendEvent(log,f.row('stop'));f.advance(3001);
  assert.equal(f.activity.read(f.now).tools.length,0);assert.equal(f.activity.read(f.now).state,'idle');
 });
}
