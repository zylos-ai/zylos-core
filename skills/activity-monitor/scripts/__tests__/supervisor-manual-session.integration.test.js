import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { submit } from '../../../../cli/lib/am-sock-client.js';
const worker=fileURLToPath(new URL('./fixtures/supervisor-manual-session-worker.js',import.meta.url));
async function fixture(t,mode='multi',variant=''){
 const f=readyTmuxTarget(t,{prefix:'manual-session-entry-',mode,runtimeProcess:true});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const child=fork(worker,[f.socketPath,f.binary,mode,variant],{env:{...process.env,...f.env},silent:true});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const inbox=[],waiters=[];child.on('message',m=>waiters.length?waiters.shift().resolve(m):inbox.push(m));
 child.on('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(new Error(`Worker exited ${code??signal}: ${stderr}`));});
 const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
 t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}});assert.equal((await next()).ready,true);
 const command=async value=>{child.send(value);const result=await next();assert.equal(result.error,undefined);return result;};await command('release');
 const request={version:1,type:'manual_restart',requestId:'observed-session',expectedRunId:'run-1',expectedSessionId:'session-1'};
 return {...f,command,submit:()=>submit(request,{socketPath:path.join(f.root,'activity-monitor/am.sock'),deadlineAt:Date.now()+10000}),
 change:sessionId=>fs.writeFileSync(f.readyPath,JSON.stringify({...f.ready,sessionId})),async stop(){const done=once(child,'exit');await command('stop');assert.equal((await done)[0],0);}};
}
async function before(t,variant=''){
 const f=await fixture(t,'multi',variant);f.change('new-session');const result=await f.submit();
 assert.equal(result.kind,'rejected');assert.equal(result.reply.reason,'identity_unavailable');
 const state=await f.command('tick');assert.deepEqual(state.requests,[]);assert.deepEqual(state.fences,[]);assert.doesNotThrow(()=>f.tmux('has-session','-t','=zylos-group-origin'));await f.stop();
}
test('actual entry rejects already observed session change before manual acceptance; ignoring session fails',{timeout:20000},async t=>{await before(t);await assert.rejects(before(t,'ignore-admission-session'),{code:'ERR_ASSERTION'});});
async function after(t,mode,variant=''){
 const f=await fixture(t,mode,variant);assert.equal((await f.submit()).kind,'accepted');f.change('new-session');
 const state=await f.command('tick');assert.deepEqual(state.requests,[]);assert.deepEqual(state.fences,[]);
 assert.throws(()=>f.tmux('has-session','-t','=zylos-group-origin'));
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));
 assert.deepEqual(state.alerts,[]);
 await f.stop();
}
for(const mode of ['single','multi'])test(`${mode} actual entry stops accepted run after session changes without rechecking sessionId`,{timeout:20000},async t=>{await after(t,mode);});
test('missing post-acceptance hook marker retains run-level stop boundary without invented atomic session proof',{timeout:20000},async t=>{
 const f=await fixture(t);assert.equal((await f.submit()).kind,'accepted');fs.unlinkSync(f.readyPath);
 const state=await f.command('tick');assert.deepEqual(state.requests,[]);assert.deepEqual(state.fences,[]);assert.throws(()=>f.tmux('has-session','-t','=zylos-group-origin'));assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));await f.stop();
});

// After admission, runId remains the execution boundary even if READY is missing or malformed.
for(const [name,fields] of [
 ['empty session',{sessionId:''}],
 ['missing timestamp',{sessionId:'new-session',ts:undefined}],
 ['noninteger timestamp',{sessionId:'new-session',ts:1.5}],
 ['missing control IDs',{sessionId:'new-session',startupControlIds:undefined}],
 ['nonarray control IDs',{sessionId:'new-session',startupControlIds:{}}],
 ['noninteger control ID',{sessionId:'new-session',startupControlIds:[1,'2']}],
])test(`invalid READY ${name} does not invent a context-change veto`,{timeout:20000},async t=>{
 const f=await fixture(t);assert.equal((await f.submit()).kind,'accepted');
 fs.writeFileSync(f.readyPath,JSON.stringify({...f.ready,...fields}));
 const state=await f.command('tick');assert.deepEqual(state.requests,[]);assert.deepEqual(state.fences,[]);
 assert.throws(()=>f.tmux('has-session','-t','=zylos-group-origin'));assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));await f.stop();
});

test('replacement READY identity preserves replacement and renamed original',{timeout:20000},async t=>{
 const f=await fixture(t);assert.equal((await f.submit()).kind,'accepted');
 f.tmux('rename-session','-t','=zylos-group-origin','fixture-original');
 f.tmux('new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=replacement','-e','ZYLOS_SESSION_GROUP=origin','-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',path.join(f.root,'claude'),'120');
 fs.writeFileSync(f.readyPath,JSON.stringify({...f.ready,runId:'replacement',sessionId:'replacement-session'}));
 const state=await f.command('tick');assert.deepEqual(state.requests,[]);assert.deepEqual(state.fences,[]);
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-original'));
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=zylos-group-origin'));
 assert.equal(f.tmux('show-environment','-t','=zylos-group-origin','ZYLOS_RUN_ID'),'ZYLOS_RUN_ID=replacement');await f.stop();
});
