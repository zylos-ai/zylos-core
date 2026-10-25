import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { HealthStore } from '../health-store.js';
const worker=fileURLToPath(new URL('./fixtures/supervisor-single-auth-worker.js',import.meta.url));
async function launch(t,f){
 const child=fork(worker,[f.socketPath,f.binary],{env:{...process.env,...f.env},silent:true});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const inbox=[],waiters=[];child.on('message',m=>waiters.length?waiters.shift().resolve(m):inbox.push(m));
 child.on('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(new Error(`Worker exited ${code??signal}: ${stderr}`));});
 const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
 const kill=async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}};t.after(kill);assert.equal((await next()).ready,true);
 return {child,next,kill,async command(value){child.send(value);const result=await next();assert.equal(result.error,undefined);return result;}};
}
test('IF-28 single actual M4 SIGKILL recaptures old run without D8; finite control blocks while deadline-less permits cleanup',{timeout:20000},async t=>{
 const f=readyTmuxTarget(t,{prefix:'single-auth-entry-',mode:'single',runtimeProcess:true});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const store=new HealthStore({zylosDir:f.root,runtime:'claude'}),state=store.read();state.health='auth_failed';state.reason='authentication_failed';store.write(state);
 const first=await launch(t,f);await first.command('pending');let observed=await first.command('tick');
 assert.equal(observed.health,'auth_failed');assert.equal(observed.checks,1);assert.deepEqual(observed.targets,['run-1']);assert.equal(observed.present,true);assert.equal(observed.gates,0);assert.deepEqual(observed.fences,[]);
 await first.kill();assert.equal(store.read().health,'auth_failed');
 const next=await launch(t,f);observed=await next.command('pending');assert.equal(observed.checks,0);assert.deepEqual(observed.targets,[]);
 observed=await next.command('tick');assert.equal(observed.checks,1);assert.deepEqual(observed.targets,['run-1']);assert.equal(observed.health,'auth_failed');
 await next.command('idle');await next.command('finite');observed=await next.command('tick');assert.equal(observed.health,'auth_failed');assert.equal(observed.present,true);
 await next.command('deadline-less');observed=await next.command('tick');assert.equal(observed.health,'ok');assert.equal(observed.present,false);assert.equal(observed.gates,0);assert.deepEqual(observed.fences,[]);
 assert.equal(store.read().health,'ok');assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));
 const exited=once(next.child,'exit');await next.command('stop');assert.equal((await exited)[0],0);
});
