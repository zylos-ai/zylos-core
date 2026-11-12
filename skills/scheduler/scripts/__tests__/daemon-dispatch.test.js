import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import * as schema from '../schema.js';
import * as c4Schema from '../../../comm-bridge/scripts/c4-schema.js';
import * as c4 from '../../../comm-bridge/scripts/c4-db.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import { dispatchTask, executionMarker } from '../daemon-dispatch.js';
import { sendViaC4 } from '../runtime.js';
import { queryComponentSessionGroup } from '../../../comm-bridge/scripts/c4-component-session-group.js';
import { mainLoop, handleMissedTasks, runSchedulerIteration } from '../daemon-dispatch.js';
import { realReceive } from './fixtures/real-receive.js';
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

// Real scheduler/SQLite boundary: run after delivery accounting or cadence changes;
// unrelated UI changes may skip. The official runner supplies isolated HOME,
// ZYLOS_DIR, PM2_HOME, CODEX_HOME, short TMPDIR and private TMUX_TMPDIR. C4 queries
// and receives are injected; no live socket/network/PM2/database is touched.
for (const type of ['one-time', 'recurring', 'interval'])
test(`successful ${type} delivery ends its exact history and advances from delivery time`, t => {
  const start = Date.parse('2030-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { db, task, read } = fixture(t, { type, cron_expression: type === 'recurring' ? '*/30 * * * *' : null,
    interval_seconds: type === 'interval' ? 1800 : null, timezone: 'UTC',
    last_error: 'OLD_FAILURE', failed_at: start / 1000 - 99 });
  db.prepare("INSERT INTO task_history(task_id,executed_at,completed_at,status,error,duration_ms) VALUES(?,1,2,'failed','OLD_FAILURE',1000)").run(task.id);
  const previous = read().history[0];
  const result = dispatchTask(db, task, { ...base, sendViaC4(message) {
    const claimed = read();
    assert.equal(claimed.task.status, 'running');
    assert.equal(claimed.history.at(-1).status, 'started');
    assert.equal(message, executionMarker(task.id, claimed.history.at(-1).id) + '\n' + task.prompt);
    assert.doesNotMatch(message, /After completing this task|cli\.js done/);
    t.mock.timers.tick(7000); return { category: 'success' };
  } });
  const after = read(), history = after.history.at(-1);
  assert.equal(result.category, 'success');
  assert.equal(history.id, result.historyId); assert.equal(history.status, 'success');
  assert.equal(history.executed_at, start / 1000); assert.equal(history.completed_at, start / 1000 + 7);
  assert.equal(history.duration_ms, 7000); assert.equal(history.error, null);
  assert.deepEqual(after.history[0], previous);
  assert.equal(after.task.status, type === 'one-time' ? 'completed' : 'pending');
  assert.equal(after.task.last_run_at, start / 1000 + 7);
  assert.equal(after.task.updated_at, start / 1000 + 7);
  assert.equal(after.task.last_error, null); assert.equal(after.task.failed_at, null);
  assert.equal(after.task.next_run_at, type === 'one-time' ? task.next_run_at
    : type === 'recurring' ? start / 1000 + 1800 : start / 1000 + 1807);
});

for (const type of ['recurring', 'interval'])
test(`half-hour ${type} delivers at two consecutive occurrences without done`, t => {
  const start = Date.parse('2030-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { db, read } = fixture(t, { type, cron_expression: type === 'recurring' ? '*/30 * * * *' : null,
    interval_seconds: type === 'interval' ? 1800 : null, timezone: 'UTC', next_run_at: start / 1000 });
  let sends = 0;
  const deps = { ...base, sendViaC4: () => { sends++; return { category: 'success' }; } };
  runSchedulerIteration(db, deps);
  assert.equal(sends, 1); assert.equal(read().task.status, 'pending');
  assert.equal(read().task.next_run_at, start / 1000 + 1800);
  t.mock.timers.tick(1799000); runSchedulerIteration(db, deps); assert.equal(sends, 1);
  t.mock.timers.tick(1000); runSchedulerIteration(db, deps);
  assert.equal(sends, 2); assert.equal(read().task.status, 'pending');
  assert.equal(read().task.next_run_at, start / 1000 + 3600);
  assert.equal(read().history.length, 2);
  for (const row of read().history) {
    assert.equal(row.status, 'success'); assert.equal(row.completed_at, row.executed_at);
    assert.equal(row.duration_ms, 0); assert.equal(row.error, null);
  }
});

