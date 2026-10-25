import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import * as schema from '../schema.js';
import * as c4 from '../../../comm-bridge/scripts/c4-db.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import { dispatchTask, executionMarker } from '../daemon-dispatch.js';
import { sendViaC4 } from '../runtime.js';
import { mainLoop, handleMissedTasks, runSchedulerIteration } from '../daemon.js';
import { handleStaleRunningTasks, processCompletedTasks, TASK_TIMEOUT } from '../daemon-tasks.js';
const receiveFixture=fileURLToPath(new URL('./fixtures/receive-result.mjs',import.meta.url));
function fixture(t, overrides={}) {
  const db=new Database(':memory:'); guardDatabase(db,schema); t.after(()=>db.close());
  const time=Math.floor(Date.now()/1000);
  const task={id:'task-test',name:'Test',prompt:'literal prompt\nnext line',type:'one-time',next_run_at:time-10,priority:3,status:'pending',require_idle:0,miss_threshold:300,created_at:time,updated_at:time,...overrides};
  const keys=Object.keys(task); db.prepare(`INSERT INTO tasks(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...Object.values(task));
  const read=()=>({task:db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id),history:db.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(task.id)});
  return {db,task,time,read};
}
const base={getRecentConversations:()=>[],getConversationsByRange:()=>[]};
function receive(mode, options={}) {return (message,route)=>sendViaC4(message,route,{receivePath:receiveFixture,execute(cmd,args,settings){return execFileSync(cmd,args,{...settings,...options,env:{...process.env,...options.env,RECEIVE_FIXTURE_MODE:mode}});}});}

for(const mode of ['success','UNHEALTHY_NOTIFY_FAILED:["conversations"]','UNHEALTHY_NOTIFY_UNCERTAIN:["conversations"]'])
 test(`committed ${mode} remains running and does not resend`,t=>{
  const {db,task,read}=fixture(t);let sends=0;
  const deps={...base,sendViaC4(...args){sends++;return receive(mode)(...args);}};
  const result=dispatchTask(db,task,deps);assert.equal(result.claimed,true);
  const row=read();assert.equal(row.task.status,'running');assert.equal(row.history[0].status,'started');
  if(mode!=='success')assert.equal(row.task.last_error,mode.split(':')[0]);
  assert.deepEqual(dispatchTask(db,task,deps),{claimed:false});assert.equal(sends,1);
 });

for(const type of ['one-time','recurring','interval']) test(`R fails exact execution and advances only recurring schedule: ${type}`,t=>{
 const {db,task,read}=fixture(t,{type,interval_seconds:60,cron_expression:'* * * * *',timezone:'UTC'});
 db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,1,'started')").run(task.id);
 const result=dispatchTask(db,task,{...base,sendViaC4:receive('INVALID_ARGS:[]')});
 const row=read(); assert.equal(row.history[0].status,'started'); assert.equal(row.history[1].id,result.historyId);
 assert.equal(row.history[1].status,'failed'); assert.equal(row.history[1].error,'INVALID_ARGS'); assert.ok(row.history[1].completed_at);
 assert.equal(row.task.status,type==='one-time'?'failed':'pending');
 assert.equal(row.task.last_error,'INVALID_ARGS');
 if(type!=='one-time')assert.ok(row.task.next_run_at>task.next_run_at);else assert.equal(row.task.next_run_at,task.next_run_at);
});

test('T known zero commit retains original due time and retries with new execution id',t=>{
 const {db,task,read}=fixture(t);let sends=0;
 const deps={...base,sendViaC4(...args){sends++;return receive('DB_BUSY:[]')(...args);}};
 const first=dispatchTask(db,task,deps);const second=dispatchTask(db,task,deps);
 assert.notEqual(first.historyId,second.historyId);assert.equal(sends,2);
 assert.equal(read().task.status,'pending');assert.equal(read().task.next_run_at,task.next_run_at);
 assert.ok(read().history.every(row=>row.status==='failed'&&row.error==='DB_BUSY'));
});

test('failed pre-send lower bound never starts receive and rolls back execution to pending',t=>{
 const {db,task,read}=fixture(t);
 const result=dispatchTask(db,task,{...base,getRecentConversations(){throw new Error('locked');},sendViaC4(){assert.fail('must not send');}});
 assert.equal(result.category,'T');assert.equal(read().task.status,'pending');assert.equal(read().task.next_run_at,task.next_run_at);
 assert.equal(read().history[0].error,'CONVERSATION_BOUND_UNAVAILABLE');
});

for(const state of ['pending','running','delivered','failed']) test(`unknown receipt finds exact execution regardless of D1 ${state} or absorbed group`,t=>{
 const {db,task,read}=fixture(t);let marker;let exited=false;let reads=0;
 const result=dispatchTask(db,task,{getRecentConversations(limit){assert.equal(limit,1);return [{id:3}];},
 sendViaC4(message,options){marker=message.split('\n')[0];const result=receive('invalid')(message,options);exited=true;return result;},
 getConversationsByRange(start,end){reads++;assert.equal(exited,true);assert.equal(start,4);assert.equal(end,Number.MAX_SAFE_INTEGER);return [
 {id:4,direction:'in',content:executionMarker(task.id,999)+'\nold',status:'delivered'},
 {id:50,direction:'in',content:marker+'\n'+('x'.repeat(5000)),status:state,session_group:'origin'}];}});
 assert.equal(result.category,'success');assert.equal(reads,1);assert.equal(read().task.status,'running');assert.equal(read().history[0].status,'started');
});

test('full marker rejects old history, substrings, prefix and outbound false matches',t=>{
 const {db,task,read}=fixture(t);let marker;
 const result=dispatchTask(db,task,{...base,sendViaC4(message){marker=message.split('\n')[0];return {category:'U'};},getConversationsByRange(start,end){
 assert.equal(start,1);assert.equal(end,Number.MAX_SAFE_INTEGER);
 return [{direction:'in',content:executionMarker(task.id,0)+'\nold'},{direction:'in',content:'prefix '+marker},{direction:'in',content:marker+' suffix'}, {direction:'in',content:'other\n'+marker},{direction:'out',content:marker}];}});
 assert.equal(result.category,'T');assert.equal(read().task.status,'pending');assert.equal(read().task.next_run_at,task.next_run_at);
});

for(const mode of ['abnormal','invalid','timeout'])for(const outcome of ['found','absent','failed'])
 test(`actual child ${mode}, one readback ${outcome}`,t=>{
 const {db,task,read}=fixture(t);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-readback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const exited=path.join(dir,'exited');let marker,returned=false;
 const result=dispatchTask(db,task,{...base,sendViaC4(message,options){marker=message.split('\n')[0];const value=receive(mode,{timeout:mode==='timeout'?500:45000,env:{RECEIVE_FIXTURE_EXITED:exited}})(message,options);returned=true;return value;},
 getConversationsByRange(){assert.equal(returned,true);if(mode==='timeout')assert.equal(fs.readFileSync(exited,'utf8'),'exited');if(outcome==='failed')throw new Error('read failed');return outcome==='found'?[{direction:'in',content:marker+'\ntext'}]:[];}});
 assert.equal(result.category,{found:'success',absent:'T',failed:'U'}[outcome]);
 assert.equal(read().task.status,outcome==='absent'?'pending':'running');
 assert.equal(read().history[0].status,outcome==='absent'?'failed':'started');
 });

for(const category of ['R','T','C','U','success']) test(`late ${category} accounting cannot overwrite done`,t=>{
 const {db,task,read}=fixture(t);
 dispatchTask(db,task,{...base,sendViaC4(){db.transaction(()=>{
 db.prepare("UPDATE tasks SET status='completed',last_error='done' WHERE id=?").run(task.id);
 db.prepare("UPDATE task_history SET status='success',completed_at=99 WHERE task_id=?").run(task.id);
 })();return {category,code:'TEST'};},getConversationsByRange(){throw new Error('unknown');}});
 assert.equal(read().task.status,'completed');assert.equal(read().task.last_error,'done');assert.equal(read().history[0].status,'success');assert.equal(read().history[0].completed_at,99);
});

test('claim and history insertion are one transaction',t=>{
 const {db,task,read}=fixture(t);db.exec("CREATE TRIGGER fail_history BEFORE INSERT ON task_history BEGIN SELECT RAISE(ABORT,'history fail'); END");
 assert.throws(()=>dispatchTask(db,task,{...base,sendViaC4(){assert.fail('must not send');}}),/history fail/);
 assert.equal(read().task.status,'pending');assert.equal(read().history.length,0);
});

test('result accounting rolls back both writes and never resends on DB failure',t=>{
 const {db,task,read}=fixture(t);let calls=0;
 db.exec("CREATE TRIGGER fail_result BEFORE UPDATE ON tasks WHEN NEW.status='pending' BEGIN SELECT RAISE(ABORT,'account fail'); END");
 assert.throws(()=>dispatchTask(db,task,{...base,sendViaC4(){calls++;return {category:'T',code:'DB_BUSY'};}}),/account fail/);
 assert.equal(calls,1);assert.equal(read().task.status,'running');assert.equal(read().history[0].status,'started');
 assert.equal(dispatchTask(db,task,{...base,sendViaC4(){assert.fail('must not resend');}}).claimed,false);
});

async function withStatusFiles(t,mode,scope,state,fn) {
 const oldRoot=process.env.ZYLOS_DIR;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-status-'));
 try {
  process.env.ZYLOS_DIR=root;
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({runtime:'claude',session_mode:mode}));
  const monitor=path.join(root,'activity-monitor');
  const statusDir=scope==='machine'?monitor:path.join(monitor,'session-groups',scope==='origin'?'origin':'telegram.team');
  fs.mkdirSync(statusDir,{recursive:true});
  if(state!=='missing')fs.writeFileSync(path.join(statusDir,'agent-status.json'),
   state==='error'?'{bad':JSON.stringify({state:state==='busy'?'busy':'stopped',updatedAt:state==='stale'?1:Date.now()}));
  // Observe actual filesystem access, not an unused injected reader. Even a
  // swallowed read error increments the counter and fails the assertion.
  const originalRead=fs.readFileSync; let statusReads=0;
  const guarded=t.mock.method(fs,'readFileSync',function(file,...args){
    if(String(file).startsWith(monitor+path.sep)) { statusReads++; throw new Error('Scheduler must not read runtime diagnostics'); }
    return originalRead.call(this,file,...args);
  });
  syncBuiltinESMExports();
  try { const result=await fn(); assert.equal(statusReads,0,'runtime diagnostic reader was invoked'); return result; }
  finally { guarded.mock.restore(); syncBuiltinESMExports(); }
 } finally {
  if(oldRoot===undefined)delete process.env.ZYLOS_DIR;else process.env.ZYLOS_DIR=oldRoot;
  fs.rmSync(root,{recursive:true,force:true});
 }
}

for(const mode of ['single','multi'])for(const scope of ['machine','origin','target'])for(const state of ['missing','busy','stale','error'])
 test(`main loop ignores actual ${mode} / ${scope} / ${state} status files`,async t=>{
  const {db}=fixture(t,{id:`task-${mode}-${scope}-${state}`,session_component:'telegram',session_group_name:'team'});let sends=0,loops=0;
  await withStatusFiles(t,mode,scope,state,()=>mainLoop(db,{shouldRun:()=>loops++===0,sleep:async()=>{},dependencies:{...base,
   sendViaC4(){sends++;return {category:'success'};}}}));
  assert.equal(sends,1);
 });

for(const mode of ['single','multi'])for(const scope of ['machine','origin','target'])for(const state of ['missing','busy','stale','error'])
 test(`missed loop ignores actual ${mode} / ${scope} / ${state} status files`,async t=>{
  const {db,read}=fixture(t,{type:'interval',interval_seconds:60,next_run_at:Math.floor(Date.now()/1000)-400,miss_threshold:600,session_component:'telegram',session_group_name:'team'});let sends=0;
  await withStatusFiles(t,mode,scope,state,()=>handleMissedTasks(db,{...base,sendViaC4(){sends++;return {category:'success'};}}));
  assert.equal(sends,1);assert.equal(read().task.status,'running');
 });

for(const type of ['one-time','interval']) test(`zero-commit retries stop beyond miss window: ${type}`,t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});
 const {db,task,read}=fixture(t,{type,interval_seconds:60});let sends=0;
 const deps={...base,sendViaC4(){sends++;return {category:'T',code:'DB_BUSY'};}};
 runSchedulerIteration(db,deps);assert.equal(sends,1);t.mock.timers.tick(301000);runSchedulerIteration(db,deps);
 assert.equal(sends,1);assert.equal(read().task.status,type==='one-time'?'failed':'pending');
 if(type==='interval')assert.ok(read().task.next_run_at>task.next_run_at);
});

for(const category of ['C','U'])for(const type of ['one-time','interval']) test(`${category} retains execution until 3600s stale: ${type}`,t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});
 const {db,task,read}=fixture(t,{type,interval_seconds:60});let sends=0;
 const deps={...base,sendViaC4(){sends++;return {category,code:'UNCERTAIN'};},getConversationsByRange(){throw new Error('read failed');}};
 dispatchTask(db,task,deps);t.mock.timers.tick(TASK_TIMEOUT*1000);handleStaleRunningTasks(db);assert.equal(read().task.status,'running');
 assert.equal(dispatchTask(db,task,deps).claimed,false);assert.equal(sends,1);
 t.mock.timers.tick(1000);handleStaleRunningTasks(db);assert.equal(read().history[0].status,'timeout');
 assert.equal(read().task.status,type==='one-time'?'failed':'completed');processCompletedTasks(db);
 if(type==='interval'){assert.equal(read().task.status,'pending');assert.ok(read().task.next_run_at>task.next_run_at);}
});


test('real P01 recent/range reads find full execution after a non-maximum-id lower bound',t=>{
 const {db,task,read}=fixture(t);
 const messages=c4.getDb();
 // Exercise the existing D1 owner schema and read APIs; receive remains a fixture.
 const put=messages.prepare("INSERT INTO conversations(direction,channel,content,timestamp,status,session_group) VALUES('in','system',?,?,?,?)");
 const old=Number(put.run(executionMarker(task.id,999)+'\nold',9999999999,'failed','origin').lastInsertRowid);
 const later=Number(put.run('different prior message',1,'pending','origin').lastInsertRowid);
 assert.ok(later>old);assert.equal(c4.getRecentConversations(1)[0].id,old);
 const result=dispatchTask(db,task,{sendViaC4(message){
   put.run(message+'\n'+('long'.repeat(3000)),2,'failed','origin');
   return {category:'U'};
 }});
 assert.equal(result.category,'success');assert.equal(read().task.status,'running');
 assert.equal(read().history[0].status,'started');
});

test('retry with extended window sends once per scheduler iteration, then expires',t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});
 const {db,task,read}=fixture(t,{type:'interval',interval_seconds:60,next_run_at:2000000000-400,miss_threshold:600});let calls=0;
 const deps={...base,sendViaC4(){calls++;return {category:'T',code:'DB_BUSY'};}};
 runSchedulerIteration(db,deps);assert.equal(calls,1);assert.equal(read().task.next_run_at,task.next_run_at);
 t.mock.timers.tick(201000);runSchedulerIteration(db,deps);assert.equal(calls,1);assert.ok(read().task.next_run_at>task.next_run_at);
});
