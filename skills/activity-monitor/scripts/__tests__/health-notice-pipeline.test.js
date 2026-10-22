import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {spawn,spawnSync} from 'node:child_process';
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
import {currentOutageNotice,restoreOutageAnchor} from '../outage-notice.js';
import {MessageRouter} from '../message-router.js';
import {buildStatusPayload} from '../status-writer.js';
import {claimStatusNotice,finishStatusNotice,startStatusNotice} from '../../../comm-bridge/scripts/c4-db.js';
import {statusNoticeKey,normalizeStatusEndpoint} from '../../../comm-bridge/scripts/status-notice.js';

function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-notice-pipeline-'));
  t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  const generation=createRuntimeGeneration('claude',{zylosDir});
  const identity={...generation,session_id:'session',claude_pid:process.pid,process_start:readProcessStart(process.pid)};
  fs.writeFileSync(path.join(zylosDir,'activity-monitor','foreground-session.json'),JSON.stringify(identity));
  const env={...process.env,...runtimeGenerationEnv(generation),ZYLOS_DIR:zylosDir};
  fs.mkdirSync(path.join(zylosDir,'comm-bridge'));
  const db=new Database(path.join(zylosDir,'comm-bridge','c4.db'));guardDatabase(db,schema);t.after(()=>db.close());
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

test('336ms late quota enriches first reply and subsequent routes without rewriting failure or health',t=>{
  const f=fixture(t);const at=Date.now();let clock=at;
  const reset=Math.floor(at/1000)+3600;
  f.db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status) VALUES (1,'in','fake','group|thread:late|msg:1','prompt','running')").run();
  const item={id:1,type:'conversation',channel:'fake',endpoint_id:'group|thread:late|msg:1'};
  const delivery=beginRuntimeDelivery(item,f.identity,{database:f.db,now:at-20});
  finishRuntimeDelivery(delivery,item,'submitted',f.identity,{database:f.db,now:at-10});
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit',last_assistant_message:'You have hit your usage limit'}, {...f.options,nowMs:at});
  const store=new HealthStore(f.db,{now:()=>clock});store.consume(event,{identity:f.identity});
  const before=store.read();
  const payload=f.db.prepare('SELECT payload_json FROM runtime_health_events').get().payload_json;
  const quota=()=>readHealthQuota({identity:f.identity,zylosDir:f.zylosDir,nowMs:clock});
  const sent=[];
  const options={database:f.db,identity:()=>f.identity,now:()=>clock,quota,quotaWaitMs:750,
    reserve:(channel,endpoint,route)=>({key:'late',attemptId:'late',channel,endpoint,...route}),
    send:(claim,message,route)=>{sent.push({claim,message,route});return {outcome:'sent'};}};
  processFirstFailureNotices(options);assert.equal(sent.length,0);
  clock=at+336;
  writeHealthQuota({session_id:'session',rate_limits:{five_hour:{used_percentage:100,resets_at:reset}}},{...f.options,nowMs:clock});
  clock=at+750;processFirstFailureNotices(options);
  assert.equal(sent.length,1);assert.equal(sent[0].route.resetAt,reset*1000);
  assert.equal(sent[0].claim.endpoint,item.endpoint_id);
  assert.equal(f.db.prepare('SELECT payload_json FROM runtime_health_events').get().payload_json,payload);
  assert.equal(JSON.parse(payload).quota,undefined);
  const evidence={store,notice:()=>store.currentNotice({identity:f.identity,quota:quota()})};
  const engine={health:'rate_limited',healthReason:before.reason,evidence};
  const router=new MessageRouter({healthEngine:engine});
  const routed=router._decision({requestId:'new-conversation'},{recovered:false,health:'rate_limited'});
  assert.match(routed.userMessage,/expected to reset at/);
  assert.equal(buildStatusPayload({statusObj:{},healthEngine:engine}).health_notice.resetAt,reset*1000);
  const after=store.read();
  assert.equal(after.revision,before.revision);assert.equal(after.episode,before.episode);
  assert.equal(after.reason,before.reason);assert.deepEqual(after.notice,before.notice);
  assert.equal(after.outage_quota.snapshot.observed_at,at+336);
  const reserve=(endpoint,attemptId)=>claimStatusNotice({key:statusNoticeKey('fake',endpoint),episode:`claude:${after.episode}`,
    attemptId,channel:'fake',endpoint,normalizedEndpoint:normalizeStatusEndpoint(endpoint),now:Math.floor(clock/1000)},f.db);
  const original=reserve(item.endpoint_id,'cooldown');
  startStatusNotice(original,Math.floor(clock/1000),f.db);
  finishStatusNotice(original,'sent',{now:Math.floor(clock/1000)},f.db);
  assert.equal(reserve('group|thread:late|msg:next','same').suppressed,true);
  assert.equal(reserve('group|thread:different|msg:next','other').suppressed,false);
  clock=at+120000;
  const restarted=new HealthStore(f.db,{now:()=>clock});
  assert.equal(restarted.currentNotice({identity:f.identity,quota:null}).resetAt,reset*1000);
  clock=reset*1000;
  assert.equal(store.currentNotice({identity:f.identity,quota:null}).resetAt,null);
  assert.equal(store.read().health,'rate_limited');
});

