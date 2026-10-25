import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './c4-v2-test-helpers.js';
import { sendInternal } from '../c4-send-internal.js';
const repository=fileURLToPath(new URL('../../../../',import.meta.url));
const command=fileURLToPath(new URL('../c4-send.js',import.meta.url));
const guard=fileURLToPath(new URL('./fixtures/internal-send-no-dispatch.js',import.meta.url));
const barrier=fileURLToPath(new URL('./fixtures/internal-send-barrier.js',import.meta.url));
function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'send-internal-'));
  fs.mkdirSync(path.join(root,'comm-bridge'));fs.mkdirSync(path.join(root,'.zylos'));
  fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({session_mode:'multi',runtime:'claude'}));
  const f=fixture(t,{},path.join(root,'comm-bridge/c4.db'));
  f.db.pragma('journal_mode=WAL');
  for(const groupName of ['a','b'])f.store.insertConversation('in','chat','seed','seed',{groupName});
  const dir=path.join(root,'activity-monitor/session-groups/chat:a');fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'current-session.json'),JSON.stringify({runId:'run-a',sessionId:'session-a',ts:1,startupControlIds:[]}));
  // No cleanup until the connection from fixture() has closed.
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return {...f,root,env:{...process.env,HOME:root,ZYLOS_DIR:root,ZYLOS_PACKAGE_ROOT:repository,ZYLOS_SESSION_GROUP:'chat:a',ZYLOS_RUN_ID:'run-a'}};
}
function snapshot(f) {
  return {rows:f.db.prepare('SELECT * FROM conversations ORDER BY id').all(),heads:f.db.prepare('SELECT * FROM group_heads ORDER BY session_group').all()};
}
function run(f,args=['internal','chat:b'],body='message\n',env={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,['--import',guard,command,...args],{env:{...f.env,...env},stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));
    child.stdin.on('error',error=>{if(error.code!=='EPIPE')reject(error);});child.stdin.end(body);
  });
}
function internalRows(f){return f.db.prepare("SELECT * FROM conversations WHERE channel='internal' ORDER BY id").all();}
function assertPair(f,content,sender='chat:a',target='chat:b',sessionId='session-a') {
  const rows=internalRows(f);assert.equal(rows.length,2);const [out,input]=rows;
  assert.deepEqual([out.direction,out.endpoint_id,out.session_group,out.content,out.status,out.priority,out.session_id],['out',target,sender,content,'delivered',3,sessionId]);
  assert.deepEqual([input.direction,input.endpoint_id,input.session_group,input.content,input.status,input.priority,input.session_id],['in',sender,target,`[internal] ${sender} said: ${content}`,'pending',3,null]);
  assert.equal(input.id,out.id+1);
  for(const row of rows)assert.equal(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(row.session_group).head_id,row.id);
  return input.id;
}
test('IF-45 real stdin CLI writes one atomic pair, preserves bytes and records matching sender F3',async t=>{
  const f=setup(t),content='  中文\n"quotes" $x \\n and `literal`';
  const result=await run(f,undefined,content+' \t\n');assert.equal(result.code,0,result.stderr);
  const id=assertPair(f,content);assert.equal(result.stdout,`[C4] internal message queued for chat:b (id ${id})\n`);
});

test('IF-45 rejects all invalid send forms without changing conversations or heads',async t=>{
  const f=setup(t),before=snapshot(f);
  const cases=[
    {env:{ZYLOS_SESSION_GROUP:''},code:'NO_SENDER_GROUP'},
    {env:{ZYLOS_SESSION_GROUP:'chat:unknown'},code:'UNKNOWN_SENDER_GROUP'},
    {args:['internal',''],code:'UNKNOWN_TARGET_GROUP'},
    {args:['internal','*'],code:'UNKNOWN_TARGET_GROUP'},
    {args:['internal','chat:missing'],code:'UNKNOWN_TARGET_GROUP'},
    {args:['internal','Chat:b'],code:'UNKNOWN_TARGET_GROUP'},
    {args:['internal','chat:a'],code:'SELF_TARGET'},
    {body:' \t\n',code:'EMPTY_CONTENT'},
    {args:['internal'],code:'INVALID_ARGS'},
    {args:['internal','--group'],code:'INVALID_ARGS'},
    {args:['internal','chat:b','argv body'],code:'INVALID_ARGS'},
    ...['--session-group','--group','--stdin'].map(flag=>({args:['internal','chat:b',flag,'b'],code:'INVALID_ARGS'})),
  ];
  for(const c of cases){const result=await run(f,c.args,c.body,c.env);assert.equal(result.code,1,JSON.stringify(c));assert.match(result.stderr,new RegExp(`^Error: ${c.code}:`));assert.deepEqual(snapshot(f),before);}
});

