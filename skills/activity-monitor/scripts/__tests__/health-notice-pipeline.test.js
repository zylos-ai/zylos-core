import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import Database from '../../../comm-bridge/node_modules/better-sqlite3/lib/index.js';
import {guardDatabase} from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../comm-bridge/scripts/c4-schema.js';
import {freezeFirstFailureNotice,processFirstFailureNotices,sendNoticeWorker} from '../../../comm-bridge/scripts/first-failure-notice.js';
import {claimStatusNotice} from '../../../comm-bridge/scripts/c4-db.js';
import {statusNoticeKey} from '../../../comm-bridge/scripts/status-notice.js';
import {readDeliveryIdentity} from '../../../comm-bridge/scripts/runtime-delivery.js';
import {writeHealthQuota,readHealthQuota} from '../health-quota.js';
import {collectHealthHook} from '../hook-health.js';
import {HealthStore} from '../health-store.js';
import {createToolPipeline} from '../adapters/runtime-components.js';
import {createToolEventStreamState,rotateToolEventStream} from '../tool-event-stream.js';
import {currentOutageNotice} from '../outage-notice.js';

function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-stream-'));
  t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  const dir=path.join(zylosDir,'activity-monitor');fs.mkdirSync(dir);
  const identity={runtime:'claude',session_id:'session',claude_pid:process.pid};
  fs.mkdirSync(path.join(zylosDir,'comm-bridge'));
  const db=new Database(path.join(zylosDir,'comm-bridge','c4.db'));guardDatabase(db,schema);t.after(()=>db.close());
  let clock=Date.now();
  const store=new HealthStore({zylosDir,now:()=>clock,freezeNotice:input=>freezeFirstFailureNotice(db,{...input,sessionGroup:null})});
  const files=Object.fromEntries(['toolEvents','toolEventStreamState','sessionToolState','apiActivity','foregroundSession','statusline'].map(key=>[key,path.join(dir,key)]));
  files.toolEvents=path.join(dir,'events.jsonl');
  const {pipeline}=createToolPipeline({runtimeId:'claude'}, {}, {files,getRuntimeLaunchAtMs:()=>0,
    onHealthEvent:event=>store.consume(event,{identity})});
  const options={zylosDir,pid:process.pid,managedIdentity:()=>identity};
  const collect=(overrides={},time=clock)=>collectHealthHook({hook_event_name:'StopFailure',session_id:'session',prompt_id:'prompt',error:'rate_limit',...overrides},{...options,nowMs:time});
  const tick=()=>pipeline.processToolLifecycle(clock,process.pid,null);
  return {zylosDir,identity,db,store,files,pipeline,options,collect,tick,now:()=>clock,setTime:value=>clock=value};
}

test('A-B-A, cursor reset and monitor restart retain one strict terminal marker',t=>{
  const f=fixture(t), at=f.now();
  const a=f.collect();f.tick();
  f.setTime(at+1);f.collect({hook_event_name:'Stop'},at+1);f.tick();
  const before=f.store.read();
  fs.appendFileSync(f.files.toolEvents,JSON.stringify(a)+'\n');f.tick();
  assert.deepEqual(f.store.read(),before);
  f.pipeline.streamState=createToolEventStreamState(f.files.toolEvents);f.tick();
  assert.deepEqual(f.store.read(),before);
  const restarted=new HealthStore({zylosDir:f.zylosDir,now:f.now});
  assert.equal(restarted.consume(a,{identity:f.identity}).reason,'replay');
  assert.equal(restarted.read().last_processed.received_at,at+1);
});

test('nonterminal hooks, equal timestamps, stale and backward-clock events do not move marker',t=>{
  const f=fixture(t),at=f.now();
  for (const hook_event_name of ['SessionStart','UserPromptSubmit']) f.collect({hook_event_name});
  f.tick();assert.equal(f.store.read().last_processed,undefined);
  f.collect();f.tick();const before=f.store.read();
  f.collect({hook_event_name:'Stop'});f.collect({},at-300001);f.collect({},at+1);f.tick();
  assert.deepEqual(f.store.read(),before);
  f.setTime(at-1000);f.collect();f.tick();assert.deepEqual(f.store.read(),before);
});

