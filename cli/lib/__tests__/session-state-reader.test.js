import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installParserFixture } from '../../../test/helpers/p02-parser-fixture.js';
installParserFixture(['origin','lark:x']);
const {createSessionReader}=await import('../session-state-reader-async.js');
const {readRuntimeHealth}=await import('../session-state-reader.js');
const identity={present:true,ready:true,runtime:'claude',runId:'run',sessionId:'session',createdAt:123,serverGeneration:'generation',tmuxSessionId:'$1',paneId:'%1',tmuxName:'zylos-group-lark=x',launchConfig:{runtime:'claude'}};
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'p02-state-'));const dir=path.join(root,'activity-monitor/session-groups/lark:x');fs.mkdirSync(dir,{recursive:true});return {root,dir,env:{ZYLOS_DIR:root},clean:()=>fs.rmSync(root,{recursive:true,force:true})};}
function put(file,value,mtime=1000){fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));fs.utimesSync(file,mtime/1000,mtime/1000);}
const status=()=>({runId:'run',sessionId:'session',marker:'sample'});
const usage=()=>({session_id:'session',zylos:{v:1,runId:'run',capturedAt:1000}});
test('one connection brackets actual file reads I0/sample/I1 and always closes',async()=>{
 const f=fixture();let n=0,closed=0;const connection={close:async()=>{closed++;}};
 try {
  const reader=createSessionReader({env:f.env,now:()=>1100,open:async()=>connection,observe:async({connection:c})=>{
   assert.equal(c,connection);n++;
   if(n===1){put(path.join(f.dir,'agent-status.json'),status());put(path.join(f.dir,'statusline.json'),usage());}
   else {put(path.join(f.dir,'agent-status.json'),{...status(),marker:'after-I1'});put(path.join(f.dir,'statusline.json'),{...usage(),session_id:'after-I1'});}
   return identity;
  }});
  const result=await reader.readSessionState('lark:x',{freshnessMs:200});
  assert.equal(n,2);assert.equal(closed,1);assert.equal(result.status.value.marker,'sample');assert.equal(result.usage.value.session_id,'session');
  assert.equal(result.status.valid,true);assert.equal(result.usage.valid,true);
 }finally{f.clean();}
});
test('ordered invalid reasons retain known timestamps and discard values',async()=>{
 const f=fixture();
 try{
  const cases=[
   {reason:'not_running',first:{...identity,present:false,ready:false},sample:usage()},
   {reason:'starting',first:{...identity,ready:false},sample:usage()},
   {reason:'identity_changed',last:{...identity,runId:'replaced'},sample:usage()},
   {reason:'missing',sample:null,time:null},
   {reason:'unparseable',sample:'{broken',time:null},
   {reason:'version_unknown',sample:{...usage(),zylos:{...usage().zylos,v:2}}},
   {reason:'identity_missing',sample:{...usage(),session_id:undefined}},
   {reason:'identity_mismatch',sample:{...usage(),session_id:'other'}},
   {reason:'stale',sample:usage(),now:1500},
  ];
  for(const row of cases){
   const file=path.join(f.dir,'statusline.json');if(fs.existsSync(file))fs.unlinkSync(file);if(row.sample!==null)put(file,row.sample);
   put(path.join(f.dir,'agent-status.json'),status());let count=0;
   const reader=createSessionReader({env:f.env,now:()=>row.now??1100,open:async()=>({close:async()=>{}}),observe:async()=>++count===1?row.first??identity:row.last??identity});
   const result=await reader.readSessionState('lark:x',{freshnessMs:200});
   assert.deepEqual(result.usage,{value:null,valid:false,reason:row.reason,sampledAt:Object.hasOwn(row,'time')?row.time:1000},row.reason);
  }
  put(path.join(f.dir,'agent-status.json'),'{broken',1000);
  const reader=createSessionReader({env:f.env,now:()=>1100,open:async()=>({close:async()=>{}}),observe:async()=>identity});
  assert.deepEqual((await reader.readSessionState('lark:x',{freshnessMs:200})).status,{value:null,valid:false,reason:'unparseable',sampledAt:1000});
 }finally{f.clean();}
});
test('unknown runtime does not consume usage; I1 observation loss invalidates; open errors preserve uncertainty',async()=>{
 const f=fixture();try{
  put(path.join(f.dir,'statusline.json'),usage());let count=0,closed=0;
  const reader=createSessionReader({env:f.env,now:()=>1100,open:async()=>({close:async()=>{closed++;}}),observe:async()=>({...identity,runtime:'unknown'})});
  assert.equal((await reader.readSessionState('lark:x',{freshnessMs:200})).usage.reason,'missing');
  const lost=createSessionReader({env:f.env,now:()=>1100,open:async()=>({close:async()=>{closed++;}}),observe:async()=>{if(++count===2)throw Object.assign(new Error(),{code:'TMUX_UNAVAILABLE'});return identity;}});
  await assert.rejects(lost.readSessionState('lark:x',{freshnessMs:200}),{code:'TMUX_UNAVAILABLE'});assert.equal(closed,2);
  const error=Object.assign(new Error('timeout'),{code:'TMUX_UNAVAILABLE'});
  await assert.rejects(createSessionReader({open:async()=>{throw error;}}).readLiveIdentity('lark:x'),e=>e===error);
 }finally{f.clean();}
});
test('F10 projection retains historical evidence and never rewrites input',()=>{
 const f=fixture();const old=process.env.ZYLOS_DIR;process.env.ZYLOS_DIR=f.root;
 const dir=path.join(f.root,'activity-monitor/runtime-health');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'claude.json');
 try{
  assert.deepEqual(readRuntimeHealth('claude'),{missing:true});
  const base={v:1,runtime:'claude',health:'recovering',reason:'historical-private-diagnostic',updatedAt:100,hook:{lastError:'old reason'},groups:{'lark:x':{reason:'old reason'}},pendingNotice:{reason:'old reason'},unavailableSince:0,cooldownUntil:0,recoveringStartedAt:0,lastUserMessageRecoveryAt:0,restartFailureCount:0,lastRecoveryAt:0,lastDownCheckAt:0,rateLimitResetTime:''};
  for(const health of ['recovering','down','ok','rate_limited','auth_failed','unavailable']){
   put(file,{...base,health});const bytes=fs.readFileSync(file);const result=readRuntimeHealth('claude');
   assert.equal(result.publicHealth,['recovering','down'].includes(health)?'unavailable':health);assert.equal(result.health,health);assert.equal(result.rateLimitActive,health==='rate_limited');
   assert.deepEqual(result.hook,base.hook);assert.deepEqual(result.groups,base.groups);assert.deepEqual(result.pendingNotice,base.pendingNotice);
   assert.deepEqual(fs.readFileSync(file),bytes);if(health==='ok')assert.equal(result.reason,'');
  }
  for(const rateLimitActive of [true,false]) {
   put(file,{...base,health:'auth_failed',rateLimitActive});const bytes=fs.readFileSync(file);
   assert.equal(readRuntimeHealth('claude').rateLimitActive,rateLimitActive);assert.deepEqual(fs.readFileSync(file),bytes);
  }
  put(file,{...base,rateLimitActive:'true'});assert.deepEqual(readRuntimeHealth('claude'),{unreadable:true});
  put(file,{...base,v:2});assert.deepEqual(readRuntimeHealth('claude'),{unreadable:true});
  put(file,'{broken');assert.deepEqual(readRuntimeHealth('claude'),{unreadable:true});
 }finally{if(old===undefined)delete process.env.ZYLOS_DIR;else process.env.ZYLOS_DIR=old;f.clean();}
});
test('missing server returns absent identity; unexpected observe failure closes held connection',async()=>{
 let observed=0,closed=0;
 const absent=createSessionReader({open:async()=>{throw Object.assign(new Error(),{code:'TMUX_NO_SERVER'});},observe:async()=>{observed++;return identity;}});
 const value=await absent.readLiveIdentity(null);assert.equal(value.present,false);assert.equal(value.tmuxName,'zylos-group-origin');assert.equal(observed,0);
 const error=new Error('unexpected provider failure');
 const failing=createSessionReader({open:async()=>({close:async()=>{closed++;}}),observe:async()=>{throw error;}});
 await assert.rejects(failing.readLiveIdentity('lark:x'),e=>e===error);assert.equal(closed,1);
});
