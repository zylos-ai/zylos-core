import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {CORE_DATABASES,DATABASE_DEADLINE_MS,superviseDatabases} from '../core-db-backup-worker.js';

function children() {
  const calls=[];
  const spawnWorker=(node,args,options)=>{
    const child=new EventEmitter();
    child.stdout=new PassThrough();
    child.killed=false;
    child.kill=signal=>{child.killed=signal;queueMicrotask(()=>child.emit('close',null));};
    child.finish=(value,status=0)=>{child.stdout.write(JSON.stringify(value));child.emit('close',status);};
    calls.push({child,node,input:JSON.parse(args[1]),options});
    return child;
  };
  return {calls,spawnWorker};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('each database receives a fresh ten minute deadline after earlier databases consume their budget',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {calls,spawnWorker}=children();
  let now=0;
  const pending=superviseDatabases({action:'snapshot',reportTimings:true},{spawnWorker,now:()=>now});
  assert.equal(DATABASE_DEADLINE_MS,600000);
  for(let index=0;index<CORE_DATABASES.length;index++) {
    assert.equal(calls.length,index+1);
    assert.equal(calls[index].input.databaseSource,CORE_DATABASES[index].source);
    t.mock.timers.tick(599999);
    assert.equal(calls[index].child.killed,false);
    now+=100+index;
    calls[index].child.finish({databases:[{source:CORE_DATABASES[index].source,status:'backed_up',bytes:4096*(index+1)}]});
    await flush();
  }
  const result=await pending;
  assert.equal(result.databases.length,3);
  assert.deepEqual(result.databaseTimings,CORE_DATABASES.map(({source},index)=>({
    source,bytes:4096*(index+1),durationMs:100+index
  })));
});

for(const step of ['check','copy','rehearsal']) test(`database ${step} deadline kills the active child and names its database and step`,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {calls,spawnWorker}=children();
  const pending=superviseDatabases({action:'snapshot'},{spawnWorker});
  const rejected=assert.rejects(pending,new RegExp(`comm-bridge/c4\\.db: ${step} deadline exceeded \\(600s\\)`));
  calls[0].child.emit('message',{step});
  t.mock.timers.tick(600000);
  await rejected;
  assert.equal(calls[0].child.killed,'SIGKILL');
  assert.equal(calls.length,1);
});

test('database failure preserves structured schema errors and current step',async()=>{
  const {calls,spawnWorker}=children();
  const pending=superviseDatabases({action:'version-probe'},{spawnWorker});
  const rejected=assert.rejects(pending,error=>{
    assert.equal(error.code,'SCHEMA_TOO_NEW');
    assert.match(error.message,/comm-bridge\/c4.db: check failed: future schema/);
    return true;
  });
  calls[0].child.finish({ok:false,error:{code:'SCHEMA_TOO_NEW',message:'future schema'}},1);
  await rejected;
  assert.equal(calls.length,1);
});

test('version probes aggregate migration state across separate database children',async()=>{
  const {calls,spawnWorker}=children();
  const pending=superviseDatabases({action:'version-probe'},{spawnWorker});
  for(let index=0;index<CORE_DATABASES.length;index++) {
    calls[index].child.finish({databases:[{source:CORE_DATABASES[index].source,needsMigration:index===1}]});
    await flush();
  }
  assert.equal((await pending).needsMigration,true);
});

test('scoped execution validates only the selected database and preserves its snapshot row',async t=>{
  const fs=await import('node:fs');
  const os=await import('node:os');
  const path=await import('node:path');
  const {execute}=await import('../core-db-backup-worker.js');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'db-deadline-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'comm-bridge'));
  fs.writeFileSync(path.join(root,'comm-bridge/c4.db-wal'),'orphan');
  const result=await execute({action:'snapshot',zylosDir:root,databaseSource:'scheduler/scheduler.db'});
  assert.deepEqual(result.databases.map(row=>[row.source,row.status]),[['scheduler/scheduler.db','missing']]);
  await assert.rejects(execute({action:'snapshot',zylosDir:root}),/Orphan SQLite sidecar/);
});

