import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import Database from '../../../comm-bridge/node_modules/better-sqlite3/lib/index.js';
import {guardDatabase} from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import {beginRuntimeDelivery,finishRuntimeDelivery} from '../../../comm-bridge/scripts/runtime-delivery.js';
import {processFirstFailureNotices} from '../../../comm-bridge/scripts/first-failure-notice.js';
import {createRuntimeGeneration,runtimeGenerationEnv,readProcessStart} from '../runtime-generation.js';
import {writeHealthQuota,readHealthQuota} from '../health-quota.js';
import {collectHealthHook} from '../hook-health.js';
import {HealthStore} from '../health-store.js';

function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-notice-pipeline-'));
  t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  const generation=createRuntimeGeneration('claude',{zylosDir});
  const identity={...generation,session_id:'session',claude_pid:process.pid,process_start:readProcessStart(process.pid)};
  fs.writeFileSync(path.join(zylosDir,'activity-monitor','foreground-session.json'),JSON.stringify(identity));
  const env={...process.env,...runtimeGenerationEnv(generation),ZYLOS_DIR:zylosDir};
  const db=new Database(path.join(zylosDir,'isolated.db'));guardDatabase(db,schema);t.after(()=>db.close());
  return {zylosDir,identity,env,db,options:{zylosDir,env,pid:process.pid,processStart:identity.process_start}};
}
test('real status-line process -> frozen collector quota -> durable health/notice -> bilingual send',t=>{
  const f=fixture(t);const reset=Math.floor(Date.now()/1000)+3600;
  const status={session_id:'session',rate_limits:{five_hour:{used_percentage:100,resets_at:reset},seven_day:{used_percentage:42,resets_at:reset+86400}},context_window:{used_percentage:0},last_assistant_message:'PRIVATE STATUS'};
  const script=fileURLToPath(new URL('../context-monitor.js',import.meta.url));
  // Keep the shell alive so collector ancestry matches Claude -> shell -> node.
  const child=spawnSync('bash',['-c','node "$1"; result=$?; exit "$result"','quota-test',script],{env:f.env,input:JSON.stringify(status),encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const quota=readHealthQuota({identity:f.identity,zylosDir:f.zylosDir});
  assert.equal(quota.rate_limits.five_hour.used_percentage,100);
  const at=Date.now();
  f.db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status) VALUES (1,'in','fake','group|thread:thread|msg:1','PRIVATE PROMPT','running')").run();
  const item={id:1,type:'conversation',channel:'fake',endpoint_id:'group|thread:thread|msg:1'};
  const delivery=beginRuntimeDelivery(item,f.identity,{database:f.db,now:at-20});
  finishRuntimeDelivery(delivery,item,'submitted',f.identity,{database:f.db,now:at-10});
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit',last_assistant_message:"You've hit your session limit · resets soon PRIVATE RAW"},{...f.options,nowMs:at});
  assert.equal(event.quota.rate_limits.five_hour.used_percentage,100);
  writeHealthQuota({...status,rate_limits:{five_hour:{used_percentage:0,resets_at:reset}}},{...f.options,nowMs:at+1});
  const store=new HealthStore(f.db,{now:()=>at+2});const result=store.consume(event,{identity:f.identity});
  assert.equal(result.notice.noticeCode,'quota_exhausted_reset');
  assert.equal(store.read().reason,'rate_limit_five_hour');
  assert.equal(result.notice.resetAt,reset*1000);
  const intent=f.db.prepare('SELECT * FROM runtime_notice_intents').get();assert.equal(intent.endpoint,item.endpoint_id);
  assert.equal(JSON.parse(intent.notice_json).resetAt,reset*1000);
  assert.doesNotMatch(f.db.prepare('SELECT payload_json FROM runtime_health_events').get().payload_json,/PRIVATE/);
  const sent=[];
  processFirstFailureNotices({database:f.db,identity:()=>f.identity,now:()=>at+3,reserve:(channel,endpoint,route)=>({key:'isolated',attemptId:'isolated',channel,endpoint,...route}),send:(claim,message,route)=>{sent.push({claim,message,route});return {outcome:'sent'};}});
  assert.equal(sent.length,1);assert.match(sent[0].message,/Zylos/);assert.match(sent[0].message,/[\u4e00-\u9fff]/);
  assert.equal(sent[0].route.noticeCode,'quota_exhausted_reset');
});
test('live process mismatch and stale quota stay neutral through real collector and state reducer',t=>{
  const f=fixture(t);const now=Date.now();const status={session_id:'session',rate_limits:{five_hour:{used_percentage:100,resets_at:Math.floor(now/1000)+3600}}};
  writeHealthQuota(status,{...f.options,nowMs:now-60001});
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit'},{...f.options,nowMs:now});
  assert.equal(event.quota,undefined);
  const store=new HealthStore(f.db,{now:()=>now});const result=store.consume(event,{identity:f.identity});
  assert.equal(result.notice.noticeCode,'rate_limited');assert.equal(result.notice.resetAt,null);
  writeHealthQuota(status,{...f.options,nowMs:now});
  const mismatched=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'other',error:'billing_error'},{...f.options,processStart:f.identity.process_start+'0',nowMs:now});
  assert.equal(mismatched.quota,undefined);
  assert.equal(store.consume(mismatched,{identity:f.identity}).status,'ignored');
});
