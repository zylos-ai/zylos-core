import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { startSupervisor } from '../supervisor-main.js';
// DM54/IF31: actual entry + SQLite + immutable real tmux target; no memory-only fence fixture.
for(const corruption of ['malformed','unwritable'])test(`entry advances existing durable D8 with corrupt F9 and ${corruption} diagnostic streams`,{timeout:15000},async t=>{
 const f=readyTmuxTarget(t,{prefix:'p05-durable-entry-',mode:'multi'});
 f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const db=createStore(f.db,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'multi'}})});
 db.setDrainFence('origin',{reason:'upgrade',runId:'run-1'});
 const requests=path.join(f.root,'activity-monitor/restart-requests.json');fs.writeFileSync(requests,'invalid retained bytes');
 for(const relative of ['activity-monitor/supervisor-events.jsonl','activity-monitor/pool-metrics.jsonl','comm-bridge/router-events.jsonl']) {
  const file=path.join(f.root,relative);if(corruption==='unwritable')fs.mkdirSync(file);else fs.writeFileSync(file,'bad\n{"event":"restart_done","requestId":"fake","runId":"run-1"}\n');
 }
 const scenes=new SupervisorScenes({env:f.env,connectionOptions:{socketPath:f.socketPath,binary:f.binary},readMode:()=>({mode:'multi'}),readActivity:()=>({state:'idle',idleSince:1}),readUsage:()=>null});
 const logs=[];const service=await startSupervisor({env:f.env,db:{...db,getDb:()=>f.db},scenes,
  readMode:()=>({mode:'multi'}),readConfiguration:()=>({mode:'multi',runtime:'claude',capacity:2}),resolveTargetRuntime:()=> 'claude',
  machineTasks:{tick(){},stop(){}},legacyStatus:{tick(){},close(){}},sendAlert:async()=>{throw new Error('external sends forbidden');},log:value=>logs.push(value),loopOptions:{schedule:()=>1,cancel:()=>{}}});
 t.after(()=>service.stop());
 assert.equal(db.getDrainFence('origin'),null);assert.equal((await scenes.observeGroup('origin')).present,false);assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));
 assert.equal(fs.readFileSync(requests,'utf8'),'invalid retained bytes');assert.equal(service.supervisor.health.store('claude').read().health,'ok');
 assert.ok(logs.some(row=>row?.error==='requests_unreadable'));assert.equal(service.supervisor.admission.open,true);
 const response=await service.supervisor.admission.handle({version:1,type:'restart_all',requestId:'new',reason:'upgrade'});assert.equal(response.code,'requests_unreadable');
 await service.stop();
});