for (const type of ['one-time', 'interval'])
test(`successful ${type} accounting rolls back task and history together on database failure`, t => {
  const { db, task, read } = fixture(t, { type, interval_seconds: 1800 }); let sends = 0;
  const status = type === 'one-time' ? 'completed' : 'pending';
  db.exec(`CREATE TRIGGER fail_delivery_result BEFORE UPDATE ON tasks WHEN NEW.status='${status}' BEGIN SELECT RAISE(ABORT,'delivery account failure'); END`);
  assert.throws(() => dispatchTask(db, task, { ...base, sendViaC4: () => { sends++; return { category: 'success' }; } }), /delivery account failure/);
  assert.equal(sends, 1); assert.equal(read().task.status, 'running');
  assert.equal(read().history.length, 1); assert.equal(read().history[0].status, 'started');
  assert.equal(read().history[0].completed_at, null); assert.equal(read().history[0].duration_ms, null);
  assert.equal(dispatchTask(db, task, { ...base, sendViaC4: () => assert.fail('must not resend') }).claimed, false);
});

for (const category of ['T', 'R']) test(`failed dispatch records elapsed time and reason: ${category}`, t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
  const { db, task, read } = fixture(t);
  const result = dispatchTask(db, task, { ...base, sendViaC4() {
    t.mock.timers.tick(7000);
    return { category, code: 'DB_BUSY' };
  } });
  const row = read().history.find(entry => entry.id === result.historyId);
  assert.equal(row.status, 'failed');
  assert.equal(row.error, 'DB_BUSY');
  assert.equal(row.completed_at - row.executed_at, 7);
  assert.equal(row.duration_ms, (row.completed_at - row.executed_at) * 1000);
});

for (const [category, code] of [['U', 'RECEIVE_RESULT_UNKNOWN'], ['C', 'UNHEALTHY_NOTIFY_FAILED']])
test(`uncertain dispatch records reason without completing history: ${category}`, t => {
  const { db, task, read } = fixture(t);
  db.prepare("INSERT INTO task_history(task_id,executed_at,status,error,duration_ms) VALUES(?,1,'failed','OLDER_FAILURE',3000)").run(task.id);
  const previous = read().history[0];
  const result = dispatchTask(db, task, { ...base,
    sendViaC4: () => ({ category, code }),
    getConversationsByRange() { throw new Error('read unavailable'); }
  });
  const row = read();
  const history = row.history.find(entry => entry.id === result.historyId);
  assert.equal(history.status, 'started');
  assert.equal(history.error, code);
  assert.equal(history.duration_ms, null);
  assert.equal(history.completed_at, null);
  assert.equal(row.task.status, 'running');
  assert.equal(row.task.last_error, code);
  assert.deepEqual(row.history[0], previous);
});

test('unknown delivery is not reclassified or notified after an hour', t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
  const { db, task, read } = fixture(t); let sends = 0;
  const deps = { ...base, sendViaC4() { sends++; return { category: 'U' }; },
    getConversationsByRange() { throw new Error('read unavailable'); } };
  dispatchTask(db, task, deps);
  const unresolved = read();
  t.mock.timers.tick(3601000);
  runSchedulerIteration(db, deps);
  assert.deepEqual(read(), unresolved);
  assert.equal(sends, 1);
  assert.equal(read().history[0].error, 'RECEIVE_RESULT_UNKNOWN');
});