test('late enrichment rejects stale, foreign, recovered and nonquota evidence; newer windows replace learned details',t=>{
  const f=fixture(t);const at=Date.now();const now=at+1000;const reset=Math.floor(at/1000)+3600;
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit'}, {...f.options,nowMs:at});
  const store=new HealthStore(f.db,{now:()=>now});store.consume(event,{identity:f.identity});
  const state=store.read();
  const snapshot={schema_version:1,source:'statusline',...f.identity,observed_at:at+336,rate_limits:{five_hour:{used_percentage:100,resets_at:reset}}};
  for(const change of [
    {runtime_generation:'00000000-0000-0000-0000-000000000000'}, {session_id:'foreign'},
    {claude_pid:process.pid+1}, {process_start:f.identity.process_start+'1'},
    {observed_at:at-1}, {observed_at:now+1}, {observed_at:now-60001},
  ]) assert.equal(currentOutageNotice(state,f.identity,{...snapshot,...change},now).annotation,null,JSON.stringify(change));
  for(const change of [{health:'ok'},{source:'screen'},{recovered:{}},{health:'auth_failed'},{evidence_id:'different'}]) {
    assert.equal(currentOutageNotice({...state,...change},f.identity,snapshot,now).annotation,null);
  }
  const both={...snapshot,rate_limits:{...snapshot.rate_limits,seven_day:{used_percentage:100,resets_at:reset+86400}}};
  assert.equal(currentOutageNotice(state,f.identity,both,now).notice.resetAt,(reset+86400)*1000);
  const unknown={...both,rate_limits:{...both.rate_limits,seven_day:{used_percentage:100}}};
  assert.equal(currentOutageNotice(state,f.identity,unknown,now).notice.resetAt,null);
  const admitted=currentOutageNotice(state,f.identity,snapshot,now);
  const annotated={...state,outage_quota:admitted.annotation};
  const nonfull={...snapshot,observed_at:now,rate_limits:{five_hour:{used_percentage:0,resets_at:reset}}};
  const updated=currentOutageNotice(annotated,f.identity,nonfull,now);
  assert.equal(updated.notice.noticeCode,'rate_limited');assert.equal(updated.notice.resetAt,null);
  assert.equal(updated.annotation.snapshot.observed_at,now);
  assert.equal(currentOutageNotice(annotated,f.identity,null,reset*1000).notice.resetAt,null);
  assert.equal(currentOutageNotice({...annotated,evidence_id:'next'},f.identity,null,now).annotation,null);
});

test('first quota wait is bounded and absence of a snapshot preserves original wording',t=>{
  const f=fixture(t);const at=Date.now();let now=at;
  f.db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status) VALUES (1,'in','fake','group','prompt','running')").run();
  const item={id:1,type:'conversation',channel:'fake',endpoint_id:'group'};
  const delivery=beginRuntimeDelivery(item,f.identity,{database:f.db,now:at-20});
  finishRuntimeDelivery(delivery,item,'submitted',f.identity,{database:f.db,now:at-10});
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit'}, {...f.options,nowMs:at});
  event.notice_match={sourceId:6,kind:'quota'};
  const store=new HealthStore(f.db,{now:()=>now});store.consume(event,{identity:f.identity});
  const sent=[];const options={database:f.db,identity:()=>f.identity,now:()=>now,quota:()=>null,quotaWaitMs:99999,
    reserve:(channel,endpoint,route)=>({key:'bounded',attemptId:'bounded',channel,endpoint,...route}),
    send:(claim,message,route)=>{sent.push(route);return {outcome:'sent'};}};
  processFirstFailureNotices(options);assert.equal(sent.length,0);
  now=at+750;processFirstFailureNotices(options);
  assert.equal(sent.length,1);assert.equal(sent[0].noticeCode,'quota_exhausted');assert.equal(sent[0].resetAt,null);
});

