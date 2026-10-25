import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { startSupervisor } from '../supervisor-main.js';
import { RestartRequestStore } from '../restart-request-store.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
const Database=createRequire(new URL('../../../comm-bridge/package.json',import.meta.url))('better-sqlite3');
async function fixture(t,kind,mutant=false){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'entry-negative-'));fs.mkdirSync(path.join(root,'comm-bridge'));fs.mkdirSync(path.join(root,'activity-monitor'));
 const database=new Database(path.join(root,'comm-bridge/c4.db'));guardDatabase(database,schema);
 const db=createStore(database,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'multi'}})});
 const file=path.join(root,'activity-monitor/restart-requests.json'),requests=new RestartRequestStore({file});
 if(kind==='corrupt')fs.writeFileSync(file,'{unreadable-original');
 if(kind==='corrupt'&&mutant){const read=requests.read.bind(requests);requests.read=()=>{try{return read();}catch{requests.write([]);return [];}};}
 let gateWrites=0;
 const scene={runId:'run-1',ready:true,launchConfig:{runtime:'claude',mode:'default'}};
 const service=await startSupervisor({env:{...process.env,ZYLOS_DIR:root},db:{...db,getDb:()=>database,resolveSessionLaunchConfig:()=>({runtime:'codex',mode:'default'}),setDrainFence:(...args)=>{gateWrites++;return db.setDrainFence(...args);}},
 scenes:{observe:async()=>[],observeGroup:async()=>({present:false}),listRuns:async()=>[{runId:'run-1'}],readRun:async()=>scene},requestStore:requests,
 readMode:()=>({mode:'multi'}),readConfiguration:()=>({mode:'multi',runtime:'claude',capacity:2}),resolveTargetRuntime:()=> 'claude',
 // Successful config admission requires an explicitly available Sync reader.
 readSyncMarker:()=>({held:false,stale:false}),
 machineTasks:{tick(){},stop(){}},legacyStatus:{tick(){},close(){}},log:()=>{},loopOptions:{schedule:()=>1,cancel:()=>{}}});
 t.after(async()=>{await service.stop();database.close();fs.rmSync(root,{recursive:true,force:true});});
 if(kind==='duplicate'&&mutant){const owner=service.supervisor.admission,config=owner.config.bind(owner);owner.config=async(request,rows)=>{if(await owner.db.getDrainFence(request.sessionGroup))await owner.db.setDrainFence(request.sessionGroup,{reason:'model_config',runId:request.expectedRunId});return config(request,rows);};}
 async function request(value){const socket=net.createConnection(path.join(root,'activity-monitor/am.sock'));await once(socket,'connect');socket.write(JSON.stringify(value)+'\n');let result='';for await(const chunk of socket)result+=chunk;return JSON.parse(result);}
 return {file,request,writes:()=>gateWrites,db};
}
async function corruptScenario(t,mutant){
 const f=await fixture(t,'corrupt',mutant);
 const response=await f.request({version:1,type:'restart_all',requestId:'corruption',reason:'upgrade'});
 assert.equal(response.code,'requests_unreadable');assert.equal(fs.readFileSync(f.file,'utf8'),'{unreadable-original');assert.deepEqual(f.db.listDrainFences(),[]);
}
test('IF-34 actual entry refuses corrupt F9 and detects reset-to-empty recovery implementation',async t=>{await corruptScenario(t,false);await assert.rejects(corruptScenario(t,true),{code:'ERR_ASSERTION'});});
async function duplicateScenario(t,mutant){
 const f=await fixture(t,'duplicate',mutant),request={version:1,type:'ready_for_config_reclaim',requestId:'config-retry',sessionGroup:'telegram:one',expectedRunId:'run-1'};
 assert.equal((await f.request(request)).result,'accepted');assert.equal(f.writes(),1);
 assert.equal((await f.request(request)).result,'already_accepted');assert.equal(f.writes(),1);assert.equal(f.db.listDrainFences().length,1);
}
test('IF-35 actual entry config retry performs no second gate insertion attempt; duplicate-write implementation fails',async t=>{await duplicateScenario(t,false);await assert.rejects(duplicateScenario(t,true),{code:'ERR_ASSERTION'});});
