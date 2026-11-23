import nativeTest from 'node:test';
// Linux retains automatic stale-owner takeover and kernel guard semantics.
const test=(name,fn)=>nativeTest(name,{skip:process.platform!=='linux'},fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';

const require=createRequire(import.meta.url);
const modulePath=require.resolve('../upgrade-maintenance.cjs');
const m=require(modulePath);
const participants=new Map();
function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-controller-'));
  fs.chmodSync(dir,0o700);
  participants.set(dir,[]);
  t.after(async()=>{await Promise.all(participants.get(dir).map(child=>stop(child)));participants.delete(dir);fs.rmSync(dir,{recursive:true,force:true});});
  return dir;
}
function participant(t,dir,env={}) {
  const script=path.join(dir,'participant.cjs');
  if(!fs.existsSync(script)) fs.writeFileSync(script,`
    const m=require(process.env.LOCK_MODULE);
    try { const release=m.acquire(process.env.LOCK_DIR);
      process.send({acquired:true});
      process.on('message',message=>{if(message==='release'){release();process.exit(0);}});
    } catch(e) { process.send({acquired:false,error:e.message});process.exit(0); }
  `);
  const child=fork(script,[],{env:{...process.env,LOCK_MODULE:modulePath,LOCK_DIR:dir,...env},stdio:['ignore','ignore','pipe','ipc'],detached:true});
  participants.get(dir).push(child);
  let stderr='';child.stderr.on('data',d=>stderr+=d);
  const result=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('controller child timeout: '+stderr)),12000);
    child.once('message',message=>{clearTimeout(timer);resolve(message);});
    child.once('error',e=>{clearTimeout(timer);reject(e);});
  });
  return {child,result};
}
async function stop(child,signal='SIGKILL') {
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  try{process.kill(-child.pid,signal);}catch(e){if(e.code!=='ESRCH')throw e;child.kill(signal);}await exited;
}
async function exitOf(child) {
  if(child.exitCode!==null||child.signalCode!==null)return;
  await new Promise(resolve=>child.once('exit',resolve));
}

test('concurrent takers after controller crash elect exactly one owner and retain guard inode',async t=>{
  const dir=fixture(t),owner=participant(t,dir);
  assert.equal((await owner.result).acquired,true);
  const guard=path.join(dir,'controller.guard'),inode=fs.statSync(guard).ino;
  await stop(owner.child);
  const contenders=Array.from({length:10},()=>participant(t,dir));
  const results=await Promise.all(contenders.map(c=>c.result));
  assert.equal(results.filter(r=>r.acquired).length,1,JSON.stringify(results));
  const winner=contenders[results.findIndex(r=>r.acquired)];
  assert.equal(m.read(path.join(dir,'controller.json')).pid,winner.child.pid);
  assert.equal(fs.statSync(guard).ino,inode);
  await stop(winner.child);
  await Promise.all(contenders.map(c=>exitOf(c.child)));
  const release=m.acquire(dir);release();
  assert.equal(fs.statSync(guard).ino,inode);
});


test('unknown identity cannot authorize controller takeover',t=>{
  const dir=fixture(t),lock=path.join(dir,'controller.json');
  m.durable(lock,{pid:process.pid,unsupported:true});
  const before=fs.readFileSync(lock,'utf8');
  assert.throws(()=>m.acquire(dir),/identity unavailable/);
  assert.equal(fs.readFileSync(lock,'utf8'),before);
});
