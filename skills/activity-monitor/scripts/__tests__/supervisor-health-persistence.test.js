import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HealthStore } from '../health-store.js';
const worker=fileURLToPath(new URL('./fixtures/supervisor-health-persistence-worker.js',import.meta.url)),T=1792000000;

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

// recovery samples through the same production entry, including quarantine bytes.
test('actual supervisor startup retains health/cooldown/budget, quarantines corruption and retains acceleration throttle',{timeout:20000},async t=>{
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
