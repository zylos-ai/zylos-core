import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const installer=require('../upgrade-installer.cjs');
test('interrupted launch without durable PID fails closed regardless of parent death',()=>{
 assert.throws(()=>installer.quiesce('',{},{kind:'finalizer'}),/unsupported contained process kind/);
 assert.equal(installer.quiesce('',{installerStarted:true,installerPid:null},{terminate:true,kind:'installer'}).confirmed,false);
});
test('recovery observation cannot signal a live group',async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 assert.equal(installer.quiesce('',{installerStarted:true,installerPid:child.pid}).confirmed,false);
 assert.ok(installer.members(child.pid).length);
});
test('process-group snapshots exclude a ps wrapper and its child but retain real descendants',{skip:process.platform==='win32'},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-ps-wrapper-')),bin=path.join(root,'bin');
 fs.mkdirSync(bin);
 const realPs=fs.realpathSync(['/usr/bin/ps','/bin/ps'].find(file=>fs.existsSync(file)));
 fs.writeFileSync(path.join(bin,'ps'),`#!/bin/sh\n${JSON.stringify(realPs)} "$@" &\nchild=$!\nwait "$child"\n`,{mode:0o700});
 const script=`
  const {spawn}=require('node:child_process');
  const installer=require(${JSON.stringify(path.resolve('cli/lib/upgrade-installer.cjs'))});
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
  child.once('error',error=>{process.stderr.write(error.stack);process.exit(2);});
  child.once('spawn',()=>{try{
    const pids=installer.members(process.pid).map(row=>Number(row[1]));
    process.stdout.write(JSON.stringify({leader:process.pid,descendant:child.pid,pids}));
  }catch(error){process.stderr.write(error.stack);process.exitCode=3;}finally{try{process.kill(child.pid,'SIGKILL');}catch{}}});
 `;
 const leader=spawn(process.execPath,['-e',script],{detached:true,env:{...process.env,PATH:bin+path.delimiter+process.env.PATH},stdio:['ignore','pipe','pipe']});
 t.after(()=>{try{process.kill(-leader.pid,'SIGKILL');}catch{}fs.rmSync(root,{recursive:true,force:true});});
 const result=await new Promise((resolve,reject)=>{let stdout='',stderr='';leader.stdout.on('data',chunk=>stdout+=chunk);leader.stderr.on('data',chunk=>stderr+=chunk);leader.once('error',reject);leader.once('close',(code,signal)=>resolve({code,signal,stdout,stderr}));});
 assert.equal(result.code,0,result.stderr||result.signal);
 const observed=JSON.parse(result.stdout);
 assert.deepEqual(new Set(observed.pids),new Set([observed.leader,observed.descendant]));
});
