import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const f=require('../upgrade-finalizer.cjs');
test('finalizer descendant survives leader exit and is killed before confirmation',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-finalizer-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const script=path.join(dir,'fixture.cjs');
 fs.writeFileSync(script,`const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();process.exit(2);`);
 const child=spawn(process.execPath,[script],{detached:true,stdio:'ignore'});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});assert.equal(code,2);
 const saved={finalizerStarted:true,finalizerPid:child.pid,finalizerExitConfirmed:true,finalizerExitUnconfirmed:true};
 assert.ok(f.members(child.pid).length);assert.equal(f.quiesce(dir,saved).confirmed,false);
 assert.equal(f.quiesce(dir,saved,{terminate:true}).confirmed,true);assert.equal(f.members(child.pid).length,0);
});
test('interrupted launch without durable PID fails closed regardless of parent death',()=>{
 assert.equal(f.quiesce('',{finalizerStarted:true,finalizerPid:null},{terminate:true}).confirmed,false);
 assert.equal(f.quiesce('',{installerStarted:true,installerPid:null},{terminate:true,kind:'installer'}).confirmed,false);
});
test('recovery observation cannot signal a live group',async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 assert.equal(f.quiesce('',{finalizerStarted:true,finalizerPid:child.pid}).confirmed,false);
 assert.ok(f.members(child.pid).length);
});
