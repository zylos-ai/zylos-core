import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RuntimeHealthCoordinator } from '../skills/activity-monitor/scripts/runtime-health.js';
import { HealthEventReader } from '../skills/activity-monitor/scripts/health-event-reader.js';
import { HealthStore } from '../skills/activity-monitor/scripts/health-store.js';
import { processFailureContinuation } from '../skills/activity-monitor/scripts/failure-continuation.js';
import { freezeFirstFailureNotice, processFirstFailureNotices } from '../skills/comm-bridge/scripts/first-failure-notice.js';
import { messageForStatus } from '../skills/comm-bridge/scripts/status-notice-templates.js';
import { appendEvent } from '../cli/lib/event-log.js';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { SessionActivity } from '../skills/activity-monitor/scripts/session-activity.js';

function setup(t,runtime='claude') {
 const f=fixture(t), root=fs.mkdtempSync(path.join(os.tmpdir(),'failure-continue-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 f.store.insertConversation('in','telegram','owner','work');
 const group=f.db.prepare('SELECT session_group FROM conversations LIMIT 1').get().session_group;
 f.db.prepare("UPDATE conversations SET status='delivered'").run();
 const scene={sessionGroup:group,runId:'r1',sessionId:'s1',runtime,ready:true,runDir:path.join(root,'run')};
 const identity={runtime,session_id:'s1',claude_pid:123};
 let now=1000000;
 const coordinator=new RuntimeHealthCoordinator({zylosDir:root,now:()=>now,freezeNotice:options=>freezeFirstFailureNotice(f.db,options)});
 const reader=new HealthEventReader({coordinator,zylosDir:root,now:()=>now,quota:()=>null,getControl:id=>f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),expireControl:f.store.expireControlById});t.after(()=>reader.close());
 const store=coordinator.store(runtime);
 const binding={expectedRunId:'r1',tmuxTarget:{serverGeneration:'g1',sessionId:'$1',paneId:'%1'}};
 const write=(event,error=null,extra={})=>{
  now+=100;
  const row={v:1,type:'runtime_health',schema_version:1,source:'hook',...identity,event_id:randomUUID(),prompt_id:randomUUID(),event,error,received_at:now,ts:now,run_id:scene.runId,...extra};
  appendEvent(path.join(scene.runDir,'events.jsonl'),row);return row;
 };
 const consume=()=>reader.consumeScene(scene,identity);
 const process=options=>processFailureContinuation({store,scene,identity:async()=>scene,bindTarget:async()=>binding,insertControl:f.store.insertControl,getPending:f.store.getNextPending,getControl:id=>f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),now:()=>now,expireControl:f.store.expireControlById,
   readNativeActivity:()=>({turnStartedAt:null}),...options});
 return {...f,c4:f.store,root,scene,identity,store,reader,coordinator,write,consume,process,group,now:()=>now,advance:ms=>now+=ms};
}

