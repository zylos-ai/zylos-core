import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { UPGRADE_RESTART_CHECK_PROMPT } from '../reclaim-prompts.js';
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
 // A present pane is a live run: upgrade must finish its bound check before reclaim.
 const checking=await reopened.command('tick');assert.equal(checking.present,true);assert.deepEqual(checking.fences,[]);
 const upgradeChecks=checking.controls.filter(control=>control.raw_content===UPGRADE_RESTART_CHECK_PROMPT);
 assert.equal(upgradeChecks.length,1);
 const check=upgradeChecks[0];
 assert.equal(check.status,'pending');assert.equal(check.session_group,'origin');
 assert.equal(JSON.parse(check.target_binding).expectedRunId,'run-1');assert.ok(check.ack_deadline_at>0);
 assert.equal(checking.requests.length,1);
 const waiting=await reopened.command('tick');assert.equal(waiting.present,true);
 assert.equal(waiting.controls.filter(control=>control.raw_content===UPGRADE_RESTART_CHECK_PROMPT).length,1);
 await reopened.command({expireControl:check.id});
 const first=await reopened.command('tick');assert.equal(first.present,false);assert.deepEqual(first.fences,[]);
 const second=await reopened.command('tick');assert.deepEqual(second.requests,[]);
 assert.deepEqual(second.fences,[]);assert.equal(second.present,false);
 assert.doesNotThrow(()=>f.tmux('has-session','-t','=fixture-keeper'));
 const events=fs.readFileSync(path.join(f.root,'activity-monitor/supervisor-events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(events.filter(e=>e.event==='restart_done'&&e.requestId===restart.requestId).length,1);
 await reopened.command('stop');
}
// Covers durable restart entry through real SQLite, supervisor and private tmux. Run when
// restart admission, upgrade preparation or runtime liveness changes; skip for unrelated code.
// readyTmuxTarget owns the socket/database; launch() kills workers even on failed assertions.
test('actual supervisor commit-before-reply SIGKILL preserves snapshot, rejects changed content and finishes SQLite/tmux cleanup',{timeout:20000},async t=>{await scenario(t);});