for(const mode of ['success','UNHEALTHY_NOTIFY_FAILED','UNHEALTHY_NOTIFY_UNCERTAIN'])
 test(`committed ${mode} keeps its delivery outcome and does not resend`,t=>{
  const {db,task,read}=fixture(t,{reply_channel:'telegram',reply_endpoint:'target',session_component:'telegram'});let sends=0;
  const real=realReceive(t,mode==='success'?{}:{health:'unavailable',...(mode==='UNHEALTHY_NOTIFY_UNCERTAIN'?{noticeExit:7}:{})});
  const deps={...base,sendViaC4(...args){sends++;const result=real.send(...args);
    if(mode!=='success')assert.deepEqual(result.receipt.error.persisted,['D1']);
    return result;}};
  const result=dispatchTask(db,task,deps);assert.equal(result.claimed,true);
  const row=read();assert.equal(row.task.status,mode==='success'?'completed':'running');assert.equal(row.history[0].status,mode==='success'?'success':'started');
  if(mode!=='success')assert.equal(row.task.last_error,mode.split(':')[0]);
  assert.deepEqual(dispatchTask(db,task,deps),{claimed:false});assert.equal(sends,1);
  assert.equal(real.rows().filter(row=>row.direction==='in').length,1);
 });

for(const type of ['one-time','recurring','interval']) test(`R fails exact execution and advances only recurring schedule: ${type}`,t=>{
 const {db,task,read}=fixture(t,{type,interval_seconds:60,cron_expression:'* * * * *',timezone:'UTC',session_component:'not-installed'});
 const real=realReceive(t);
 db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,1,'started')").run(task.id);
 const result=dispatchTask(db,task,{...base,sendViaC4(message,route){const result=real.send(message,route);assert.equal(result.receipt.error.code,'INVALID_ARGS');assert.deepEqual(result.receipt.error.persisted,[]);return result;}});
 assert.deepEqual(real.rows(),[]);
 const row=read(); assert.equal(row.history[0].status,'started'); assert.equal(row.history[1].id,result.historyId);
 assert.equal(row.history[1].status,'failed'); assert.equal(row.history[1].error,'INVALID_ARGS'); assert.ok(row.history[1].completed_at);
 assert.equal(row.task.status,type==='one-time'?'failed':'pending');
 assert.equal(row.task.last_error,'INVALID_ARGS');
 if(type!=='one-time')assert.ok(row.task.next_run_at>task.next_run_at);else assert.equal(row.task.next_run_at,task.next_run_at);
});

