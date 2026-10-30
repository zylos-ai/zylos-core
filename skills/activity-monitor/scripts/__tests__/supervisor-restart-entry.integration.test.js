import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { HealthStore } from '../health-store.js';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
const worker=fileURLToPath(new URL('./fixtures/supervisor-restart-entry-worker.js',import.meta.url));
async function launch(t,f,pause='',authMode=false){
 const child=fork(worker,[f.socketPath,f.binary,pause,authMode?'auth':''],{env:{...process.env,...f.env},silent:true});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const inbox=[],waiters=[];child.on('message',m=>waiters.length?waiters.shift().resolve(m):inbox.push(m));
 child.on('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(new Error(`Worker exit ${code??signal}: ${stderr}`));});
 const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
 const kill=async()=>{if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}};t.after(kill);
 assert.equal((await next()).ready,true);return {child,next,kill,async command(command){child.send(command);const result=await next();assert.equal(result.error,undefined);return result;}};
}
async function request(f,value){
 const socket=net.createConnection(path.join(f.root,'activity-monitor/am.sock'));await once(socket,'connect');socket.write(JSON.stringify(value)+'\n');
 let response='';for await(const chunk of socket)response+=chunk;return response?JSON.parse(response):null;
}
const restart={version:1,type:'restart_all',requestId:'durable-restart',reason:'upgrade'};
async function scenario(t,mutant=''){
 const f=readyTmuxTarget(t,{prefix:'restart-entry-',mode:'multi'});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const w=await launch(t,f,mutant||'commit');await w.command('release');
 const lost=request(f,restart);assert.deepEqual(await w.next(),{barrier:'committed'});await w.kill();assert.equal(await lost,null);
 const file=path.join(f.root,'activity-monitor/restart-requests.json');assert.equal(fs.existsSync(file),true);
 assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8'))[0].runIds,['run-1']);
 const reopened=await launch(t,f);await reopened.command('release');
 assert.equal((await request(f,restart)).result,'already_accepted');
 assert.equal((await request(f,{version:1,type:'manual_restart',requestId:restart.requestId,expectedRunId:'run-1'})).reason,'request_conflict');
 const first=await reopened.command('tick');assert.equal(first.present,false);assert.deepEqual(first.fences,[]);
 const second=await reopened.command('tick');assert.deepEqual(second.requests,[]);
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));
 const events=fs.readFileSync(path.join(f.root,'activity-monitor/supervisor-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.event==='restart_done'&&e.requestId===restart.requestId).length,1);
 await reopened.command('stop');
}
test('actual supervisor commit-before-reply SIGKILL preserves snapshot, rejects changed content and finishes SQLite/tmux cleanup',{timeout:20000},async t=>{await scenario(t);});
test('actual entry crash harness rejects memory-only acceptance',{timeout:15000},async t=>{await assert.rejects(scenario(t,'memory-only'),{code:'ERR_ASSERTION'});});

async function configScenario(t,mutant=''){
 const f=readyTmuxTarget(t,{prefix:'config-entry-',mode:'multi'});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const config={version:1,type:'ready_for_config_reclaim',requestId:'config-entry',sessionGroup:'origin',expectedRunId:'run-1'};
 const w=await launch(t,f,'config-commit');await w.command('release');
 const lost=request(f,config);assert.deepEqual(await w.next(),{barrier:'config-committed'});await w.kill();assert.equal(await lost,null);
 const reopened=await launch(t,f,mutant);await reopened.command('release');
 assert.equal((await request(f,config)).result,'already_accepted');
 let observed=await reopened.command('unchanged');assert.equal(observed.fences.length,1);assert.equal(observed.fences[0].reason,'model_config');
 assert.equal((await request(f,config)).result,'already_accepted');
 assert.equal((await request(f,{...config,expectedRunId:'different-run'})).reason,'run_changed');
 await reopened.command('clear-config');assert.equal((await request(f,config)).result,'unchanged');
 await reopened.command('changed');assert.equal((await request(f,{...config,requestId:'fresh'})).result,'accepted');
 observed=await reopened.command('tick');assert.equal(observed.present,false);assert.deepEqual(observed.fences,[]);
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));await reopened.command('stop');
}
test('actual supervisor SQLite commit-before-reply crash preserves one config gate across retry and input changes',{timeout:20000},async t=>{await configScenario(t);});
test('config gate deletion on restart is detected by actual retry harness',{timeout:15000},async t=>{await assert.rejects(configScenario(t,'drop-config-gate'),{code:'ERR_ASSERTION'});});

test('real supervisor SIGKILL after auth fence retains health, drains old target and rechecks credentials before clearing',{timeout:20000},async t=>{
 const f=readyTmuxTarget(t,{prefix:'auth-entry-',mode:'multi',runtimeProcess:true});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const store=new HealthStore({zylosDir:f.root,runtime:'claude'}),state=store.read();state.health='auth_failed';state.reason='authentication_failed';store.write(state);
 const w=await launch(t,f,'auth-fence',true);await w.command('release');await w.command('pending');
 w.child.send('tick');assert.deepEqual(await w.next(),{barrier:'auth-fenced'});await w.kill();
 assert.equal(store.read().health,'auth_failed');
 const reopened=await launch(t,f,'',true);let observed=await reopened.command('release');
 assert.equal(observed.health.health,'auth_failed');assert.equal(observed.checks,0);assert.deepEqual(observed.authTargets,[]);assert.equal(observed.fences[0].reason,'auth');
 await reopened.command('pending');await reopened.command('busy');observed=await reopened.command('tick');
 assert.equal(observed.health.health,'auth_failed');assert.equal(observed.checks,0);assert.equal(observed.present,true);assert.equal(observed.fences.length,1);
 await reopened.command('idle');observed=await reopened.command('tick');
 assert.equal(observed.present,false);assert.deepEqual(observed.fences,[]);assert.equal(observed.checks,1);assert.equal(observed.health.health,'ok');
 assert.equal(store.read().health,'ok');assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));await reopened.command('stop');
});
