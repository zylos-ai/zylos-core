import fs from 'node:fs';
import path from 'node:path';
import { startSupervisor } from '../../supervisor-main.js';
let clock=Number(process.argv[2]),current=[],control=null;
const logs=[];
const mutant=process.argv[3],root=process.env.ZYLOS_DIR;
const db={getModeTransition:()=>null,listDrainFences:()=>[],getDrainFence:()=>null,listPendingSessionGroups:()=>[],getControlById:()=>control,insertControl:()=>{control={id:1,status:'pending'};return 1;},resolveSessionLaunchConfig:()=>({runtime:'claude',mode:'default'})};
const scenes={observe:async()=>current,observeGroup:async group=>current.find(s=>s.sessionGroup===group)??{present:false},listRuns:async()=>current,readRun:async()=>null,bindTarget:async s=>({runId:s.runId}),readScreen:async()=>'',stop:async()=>false};
const service=await startSupervisor({now:()=>clock,db,scenes,resolveTargetRuntime:()=> 'claude',matchScreen:()=>({}),legacyStatus:{tick(){},close(){}},machineTasks:{tick(){},stop(){}},sendAlert:()=>{throw new Error('External send forbidden');},log:value=>logs.push(value),loopOptions:{intervalMs:3600000}});
const {health,observer}=service.supervisor;
if(mutant==='clear-budget'){const s=health.store('claude').read();s.scheduling.restartFailureCount=0;s.scheduling.lastRecoveryAt=0;health.store('claude').write(s);}
if(mutant==='early-backoff'){const original=health.registerStartAttempt.bind(health);health.registerStartAttempt=async r=>{clock+=1000;try{return await original(r);}finally{clock-=1000;}};}
if(mutant==='double-result'){const original=health.applyProbeResult.bind(health);health.applyProbeResult=async input=>{await original(input);return original(input);};}
process.send({ready:true,pid:process.pid,state:health.store('claude').read(),logs});
process.on('message',async message=>{try{
  if(message.type==='clock')clock=message.now;
  if(message.type==='due'){process.send({due:await observer.due('claude')});return;}
  if(message.type==='user'){process.send({accelerated:await health.notifyUserMessage('claude'),state:health.store('claude').read()});return;}
  if(message.type==='probe'){
    const runDir=path.join(root,'fixture-run');fs.mkdirSync(runDir,{recursive:true});
    current=[{runtime:'claude',runId:message.runId,sessionGroup:'telegram:one',sessionId:'fixture-session',present:true,ready:true,runDir}];
    const pending=observer.requestProbe('claude',{force:true});await Promise.all([...observer.preparations]);
    control.status='timeout';clock=message.now;await observer.pollProbe(observer.probes.get('claude'));await pending;
    for(const probe of [...observer.probes.values()])await observer.pollProbe(probe);current=[];
  }
  if(message.type==='stop'){await service.stop();process.send({stopped:true});process.disconnect();return;}
  process.send({state:health.store('claude').read(),probes:observer.probes.size});
}catch(error){process.send({error:error.stack});}});
