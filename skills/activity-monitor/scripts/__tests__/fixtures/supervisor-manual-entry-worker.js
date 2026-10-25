import path from 'node:path';
import { createRequire } from 'node:module';
import { startSupervisor } from '../../supervisor-main.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
import { RestartRequestStore } from '../../restart-request-store.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
const Database=createRequire(new URL('../../../../comm-bridge/package.json',import.meta.url))('better-sqlite3');
const [socketPath,binary,mode,pause]=process.argv.slice(2),root=process.env.ZYLOS_DIR;
const database=new Database(path.join(root,'comm-bridge/c4.db'));
const db=createStore(database,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:mode}})});
let holding=true;
const requests=new RestartRequestStore({file:path.join(root,'activity-monitor/restart-requests.json')}),publish=requests.publish;
requests.publish=(...args)=>{if(pause==='before-remove'&&args[1].length===0){process.send({barrier:'before-remove'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}publish(...args);if(pause==='after-remove'&&args[1].length===0){process.send({barrier:'after-remove'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}if(pause==='commit'){process.send({barrier:'committed'});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}};
const scenes=new SupervisorScenes({env:process.env,connectionOptions:{socketPath,binary},readMode:()=>({mode}),readActivity:()=>({state:'idle',idleSince:1}),readUsage:()=>null});
const observe=scenes.observeGroup.bind(scenes);scenes.observeGroup=async group=>{const scene=await observe(group);return holding&&scene.present?{...scene,processRunning:undefined}:scene;};
const originalStop=scenes.stopFixedTarget.bind(scenes);
if(pause==='retarget')scenes.stopFixedTarget=async()=>{const replacement=await observe(mode==='single'?null:'origin');await originalStop({expectedRunId:replacement.runId,tmuxTarget:replacement.tmuxTarget});};
const service=await startSupervisor({env:process.env,db:{...db,getDb:()=>database,getModeTransition:()=>holding?{phase:'fixture_hold'}:db.getModeTransition()},scenes,requestStore:requests,
 readMode:()=>({mode}),readConfiguration:()=>({mode,runtime:'claude',capacity:2}),resolveTargetRuntime:()=> 'claude',readSyncMarker:()=>({held:false,stale:false}),
 machineTasks:{tick(){},stop(){}},legacyStatus:{tick(){},close(){}},sendAlert:()=>{throw new Error('No external send');},log:()=>{},loopOptions:{schedule:()=>1,cancel:()=>{}}});
process.send({ready:true});
process.on('message',async command=>{try{
 if(command==='release')holding=false;
 if(command==='tick')await service.supervisor.loop.tick();
 if(command==='stop'){await service.stop();database.close();process.send({stopped:true});process.disconnect();return;}
 process.send({requests:requests.read(),fences:db.listDrainFences()});
}catch(error){process.send({error:error.stack});}});
