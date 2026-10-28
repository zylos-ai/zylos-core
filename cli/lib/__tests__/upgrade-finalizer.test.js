import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const f=require('../upgrade-finalizer.cjs');
test('interrupted launch without durable PID fails closed regardless of parent death',()=>{
 assert.throws(()=>f.quiesce('',{},{kind:'finalizer'}),/unsupported contained process kind/);
 assert.equal(f.quiesce('',{installerStarted:true,installerPid:null},{terminate:true,kind:'installer'}).confirmed,false);
});
test('recovery observation cannot signal a live group',async t=>{
 const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 assert.equal(f.quiesce('',{installerStarted:true,installerPid:child.pid}).confirmed,false);
 assert.ok(f.members(child.pid).length);
});
