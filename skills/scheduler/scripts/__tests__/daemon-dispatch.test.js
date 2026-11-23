import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import * as schema from '../schema.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import { dispatchTask, executionMarker } from '../daemon-dispatch.js';
import { sendViaC4 } from '../runtime.js';
import { mainLoop, runSchedulerIteration } from '../daemon-dispatch.js';
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
  assert.equal(after.task.last_error, 'OLD_FAILURE'); assert.equal(after.task.failed_at, null);
  assert.equal(after.task.next_run_at, type === 'one-time' ? task.next_run_at
    : type === 'recurring' ? start / 1000 + 1800 : start / 1000 + 1807);
});

for(const mode of ['success','UNHEALTHY_NOTIFY_FAILED','UNHEALTHY_NOTIFY_UNCERTAIN'])
 test(`committed ${mode} keeps its delivery outcome and does not resend`,t=>{
  const {db,task,read}=fixture(t,{reply_channel:'telegram',reply_endpoint:'target',session_component:'telegram'});let sends=0;
  const real=realReceive(t,mode==='success'?{}:{health:'unavailable',...(mode==='UNHEALTHY_NOTIFY_UNCERTAIN'?{noticeExit:7}:{})});
  const deps={...base,sendViaC4(...args){sends++;const result=real.send(...args);
    if(mode!=='success')assert.deepEqual(result.receipt.error.persisted,['D1']);
    return result;}};
  const result=dispatchTask(db,task,deps);assert.equal(result.claimed,true);
  const row=read();assert.equal(row.task.status,'completed');assert.equal(row.history[0].status,'success');
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

test('full marker rejects old history, substrings, prefix and outbound false matches',t=>{
 const {db,task,read}=fixture(t);let marker;
 const result=dispatchTask(db,task,{...base,sendViaC4(message){marker=message.split('\n')[0];return {category:'U'};},getConversationsByRange(start,end){
 assert.equal(start,1);assert.equal(end,Number.MAX_SAFE_INTEGER);
 return [{direction:'in',content:executionMarker(task.id,0)+'\nold'},{direction:'in',content:'prefix '+marker},{direction:'in',content:marker+' suffix'}, {direction:'in',content:'other\n'+marker},{direction:'out',content:marker}];}});
 assert.equal(result.category,'T');assert.equal(read().task.status,'pending');assert.equal(read().task.next_run_at,task.next_run_at);
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

for(const type of ['one-time','interval']) test(`zero-commit retries stop beyond miss window: ${type}`,t=>{
 t.mock.timers.enable({apis:['Date'],now:2000000000000});
 const {db,task,read}=fixture(t,{type,interval_seconds:60});let sends=0;
 const deps={...base,sendViaC4(){sends++;return {category:'T',code:'DB_BUSY'};}};
 runSchedulerIteration(db,deps);assert.equal(sends,1);t.mock.timers.tick(301000);runSchedulerIteration(db,deps);
 assert.equal(sends,1);assert.equal(read().task.status,type==='one-time'?'failed':'pending');
 if(type==='interval')assert.ok(read().task.next_run_at>task.next_run_at);
});

for (const type of ['one-time', 'recurring', 'interval'])
test(`unknown ${type} delivery expires in a daemon iteration without resending`, t => {
  const start = Date.parse('2030-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const { db, task, read } = fixture(t, { type,
    cron_expression: type === 'recurring' ? '*/30 * * * *' : null,
    interval_seconds: type === 'interval' ? 1800 : null, timezone: 'UTC' });
  let sends = 0;
  const deps = { ...base, sendViaC4() { sends++; return { category: 'U' }; },
    getConversationsByRange() { throw new Error('read failed'); } };
  dispatchTask(db, task, deps);
  const unresolved = read();
  for (const age of [179, 180]) {
    t.mock.timers.setTime(start + age * 1000); runSchedulerIteration(db, deps);
    assert.deepEqual(read(), unresolved); assert.equal(sends, 1);
  }
  t.mock.timers.setTime(start + 181000); runSchedulerIteration(db, deps);
  const after = read();
  assert.equal(sends, 1); assert.equal(after.history[0].status, 'failed');
  assert.equal(after.history[0].error, 'DELIVERY_RESULT_UNKNOWN');
  assert.equal(after.history[0].completed_at, start / 1000 + 181);
  assert.equal(after.history[0].duration_ms, 181000);
  assert.equal(after.task.status, type === 'one-time' ? 'failed' : 'pending');
  assert.equal(after.task.last_error, 'DELIVERY_RESULT_UNKNOWN');
  assert.equal(after.task.failed_at, type === 'one-time' ? start / 1000 + 181 : null);
  if (type !== 'one-time') assert.equal(after.task.next_run_at,
    start / 1000 + (type === 'recurring' ? 1800 : 1981));
  runSchedulerIteration(db, deps); assert.deepEqual(read(), after); assert.equal(sends, 1);
});

for (const type of ['one-time', 'recurring', 'interval'])
test(`daemon startup closes an abandoned ${type} claim without sending`, async t => {
  const start = Date.parse('2030-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start + 181000 });
  const { db, task, read } = fixture(t, { type, status: 'running',
    updated_at: start / 1000, cron_expression: type === 'recurring' ? '*/30 * * * *' : null,
    interval_seconds: type === 'interval' ? 1800 : null, timezone: 'UTC' });
  db.prepare("INSERT INTO task_history(task_id,executed_at,status) VALUES(?,?,'started')").run(task.id, start / 1000);
  let sends = 0;
  await mainLoop(db, { shouldRun: () => false, dependencies: { ...base,
    sendViaC4: () => { sends++; assert.fail('startup recovery must not send'); } } });
  assert.equal(sends, 0); assert.equal(read().history[0].status, 'failed');
  assert.equal(read().history[0].error, 'DELIVERY_RESULT_UNKNOWN');
  assert.equal(read().task.status, type === 'one-time' ? 'failed' : 'pending');
});

// Boundary: actual daemon iteration/startup and SQLite accounting for damaged
// saved schedules. Run after rescheduling or stale-delivery changes; UI-only
// changes may skip. Uses only the private/in-memory fixture and injected receive,
// with bounded mainLoop iterations and no daemon child, socket or live service.
function insertUnrelatedDueTask(db, task) {
  const sibling = { ...task, id: 'unrelated-due', name: 'Unrelated due task',
    type: 'one-time', cron_expression: null, timezone: 'UTC', status: 'pending',
    updated_at: Math.floor(Date.now() / 1000), next_run_at: Math.floor(Date.now() / 1000), priority: 3 };
  const keys = Object.keys(sibling);
  db.prepare(`INSERT INTO tasks(${keys.join(',')}) VALUES(${keys.map(() => '?').join(',')})`).run(...Object.values(sibling));
  return sibling;
}

for (const [invalid, fields] of [
  ['cron', { cron_expression: 'bogus', timezone: 'UTC' }],
  ['timezone', { cron_expression: '*/30 * * * *', timezone: 'Mars/Olympus' }],
]) for (const entry of ['iteration', 'startup'])
test(`invalid saved ${invalid} fails only its abandoned task during daemon ${entry}`, async t => {
  const start = Date.parse('2030-01-01T00:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start + 200000 });
  const { db, task, read } = fixture(t, { type: 'recurring', status: 'running', priority: 1,
    updated_at: start / 1000, ...fields });
  db.prepare("INSERT INTO task_history(task_id,executed_at,status,error) VALUES(?,?,'started','RECEIVE_RESULT_UNKNOWN')")
    .run(task.id, start / 1000);
  const sibling = insertUnrelatedDueTask(db, task), sent = [];
  const deps = { ...base, sendViaC4(message) { sent.push(message); return { category: 'success' }; } };
  if (entry === 'startup') {
    let iterations = 0;
    await mainLoop(db, { shouldRun: () => iterations < 2, sleep: async () => { iterations++; }, dependencies: deps });
    assert.equal(iterations, 2);
  } else {
    runSchedulerIteration(db, deps);
    runSchedulerIteration(db, deps);
  }
  const after = read();
  assert.equal(after.task.status, 'failed');
  assert.match(after.task.last_error, /^Invalid cron expression "/);
  assert.equal(after.task.updated_at, start / 1000 + 200);
  assert.equal(after.history.length, 1); assert.equal(after.history[0].status, 'failed');
  assert.equal(after.history[0].error, 'DELIVERY_RESULT_UNKNOWN');
  assert.equal(after.history[0].completed_at, start / 1000 + 200);
  assert.equal(after.history[0].duration_ms, 200000);
  assert.equal(sent.length, 1); assert.ok(sent[0].startsWith(`[Scheduled Task: ${sibling.id} #`));
  assert.equal(db.prepare('SELECT status FROM tasks WHERE id=?').get(sibling.id).status, 'completed');
  const preserved = JSON.stringify(after);
  runSchedulerIteration(db, deps);
  assert.equal(sent.length, 1); assert.equal(JSON.stringify(read()), preserved);
});
