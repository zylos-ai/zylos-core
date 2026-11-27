import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSupervisor } from '../supervisor.js';
import { PENDING_MAX_AGE_SECONDS } from '../../../comm-bridge/scripts/c4-config.js';
import { RestartRequestStore } from '../restart-request-store.js';
function fixture(t,{batchIdentities,badRequests=false,readMode=()=>({mode:'multi'}),resolveLaunchConfig=()=>({runtime:'claude',mode:'default'}),consumeHealthEvents,readConfiguration=async()=>({mode:'multi',runtime:'claude',capacity:2}),checkAuth=async()=>({status:'uncertain'}),alert,now=Date.now,database={},prepareReferenceReorg,prompts,resolveTargetRuntime=async()=> 'claude'}={}) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'supervisor-assembly-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const file=path.join(root,'requests.json');if(badRequests)fs.writeFileSync(file,'broken');
 const calls=[],db={getOriginNeed:()=>({controls:{count:0},inbound:{oldestAt:null}}),getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,listSlotOccupancy:()=>[],pruneSlots:()=>({deletedHeld:0,deletedOrphans:[]}),listPendingContinuations:()=>[],listRunEndings:()=>[],getLastCompletedModeTransition:()=>null,listPendingSessionGroups:()=>[],getLatestContentCheckpoint:()=>null,getControlById:()=>null,resolveSessionLaunchConfig:resolveLaunchConfig,...database};
 const scenes={observe:async()=>[],readIdentity(group) { return this.observeGroup(group); }, observeGroup:async()=>({present:false}),listRuns:async()=>[],readRun:async()=>null};
 if(batchIdentities)scenes.readIdentities=batchIdentities;
 const supervisor=createSupervisor({db,scenes,zylosDir:root,env:{ZYLOS_DIR:root},readConfiguration,readMode,resolveTargetRuntime,requestStore:new RestartRequestStore({file}),consumeHealthEvents,checkAuth,alert,now,prepareReferenceReorg,prompts,log:item=>calls.push(item),loopOptions:{schedule:()=>1,cancel:()=>{}}});
 t.after(()=>supervisor.stop());return {supervisor,calls,file,root,scenes,db};
}

// Exercise the real Supervisor assembly and socket dispatch, with private paths
// and live-run scene data supplied by the existing isolated fixture.

test('shutdown: accepted lifecycle mutation finishes before Supervisor stop resolves',async t=>{
 const {supervisor}=fixture(t);supervisor.admission.openEntry();
 let release,entered;const running=new Promise(resolve=>{entered=resolve;});
 const barrier=new Promise(resolve=>{release=resolve;});let written=false;
 const accepted=supervisor.admission.serialize(async()=>{entered();await barrier;written=true;});
 await running;let stopped=false;const stopping=supervisor.stop().then(()=>{stopped=true;});
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(supervisor.admission.open,false);assert.equal(stopped,false);assert.equal(written,false);
 release();await accepted;await stopping;assert.equal(written,true);assert.equal(stopped,true);
});

// Boundary: real supervisor admission -> activity facts -> control insertion. Scenes/DB/clock are private injected objects; no native
// process, network or service is started. Run for quiet-turn/admission changes;
// unrelated UI work may skip. The official runner isolates all runtime paths.
for(const runtime of ['claude','codex','agy'])test(`assembled ${runtime} quiet-turn interruption queues one Escape before allowing idle`,async t=>{
 let now=1000;const controls=[];
 const f=fixture(t,{now:()=>now,database:{insertControl:(content,options)=>{controls.push({content,...options});return {id:controls.length};}}});
 const scene={sessionGroup:'a',runDir:f.root,runId:'r',sessionId:'s',runtime,createdAt:0,present:true,ready:true};
 f.scenes.readIdentity=async()=>scene;
 f.scenes.bindTarget=async()=>({expectedRunId:'r',tmuxTarget:{serverGeneration:'1:1',sessionId:'$1',paneId:'%1'}});
 const file=path.join(f.root,'events.jsonl');
 fs.writeFileSync(file,JSON.stringify({run_id:'r',session_id:'s',runtime,ts:1000,event:'prompt'})+'\n');
 if(runtime==='agy')fs.writeFileSync(path.join(f.root,'statusline.json'),JSON.stringify({session_id:'s',agent_state:'working',zylos:{v:1,runId:'r',capturedAt:1000}}));
 now=1000+20*60*1000-1;
 assert.equal(await f.supervisor.interruptQuietTurn(scene),false);assert.equal(controls.length,0);
 assert.equal(f.supervisor.readActivity(scene).state,'busy');
 now++;
 assert.equal(await f.supervisor.interruptQuietTurn(scene),true);
 assert.equal(controls.length,1);assert.equal(controls[0].content,'[KEYSTROKE]Escape');
 assert.equal(controls[0].priority,0);assert.equal(controls[0].bypassState,true);assert.equal(controls[0].appendAckSuffix,false);
 assert.equal(controls[0].targetBinding.expectedSessionId,'s');
 if(runtime==='agy') {assert.equal(f.supervisor.readActivity(scene).state,'busy');now+=500;}
 const idle=f.supervisor.readActivity(scene);
 assert.equal(idle.state,'idle');assert.equal(idle.turnOpen,false);assert.equal(idle.lastResponseAt,runtime==='agy'?1000:null);assert.equal(idle.lastActivityAt,1000);
 for(let tick=0;tick<3;tick++){now+=1200000;assert.equal(await f.supervisor.interruptQuietTurn(scene),false);}
 assert.equal(controls.length,1);
 fs.appendFileSync(file,JSON.stringify({run_id:'r',session_id:'s',runtime,ts:now+1,event:'prompt'})+'\n');
 now+=1200001;
 assert.equal(await f.supervisor.interruptQuietTurn(scene),true);assert.equal(controls.length,2);
});