// Boundary: Health hooks → retry state → C4 deadline → notice worker. Run for retry/notice changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('three failed continuations preserve delays and send one existing error notice',async t=>{
 const f=setup(t);
 const native=new SessionActivity({runDir:f.scene.runDir,runId:'r1',sessionId:'s1',runtime:'claude',startedAt:f.now()});
 t.after(()=>native.close());
 const readNativeActivity=()=>native.read(f.now());
 const hook=(event,ts)=>appendEvent(path.join(f.scene.runDir,'events.jsonl'),{v:1,event,ts,run_id:'r1',session_id:'s1',runtime:'claude'});
 for(let attempt=1;attempt<=4;attempt++) {
  if(attempt===2)f.db.prepare("UPDATE conversations SET endpoint_id='changed-target'").run();
  const failure=f.write('stop_failure','server_error');hook('stop',failure.received_at+1);await f.consume();
  await f.process({readNativeActivity});
  if(attempt===4)break;
  assert.equal(f.store.read(f.group).pending_notice,undefined);
  await f.process({readNativeActivity});
  const retry=f.store.read(f.group).failure_retry;
  assert.equal(retry.attempts,attempt);
  const row=f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(retry.controlId);
  assert.equal(row.content,'Continue');assert.equal(row.require_idle,1);assert.equal(row.bypass_state,0);
  assert.equal(row.available_at,Math.ceil((failure.received_at+[30000,120000,300000][attempt-1])/1000));
  f.advance(retry.dueAt-f.now());f.c4.claimControl(row.id);
  hook('prompt',f.now()+1);f.write('prompt_submit');
  // Failure can precede the dispatcher's done publication. Keep it unconsumed
  // while running, then settle through the existing terminal row state.
  if(attempt===3) {
   const early=f.write('stop_failure','server_error');hook('stop',early.received_at+1);
   await f.consume();await f.process({readNativeActivity});
   assert.equal(f.store.read(f.group).failure_retry.eventId,retry.eventId);
   assert.equal(f.store.read(f.group).pending_notice,undefined);
   f.db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(row.id);
   await f.consume();await f.process({readNativeActivity});
   break;
  }
  f.db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(row.id);
  await f.consume();
 }
 const state=f.store.read(f.group);
 assert.equal(state.failure_retry,undefined);
 assert.equal(state.pending_notice.notice.noticeCode,'service_error');
 const sent=[];
 const options={store:f.store,database:f.db,sessionGroup:f.group,identity:async()=>f.identity,now:f.now,
   reserve:(_channel,endpoint)=>{assert.equal(endpoint,'owner');return {};},send:async(_,message)=>{sent.push(message);return {outcome:'sent'};}};
 await processFirstFailureNotices(options);await processFirstFailureNotices(options);await f.process();
 assert.equal(sent.length,1);assert.match(sent[0],/服务返回了服务端错误或过载/);assert.doesNotMatch(sent[0],/重试 3 次|Automatic retries/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n,3);
 // A fresh failure after the retry budget ends starts a new chain even if its start was
 // never sampled. The visible failure must not be swallowed by old exhaustion.
 const fresh=f.write('stop_failure','network_error');hook('stop',fresh.received_at+1);
 await f.consume();await f.process({readNativeActivity});
 assert.equal(f.store.read(f.group).failure_retry.attempts,1);
 assert.equal(f.store.read(f.group).failure_retry.eventId,fresh.event_id);
 assert.equal(f.store.read(f.group).pending_notice,undefined);
});

// Boundary: Prompt hook → retry cancellation, before and after enqueue. Run for cancellation/ingestion changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('a confirmed new round cancels before or after enqueue while a prompt hook alone does not',async t=>{
 for(const enqueue of [false,true]) {
  const f=setup(t);f.write('stop_failure','overloaded');await f.consume();if(enqueue)await f.process();
  const retry=f.store.read(f.group).failure_retry;
  f.write('prompt_submit');
  await f.consume();await f.process();
  assert.equal(f.store.read(f.group).failure_retry.eventId,retry.eventId,'a prompt hook alone does not prove a new round');
  await f.process({readNativeActivity:()=>({turnStartedAt:retry.failedAt+1})});
  assert.equal(f.store.read(f.group).failure_retry,undefined);assert.equal(f.store.read(f.group).pending_notice,undefined);
 }
});

// Boundary: Error/runtime selection → existing notice flow. Run for eligibility/health changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('nonretryable Claude and every AGY failure preserve immediate notices',async t=>{
 for(const [runtime,error] of [['claude','rate_limit'],['agy','server_error']]) {
  const f=setup(t,runtime);f.write('stop_failure',error);await f.consume();await f.process();
  assert.equal(f.store.read(f.group).failure_retry,undefined,`${runtime}:${error}`);assert.ok(f.store.read(f.group).pending_notice);
 }
});