test('IF-45 empty stdin never calls the store or identity reader, even without a sender',async()=>{
  let calls=0;const forbidden=()=>{calls++;throw new Error('must not be called');};
  await assert.rejects(sendInternal(['internal','chat:b'],async()=> '\n \t',{env:{},insertMessage:forbidden,readIdentity:forbidden}),{code:'EMPTY_CONTENT'});
  assert.equal(calls,0);
});

test('IF-45 origin and inherited background group work without a mode or target-health gate',async t=>{
  const f=setup(t);
  // A late Origin retains its old environment even after a single cutover.
  fs.writeFileSync(path.join(f.root,'.zylos/config.json'),JSON.stringify({session_mode:'single',runtime:'claude'}));
  const result=await run(f,['internal','chat:b'],'from inherited Origin\n',{ZYLOS_SESSION_GROUP:'origin'});
  assert.equal(result.code,0,result.stderr);assertPair(f,'from inherited Origin','origin','chat:b',null);
  const g=setup(t);const toOrigin=await run(g,['internal','origin'],'origin target\n');assert.equal(toOrigin.code,0,toOrigin.stderr);assertPair(g,'origin target','chat:a','origin');
});

test('IF-45 stale, missing and malformed F3 identities store NULL without rejecting the message',async t=>{
  for(const kind of ['run-mismatch','no-run','missing','malformed']){
    const f=setup(t),file=path.join(f.root,'activity-monitor/session-groups/chat:a/current-session.json');
    if(kind==='missing')fs.unlinkSync(file);if(kind==='malformed')fs.writeFileSync(file,'{');
    const result=await run(f,undefined,'payload',kind==='run-mismatch'?{ZYLOS_RUN_ID:'stale'}:kind==='no-run'?{ZYLOS_RUN_ID:''}:{});
    assert.equal(result.code,0,result.stderr);assertPair(f,'payload','chat:a','chat:b',null);
  }
});

test('IF-45 fenced target without a session still queues and leaves its fence intact',async t=>{
  const f=setup(t);
  f.store.setDrainFence('chat:b',{reason:'ttl',runId:'target-run'});
  const before=f.db.prepare('SELECT * FROM drain_fences').all();
  assert.equal(fs.existsSync(path.join(f.root,'activity-monitor/session-groups/chat:b')),false);
  const result=await run(f,undefined,'wait for target');
  assert.equal(result.code,0,result.stderr);assertPair(f,'wait for target');
  assert.deepEqual(f.db.prepare('SELECT * FROM drain_fences').all(),before);
});

function injectInboundFailure(f){f.db.exec("CREATE TRIGGER reject_internal_in BEFORE INSERT ON conversations WHEN NEW.channel='internal' AND NEW.direction='in' BEGIN SELECT RAISE(ABORT,'fixture inbound failure'); END");}
test('IF-45 real CLI failure after outbound insert rolls back both rows and both heads',async t=>{
  const f=setup(t);injectInboundFailure(f);const before=snapshot(f);const result=await run(f);
  assert.equal(result.code,1);assert.match(result.stderr,/^Error: DB_WRITE_FAILED:/);assert.deepEqual(snapshot(f),before);
});

test('IF-45 concurrent real CLI A-to-B and B-to-A commit whole pairs and monotonic heads',{timeout:15000},async t=>{
  const f=setup(t);
  const workers=[['chat:a','chat:b','a-to-b'],['chat:b','chat:a','b-to-a']].map(([sender,target,body])=>{
    const child=spawn(process.execPath,['--import',guard,'--import',barrier,command,'internal',target],{
      env:{...f.env,ZYLOS_SESSION_GROUP:sender},stdio:['pipe','pipe','pipe','ipc'],
    });
    let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const exited=new Promise((resolve,reject)=>{
      child.once('error',reject);child.once('close',code=>resolve({code,stdout,stderr}));
    });
    const ready=Promise.race([
      new Promise(resolve=>child.once('message',message=>{assert.equal(message,'database-open');resolve();})),
      exited.then(result=>{throw new Error(`CLI exited before database barrier: ${result.stderr}`);}),
    ]);
    child.stdin.end(body);
    t.after(()=>{if(child.exitCode===null)child.kill();});
    return {child,ready,exited};
  });
  await Promise.all(workers.map(worker=>worker.ready));
  assert.equal(internalRows(f).length,0);
  for(const worker of workers)worker.child.send('send');
  const results=await Promise.all(workers.map(worker=>worker.exited));
  for(const result of results)assert.equal(result.code,0,result.stderr);
  const rows=internalRows(f);assert.equal(rows.length,4);
  for(let i=0;i<4;i+=2){assert.equal(rows[i].direction,'out');assert.equal(rows[i+1].direction,'in');assert.equal(rows[i+1].id,rows[i].id+1);assert.equal(rows[i].endpoint_id,rows[i+1].session_group);assert.equal(rows[i].session_group,rows[i+1].endpoint_id);}
  for(const group of ['chat:a','chat:b'])assert.equal(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(group).head_id,Math.max(...rows.filter(r=>r.session_group===group).map(r=>r.id)));
});