test('failed atomic health commit leaves cursor retryable and pending target frozen',t=>{
  const f=fixture(t);
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','original','secret','delivered')").run();
  f.collect();
  const write=f.store.write.bind(f.store);f.store.write=()=>{throw new Error('disk failure');};
  assert.throws(f.tick,/disk failure/);assert.equal(f.pipeline.streamState.offset,0);
  assert.equal(fs.existsSync(f.files.toolEventStreamState),false);
  f.store.write=write;f.tick();
  assert.equal(f.store.read().pending_notice.endpoint,'original');
  assert.equal(f.store.read().health,'rate_limited');
  assert.ok(f.pipeline.streamState.offset>0);
  assert.doesNotMatch(fs.readFileSync(f.store.file,'utf8'),/secret/);
});

test('rotation replay and late writes use the same persisted marker',t=>{
  const f=fixture(t),at=f.now();const a=f.collect();f.tick();
  f.pipeline.streamState=rotateToolEventStream({filePath:f.files.toolEvents,nowMs:at});
  fs.appendFileSync(`${f.files.toolEvents}.old`,JSON.stringify(a)+'\n');
  f.tick();assert.equal(f.store.read().last_processed.event_id,a.event_id);
  f.setTime(at+1);const b={...a,event_id:randomUUID(),received_at:at+1,ts:at+1,event:'stop',error:null};
  fs.appendFileSync(`${f.files.toolEvents}.old`,JSON.stringify(b)+'\n');f.tick();
  assert.equal(f.store.read().last_processed.event_id,b.event_id);
});

test('partial JSON line survives two reads without duplicated tail',t=>{
  const f=fixture(t);const event=f.collect();const raw=JSON.stringify(event)+'\n';
  fs.writeFileSync(f.files.toolEvents,raw.slice(0,20));f.tick();assert.equal(f.store.read().last_processed,undefined);
  fs.appendFileSync(f.files.toolEvents,raw.slice(20));f.tick();assert.equal(f.store.read().health,'rate_limited');
});

test('336ms late quota enriches reply and future reads without rewriting failure classification',async t=>{
  const f=fixture(t),at=f.now(),reset=Math.floor(at/1000)+3600;
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','original','secret','delivered')").run();
  f.collect();f.tick();const before=f.store.read();const sent=[];
  const quota=()=>readHealthQuota({identity:f.identity,zylosDir:f.zylosDir,nowMs:f.now()});
  const options={store:f.store,database:f.db,identity:()=>f.identity,now:f.now,quota,quotaWaitMs:750,
    reserve:(channel,endpoint,route)=>claimStatusNotice({key:statusNoticeKey(channel,endpoint,route.health,route.reason),channel,endpoint,normalizedEndpoint:endpoint,...route,now:Math.floor(f.now()/1000)},f.db),
    send:async(claim,message,route)=>{sent.push({message,route});return {outcome:'sent'};}};
  await processFirstFailureNotices(options);assert.equal(sent.length,0);
  f.setTime(at+336);writeHealthQuota({session_id:'session',rate_limits:{five_hour:{used_percentage:100,resets_at:reset}}},{...f.options,nowMs:f.now()});
  f.setTime(at+750);await processFirstFailureNotices(options);
  assert.equal(sent.length,1);assert.equal(sent[0].route.resetAt,reset*1000);
  assert.match(sent[0].message,/expected to reset at/);
  assert.equal(f.store.currentNotice({identity:f.identity,quota:quota()}).resetAt,reset*1000);
  const after=f.store.read();assert.equal(after.revision,before.revision);assert.equal(after.reason,before.reason);
  assert.deepEqual(after.hook_failure,before.hook_failure);
  const restarted=new HealthStore({zylosDir:f.zylosDir,now:f.now});
  assert.equal(restarted.currentNotice({identity:f.identity,quota:null}).resetAt,reset*1000);
});