// Boundary: Fresh scene identity → intent invalidation. Run for identity/binding changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('changed run or session invalidates continuation',async t=>{
 for(const key of ['runId','sessionId']) {
  const f=setup(t);f.write('stop_failure','network_error');await f.consume();
  await f.process({identity:async()=>({...f.scene,[key]:'new'})});
  assert.equal(f.store.read(f.group).failure_retry,undefined);assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n,0);
 }
});

// Boundary: DB commit and health-file publication → process recovery. Run for persistence/enqueue changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('AM restart preserves an already recorded pending control',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();
 await f.process();
 const reopened=new HealthStore({runtime:'claude',zylosDir:f.root,now:f.now});
 await f.process({store:reopened});await f.process({store:reopened});
 assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n,1);
 assert.ok(reopened.read(f.group).failure_retry.controlId);
});

// Boundary: Native Stop → retry-budget reset. Run for lifecycle/reducer changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('normal Stop clears the retry chain and restores the initial delay',async t=>{
 const f=setup(t);
 f.write('stop_failure','server_error');await f.consume();await f.process();
 const retry=f.store.read(f.group).failure_retry;f.advance(retry.dueAt-f.now());
 f.db.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(retry.controlId);
 f.write('prompt_submit');await f.consume();f.write('stop');await f.consume();
 assert.equal(f.store.read(f.group).failure_retry,undefined);
 f.write('stop_failure','server_error');await f.consume();assert.equal(f.store.read(f.group).failure_retry.attempts,1);
});

// Boundary: Structured error plus exclusion diagnostic → immediate notice. Run for eligibility changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('structured retryable error with context/request/content exclusion never retries',async t=>{
 const f=setup(t);f.write('stop_failure','server_error',{notice_match:{kind:'excluded',sourceId:16}});await f.consume();await f.process();
 assert.equal(f.store.read(f.group).failure_retry,undefined);assert.ok(f.store.read(f.group).pending_notice);
});


// Boundary: New failed event → atomic pending-control replacement. Run for queue/dedup changes; skip otherwise.
// Isolated temp run directory and in-memory database only; no runtime/tmux/network I/O.
test('a later failed turn leaves at most one pending continuation in its scope',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();await f.process();
 const first=f.store.read(f.group).failure_retry.controlId;
 f.write('stop_failure','network_error');await f.consume();await f.process();
 assert.equal(f.db.prepare('SELECT status FROM control_queue WHERE id=?').get(first).status,'timeout');
 assert.equal(f.db.prepare("SELECT count(*) n FROM control_queue WHERE status='pending'").get().n,1);
});

// Boundary: late old Stop before a new round → retry remains eligible.
// Run for terminal-event/retry changes; skip otherwise. Isolated DB/temp paths,
// injected no-new-round fact; shared start/end classification is tested by its owner.
test('a late Stop without a new-round start does not cancel the pending continuation',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();
 const failed=f.store.read(f.group).failure_retry.eventId;
 f.write('stop');await f.consume();await f.process();
 assert.equal(f.store.read(f.group).failure_retry.eventId,failed);
 assert.equal(f.db.prepare("SELECT count(*) n FROM control_queue WHERE status='pending'").get().n,1);
 assert.equal(f.store.read(f.group).pending_notice,undefined);
});

// Boundary: due retry → ordinary C4 input already pending → terminal cancellation.
// Run for queue-check/cancellation changes; skip otherwise. Isolated DB/temp paths;
// no transcript inference, tmux, runtime or network needed for this queue condition.
test('ordinary input queued at the retry deadline cancels it permanently without a notice',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();await f.process();
 const retry=f.store.read(f.group).failure_retry;
 const input=f.c4.insertConversation('in','telegram','owner','new ordinary input');
 f.advance(30000);await f.process();
 assert.equal(f.store.read(f.group).failure_retry,undefined);assert.equal(f.store.read(f.group).pending_notice,undefined);
 assert.equal(f.db.prepare('SELECT status FROM control_queue WHERE id=?').get(retry.controlId).status,'timeout');
 f.c4.claimConversation(input.id);f.c4.markDelivered(input.id,{sessionId:'s1'});
 f.advance(600000);await f.process();
 const restarted=new HealthStore({runtime:'claude',zylosDir:f.root,now:f.now});await f.process({store:restarted});
 assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n,1);
 assert.equal(restarted.read(f.group).pending_notice,undefined);
});

