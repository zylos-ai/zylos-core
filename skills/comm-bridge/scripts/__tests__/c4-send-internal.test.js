import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fixture } from './c4-v2-test-helpers.js';
const repository=fileURLToPath(new URL('../../../../',import.meta.url));
const command=fileURLToPath(new URL('../c4-send.js',import.meta.url));
const guard=fileURLToPath(new URL('./fixtures/internal-send-no-dispatch.js',import.meta.url));
function setup(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'send-internal-'));
  fs.mkdirSync(path.join(root,'comm-bridge'));fs.mkdirSync(path.join(root,'.zylos'));
  fs.mkdirSync(path.join(root,'.claude/skills/chat'),{recursive:true});
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
  assert.deepEqual([input.direction,input.endpoint_id,input.session_group,input.content,input.status,input.priority,input.session_id],['in',sender,target,`[internal] Yourself, from your "${sender}" session group, said: ${content}`,'pending',3,null]);
  assert.equal(input.id,out.id+1);
  for(const row of rows)assert.equal(f.db.prepare('SELECT head_id FROM group_heads WHERE session_group=?').get(row.session_group).head_id,row.id);
  return input.id;
}
test('real stdin CLI writes one atomic pair, preserves bytes and records matching sender',async t=>{
  const f=setup(t),content='  中文\n"quotes" $x \\n and `literal`';
  const result=await run(f,undefined,content+' \t\n');assert.equal(result.code,0,result.stderr);
  const id=assertPair(f,content);assert.equal(result.stdout,`[C4] internal message queued for chat:b (id ${id})\n`);
});
