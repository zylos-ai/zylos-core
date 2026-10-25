import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HealthStore } from '../health-store.js';
const worker=fileURLToPath(new URL('./fixtures/supervisor-health-persistence-worker.js',import.meta.url)),T=1792000000;
function registered(reply) {
  assert.equal(reply.result, 'registered');
  assert.equal(Object.hasOwn(reply, 'attemptCount'), false);
  assert.equal(Object.hasOwn(reply, 'attemptAt'), false);
}
function scheduling(state) {
  const s = state.scheduling;
  return [s.restartFailureCount, s.lastRecoveryAt, s.lastDownCheckAt];
}

function fixture(t,{health='unavailable',count=0,last=0,cooldown=0}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'m4-health-persistence-'));fs.mkdirSync(path.join(root,'.zylos'));
  fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({session_mode:'multi',runtime:'claude'}));
  const store=new HealthStore({zylosDir:root,runtime:'claude',now:()=>T*1000}),s=store.read();s.health=health;
  Object.assign(s.scheduling,{restartFailureCount:count,lastRecoveryAt:last,cooldownUntil:cooldown});store.write(s);
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,store};
}
async function launch(t,root,now,mutant=''){
  const child=fork(worker,[String(now*1000),mutant],{env:{...process.env,HOME:root,ZYLOS_DIR:root},silent:true});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);const inbox=[],waiters=[];
  child.on('message',m=>waiters.length?waiters.shift().resolve(m):inbox.push(m));
  child.on('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(new Error(`Worker exited ${code??signal}: ${stderr}`));});
  const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}});
  const ready=await next();assert.equal(ready.ready,true);
  return {child,ready,async command(m){child.send(m);const result=await next();assert.equal(result.error,undefined);return result;},async kill(){const done=once(child,'exit');child.kill('SIGKILL');const [,signal]=await done;assert.equal(signal,'SIGKILL');}};
}
async function register(root,runId=randomUUID()){
  const socket=net.createConnection(path.join(root,'activity-monitor/am.sock'));await once(socket,'connect');
  socket.end(JSON.stringify({version:1,type:'start_attempt',requestId:`sa-${Date.now()}-123456789abc`,runtime:'claude',sessionGroup:'telegram:one',runId})+'\n');
  let value='';for await(const chunk of socket)value+=chunk;return JSON.parse(value);
}
async function scenario(t,{restart,mutant=''}){
  const f=fixture(t);let w=await launch(t,f.root,T),at=T,count=0;
  for(let round=0;round<2;round++){
    const runId=randomUUID(),reply=await register(f.root,runId);registered(reply);assert.deepEqual(scheduling(f.store.read()),[++count,at,0]);
    if(restart){const pid=w.child.pid;await w.kill();w=await launch(t,f.root,at,mutant);assert.notEqual(w.child.pid,pid);}
    const failedAt=at+10,result=await w.command({type:'probe',runId,now:failedAt*1000});if(restart)count++;
    assert.deepEqual(scheduling(result.state),[count,failedAt,0]);assert.equal(result.probes,0);
    const due=failedAt+Math.min(3600,60*5**(count-1));await w.command({type:'clock',now:(due-1)*1000});
    const early=await register(f.root);assert.equal(early.code,'attempt_backoff');assert.equal(early.notBefore,due*1000);
    await w.command({type:'clock',now:due*1000});at=due;
  }
  return f.store.read().scheduling.restartFailureCount;
}
test('DM-71 real M4 SIGKILL twice loses only association; actual Sock and observer retain conservative budget',{timeout:30000},async t=>{
  assert.equal(await scenario(t,{restart:false}),2);assert.equal(await scenario(t,{restart:true}),4);
});
test('DM-71 rejects double-result counting and early-backoff implementations under the same restart harness',{timeout:30000},async t=>{
  for(const mutant of ['double-result','early-backoff'])await assert.rejects(scenario(t,{restart:true,mutant}),{code:'ERR_ASSERTION'});
});
async function boundary(t,mutant=''){
  const f=fixture(t,{health:'rate_limited',count:2,last:T,cooldown:T-1}),w=await launch(t,f.root,T+299,mutant);
  assert.equal(w.ready.state.health,'rate_limited');assert.equal(w.ready.state.scheduling.cooldownUntil,0);
  const early=await register(f.root);assert.equal(early.code,'attempt_backoff');assert.equal(early.notBefore,(T+300)*1000);
  assert.deepEqual(scheduling(f.store.read()),[2,T,0]);
  await w.command({type:'clock',now:(T+300)*1000});const allowed=await register(f.root);
  registered(allowed);assert.deepEqual(scheduling(f.store.read()),[3,T+300,0]);
}
test('DM-45 actual entry preserves expired rate-limit budget at +299/+300; restart-clears-budget mutant fails',{timeout:15000},async t=>{
  await boundary(t);await assert.rejects(boundary(t,'clear-budget'),{code:'ERR_ASSERTION'});
});

// DM-45 recovery samples through the same production entry, including quarantine bytes.
test('DM-45 actual M4 startup retains health/cooldown/budget, quarantines corruption and retains acceleration throttle',{timeout:20000},async t=>{
  for(const sample of [
    {health:'rate_limited',cooldown:T+100,count:2,last:T-500,due:false},
    {health:'rate_limited',cooldown:T-100,count:2,last:T-500,due:true},
    {health:'auth_failed',count:2,last:T-500,due:false},
    {health:'unavailable',count:3,last:T-500,due:false},
  ]) {
    const f=fixture(t,sample),w=await launch(t,f.root,T),s=w.ready.state;
    assert.equal(s.health,sample.health);assert.equal(s.scheduling.restartFailureCount,sample.count);assert.equal(s.scheduling.lastRecoveryAt,sample.last);
    assert.equal(s.scheduling.cooldownUntil,Math.max(0,sample.cooldown>T?sample.cooldown:0));
    assert.equal((await w.command({type:'due'})).due,sample.due);
    await w.kill();
  }
  for(const corrupt of [false,true]) {
    const f=fixture(t);if(corrupt)fs.writeFileSync(f.store.file,'{"health":');else fs.unlinkSync(f.store.file);
    const w=await launch(t,f.root,T);assert.equal(w.ready.state.health,'ok');
    if(corrupt){assert.equal(fs.readFileSync(f.store.file+'.corrupt-'+T*1000,'utf8'),'{'+'"health":');assert.ok(w.ready.logs.some(v=>String(v).includes('quarantined')));}
    assert.equal(fs.existsSync(f.store.file),false);await w.kill();
  }
  const f=fixture(t,{health:'rate_limited',count:2,last:T-100,cooldown:T+100});
  const s=f.store.read();s.scheduling.lastUserMessageRecoveryAt=T-30;f.store.write(s);
  const w=await launch(t,f.root,T),before=fs.readFileSync(f.store.file,'utf8');
  assert.equal((await w.command({type:'user'})).accelerated,false);assert.equal(fs.readFileSync(f.store.file,'utf8'),before);
  await w.command({type:'clock',now:(T+30)*1000});assert.equal((await w.command({type:'user'})).accelerated,true);await w.kill();
});
