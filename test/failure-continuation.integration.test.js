import { getRuntime } from '../cli/lib/runtime/index.js';
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
import { appendEvent } from '../cli/lib/event-log.js';
import { fixture } from '../skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js';
import { SessionActivity } from '../skills/activity-monitor/scripts/session-activity.js';

const hookHealth = (await getRuntime('claude')).health.hookHealth;
const agyHookHealth = (await getRuntime('agy')).health.hookHealth;

const hookHealthByRuntime = { claude: hookHealth, agy: agyHookHealth };

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
  const row={v:1,type:'runtime_health',schema_version:1,source:'hook',...identity,event_id:randomUUID(),prompt_id:runtime==='agy'?null:randomUUID(),event,error,received_at:now,ts:now,run_id:scene.runId,...extra};
  appendEvent(path.join(scene.runDir,'events.jsonl'),row);return row;
 };
 const consume=()=>reader.consumeScene(scene,identity,{hookHealth:hookHealthByRuntime[runtime]});
 const process=options=>processFailureContinuation({store,scene,identity:async()=>scene,bindTarget:async()=>binding,insertControl:f.store.insertControl,getPending:f.store.getNextPending,getControl:id=>f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),now:()=>now,expireControl:f.store.expireControlById,
   readNativeActivity:()=>({turnStartedAt:null}),...options});
 return {...f,c4:f.store,root,scene,identity,store,reader,coordinator,write,consume,process,group,now:()=>now,advance:ms=>now+=ms};
}

// Boundary: Health hooks → retry state → C4 deadline → notice worker. Run for retry/notice changes; skip otherwise.
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

// Boundary: Fresh scene identity → intent invalidation. Run for identity/binding changes; skip otherwise.
test('changed run or session invalidates continuation',async t=>{
 for(const key of ['runId','sessionId']) {
  const f=setup(t);f.write('stop_failure','network_error');await f.consume();
  await f.process({identity:async()=>({...f.scene,[key]:'new'})});
  assert.equal(f.store.read(f.group).failure_retry,undefined);assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n,0);
 }
});

// Boundary: Structured error plus exclusion diagnostic → immediate notice. Run for eligibility changes; skip otherwise.
test('structured retryable error with context/request/content exclusion never retries',async t=>{
 const f=setup(t);f.write('stop_failure','server_error',{notice_match:{kind:'excluded',sourceId:16}});await f.consume();await f.process();
 assert.equal(f.store.read(f.group).failure_retry,undefined);assert.ok(f.store.read(f.group).pending_notice);
});

// Boundary: New failed event → atomic pending-control replacement. Run for queue/dedup changes; skip otherwise.
test('a later failed turn leaves at most one pending continuation in its scope',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();await f.process();
 const first=f.store.read(f.group).failure_retry.controlId;
 f.advance(30000);
 const later=f.write('stop_failure','network_error');await f.consume();await f.process();
 assert.equal(f.db.prepare('SELECT status FROM control_queue WHERE id=?').get(first).status,'timeout');
 assert.equal(f.db.prepare("SELECT count(*) n FROM control_queue WHERE status='pending'").get().n,1);
 const retry=f.store.read(f.group).failure_retry;
 assert.equal(retry.attempts,1);assert.equal(retry.dueAt,later.received_at+30000);
});

// Boundary: due retry → ordinary C4 input already pending → terminal cancellation.
// Run for queue-check/cancellation changes; skip otherwise. Isolated DB/temp paths;
// no transcript inference, tmux, runtime or network needed for this queue condition.
test('ordinary input queued at the retry deadline cancels it permanently without a notice',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();await f.process();
 const retry=f.store.read(f.group).failure_retry;
 const input=f.c4.insertConversation('in','telegram','owner','new ordinary input');
 await f.process();
 assert.equal(f.store.read(f.group).failure_retry.controlId,retry.controlId,'pending input is checked only at the deadline');
 f.advance(30000);await f.process();
 assert.equal(f.store.read(f.group).failure_retry,undefined);assert.equal(f.store.read(f.group).pending_notice,undefined);
 assert.equal(f.db.prepare('SELECT status FROM control_queue WHERE id=?').get(retry.controlId).status,'timeout');
 f.c4.claimConversation(input.id);f.c4.markDelivered(input.id,{sessionId:'s1'});
 f.advance(600000);await f.process();
 const restarted=new HealthStore({runtime:'claude',zylosDir:f.root,now:f.now});await f.process({store:restarted});
 assert.equal(f.db.prepare('SELECT count(*) n FROM control_queue').get().n,1);
 assert.equal(restarted.read(f.group).pending_notice,undefined);
});

// Boundary: shared health cache must not make another group's terminal hook
// wait on this group's running Continue. Run for group selection/reader changes;
// isolated two-group event files and in-memory C4 DB, no runtime or tmux.
test('a running continuation never blocks terminal hooks in another group',async t=>{
 const f=setup(t);f.write('stop_failure','server_error');await f.consume();await f.process();
 const retry=f.store.read(f.group).failure_retry;f.c4.claimControl(retry.controlId);
 const other={...f.scene,sessionGroup:'telegram:other',runDir:path.join(f.root,'other-run')};
 // Reopen selecting the first group to expose stale top-level cache projection
 // as well as the reader's resulting stall in a different group.
 const second=f.write('stop_failure','rate_limit');
 appendEvent(path.join(other.runDir,'events.jsonl'),second);
 const reopened=new RuntimeHealthCoordinator({zylosDir:f.root,now:f.now});
 reopened.store('claude').read(f.group);
 const reader=new HealthEventReader({coordinator:reopened,zylosDir:f.root,now:f.now,quota:()=>null,
   getControl:id=>f.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id)});
 t.after(()=>reader.close());
 const results=await reader.consumeScene(other,f.identity,{hookHealth});
 assert.equal(results.length,1);assert.equal(results[0].status,'processed');
 assert.equal(reopened.store('claude').read(other.sessionGroup).failure_retry,undefined);
 assert.equal(reopened.store('claude').read(other.sessionGroup).last_processed.event_id,second.event_id);
 assert.equal(reopened.store('claude').read(f.group).failure_retry.controlId,retry.controlId);
});