for(const outcome of ['pending','done','unknown'])test(`quiet-turn ${outcome} admission is one-shot across supervisor restart`,async t=>{
 let now=1201000,attempts=0,fail=outcome==='unknown';const controls=[];
 const f=fixture(t,{now:()=>now,database:{insertControl:(content,options)=>{
  attempts++;
  if(fail)throw new Error('uncertain insertion');
  const row={id:controls.length+1,status:outcome==='done'?'done':'pending',content,...options};controls.push(row);return row;
 },getControlById:id=>controls.find(row=>row.id===id)}});
 const scene={sessionGroup:'a',runDir:f.root,runId:'r',sessionId:'s',runtime:'claude',createdAt:0,present:true,ready:true};
 f.scenes.readIdentity=async()=>scene;
 f.scenes.bindTarget=async()=>({expectedRunId:'r',tmuxTarget:{serverGeneration:'1:1',sessionId:'$1',paneId:'%1'}});
 const file=path.join(f.root,'events.jsonl');
 const prompt=ts=>JSON.stringify({run_id:'r',session_id:'s',runtime:'claude',ts,event:'prompt'})+'\n';
 fs.writeFileSync(file,prompt(1000));
 if(fail)await assert.rejects(f.supervisor.interruptQuietTurn(scene),/uncertain insertion/);
 else assert.equal(await f.supervisor.interruptQuietTurn(scene),true);
 await f.supervisor.stop();
 const restarted=createSupervisor({db:f.db,scenes:f.scenes,zylosDir:f.root,env:{ZYLOS_DIR:f.root},
  readConfiguration:async()=>({mode:'multi',runtime:'claude',capacity:2}),readMode:()=>({mode:'multi'}),
  resolveTargetRuntime:async()=> 'claude',requestStore:new RestartRequestStore({file:f.file}),
  now:()=>now,loopOptions:{schedule:()=>1,cancel:()=>{}}});
 t.after(()=>restarted.stop());
 const recovered=restarted.readActivity(scene);
 assert.equal(recovered.state,fail?'busy':'idle');assert.equal(recovered.lastActivityAt,1000);assert.equal(recovered.lastResponseAt,null);
 for(let tick=0;tick<3;tick++){now+=1200000;assert.equal(await restarted.interruptQuietTurn(scene),false);}
 assert.equal(attempts,1);
 const facts=fs.readFileSync(file,'utf8').trim().split('\n').map(line=>JSON.parse(line));
 assert.equal(facts.filter(row=>row.event==='quiet_turn_interrupt_attempt').length,1);
 assert.equal(facts.filter(row=>row.event==='quiet_turn_interrupt').length,fail?0:1);
 fail=false;
 fs.appendFileSync(file,JSON.stringify({run_id:'r',session_id:'s',runtime:'claude',ts:now,event:'stop'})+'\n'+prompt(now+1));now+=1200001;
 assert.equal(await restarted.interruptQuietTurn(scene),true);assert.equal(attempts,2);
});


test('supervisor alerts once per group fence when pending inbound work reaches the age threshold', async t => {
  const oldestAt = 1_800_000_000_000;
  const fence = { sessionGroup: 'chat:blocked', runId: 'run-blocked', reason: 'auth', createdAt: oldestAt / 1000 };
  let now = oldestAt + (PENDING_MAX_AGE_SECONDS - 360) * 1000;
  const alerts = [];
  const { supervisor } = fixture(t, {
    now: () => now,
    alert: async event => { alerts.push(event); },
    database: {
      listGroupQueues: () => ({
        groups: [{ sessionGroup: fence.sessionGroup, fence, pending: { oldestAt, count: 2 } }],
      }),
    },
  });
  const context = { scenes: [], fences: [fence] };
  await supervisor.loop.deps.readConfiguration();
  await supervisor.loop.deps.writeMetricsAndMaintain(context);
  assert.equal(alerts.length, 0);

  now += 60_000;
  await supervisor.loop.deps.writeMetricsAndMaintain(context);
  await supervisor.loop.deps.writeMetricsAndMaintain(context);
  assert.deepEqual(alerts, [{
    event: 'group_fence_backlog', sessionGroup: fence.sessionGroup, reason: fence.reason, count: 2, oldestAt,
  }]);
});
