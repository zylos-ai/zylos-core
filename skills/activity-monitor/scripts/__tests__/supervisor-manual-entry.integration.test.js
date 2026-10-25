import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { submit } from '../../../../cli/lib/am-sock-client.js';
const worker=fileURLToPath(new URL('./fixtures/supervisor-manual-entry-worker.js',import.meta.url));
async function launch(t,f,mode,pause=''){
 const child=fork(worker,[f.socketPath,f.binary,mode,pause],{env:{...process.env,...f.env},silent:true});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const inbox=[],waiters=[];child.on('message',m=>waiters.length?waiters.shift().resolve(m):inbox.push(m));
 child.on('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(new Error(`Worker exited ${code??signal}: ${stderr}`));});
 const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
 const kill=async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}};t.after(kill);assert.equal((await next()).ready,true);
 return {child,next,kill,async command(value){child.send(value);const result=await next();assert.equal(result.error,undefined);return result;}};
}
async function scenario(t,mode,mutant=''){
 const f=readyTmuxTarget(t,{prefix:'manual-entry-',mode,runtimeProcess:true});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const request={version:1,type:'manual_restart',requestId:'manual-lost-reply',expectedRunId:'run-1',expectedSessionId:'session-1'};
 const send=value=>submit(value,{socketPath:path.join(f.root,'activity-monitor/am.sock'),deadlineAt:Date.now()+10000});
 const first=await launch(t,f,mode,'commit');await first.command('release');
 const pending=send(request);assert.deepEqual(await first.next(),{barrier:'committed'});await first.kill();assert.deepEqual(await pending,{kind:'no_reply',sent:true});
 const file=path.join(f.root,'activity-monitor/restart-requests.json'),record=JSON.parse(fs.readFileSync(file,'utf8'))[0];
 assert.equal(record.expectedRunId,'run-1');assert.equal(record.mode,mode);assert.equal(record.expectedSessionId,'session-1');assert.ok(record.tmuxTarget.sessionId);
 f.tmux('rename-session','-t','=zylos-group-origin','fixture-original');
 f.tmux('new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=replacement','-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',...(mode==='multi'?['-e','ZYLOS_SESSION_GROUP=origin']:[]),path.join(f.root,'claude'),'120');
 const second=await launch(t,f,mode,mutant);
 const retry=await send(request);assert.equal(retry.kind,'accepted');assert.equal(retry.reply.result,'already_accepted');assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8'))[0],record);
 const conflict=await send({...request,expectedRunId:'replacement'});assert.equal(conflict.kind,'rejected');assert.equal(conflict.reply.reason,'request_conflict');
 await second.command('release');const done=await second.command('tick');
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=zylos-group-origin'));assert.equal(f.tmux('show-environment','-t','=zylos-group-origin','ZYLOS_RUN_ID'),'ZYLOS_RUN_ID=replacement');
 assert.throws(()=>f.tmux('has-session','-t','=fixture-original'));assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));
 assert.deepEqual(done.requests,[]);assert.deepEqual(done.fences,[]);
 const exited=once(second.child,'exit');await second.command('stop');assert.equal((await exited)[0],0);
}
for(const mode of ['single','multi'])test(`IF-36 ${mode} actual M4/client lost reply requery retains original target and preserves same-name replacement`,{timeout:20000},async t=>{await scenario(t,mode);});
test('IF-36 actual manual lost-reply harness rejects name-retargeting implementation',{timeout:20000},async t=>{await assert.rejects(scenario(t,'multi','retarget'),{code:'ERR_ASSERTION'});});

for(const pause of ['before-remove','after-remove'])test(`DM-42 actual manual M4 SIGKILL ${pause} preserves truthful completion without resubmission`,{timeout:20000},async t=>{
 const f=readyTmuxTarget(t,{prefix:'manual-remove-entry-',mode:'multi',runtimeProcess:true});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const request={version:1,type:'manual_restart',requestId:'manual-remove',expectedRunId:'run-1'};
 const first=await launch(t,f,'multi',pause);await first.command('release');
 const reply=await submit(request,{socketPath:path.join(f.root,'activity-monitor/am.sock'),deadlineAt:Date.now()+10000});assert.equal(reply.kind,'accepted');
 first.child.send('tick');assert.deepEqual(await first.next(),{barrier:pause});await first.kill();
 const file=path.join(f.root,'activity-monitor/restart-requests.json');assert.equal(JSON.parse(fs.readFileSync(file,'utf8')).length,pause==='before-remove'?1:0);
 assert.throws(()=>f.tmux('has-session','-t','=zylos-group-origin'));
 const events=path.join(f.root,'activity-monitor/supervisor-events.jsonl');
 const completions=()=>fs.existsSync(events)?fs.readFileSync(events,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(e=>e.event==='manual_restart_done'&&e.requestId===request.requestId).length:0;
 assert.equal(completions(),0);
 const second=await launch(t,f,'multi');await second.command('release');let observed=await second.command('tick');assert.deepEqual(observed.requests,[]);assert.deepEqual(observed.fences,[]);
 // No request is submitted after restart. A deleted F9 row without completion log
 // is unknown history, not permission to synthesize another accepted request.
 assert.equal(completions(),pause==='before-remove'?1:0);observed=await second.command('tick');assert.deepEqual(observed.requests,[]);assert.equal(completions(),pause==='before-remove'?1:0);
 const exited=once(second.child,'exit');await second.command('stop');assert.equal((await exited)[0],0);
});
