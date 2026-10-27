import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readyTmuxTarget } from '../../../../test/helpers/ready-tmux-target.js';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
const worker=fileURLToPath(new URL('./fixtures/supervisor-reclaim-entry-worker.js',import.meta.url));
function launch(t,f,pause=''){
 const child=fork(worker,[f.socketPath,f.binary,pause],{env:{...process.env,...f.env},silent:true});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);
 const inbox=[],waiters=[];child.on('message',m=>waiters.length?waiters.shift().resolve(m):inbox.push(m));
 child.on('exit',(code,signal)=>{for(const w of waiters.splice(0))w.reject(new Error(`Worker exited ${code??signal}: ${stderr}`));});
 const next=()=>inbox.length?Promise.resolve(inbox.shift()):new Promise((resolve,reject)=>waiters.push({resolve,reject}));
 const kill=async()=>{if(child.exitCode===null&&child.signalCode===null){const done=once(child,'exit');child.kill('SIGKILL');await done;}};t.after(kill);
 return {child,next,kill};
}
async function scenario(t,pause,mutant=''){
 const f=readyTmuxTarget(t,{prefix:'reclaim-entry-',mode:'multi',runtimeProcess:true});f.tmux('new-session','-d','-s','fixture-keeper','sleep','120');
 const db=createStore(f.db,{readConfig:()=>({state:'ok',config:{runtime:'claude',session_mode:'multi'}})});db.setDrainFence('origin',{reason:'upgrade',runId:'run-1'});
 const first=launch(t,f,pause);assert.deepEqual(await first.next(),{barrier:pause});await first.kill();assert.equal(db.getDrainFence('origin').runId,'run-1');
 const second=launch(t,f,mutant),result=await second.next();assert.equal(result.ready,true);assert.equal(result.fence,null);assert.equal(result.present,false);
 assert.equal(db.getDrainFence('origin'),null);assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));
 const exited=once(second.child,'exit');second.child.send('stop');assert.deepEqual(await second.next(),{stopped:true});assert.equal((await exited)[0],0);
}
for(const pause of ['after-fence','before-stop','after-stop'])test(`IF-32 actual M4 entry SIGKILL ${pause} resumes retained SQLite gate and exact target cleanup`,{timeout:20000},async t=>{await scenario(t,pause);});
test('IF-32 actual entry restart-clear-D8 mutant cannot pass original-target cleanup assertion',{timeout:20000},async t=>{await assert.rejects(scenario(t,'after-fence','clear-fence'),{code:'ERR_ASSERTION'});});