test('quota refinement rejects foreign identity, older evidence and recovery',t=>{
  const f=fixture(t),at=f.now();f.collect();f.tick();const state=f.store.read();
  const quota={schema_version:1,source:'statusline',...f.identity,observed_at:at+1,rate_limits:{five_hour:{used_percentage:100,resets_at:Math.floor(at/1000)+3600}}};
  for(const change of [{session_id:'other'},{claude_pid:1},{observed_at:at-1},{observed_at:at+1001}]) {
    assert.equal(currentOutageNotice(state,f.identity,{...quota,...change},at+1000).annotation,null);
  }
  assert.equal(currentOutageNotice({...state,recovered:{}},f.identity,quota,at+1000).annotation,null);
  assert.equal(currentOutageNotice({...state,evidence_id:'other'},f.identity,quota,at+1000).annotation,null);
});

test('same-session recovery, normal Stop, new prompt and AM restart permit a new failure notice',async t=>{
  const f=fixture(t),at=f.now();
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','first','test','delivered')").run();
  const first=f.collect();f.tick();
  const sent=[];
  const reserve=(channel,endpoint,route)=>claimStatusNotice({key:statusNoticeKey(channel,endpoint,route.health,route.reason),channel,endpoint,normalizedEndpoint:endpoint,...route,now:Math.floor(f.now()/1000)},f.db);
  const send=async(claim,message,route)=>{sent.push({claim,message,route});return {outcome:'sent'};};
  await processFirstFailureNotices({store:f.store,database:f.db,identity:()=>f.identity,now:f.now,reserve,send});
  f.setTime(at+10);f.store.transition('ok','',{identity:f.identity,kind:'recovery'});
  f.setTime(at+20);f.collect({hook_event_name:'Stop',prompt_id:'normal'});f.tick();
  f.setTime(at+21);f.collect({hook_event_name:'UserPromptSubmit',prompt_id:'next'});f.tick();
  const restarted=new HealthStore({zylosDir:f.zylosDir,now:f.now,freezeNotice:input=>freezeFirstFailureNotice(f.db,{...input,sessionGroup:null})});
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','next','test','delivered')").run();
  f.setTime(at+30);const next=f.collect({prompt_id:'next',error:'authentication_failed'});
  const result=restarted.consume(next,{identity:f.identity});
  assert.equal(result.reason,'hook_failure');assert.equal(restarted.read().health,'auth_failed');
  assert.equal(restarted.read().recovered,null);assert.equal(restarted.read().pending_notice.endpoint,'next');
  await processFirstFailureNotices({store:restarted,database:f.db,identity:()=>f.identity,now:f.now,reserve,send});
  assert.equal(sent.length,2);assert.equal(sent[1].route.health,'auth_failed');
  assert.equal(sent[1].claim.endpoint,'next');
  assert.equal(restarted.consume(first,{identity:f.identity}).reason,'replay');
  assert.equal(restarted.read().health,'auth_failed');
});

