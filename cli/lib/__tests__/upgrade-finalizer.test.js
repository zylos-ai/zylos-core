import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-finalizer-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-finalizer.cjs','finalizer.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(dir,dest));
 return {dir,m:require(path.join(dir,'maintenance.cjs')),f:require(path.join(dir,'finalizer.cjs'))};
}
test('finalizer child publishes identity before executing and descendant survives root exit until verified termination',async t=>{
 const {dir,m,f}=fixture(t),nonce='a'.repeat(32),state=path.join(dir,'state.json'),script=path.join(dir,'fixture.cjs');
 m.durable(path.join(dir,'journal.json'),{installationIntent:true,finalizerLaunchIntent:{nonce,parent:m.identity()}});
 fs.writeFileSync(script,`const fs=require('node:fs'),cp=require('node:child_process');
 const journal=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir,'journal.json'))}));
 if(!journal.finalizerExecution)process.exit(9);
 const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();
 fs.writeFileSync(${JSON.stringify(state)},String(child.pid));process.exit(2);`);
 const child=spawn(process.execPath,[path.join(dir,'finalizer.cjs'),script,state,dir,nonce],{detached:true,stdio:'ignore'});
 t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const code=await new Promise((resolve,reject)=>{child.once('exit',resolve);child.once('error',reject);});assert.equal(code,2);
 const saved=m.read(path.join(dir,'journal.json'));assert.equal(saved.finalizerExecution.pid,child.pid);
 assert.ok(f.members(child.pid).length>0);assert.equal(f.quiesce(dir,saved).confirmed,false);
 assert.equal(f.quiesce(dir,saved,{terminate:true}).confirmed,true);assert.equal(f.members(child.pid).length,0);
});
test('mismatched launch nonce cannot signal a live group',async t=>{
 const {dir,m,f}=fixture(t),child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 const j={finalizerExecution:{...m.identity(child.pid),nonce:'a'.repeat(32)},finalizerLaunchIntent:{nonce:'b'.repeat(32)}};
 assert.equal(f.quiesce(dir,j,{terminate:true}).confirmed,false);assert.equal(m.alive(j.finalizerExecution),true);
});
test('launch intent without execution only clears after launcher death and absence of nonce-bearing wrapper',t=>{
 const {dir,m,f}=fixture(t),nonce='c'.repeat(32),j={finalizerLaunchIntent:{nonce,parent:m.identity()}};
 assert.equal(f.quiesce(dir,j).confirmed,false);
 j.finalizerLaunchIntent.parent={pid:2147483647,boot:'old-boot',start:'0'};
 assert.equal(f.quiesce(dir,j).confirmed,true);
});