test('production --drain subprocess waits for late quota and sends only to local capture',async t=>{
  const f=fixture(t);const at=Date.now();const reset=Math.floor(at/1000)+3600;
  const bin=path.join(f.zylosDir,'bin');fs.mkdirSync(bin);
  const marker=path.join(f.zylosDir,'identity-read');
  fs.writeFileSync(path.join(bin,'tmux'),`#!/bin/sh\ntouch '${marker}'\nprintf '%s\\n' '${process.pid}'\n`,{mode:0o755});
  const sender=path.join(f.zylosDir,'.claude/skills/fake/scripts');fs.mkdirSync(sender,{recursive:true});
  const capture=path.join(f.zylosDir,'capture.json');
  fs.writeFileSync(path.join(sender,'send.js'),`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({at:Date.now(),args:process.argv.slice(2),body:fs.readFileSync(0,'utf8')}));`);
  f.db.prepare("INSERT INTO conversations(id,direction,channel,endpoint_id,content,status) VALUES (1,'in','fake','group|thread:cli|msg:1','prompt','running')").run();
  const item={id:1,type:'conversation',channel:'fake',endpoint_id:'group|thread:cli|msg:1'};
  const delivery=beginRuntimeDelivery(item,f.identity,{database:f.db,now:at-20});
  finishRuntimeDelivery(delivery,item,'submitted',f.identity,{database:f.db,now:at-10});
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit'}, {...f.options,nowMs:at});
  new HealthStore(f.db).consume(event,{identity:f.identity});
  const script=fileURLToPath(new URL('../../../comm-bridge/scripts/first-failure-notice.js',import.meta.url));
  const child=spawn(process.execPath,[script,'--drain'],{env:{...f.env,PATH:`${bin}:${process.env.PATH}`},stdio:['ignore','pipe','pipe']});
  t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
  const completed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',(code,signal)=>resolve({code,signal}));});
  const deadline=Date.now()+3000;
  while(!fs.existsSync(marker)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(fs.existsSync(marker),true,'worker reached real identity reader');
  const firstRead=Date.now();
  await new Promise(resolve=>setTimeout(resolve,336));
  assert.equal(fs.existsSync(capture),false,'first pass deferred its send');
  writeHealthQuota({session_id:'session',rate_limits:{five_hour:{used_percentage:100,resets_at:reset}}},{...f.options,nowMs:Date.now()});
  const result=await completed;assert.equal(result.code,0,stderr);
  const sent=JSON.parse(fs.readFileSync(capture,'utf8'));
  assert.ok(sent.at-firstRead>=600,'production worker used bounded asynchronous wait');
  assert.match(sent.args.join('\n')+sent.body,/expected to reset at/);
  assert.ok(sent.args.includes(item.endpoint_id));
  assert.equal(f.db.prepare('SELECT status FROM runtime_notice_intents').get().status,'sent');
});

for (const hook of ['Stop','StopFailure']) for (const timing of ['before','after']) {
  test(`${hook} telemetry ${timing} quota admission cannot hide authoritative outage details`,t=>{
    const f=fixture(t);const at=Date.now();let clock=at;const reset=Math.floor(at/1000)+3600;
    const store=new HealthStore(f.db,{now:()=>clock});
    const failure=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'authoritative',error:'rate_limit'}, {...f.options,nowMs:at});
    store.consume(failure,{identity:f.identity});
    const before=store.read();
    const snapshot={schema_version:1,source:'statusline',...f.identity,observed_at:at+336,
      rate_limits:{five_hour:{used_percentage:100,resets_at:reset}}};
    clock=at+750;
    if(timing==='after')assert.equal(store.currentNotice({identity:f.identity,quota:snapshot}).resetAt,reset*1000);
    const telemetry=collectHealthHook({hook_event_name:hook,session_id:'session',prompt_id:'unrelated',error:'rate_limit'},
      {...f.options,nowMs:at-100});
    const result=store.consume(telemetry,{identity:f.identity});
    assert.equal(result.reason,hook==='Stop'?'unproven_success_order':'unordered_failure');
    const changed=store.read();
    assert.notEqual(changed.last_hook.event_id,changed.evidence_id);
    assert.equal(changed.evidence_id,before.evidence_id);assert.equal(changed.revision,before.revision);
    assert.equal(changed.health,'rate_limited');assert.deepEqual(changed.hook_failure,before.hook_failure);
    assert.equal(store.currentNotice({identity:f.identity,quota:snapshot}).resetAt,reset*1000);
    assert.equal(store.currentNotice({identity:f.identity,quota:null}).resetAt,reset*1000);
    const newer={...snapshot,observed_at:clock,rate_limits:{five_hour:{used_percentage:100,resets_at:reset+60}}};
    assert.equal(store.currentNotice({identity:f.identity,quota:newer}).resetAt,(reset+60)*1000);
    assert.equal(store.transition('ok','',{identity:f.identity,kind:'recovery',expectedRevision:before.revision}).accepted,true);
    assert.equal(store.currentNotice({identity:f.identity,quota:newer}),undefined);
    assert.equal(store.read().health,'ok');
  });
}