test('real database subprocesses finish and aggregate missing snapshot rows',async t=>{
  const fs=await import('node:fs');
  const os=await import('node:os');
  const path=await import('node:path');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'db-children-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const result=await superviseDatabases({action:'snapshot',zylosDir:root},{timeoutMs:2000});
  assert.deepEqual(result.databases.map(row=>[row.source,row.status]),CORE_DATABASES.map(item=>[item.source,'missing']));
});

const installed=process.env.CORE_DB_TEST_SKILL || path.resolve('skills/comm-bridge');
let Database,driverPath;
try {
  const require=createRequire(path.join(installed,'package.json'));
  driverPath=require.resolve('better-sqlite3');
  Database=require('better-sqlite3');
  new Database(':memory:').close();
} catch {}

for(const blockedStep of ['check','copy','rehearsal']) test(`real SQLite subprocess enforces the ${blockedStep} deadline`,{skip:!Database},async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'db-blocking-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const source=path.join(root,'comm-bridge/c4.db');
  fs.mkdirSync(path.dirname(source));
  const db=new Database(source);
  db.exec('CREATE TABLE entries(value TEXT); INSERT INTO entries VALUES (\'retained\')');
  t.after(()=>db.close());
  const schemaRoot=path.join(root,'schemas');
  fs.mkdirSync(path.join(schemaRoot,'comm-bridge/scripts'),{recursive:true});
  fs.writeFileSync(path.join(schemaRoot,'package.json'),' {"type":"module"}');
  fs.copyFileSync(new URL('./fixtures/db-deadline-owner.js',import.meta.url),path.join(schemaRoot,'comm-bridge/scripts/c4-schema.js'));
  fs.copyFileSync(new URL('./fixtures/db-deadline-engine.js',import.meta.url),path.join(schemaRoot,'comm-bridge/scripts/sqlite-schema.js'));
  const stagingDir=path.join(root,'staging'),rehearsalDir=path.join(root,'rehearsal');
  fs.mkdirSync(stagingDir);fs.mkdirSync(rehearsalDir);
  if(blockedStep==='copy')db.exec('BEGIN EXCLUSIVE');
  let observedStep='check';
  const spawnWorker=(node,args,options)=>{
    const child=spawn(node,args,{...options,env:{...process.env,DB_DEADLINE_BLOCK_STEP:blockedStep}});
    child.on('message',message=>{if(message.step)observedStep=message.step;});
    return child;
  };
  const action=blockedStep==='check'?'version-probe':blockedStep==='copy'?'snapshot':'rehearse';
  const pending=superviseDatabases({action,zylosDir:root,schemaRoot,driverRoot:schemaRoot,driverPath,stagingDir,rehearsalDir},{spawnWorker,timeoutMs:500});
  await assert.rejects(pending,new RegExp(`comm-bridge/c4\\.db: ${blockedStep} deadline exceeded`));
  assert.equal(observedStep,blockedStep);
  if(db.inTransaction)db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT value FROM entries').get().value,'retained');
  if(blockedStep==='rehearsal')assert.equal(fs.existsSync(rehearsalDir),false);
});

test('launcher leaves elapsed time enforcement to individual database children',async t=>{
  const actual=await import('node:child_process');
  let options;
  t.mock.module('node:child_process',{namedExports:{...actual,spawnSync:(node,args,settings)=>{
    options=settings;
    return {status:0,stdout:JSON.stringify({databases:[]})};
  }}});
  const {runCoreDbWorker}=await import('../core-db-backup.js');
  assert.deepEqual(runCoreDbWorker({action:'snapshot'}),{databases:[]});
  assert.equal(Object.hasOwn(options,'timeout'),false);
});