// : Scheduler claim/dispatch through the actual CLI and owner.
for(const [label, route, expected] of [
 ['saved group with reply',{session_component:'telegram',session_group_name:'team',reply_channel:'telegram',reply_endpoint:'chat|msg:9'},['telegram','chat|msg:9','telegram:team']],
 ['saved group without reply',{session_component:'telegram',session_group_name:'team'},['telegram',null,'telegram:team']],
 ['without reply or saved group',{},['system',null,'origin']],
]) test(`real Scheduler dispatch D1 routing: ${label}`,t=>{
 const {db,task,read}=fixture(t,route);const real=realReceive(t);
 const result=dispatchTask(db,task,{...base,sendViaC4:real.send});
 assert.equal(result.category,'success');assert.equal(read().task.status,'completed');
 assert.equal(read().history[0].status,'success');
 const rows=real.rows();assert.equal(rows.length,1);
 const row=rows[0];assert.deepEqual([row.channel,row.endpoint_id,row.session_group],expected);
 assert.equal(row.direction,'in');assert.equal(row.status,'pending');
 assert.ok(row.content.startsWith(executionMarker(task.id,result.historyId)+'\n'));
 assert.ok(row.content.includes(task.prompt));
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

test('unknown receipt finds exact execution in mixed D1 statuses and absorbed groups',t=>{
 const {db,task,read}=fixture(t);let marker;let exited=false;let reads=0;
 const result=dispatchTask(db,task,{getRecentConversations(limit){assert.equal(limit,1);return [{id:3}];},
 sendViaC4(message,options){marker=message.split('\n')[0];const result=receive('invalid')(message,options);exited=true;return result;},
 getConversationsByRange(start,end){reads++;assert.equal(exited,true);assert.equal(start,4);assert.equal(end,Number.MAX_SAFE_INTEGER);return [
 {id:4,direction:'in',content:executionMarker(task.id,999)+'\nold',status:'delivered'},
 ...['pending','running','delivered','failed'].map((status,i)=>({id:50+i,direction:'in',content:marker+'\n'+('x'.repeat(5000)),status,session_group:'origin'}))];}});
 assert.equal(result.category,'success');assert.equal(reads,1);assert.equal(read().task.status,'completed');assert.equal(read().history[0].status,'success');
});

test('full marker rejects old history, substrings, prefix and outbound false matches',t=>{
 const {db,task,read}=fixture(t);let marker;
 const result=dispatchTask(db,task,{...base,sendViaC4(message){marker=message.split('\n')[0];return {category:'U'};},getConversationsByRange(start,end){
 assert.equal(start,1);assert.equal(end,Number.MAX_SAFE_INTEGER);
 return [{direction:'in',content:executionMarker(task.id,0)+'\nold'},{direction:'in',content:'prefix '+marker},{direction:'in',content:marker+' suffix'}, {direction:'in',content:'other\n'+marker},{direction:'out',content:marker}];}});
 assert.equal(result.category,'T');assert.equal(read().task.status,'pending');assert.equal(read().task.next_run_at,task.next_run_at);
});

for(const mode of ['timeout'])for(const outcome of ['found','absent','failed'])
 test(`actual child ${mode}, one readback ${outcome}`,t=>{
 const {db,task,read}=fixture(t);const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-readback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const exited=path.join(dir,'exited');let marker,returned=false;
 const result=dispatchTask(db,task,{...base,sendViaC4(message,options){marker=message.split('\n')[0];const value=receive(mode,{timeout:mode==='timeout'?500:45000,env:{RECEIVE_FIXTURE_EXITED:exited}})(message,options);returned=true;return value;},
 getConversationsByRange(){assert.equal(returned,true);if(mode==='timeout')assert.equal(fs.readFileSync(exited,'utf8'),'exited');if(outcome==='failed')throw new Error('read failed');return outcome==='found'?[{direction:'in',content:marker+'\ntext'}]:[];}});
 assert.equal(result.category,{found:'success',absent:'T',failed:'U'}[outcome]);
 assert.equal(read().task.status,{found:'completed',absent:'pending',failed:'running'}[outcome]);
 assert.equal(read().history[0].status,{found:'success',absent:'failed',failed:'started'}[outcome]);
 });

for(const category of ['R','T','C','U','success']) test(`late ${category} accounting cannot overwrite an already closed delivery`,t=>{
 const {db,task,read}=fixture(t);
 dispatchTask(db,task,{...base,sendViaC4(){db.transaction(()=>{
 db.prepare("UPDATE tasks SET status='completed',last_error='closed elsewhere' WHERE id=?").run(task.id);
 db.prepare("UPDATE task_history SET status='success',completed_at=99 WHERE task_id=?").run(task.id);
 })();return {category,code:'TEST'};},getConversationsByRange(){throw new Error('unknown');}});
 assert.equal(read().task.status,'completed');assert.equal(read().task.last_error,'closed elsewhere');assert.equal(read().history[0].status,'success');assert.equal(read().history[0].completed_at,99);
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

async function withStatusFiles(t,mode,fn) {
 const oldRoot=process.env.ZYLOS_DIR;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'scheduler-status-'));
 try {
  process.env.ZYLOS_DIR=root;
  fs.writeFileSync(path.join(root,'config.json'),JSON.stringify({runtime:'claude',session_mode:mode}));
  const monitor=path.join(root,'activity-monitor');
  for (const scope of ['', 'session-groups/origin', 'session-groups/telegram.team']) {
    const statusDir=path.join(monitor,scope);
    fs.mkdirSync(statusDir,{recursive:true});
    fs.writeFileSync(path.join(statusDir,'agent-status.json'),JSON.stringify({state:'stopped',updatedAt:1}));
  }
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

for(const mode of ['single','multi'])
 test(`main loop ignores actual ${mode} machine / origin / target status files`,async t=>{
  const {db}=fixture(t,{id:`task-${mode}`,session_component:'telegram',session_group_name:'team'});let sends=0,loops=0;
  await withStatusFiles(t,mode,()=>mainLoop(db,{shouldRun:()=>loops++===0,sleep:async()=>{},dependencies:{...base,
   sendViaC4(){sends++;return {category:'success'};}}}));
  assert.equal(sends,1);
 });

for(const mode of ['single','multi'])
 test(`missed loop ignores actual ${mode} machine / origin / target status files`,async t=>{
  const {db,read}=fixture(t,{type:'interval',interval_seconds:60,next_run_at:Math.floor(Date.now()/1000)-400,miss_threshold:600,session_component:'telegram',session_group_name:'team'});let sends=0;
  await withStatusFiles(t,mode,()=>handleMissedTasks(db,{...base,sendViaC4(){sends++;return {category:'success'};}}));
  assert.equal(sends,1);assert.equal(read().task.status,'pending');
 });

for(const type of ['one-time','interval']) test(`zero-commit retries stop beyond miss window: ${type}`,t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});
 const {db,task,read}=fixture(t,{type,interval_seconds:60});let sends=0;
 const deps={...base,sendViaC4(){sends++;return {category:'T',code:'DB_BUSY'};}};
 runSchedulerIteration(db,deps);assert.equal(sends,1);t.mock.timers.tick(301000);runSchedulerIteration(db,deps);
 assert.equal(sends,1);assert.equal(read().task.status,type==='one-time'?'failed':'pending');
 if(type==='interval')assert.ok(read().task.next_run_at>task.next_run_at);
});

for(const category of ['C','U']) for(const type of ['one-time','interval'])
test(`${category} keeps an unresolved delivery without automatic timeout: ${type}`, t => {
  t.mock.timers.enable({ apis: ['Date'], now: 2000000000000 });
  const { db, task, read } = fixture(t, { type, interval_seconds: 60 }); let sends = 0;
  const deps = { ...base, sendViaC4() { sends++; return { category, code: 'UNCERTAIN' }; },
    getConversationsByRange() { throw new Error('read failed'); } };
  dispatchTask(db, task, deps);
  const unresolved = read();
  t.mock.timers.tick(7200000); runSchedulerIteration(db, deps);
  assert.deepEqual(read(), unresolved);
  assert.equal(dispatchTask(db, task, deps).claimed, false); assert.equal(sends, 1);
});

test('real recent/range reads find full execution after a non-maximum-id lower bound',t=>{
 const {db,task,read}=fixture(t);
 const messages=c4.getDb();
 // U readback needs a persisted row with a deliberately lost receipt; inject only that uncertainty.
 const put=messages.prepare("INSERT INTO conversations(direction,channel,content,timestamp,status,session_group) VALUES('in','system',?,?,?,?)");
 const old=Number(put.run(executionMarker(task.id,999)+'\nold',9999999999,'failed','origin').lastInsertRowid);
 const later=Number(put.run('different prior message',1,'pending','origin').lastInsertRowid);
 assert.ok(later>old);assert.equal(c4.getRecentConversations(1)[0].id,old);
 const result=dispatchTask(db,task,{sendViaC4(message){
   put.run(message+'\n'+('long'.repeat(3000)),2,'failed','origin');
   return {category:'U'};
 }});
 assert.equal(result.category,'success');assert.equal(read().task.status,'completed');
 assert.equal(read().history[0].status,'success');
});

test('retry with extended window sends once per scheduler iteration, then expires',t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});
 const {db,task,read}=fixture(t,{type:'interval',interval_seconds:60,next_run_at:2000000000-400,miss_threshold:600});let calls=0;
 const deps={...base,sendViaC4(){calls++;return {category:'T',code:'DB_BUSY'};}};
 runSchedulerIteration(db,deps);assert.equal(calls,1);assert.equal(read().task.next_run_at,task.next_run_at);
 t.mock.timers.tick(201000);runSchedulerIteration(db,deps);assert.equal(calls,1);assert.ok(read().task.next_run_at>task.next_run_at);
});