test('legacy outage anchor restores from authoritative row and persists independently of telemetry and cleanup',t=>{
  const f=fixture(t);const at=Date.now();let clock=at;const reset=Math.floor(at/1000)+3600;
  const store=new HealthStore(f.db,{now:()=>clock});
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'authoritative',error:'rate_limit'}, {...f.options,nowMs:at});
  store.consume(event,{identity:f.identity});
  const legacy=store.read();delete legacy.hook_failure;
  legacy.last_hook={event_id:'telemetry',event:'stop',error:null,observed_at:at-100,runtime_generation:f.identity.runtime_generation};
  store.write(legacy);
  const row=f.db.prepare('SELECT payload_json FROM runtime_health_events WHERE event_id=?').get(legacy.evidence_id);
  for(const status of ['pending','ignored']) {
    f.db.prepare('UPDATE runtime_health_events SET status=? WHERE event_id=?').run(status,legacy.evidence_id);
    assert.equal(restoreOutageAnchor(legacy,f.db).hook_failure,undefined);
  }
  f.db.prepare("UPDATE runtime_health_events SET status='processed' WHERE event_id=?").run(legacy.evidence_id);
  const original=JSON.parse(row.payload_json);
  for(const change of [{source:'screen'},{event:'stop'},{error:'authentication_failed'},{runtime_generation:'foreign'},
    {session_id:'foreign'},{claude_pid:process.pid+1},{process_start:'foreign'},{event_id:'foreign'}]) {
    f.db.prepare('UPDATE runtime_health_events SET payload_json=? WHERE event_id=?').run(JSON.stringify({...original,...change}),legacy.evidence_id);
    assert.equal(restoreOutageAnchor(legacy,f.db).hook_failure,undefined);
  }
  f.db.prepare('UPDATE runtime_health_events SET payload_json=? WHERE event_id=?').run(row.payload_json,legacy.evidence_id);
  clock=at+750;
  const snapshot={schema_version:1,source:'statusline',...f.identity,observed_at:at+336,rate_limits:{five_hour:{used_percentage:100,resets_at:reset}}};
  assert.equal(store.currentNotice({identity:f.identity,quota:snapshot}).resetAt,reset*1000);
  const saved=JSON.parse(f.db.prepare('SELECT state_json FROM runtime_health_state').get().state_json);
  assert.equal(saved.hook_failure.event_id,legacy.evidence_id);assert.equal(saved.hook_failure.observed_at,at);
  // The persisted anchor itself remains sufficient even without its event row.
  f.db.prepare('DELETE FROM runtime_health_events').run();
  clock=at+120000;
  const restarted=new HealthStore(f.db,{now:()=>clock});
  assert.equal(restarted.currentNotice({identity:f.identity,quota:null}).resetAt,reset*1000);
  assert.equal(restarted.read().revision,legacy.revision);
});
