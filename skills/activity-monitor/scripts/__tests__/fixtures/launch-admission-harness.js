import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import {createHash} from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { isolatedTmux } from '../../../../../test/helpers/isolated-tmux.js';
import { seedCodexTrustFixture } from '../../../../../test/helpers/codex-trust.js';
const worker=fileURLToPath(new URL('./launch-admission-worker.js',import.meta.url));
export const T=1800000000000;
export async function fixture(t,{health='unavailable',budget={},mode='multi'}={}) {
 const children=[];const tm=isolatedTmux(t,{prefix:'launch-admission-',beforeCleanup:async()=>{if(process.env.LAUNCH_ADMISSION_TRACE_DIR){const dir=path.join(process.env.LAUNCH_ADMISSION_TRACE_DIR,createHash('sha256').update(t.name).digest('hex').slice(0,12));fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'case.json'),JSON.stringify({name:t.name,root,processes:children.map(p=>({role:p.role,pid:p.child.pid}))}));for(const role of ['m1','m4'])if(fs.existsSync(path.join(root,role+'.jsonl')))fs.copyFileSync(path.join(root,role+'.jsonl'),path.join(dir,role+'.jsonl'));}for(const p of children)await p.kill()}});
 const root=fs.realpathSync(tm.dir);let clock=T;
 fs.mkdirSync(path.join(root,'.zylos'));fs.mkdirSync(path.join(root,'comm-bridge'));
 fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({runtime:'claude',session_mode:mode}));seedCodexTrustFixture({root,home:root});
 fs.mkdirSync(path.join(root,'named-runtime'));fs.writeFileSync(path.join(root,'named-runtime/sleeper.c'),'#include <unistd.h>\nint main(void){sleep(600);return 0;}\n');execFileSync('cc',[path.join(root,'named-runtime/sleeper.c'),'-o',path.join(root,'named-runtime/claude')]);fs.copyFileSync(path.join(root,'named-runtime/claude'),path.join(root,'named-runtime/codex'));fs.chmodSync(path.join(root,'named-runtime/codex'),0o700);
 fs.writeFileSync(path.join(root,'external-runtime'),`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('codex-fixture');process.exit(0)}
if(process.argv[2]==='app-server')process.exit(2);
if(process.argv.includes('--help')){console.log(' --model MODEL --effort EFFORT --no-daemon ');process.exit(0)}
const root=process.env.ZYLOS_DIR,group=process.env.ZYLOS_SESSION_GROUP||'origin',runId=process.env.ZYLOS_RUN_ID;
const dir=path.join(root,'activity-monitor/session-groups',group);fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'current-session.json'),JSON.stringify({runId,sessionId:'session-'+runId,ts:Date.now(),startupControlIds:[]}));require('node:child_process').spawn(path.join(root,'named-runtime',JSON.parse(process.env.ZYLOS_MODEL_CONFIG).runtime),[],{stdio:'inherit'});setInterval(()=>{},1000);\n`,{mode:0o700});
 for(const name of ['claude','codex']){fs.copyFileSync(path.join(root,'external-runtime'),path.join(root,name));fs.chmodSync(path.join(root,name),0o700)}
 tm.tmux('new-session','-d','-s','fixture-keeper','sleep','600');
 const trace=(role,kind)=>{try{return fs.readFileSync(path.join(root,role+'.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>!kind||x.kind===kind)}catch{return []}};
 async function start(role){
  const child=fork(worker,[role,root,tm.socketPath,tm.binary,String(clock)],{env:{...process.env,HOME:root,ZYLOS_DIR:root},silent:true});
  let stderr='',seq=0;const pending=new Map();let readyResolve,readyReject;
  const ready=new Promise((res,rej)=>{readyResolve=res;readyReject=rej});
  child.stderr.on('data',x=>stderr+=x);child.stdout.on('data',x=>stderr+=x);
  child.on('message',m=>{if(m.ready)return readyResolve(m);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(m.error)):p.resolve(m.result)}});
  child.on('exit',(code,signal)=>{const error=new Error(`${role} exit ${code??signal}: ${stderr}`);readyReject(error);for(const p of pending.values()){clearTimeout(p.timer);p.reject(error)}pending.clear()});
  const p={child,role,call(op,args={}){return new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${role} ${op} timeout: ${stderr}`))},15000);pending.set(id,{resolve,reject,timer});child.send({id,op,...args})})},async kill(){if(child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited}}};children.push(p);await ready;return p;
 }
 const f={root,tm,trace,start,get clock(){return clock},async time(now){clock=now;for(const p of children)if(p.child.exitCode===null&&p.child.signalCode===null)await p.call('clock',{now})},async round(){await f.m1.call('round')},async warm(){for(let i=0;i<8;i++){await f.time(clock+1000);await f.round()}},async attempt(){const n=trace('m1','request').length;for(let i=0;i<8;i++){const before=trace('m1','request').length;await f.round();const after=trace('m1','request').length;if(after>n){assert.equal(after-before,1,'one protocol request in the normal round');return;}}assert.fail(JSON.stringify(trace('m1')))},health:()=>f.m4.call('health'),add:(group='chat')=>f.m1.call('add',{group}),async launched(group='chat'){for(let i=0;i<40;i++){await f.round();const live=await f.m1.call('live',{group});if(live.ready && !(await f.m1.call('settled')).some(a=>!a.settled)){await f.round();return live;}await delay(10)}assert.fail(JSON.stringify(trace('m1')))},async killRun(group='chat'){const live=await f.m1.call('live',{group});tm.tmux('kill-session','-t','=zylos-group-'+group);return live}};
 f.m4=await start('m4');await f.m4.call('seed',{health,budget});f.m1=await start('m1');if(mode==='multi')await f.m1.call('fence',{group:'origin'});await f.warm();return f;
}
export const count=s=>s.scheduling.restartFailureCount;
export const responses=f=>f.trace('m4','persisted-response');
export const launches=f=>f.trace('m1','launch');
export function registeredBeforeLaunch(f){assert.equal(new Set(launches(f).map(x=>x.input.runId)).size,launches(f).length);for(const launch of launches(f)){if(launch.input.sessionGroup==='origin')continue;const grant=responses(f).find(x=>x.response.result==='registered'&&x.request.runId===launch.input.runId);assert.ok(grant,JSON.stringify(launch));assert.ok(grant.clock<=launch.clock);assert.equal(launch.f10.restartFailureCount,grant.health.scheduling.restartFailureCount)}}