// A stored zero uses the established five-minute default.
test('miss_threshold zero uses the default window, then expires',t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});
 const {db,read}=fixture(t,{miss_threshold:0});let sends=0;
 const deps={...base,sendViaC4(){sends++;return {category:'T',code:'DB_BUSY'};}};
 runSchedulerIteration(db,deps);assert.equal(sends,1);assert.equal(read().task.status,'pending');
 t.mock.timers.tick(301000);runSchedulerIteration(db,deps);
 assert.equal(sends,1);assert.equal(read().task.status,'failed');
});

test('dispatch, duplicate claim and missed window remain observable in logs',t=>{
 const {db,task}=fixture(t);const logs=[];t.mock.method(console,'log',message=>logs.push(message));
 dispatchTask(db,task,{...base,sendViaC4(){return {category:'success'};}});
 dispatchTask(db,task,base);
 db.prepare("UPDATE tasks SET status='pending',next_run_at=? WHERE id=?").run(Math.floor(Date.now()/1000)-301,task.id);
 runSchedulerIteration(db,base);
 assert.ok(logs.some(line=>line.includes(`Dispatching task ${task.id}`)));
 assert.ok(logs.some(line=>line.includes(`Task ${task.id} already claimed/modified, skipping`)));
 assert.ok(logs.some(line=>line.includes(`Task ${task.id}`)&&line.includes('missed execution window')));
});

function scheduledFileFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resched-'));
  const home = path.join(root, 'home'), zylos = path.join(home, 'zylos');
  const tmp = path.join(root, 'tmp'), pm2 = path.join(home, '.pm2');
  for (const directory of [tmp, pm2, path.join(zylos, 'scheduler'), path.join(zylos, 'comm-bridge'),
    path.join(zylos, '.zylos'), path.join(zylos, '.claude/skills/telegram')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  fs.writeFileSync(path.join(zylos, '.env'), 'TZ=UTC\n');
  fs.writeFileSync(path.join(zylos, '.zylos/config.json'), JSON.stringify({ runtime: 'claude', session_mode: 'multi' }));
  const env = { ...process.env, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2, TMPDIR: tmp, TMUX_TMPDIR: tmp, TZ: 'UTC' };
  for (const key of ['TMUX', 'ZYLOS_SESSION_GROUP', 'ZYLOS_RUN_ID', 'CLAUDE_SESSION_ID', 'CODEX_SESSION_ID']) delete env[key];
  const database = path.join(zylos, 'scheduler/scheduler.db');
  const messages = path.join(zylos, 'comm-bridge/c4.db');
  for (const target of [home, zylos, pm2, tmp, database, messages]) assert.ok(target.startsWith(root + path.sep));
  assert.ok(Buffer.byteLength(path.join(tmp, `tmux-${process.getuid?.() ?? 0}`, 'default')) < 104);
  console.log(JSON.stringify({ schedulerFixture: root, HOME: home, ZYLOS_DIR: zylos, PM2_HOME: pm2,
    TMPDIR: tmp, TMUX_TMPDIR: tmp, database, messages, tmuxSocket: path.join(tmp, `tmux-${process.getuid?.() ?? 0}`, 'default') }));
  const db = new Database(database); guardDatabase(db, schema); db.pragma('journal_mode=WAL');
  const c4db = new Database(messages); guardDatabase(c4db, c4Schema); c4db.pragma('journal_mode=WAL');
  const f = { root, env, db, c4db, daemon: null };
  t.after(async () => {
    try {
      if (f.daemon?.pid && f.daemon.exitCode === null && f.daemon.signalCode === null) {
        await new Promise(resolve => {
          const timer = setTimeout(() => f.daemon.kill('SIGKILL'), 8000);
          f.daemon.once('exit', () => { clearTimeout(timer); resolve(); });
          f.daemon.kill('SIGTERM');
        });
      }
    } finally {
      db.close(); c4db.close();
      fs.rmSync(root, { recursive: true, force: true });
      assert.equal(fs.existsSync(root), false);
    }
  });
  f.cli = args => {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../cli.js', import.meta.url)), ...args, '--json'],
      { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const lines = result.stdout.trim().split('\n'); assert.equal(lines.length, 1, result.stdout);
    const value = JSON.parse(lines[0]); assert.equal(value.ok, true);
    return value.data;
  };
  f.read = id => ({ task: db.prepare('SELECT * FROM tasks WHERE id=?').get(id),
    history: db.prepare('SELECT * FROM task_history WHERE task_id=? ORDER BY id').all(id) });
  f.failed = (id, origin) => {
    const timestamp = Math.floor(Date.now() / 1000);
    db.prepare(`INSERT INTO tasks(id,name,prompt,type,next_run_at,status,last_error,failed_at,
      session_component,session_group_name,reply_channel,reply_endpoint,created_at,updated_at)
      VALUES(?,?,?,'one-time',?,'failed',?,?,'telegram','dm-1001','telegram','1001',?,?)`)
      .run(id, id, `private rescheduled prompt ${id}`, timestamp - 600,
        origin === 'window' ? 'Missed execution window' : 'INVALID_ARGS',
        origin === 'window' ? null : timestamp - 500, timestamp - 1000, timestamp - 500);
    const history = db.prepare(`INSERT INTO task_history(task_id,executed_at,completed_at,status,duration_ms,error)
      VALUES(?,?,?,'failed',?,?)`);
    history.run(id, timestamp - 900, timestamp - 898, 2000, 'OLDER_FAILURE');
    history.run(id, timestamp - 700, timestamp - 697, 3000, 'LAST_FAILURE');
  };
  return f;
}

// Covers actual CLI re-enabling through the dispatch selector and history claim.
// Run for schedule/status/routing changes; unrelated display-only changes may skip.
// All child paths and databases are private; no tmux or PM2 process is launched.
for (const origin of ['window', 'dispatch']) test(`rescheduled ${origin} failure dispatches once while untouched failed tasks stay excluded`, t => {
  const f = scheduledFileFixture(t);
  const id = `task-rescheduled-${origin}`, control = `task-failed-${origin}`;
  f.failed(id, origin); f.failed(control, origin);
  const history = f.read(id).history, untouched = f.read(control);
  const routed = f.cli(['update', id, '--reply-channel', 'telegram', '--reply-endpoint', '1001', '--reply-session-group', 'dm-1001']);
  assert.equal(routed.task.session_component, 'telegram'); assert.equal(routed.task.session_group_name, 'dm-1001');
  const cleared = f.cli(['update', id, '--clear-session-group']);
  assert.equal(cleared.task.session_component, null); assert.equal(cleared.task.session_group_name, null);
  assert.equal(cleared.task.reply_channel, 'telegram'); assert.equal(cleared.task.reply_endpoint, '1001');
  const updated = f.cli(['update', id, '--in', '2 minutes']);
  assert.equal(updated.reenabled, true); assert.equal(updated.task.status, 'pending');
  assert.equal(updated.task.failed_at, null); assert.equal(updated.task.last_error, null);
  assert.deepEqual(f.read(id).history, history);
  const sends = [];
  const dependencies = { ...base,
    query: target => queryComponentSessionGroup(target, { skillsDir: path.join(f.env.ZYLOS_DIR, '.claude/skills'), env: f.env }),
    sendViaC4(message, route) { sends.push({ message, route }); return { category: 'success' }; } };
  runSchedulerIteration(f.db, dependencies); assert.equal(sends.length, 0);
  t.mock.timers.enable({ apis: ['Date'], now: updated.task.next_run_at * 1000 });
  runSchedulerIteration(f.db, dependencies);
  assert.equal(sends.length, 1); assert.ok(sends[0].message.includes(updated.task.prompt));
  assert.equal(sends[0].route.sessionComponent, 'telegram'); assert.equal(sends[0].route.sessionGroupName, null);
  assert.equal(sends[0].route.replyChannel, 'telegram'); assert.equal(sends[0].route.replyEndpoint, '1001');
  const after = f.read(id); assert.equal(after.task.status, 'completed');
  assert.deepEqual(after.history.slice(0, 2), history);
  assert.equal(after.history.length, 3); assert.equal(after.history[2].status, 'success');
  assert.equal(after.history[2].executed_at, updated.task.next_run_at);
  assert.deepEqual(f.read(control), untouched);
  runSchedulerIteration(f.db, dependencies); assert.equal(sends.length, 1);
});

// Covers real daemon -> real receiver -> private C4 persistence after re-enabling.
// Run with ZYLOS_RUN_SCHEDULER_DISPATCH_INTEGRATION=1 for schedule/dispatch/receive changes;
// default skip defers the two-minute process integration to the isolated reviewer run.
// Private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/tmux socket/DB paths are logged above;
// no live AM socket, runtime, reply sender or PM2 process is used, and the child/root are cleaned.
test('real scheduler daemon dispatches a re-enabled task to its saved private C4 group', {
  skip: process.env.ZYLOS_RUN_SCHEDULER_DISPATCH_INTEGRATION !== '1', timeout: 155000,
}, async t => {
  const f = scheduledFileFixture(t);
  const id = 'task-daemon-rescheduled', control = 'task-daemon-failed';
  f.failed(id, 'dispatch'); f.failed(control, 'window');
  const previous = f.read(id).history, untouched = f.read(control);
  const updated = f.cli(['update', id, '--in', '2 minutes']);
  assert.equal(updated.reenabled, true); assert.equal(updated.task.status, 'pending');
  assert.deepEqual(f.read(id).history, previous);
  let output = '', spawnError;
  f.daemon = spawn(process.execPath, [fileURLToPath(new URL('../daemon.js', import.meta.url))],
    { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
  f.daemon.stdout.on('data', chunk => { output = (output + chunk).slice(-16384); });
  f.daemon.stderr.on('data', chunk => { output = (output + chunk).slice(-16384); });
  f.daemon.on('error', error => { spawnError = error; });
  const deadline = performance.now() + 145000;
  let inbound;
  while (performance.now() < deadline) {
    assert.equal(spawnError, undefined);
    assert.equal(f.daemon.exitCode, null, output);
    const after = f.read(id);
    inbound = f.c4db.prepare("SELECT * FROM conversations WHERE direction='in' AND instr(content,?)>0 ORDER BY id LIMIT 2")
      .all(updated.task.prompt);
    if (after.history.length === 3 && inbound.length === 1) break;
    assert.ok(after.history.length <= 3, output);
    assert.ok(inbound.length <= 1, output);
    if (Math.floor(Date.now() / 1000) < updated.task.next_run_at) {
      assert.equal(after.history.length, 2); assert.equal(inbound.length, 0);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const after = f.read(id);
  assert.equal(after.history.length, 3, output); assert.deepEqual(after.history.slice(0, 2), previous);
  assert.equal(after.history[2].status, 'success', output);
  assert.ok(after.history[2].executed_at >= updated.task.next_run_at);
  assert.equal(inbound.length, 1, output); assert.equal(inbound[0].direction, 'in');
  assert.equal(inbound[0].session_group, 'telegram:dm-1001'); assert.equal(inbound[0].channel, 'telegram');
  assert.equal(inbound[0].status, 'pending');
  assert.ok(inbound[0].content.startsWith(executionMarker(id, after.history[2].id) + '\n'));
  assert.deepEqual(f.read(control), untouched);
});