// Boundary: AM observes a real native successor before the retry deadline and
// commits cancellation. Later Stop, reader loss and AM restart cannot replay it.
// Isolated shared reader, hook/transcript files and in-memory C4 database.
test('AM sees native successor at 0.2s and cancels before its 25s Stop and 30s deadline',async t=>{
 const f=setup(t),file=path.join(f.scene.runDir,'events.jsonl');
 fs.mkdirSync(f.scene.runDir,{recursive:true});
 const transcript=path.join(f.root,'s1.jsonl');fs.writeFileSync(transcript,'');
 const hook=(event,ts,extra={})=>appendEvent(file,{v:1,run_id:'r1',session_id:'s1',runtime:'claude',event,ts,...extra});
 hook('session_start',f.now()-1000,{transcript_path:transcript});hook('prompt',f.now()-900);
 const failed=f.write('stop_failure','server_error',{run_id:'r1',ts:f.now()+100});
 hook('stop',failed.ts+20);
 await f.consume();await f.process();
 const retry=f.store.read(f.group).failure_retry;
 const reader=new SessionActivity({runDir:f.scene.runDir,runId:'r1',sessionId:'s1',runtime:'claude',startedAt:failed.ts-2000});
 t.after(()=>reader.close());
 const readNativeActivity=()=>reader.read(f.now());
 // Old open-turn state and late tools are not proof of a successor start.
 await f.process({readNativeActivity:()=>({turnOpen:true,turnStartedAt:failed.ts-900})});
 hook('pre_tool',failed.ts+100,{tool_use_id:'late-old'});
 hook('post_tool',failed.ts+150,{tool_use_id:'late-old'});
 f.advance(180);await f.process({readNativeActivity});
 assert.equal(f.store.read(f.group).failure_retry.eventId,retry.eventId);
 fs.appendFileSync(transcript,JSON.stringify({type:'queue-operation',operation:'dequeue',sessionId:'s1',timestamp:new Date(failed.ts+200).toISOString()})+'\n');
 f.advance(820);await f.process({readNativeActivity});
 assert.ok(f.now()<retry.dueAt);
 assert.equal(f.store.read(f.group).failure_retry,undefined);
 assert.equal(f.db.prepare('SELECT status FROM control_queue WHERE id=?').get(retry.controlId).status,'timeout');
 f.advance(24000);hook('stop',f.now());await f.consume();
 // Discard the reader and cross the deadline: DB cancellation is authoritative.
 f.advance(10000);
 const restarted=new HealthStore({runtime:'claude',zylosDir:f.root,now:f.now});
 await f.process({store:restarted,readNativeActivity:()=>({turnOpen:false,turnStartedAt:null})});
 assert.equal(restarted.read(f.group).failure_retry,undefined);
 assert.equal(restarted.read(f.group).pending_notice,undefined);
 assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n,1);
});

// Boundary: standard control delivery exhausts its transport retries → original
// failure notice. Run for terminal control/notice changes; isolated DB and files.
test('a control that fails delivery restores the original failure notice',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();await f.process();
 const retry=f.store.read(f.group).failure_retry;
 f.c4.claimControl(retry.controlId);f.write('stop_failure','server_error');await f.consume();
 assert.equal(f.store.read(f.group).failure_retry.eventId,retry.eventId);
 f.db.prepare("UPDATE control_queue SET status='failed' WHERE id=?").run(retry.controlId);
 await f.consume();await f.process();
 assert.equal(f.store.read(f.group).failure_retry,undefined);
 assert.equal(f.store.read(f.group).pending_notice.event_id,retry.eventId);
 assert.equal(f.store.read(f.group).pending_notice.notice.noticeCode,'service_error');
});