test('Darwin ps ancestry runs collector, quota, health persistence and notice without procfs',async t=>{
  const f=fixture(t),at=f.now();let psReads=0;
  const foreground={session_id:'mac-session',claude_pid:4242};
  const file=path.join(f.zylosDir,'activity-monitor/foreground-session.json');
  fs.writeFileSync(file,JSON.stringify(foreground));
  const proof=()=>readDeliveryIdentity({zylosDir:f.zylosDir,platform:'darwin',
    read:target=>{assert.equal(target,file,'Darwin must not read procfs');return fs.readFileSync(target,'utf8');},
    run:(bin,args)=>{if(bin==='tmux')return '4000';assert.equal(bin,'ps');psReads++;return Number(args.at(-1))===4242?'4100':'4000';}});
  const identity=proof();assert.deepEqual(identity,{runtime:'claude',...foreground});
  f.pipeline.onHealthEvent=event=>f.store.consume(event,{identity:proof()});
  const reset=Math.floor(at/1000)+3600;
  writeHealthQuota({session_id:foreground.session_id,rate_limits:{five_hour:{used_percentage:100,resets_at:reset}}},
    {zylosDir:f.zylosDir,pid:4242,nowMs:at,managedIdentity:proof});
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','darwin','test','delivered')").run();
  const event=collectHealthHook({hook_event_name:'StopFailure',session_id:foreground.session_id,prompt_id:'mac-prompt',error:'rate_limit'},
    {zylosDir:f.zylosDir,pid:4242,nowMs:at});
  assert.equal(event.process_start,undefined);assert.equal(event.quota.rate_limits.five_hour.used_percentage,100);
  f.tick();assert.equal(f.store.read().health,'rate_limited');
  const raw=JSON.parse(fs.readFileSync(f.store.file));assert.equal(raw.hook.pid,4242);assert.equal(raw.hook.processStart,undefined);
  const sent=[];
  await processFirstFailureNotices({store:f.store,database:f.db,identity:proof,now:f.now,
    reserve:(channel,endpoint,route)=>claimStatusNotice({key:statusNoticeKey(channel,endpoint,route.health,route.reason),channel,endpoint,normalizedEndpoint:endpoint,...route,now:Math.floor(at/1000)},f.db),
    send:async(claim,message,route)=>{sent.push({claim,message,route});return {outcome:'sent'};}});
  assert.equal(sent.length,1);assert.equal(sent[0].route.resetAt,reset*1000);assert.match(sent[0].message,/expected to reset at/);
  assert.equal(f.store.consume(event,{identity:proof()}).reason,'replay');
  f.setTime(at+1);
  for(const change of [{claude_pid:4243},{session_id:'foreign'}])assert.equal(f.store.consume({...event,...change,event_id:randomUUID(),received_at:at+1},{identity:proof()}).reason,'foreign_runtime_or_session');
  assert.ok(psReads>0);
});

test('real isolated sender child captures one bilingual notice without writing the health file',async t=>{
  const f=fixture(t);
  const sender=path.join(f.zylosDir,'.claude/skills/fake/scripts');fs.mkdirSync(sender,{recursive:true});
  const capture=path.join(f.zylosDir,'capture.json');
  fs.writeFileSync(path.join(sender,'send.js'),`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(capture)},JSON.stringify({args:process.argv.slice(2),body:fs.readFileSync(0,'utf8')}));`);
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','capture-only','secret','delivered')").run();
  f.collect();f.tick();
  const options={store:f.store,database:f.db,identity:()=>f.identity,now:f.now,zylosDir:f.zylosDir,send:sendNoticeWorker,
    reserve:(channel,endpoint,route)=>claimStatusNotice({key:statusNoticeKey(channel,endpoint,route.health,route.reason),channel,endpoint,normalizedEndpoint:endpoint,...route,now:Math.floor(f.now()/1000)},f.db)};
  await processFirstFailureNotices(options);
  assert.equal(f.store.read().pending_notice,undefined);
  assert.equal(f.store.read().last_notice_outcome.status,'sent');
  const sent=JSON.parse(fs.readFileSync(capture,'utf8'));
  assert.match(sent.args.join('\n')+sent.body,/Zylos/);
  assert.match(sent.args.join('\n')+sent.body,/[\u4e00-\u9fff]/);
  assert.ok(sent.args.includes('capture-only'));
  assert.match(fs.readFileSync(path.join(f.zylosDir,'activity-monitor/status-notices.log'),'utf8'),/first-failure/);
  assert.equal(await processFirstFailureNotices(options),0);
});

