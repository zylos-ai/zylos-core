import path from 'node:path';
import { createRequire } from 'node:module';
import { startSupervisor } from '../../supervisor-main.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
const Database=createRequire(new URL('../../../../comm-bridge/package.json',import.meta.url))('better-sqlite3');
const [socketPath,binary]=process.argv.slice(2),root=process.env.ZYLOS_DIR;
const database=new Database(path.join(root,'comm-bridge/c4.db'));
const db=createStore(database,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'single'}})});
let pending=false,running=1,controls=0,deadlineLess=0,checks=0,gates=0;
const scenes=new SupervisorScenes({env:process.env,connectionOptions:{socketPath,binary},readMode:()=>({mode:'single'}),readActivity:()=>({state:'idle',idleSince:1}),readUsage:()=>null});
const service=await startSupervisor({env:process.env,db:{...db,getDb:()=>database,listPendingSessionGroups:()=>pending?[{sessionGroup:null}]:[],
 countGlobalRunningConversations:()=>running,countNonTerminalControls:()=>({running:controls,runningWithoutDeadline:deadlineLess}),setDrainFence:()=>{gates++;throw new Error('single auth must not write D8');}},scenes,
 readMode:()=>({mode:'single'}),readConfiguration:()=>({mode:'single',runtime:'claude'}),resolveTargetRuntime:()=> 'claude',checkAuth:async()=>{checks++;return {status:'success'};},readSyncMarker:()=>({held:false,stale:false}),
 machineTasks:{tick(){},stop(){}},legacyStatus:{tick(){},close(){}},sendAlert:()=>{throw new Error('No external send');},log:()=>{},loopOptions:{schedule:()=>1,cancel:()=>{}}});
process.send({ready:true});
process.on('message',async command=>{try{
 if(command==='pending')pending=true;
 if(command==='idle')running=0;
 if(command==='finite')controls=1;
 if(command==='deadline-less')deadlineLess=1;
 if(command==='tick')await service.supervisor.loop.tick();
 if(command==='stop'){await service.stop();database.close();process.send({stopped:true});process.disconnect();return;}
 process.send({health:service.supervisor.health.store('claude').read().health,checks,gates,fences:db.listDrainFences(),targets:service.supervisor.health.authTargets('claude').map(s=>s.runId),present:(await scenes.observeGroup(null)).present});
}catch(error){process.send({error:error.stack});}});
