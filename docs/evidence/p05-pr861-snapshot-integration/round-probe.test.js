import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createSupervisor } from '../supervisor.js';
import { SupervisorScenes } from '../supervisor-scenes.js';
import { SupervisorServerObservation } from '../supervisor-server-observation.js';
import { SupervisorServerHealth } from '../supervisor-server-health.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { readProcessTree } from '../../../../cli/lib/runtime/session-target.js';
import { groupRunDir, tmuxNameForGroup } from '../../../../cli/lib/session-group-paths.js';

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
for (const groupCount of [1,4]) test(`B2 real quiet composed round, ${groupCount} groups`, {timeout:60000}, async t => {
  const f=readyTmuxTarget(t,{prefix:'p05-round-probe-',mode:'multi',runtimeProcess:true,ledger:false});
  let clock=Date.now();
  const groups=['origin',...Array.from({length:groupCount-1},(_,i)=>`telegram:probe${i}`)];
  for(const [i,group] of groups.entries()) {
    if(group==='origin')continue;
    const runDir=groupRunDir(group,f.env);fs.mkdirSync(runDir,{recursive:true});
    fs.writeFileSync(path.join(runDir,'current-session.json'),JSON.stringify({runId:`run-${i+1}`,sessionId:`session-${i+1}`,ts:clock,startupControlIds:[]}));
    f.tmux('new-session','-d','-s',tmuxNameForGroup(group),'-e',`ZYLOS_RUN_ID=run-${i+1}`,
      '-e',`ZYLOS_SESSION_GROUP=${group}`,'-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',path.join(f.root,'claude'));
  }
  const trace=path.join(f.root,'tmux-invocations'),binary=path.join(f.root,'counted-tmux');
  fs.writeFileSync(trace,'');
  // Shell append counts actual execs; setup/cleanup use the helper's original binary.
  fs.writeFileSync(binary,`#!/bin/sh\nprintf '%s\\n' "$$" >> ${quote(trace)}\nexec ${quote(f.binary)} "$@"\n`,{mode:0o700});
  const counts={};const bump=name=>counts[name]=(counts[name]??0)+1;
  const base=new SupervisorScenes({env:f.env,connectionOptions:{socketPath:f.socketPath,binary},readMode:()=>({mode:'multi'}),now:()=>clock,
    readActivity:()=>({state:'idle',idleSince:clock}),readUsage:()=>0,
    readProcessTree:()=>{bump('processTree');return readProcessTree();}});
  for(const name of ['observe','observeGroup','readIdentity','readScreen','bindTarget','stop']) {
    const method=base[name].bind(base);base[name]=(...args)=>{bump(name);return method(...args);};
  }
  const logs=[];
  const scenes=new SupervisorServerObservation(base,{guard:new SupervisorServerHealth({now:()=>clock,sendAlert:()=>{throw Error('unexpected outage');}})});
  const empty=()=>({count:0,firstAt:null});
  const db={getModeTransition:()=>{bump('getModeTransition');return null;},
    listDrainFences:()=>{bump('listDrainFences');return [];},getDrainFence:()=>{bump('getDrainFence');return null;},
    getLastActivity:()=>clock,listPendingSessionGroups:()=>[],resolveSessionLaunchConfig:()=>({runtime:'claude',mode:'default'}),
    getGlobalUnsummarizedRange:empty,getUnsummarizedRange:empty,getOriginSyncBacklog:()=>({total:0,groups:[]}),
    insertControl:()=>{throw Error('quiet round inserted control');},getControlById:()=>null};
  const store=new RestartRequestStore({file:path.join(f.root,'requests.json')}),read=store.read.bind(store);
  store.read=()=>{bump('requestStore.read');return read();};
  const supervisor=createSupervisor({db,scenes,env:f.env,zylosDir:f.root,now:()=>clock,
    readConfiguration:()=>({mode:'multi',runtime:'claude',capacity:8}),readMode:()=>({mode:'multi'}),
    requestStore:store,resolveTargetRuntime:()=> 'claude',readSyncMarker:()=>({held:false,stale:false}),
    checkAuth:()=>({status:'uncertain'}),matchScreen:()=>({}),log:value=>logs.push(value),
    loopOptions:{schedule:()=>1,cancel:()=>{}}});
  t.after(()=>supervisor.stop());
  await supervisor.loop.deps.readConfiguration();await supervisor.loop.deps.restore();
  await supervisor.loop.runRound();
  const samples=[];
  for(let i=0;i<5;i++) {
    clock+=61000;fs.writeFileSync(trace,'');for(const key of Object.keys(counts))delete counts[key];logs.length=0;
    const start=performance.now();await supervisor.loop.runRound();const elapsedMs=performance.now()-start;
    const tmuxCalls=fs.readFileSync(trace,'utf8').trim().split('\n').filter(Boolean).length;
    assert.deepEqual(logs,[],'quiet round must not hide errors');
    for(const group of groups)assert.ok(fs.existsSync(path.join(groupRunDir(group,f.env),'agent-status.json')),'health/status pass must run');
    samples.push({tmuxCalls,elapsedMs,counts:{...counts}});
  }
  const times=samples.map(x=>x.elapsedMs).sort((a,b)=>a-b);
  const result={groupCount,samples,medianMs:times[2],maxMs:times.at(-1),tmuxVersion:f.tmux('-V'),
    scope:'createSupervisor composed quiet round including lifecycle, health/status and metrics; synthetic empty database reads, real ready tmux groups and real process sampling; no entry legacy/machine tasks; wrapper overhead included'};
  fs.writeFileSync(path.join(process.env.P05_PROBE_OUTPUT,`groups-${groupCount}.json`),JSON.stringify(result,null,2));
});