// P05 §4 health hook acceptance: preserve the recovered snapshot branch, then
// prove a strictly later failure commits health, marker and new frozen route
// together for the same PID/session. No identity change hides the regression.
async function exactRecoveryRegression(t) {
  const f=fixture(t),at=f.now();
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','first','test','delivered')").run();
  const first=f.collect();
  f.store.consume({...first,event_id:randomUUID(),received_at:at-1,ts:at-1},{identity:f.identity,sessionGroup:'other'});
  f.tick();
  assert.equal(f.store.read().health,'rate_limited');
  f.setTime(at+10);f.store.transition('ok','',{identity:f.identity,kind:'recovery'});
  const recovered=fs.readFileSync(f.store.file,'utf8');
  const recoveredDisk=JSON.parse(recovered);
  assert.equal(recoveredDisk.hook.recovered.observedAt,at+10);
  assert.equal(recoveredDisk.hook.groups.origin.lastProcessedAt,at);

  // Independent branch from exactly the pre-Stop recovered bytes. Its event is
  // newer than the terminal marker but not newer than recovery observation.
  const branch=fixture(t);branch.setTime(at+30);
  fs.mkdirSync(path.dirname(branch.store.file),{recursive:true});fs.writeFileSync(branch.store.file,recovered);
  const old={...first,event_id:randomUUID(),received_at:at+5,ts:at+5};
  assert.equal(branch.store.consume(old,{identity:f.identity}).reason,'pre_recovery_event');
  assert.equal(fs.readFileSync(branch.store.file,'utf8'),recovered);

  f.setTime(at+20);f.collect({hook_event_name:'Stop',prompt_id:'normal'});f.tick();
  const afterStop=f.store.read();assert.equal(afterStop.health,'ok');
  f.setTime(at+21);f.collect({hook_event_name:'UserPromptSubmit',prompt_id:'next'});f.tick();
  assert.deepEqual(f.store.read().last_processed,afterStop.last_processed);
  const restarted=new HealthStore({zylosDir:f.zylosDir,now:f.now,freezeNotice:input=>freezeFirstFailureNotice(f.db,{...input,sessionGroup:null})});
  f.db.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status) VALUES('in','fake','next','test','delivered')").run();
  f.setTime(at+30);const next=f.collect({prompt_id:'next',error:'authentication_failed'});
  let publications=0;const publish=restarted.write.bind(restarted);
  restarted.write=(...args)=>{publish(...args);publications++;};
  assert.equal(restarted.consume(next,{identity:f.identity}).reason,'hook_failure');
  assert.equal(publications,1);
  const committed=JSON.parse(fs.readFileSync(restarted.file,'utf8'));
  assert.equal(committed.health,'auth_failed');
  assert.equal(committed.hook.groups.origin.lastProcessedAt,at+30);
  assert.equal(committed.hook.groups.origin.lastProcessedEventId,next.event_id);
  assert.equal(committed.hook.groups.origin.pendingNotice.endpoint,'next');
  assert.equal(committed.hook.groups.origin.pendingNotice.eventId,next.event_id);
  assert.deepEqual(committed.hook.groups.other,recoveredDisk.hook.groups.other);
  const sent=[];
  await processFirstFailureNotices({store:restarted,database:f.db,identity:()=>f.identity,now:f.now,
    reserve:(channel,endpoint,route)=>claimStatusNotice({key:statusNoticeKey(channel,endpoint,route.health,route.reason),channel,endpoint,normalizedEndpoint:endpoint,...route,now:Math.floor(f.now()/1000)},f.db),
    send:async(claim,message,route)=>{sent.push({endpoint:claim.endpoint,health:route.health});return {outcome:'sent'};}});
  assert.deepEqual(sent,[{endpoint:'next',health:'auth_failed'}]);
  const afterSend=fs.readFileSync(restarted.file,'utf8');
  assert.equal(restarted.consume(next,{identity:f.identity}).reason,'replay');
  assert.equal(fs.readFileSync(restarted.file,'utf8'),afterSend);
}
test('same-identity recovery rejects intervening old event but atomically commits later failure', exactRecoveryRegression);
