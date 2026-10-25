import path from 'node:path';
import { createRequire } from 'node:module';
import { startSupervisor } from '../../supervisor-main.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
import { RestartRequestStore } from '../../restart-request-store.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
const Database=createRequire(new URL('../../../../comm-bridge/package.json',import.meta.url))('better-sqlite3');
const [socketPath,binary,pause,authMode]=process.argv.slice(2),root=process.env.ZYLOS_DIR;
const database=new Database(path.join(root,'comm-bridge/c4.db'));
const db=createStore(database,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'multi'}})});
if(pause==='drop-config-gate')db.clearDrainFence('origin',{reason:'model_config',runId:'run-1'});
let holding=true,expectedRuntime=authMode?'claude':'codex',pending=false,running=0,checks=0;
const setFence=db.setDrainFence;db.setDrainFence=(...args)=>{const result=setFence(...args);if(pause==='config-commit'||pause==='auth-fence'&&args[1]?.reason==='auth'){process.send({barrier:pause==='auth-fence'?'auth-fenced':'config-committed'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return result;};
const requests=new RestartRequestStore({file:path.join(root,'activity-monitor/restart-requests.json')});
const publish=requests.publish;
requests.publish=(...args)=>{if(pause!=='memory-only')publish(...args);if(pause==='commit'||pause==='memory-only'){process.send({barrier:'committed'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}};
const scenes=new SupervisorScenes({env:process.env,connectionOptions:{socketPath,binary},readMode:()=>({mode:'multi'}),readActivity:()=>({state:'idle',idleSince:1}),readUsage:()=>null});
// Hold observations during startup so persisted gates can be queried before the next real round.
const observeGroup=scenes.observeGroup.bind(scenes);scenes.observeGroup=async group=>{const scene=await observeGroup(group);return holding&&scene.present?{...scene,processRunning:undefined}:scene;};
const service=await startSupervisor({env:process.env,db:{...db,getDb:()=>database,...(authMode?{listPendingSessionGroups:()=>pending?[{sessionGroup:'origin'}]:[],countRunningConversations:()=>running}:{}),resolveSessionLaunchConfig:()=>({runtime:expectedRuntime,mode:'default'}),getModeTransition:()=>holding?{phase:'fixture_hold'}:db.getModeTransition()},scenes,requestStore:requests,
 readMode:()=>({mode:'multi'}),readConfiguration:()=>({mode:'multi',runtime:'claude',capacity:2}),resolveTargetRuntime:()=> 'claude',
 ...(authMode?{checkAuth:async()=>{checks++;return {status:'success'};},readSyncMarker:()=>({held:false,stale:false})}:{}),
 machineTasks:{tick(){},stop(){}},legacyStatus:{tick(){},close(){}},sendAlert:()=>{throw new Error('No external send');},log:()=>{},loopOptions:{schedule:()=>1,cancel:()=>{}}});
process.send({ready:true});
process.on('message',async command=>{try{
 if(command==='release')holding=false;
 if(command==='pending')pending=true;
 if(command==='busy')running=1;
 if(command==='idle')running=0;
 if(command==='unchanged')expectedRuntime='claude';
 if(command==='changed')expectedRuntime='codex';
 if(command==='clear-config')db.clearDrainFence('origin',{reason:'model_config',runId:'run-1'});
 if(command==='tick')await service.supervisor.loop.tick();
 if(command==='stop'){await service.stop();database.close();process.send({stopped:true});process.disconnect();return;}
 process.send({health:service.supervisor.health.store('claude').read(),checks,authTargets:service.supervisor.health.authTargets('claude'),requests:requests.read(),fences:db.listDrainFences(),present:(await scenes.observeGroup('origin')).present});
}catch(error){process.send({error:error.stack});}});
