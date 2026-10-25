import path from 'node:path';
import { createRequire } from 'node:module';
import { startSupervisor } from '../../supervisor-main.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
const Database=createRequire(new URL('../../../../comm-bridge/package.json',import.meta.url))('better-sqlite3');
const [socketPath,binary,pause]=process.argv.slice(2),root=process.env.ZYLOS_DIR;
const database=new Database(path.join(root,'comm-bridge/c4.db'));
const db=createStore(database,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'multi'}})});
async function barrier(name){if(pause===name){process.send({barrier:name});await new Promise(()=>{});}}
const scenes=new SupervisorScenes({env:process.env,connectionOptions:{socketPath,binary},readMode:()=>({mode:'multi'}),readActivity:()=>({state:'idle',idleSince:1}),readUsage:()=>null});
const stop=scenes.stop.bind(scenes);scenes.stop=async scene=>{await barrier('before-stop');await stop(scene);await barrier('after-stop');};
const service=await startSupervisor({env:process.env,db:{...db,getDb:()=>database},scenes,
 readMode:()=>({mode:'multi'}),readConfiguration:()=>({mode:'multi',runtime:'claude',capacity:2}),resolveTargetRuntime:()=> 'claude',
 readSyncMarker:()=>({held:false,stale:false}),restoreTransition:async()=>{await barrier('after-fence');if(pause==='clear-fence')db.clearDrainFence('origin',{expectedReason:'upgrade',expectedRunId:'run-1'});},
 machineTasks:{tick(){},stop(){}},legacyStatus:{tick(){},close(){}},sendAlert:()=>{throw new Error('No external send');},log:()=>{},loopOptions:{schedule:()=>1,cancel:()=>{}}});
process.send({ready:true,fence:db.getDrainFence('origin'),present:(await scenes.observeGroup('origin')).present});
process.on('message',async command=>{if(command==='stop'){await service.stop();database.close();process.send({stopped:true});process.disconnect();}});
