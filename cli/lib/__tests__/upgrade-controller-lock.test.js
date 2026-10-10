import nativeTest from 'node:test';
// Linux retains automatic stale-owner takeover and kernel guard semantics.
const test=(name,fn)=>nativeTest(name,{skip:process.platform!=='linux'},fn);
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fork, spawnSync } from 'node:child_process';

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
async function waitFor(file) {
  const deadline=Date.now()+5000;
  while(!fs.existsSync(file)) {
    if(Date.now()>deadline)throw Error('test hook did not reach stale read');
    await new Promise(resolve=>setTimeout(resolve,10));
  }
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

test('stale controller reclamation serializes read/check/replace across processes',async t=>{
  const dir=fixture(t),lock=path.join(dir,'controller.json');
  m.durable(lock,{pid:2147483647,boot:'dead-boot',start:'0'});
  const hook=path.join(dir,'delay.cjs'),observed=path.join(dir,'read-observed');
  // Force the old vulnerable schedule: one process captures stale JSON and
  // pauses while another tries to reclaim it. Without serialization both win.
  fs.writeFileSync(hook,`
    const fs=require('node:fs'),original=fs.readFileSync;
    let delayed=false;
    fs.readFileSync=function(file,...args){
      const value=original.call(this,file,...args);
      if(!delayed&&process.env.DELAY_CONTROLLER==='1'&&String(file)===process.env.DELAY_LOCK){
        delayed=true;fs.writeFileSync(process.env.READ_OBSERVED,'ready');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,800);
      }
      return value;
    };
  `);
  const first=participant(t,dir,{NODE_OPTIONS:`--require=${hook}`,DELAY_CONTROLLER:'1',DELAY_LOCK:lock,READ_OBSERVED:observed});
  await waitFor(observed);
  const second=participant(t,dir);
  const results=await Promise.all([first.result,second.result]);
  assert.equal(results.filter(r=>r.acquired).length,1,JSON.stringify(results));
  assert.equal(results[0].acquired,true);
  assert.match(results[1].error,/still alive/);
  assert.equal(m.read(lock).pid,first.child.pid);
  const released=exitOf(first.child);first.child.send('release');await released;
  await exitOf(second.child);
});

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

test('kernel guard releases on guard-holder crash',async t=>{
  const dir=fixture(t),release=m.acquire(dir);release();
  const guard=path.join(dir,'controller.guard');
  const script=path.join(dir,'guard-holder.cjs');
  fs.writeFileSync(script,`const cp=require('node:child_process');
    const fs=require('node:fs'),m=require(process.env.LOCK_MODULE);
    const fd=fs.openSync(process.env.GUARD,'r+');
    const target=require('node:path').join(require('node:path').dirname(process.env.GUARD),'hold.cjs');
    fs.writeFileSync(target,"require('node:fs').writeFileSync(process.env.READY,'ready');setInterval(()=>{},1000)");
    const args=process.platform==='darwin'?['lock-exec','5000',process.execPath,target]:['--exclusive','--no-fork',process.env.GUARD,process.execPath,target];
    const child=cp.spawn(process.platform==='darwin'?m.nativeHelper():'flock',args,{env:process.env,stdio:['ignore','ignore','ignore',fd]});
    fs.closeSync(fd);
    process.send(child.pid);`);
  const ready=path.join(dir,'guard-held');
  const holder=fork(script,[],{env:{...process.env,GUARD:guard,READY:ready,LOCK_MODULE:modulePath},stdio:['ignore','ignore','ignore','ipc']});
  const pid=await new Promise(resolve=>holder.once('message',resolve));
  t.after(()=>{try{process.kill(pid,'SIGKILL');}catch{}});
  await waitFor(ready);
  // flock execs the command, so this kills the actual inode-lock holder.
  process.kill(pid,'SIGKILL');
  const next=m.acquire(dir);next();
  await new Promise(resolve=>holder.once('exit',resolve));
});

test('a stale release callback cannot release a newer owner in the same process',t=>{
  const dir=fixture(t),first=m.acquire(dir);first();
  const second=m.acquire(dir),before=m.read(path.join(dir,'controller.json'));
  first();assert.deepEqual(m.read(path.join(dir,'controller.json')),before);
  assert.throws(()=>m.acquire(dir),/still alive/);second();
});

test('missing flock and unsafe guard fail closed without replacing controller',t=>{
  const dir=fixture(t),lock=path.join(dir,'controller.json');
  m.durable(lock,{pid:2147483647,boot:'dead-boot',start:'0'});
  const before=fs.readFileSync(lock,'utf8');
  const result=spawnSync(process.execPath,['-e',`
    const cp=require('node:child_process'),spawn=cp.spawnSync;
    cp.spawnSync=function(binary,...args){
      if(binary.endsWith('/flock') || binary.endsWith('/macos-recovery-helper') && args[0][0] === 'lock-exec')return {error:Error('ENOENT flock unavailable')};
      return spawn.call(this,binary,...args);
    };
    require(${JSON.stringify(modulePath)}).acquire(${JSON.stringify(dir)});
  `],{encoding:'utf8'});
  assert.notEqual(result.status,0);assert.match(result.stderr,/ENOENT/);
  assert.equal(fs.readFileSync(lock,'utf8'),before);
  fs.chmodSync(path.join(dir,'controller.guard'),0o666);
  assert.throws(()=>m.acquire(dir),/unsafe controller guard/);
  assert.equal(fs.readFileSync(lock,'utf8'),before);
});

test('release after terminal directory archival leaves no active lock path',t=>{
  const dir=fixture(t),release=m.acquire(dir),archived=dir+'-archive';
  t.after(()=>fs.rmSync(archived,{recursive:true,force:true}));
  fs.renameSync(dir,archived);
  assert.doesNotThrow(release);
  assert.equal(fs.existsSync(dir),false);
});
test('terminal transaction keeps its controller path and releases the captured token',t=>{
  const dir=fixture(t), release=m.acquire(dir);
  release();
  assert.equal(fs.existsSync(path.join(dir,'controller.json')),false);
  const next=m.acquire(dir); next();
});

test('unknown identity cannot authorize controller takeover',t=>{
  const dir=fixture(t),lock=path.join(dir,'controller.json');
  m.durable(lock,{pid:process.pid,unsupported:true});
  const before=fs.readFileSync(lock,'utf8');
  assert.throws(()=>m.acquire(dir),/identity unavailable/);
  assert.equal(fs.readFileSync(lock,'utf8'),before);
});

test('missing Linux boot identity is unknown, never evidence that the process is absent',()=>{
  const result=spawnSync(process.execPath,['-e',`
    const fs=require('node:fs'),read=fs.readFileSync;
    const m=require(${JSON.stringify(modulePath)});
    Object.defineProperty(process,'platform',{value:'linux'});
    fs.readFileSync=(file,...args)=>{
      if(file==='/proc/123/stat') return '123 (fixture) S '+Array(18).fill('0').join(' ')+' 456';
      if(file==='/proc/sys/kernel/random/boot_id') throw Object.assign(Error('boot identity unavailable'),{code:'ENOENT'});
      return read(file,...args);
    };
    process.stdout.write(JSON.stringify(m.identity(123)));
  `],{encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{pid:123,unsupported:true});
});
