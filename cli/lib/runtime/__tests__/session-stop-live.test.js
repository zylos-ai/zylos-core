import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {SessionAdapter,findRunProcesses} from '../session-adapter.js';
import {readOwnedProcess} from '../session-process-ownership.js';
const binary=process.env.TEST_TMUX_BIN || 'tmux';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
for(const absentAtEntry of [false,true])test(`real keyed stop: absentAtEntry=${absentAtEntry}, ignoreTERM=${absentAtEntry}`,async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-stop-live-'));const socketPath=path.join(dir,'s'),key=randomUUID(),signals=[];let family;
 const tmux=(...a)=>execFileSync(binary,['-S',socketPath,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:3000}).trim();
 try{
  tmux('-f','/dev/null','new-session','-d','-s','origin','sleep 30');const origin=tmux('list-panes','-t','=origin','-F','#{pane_id}:#{pane_pid}');
  const script=path.join(dir,'runtime.mjs'),proof=path.join(dir,'family.json');
  await fs.writeFile(script,`import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.on('SIGHUP',()=>{});${absentAtEntry?"process.on('SIGTERM',()=>{});":''}if(process.argv[2]==='child'){process.send('ready')}else{const c=spawn(process.execPath,[import.meta.filename,'child'],{stdio:['ignore','ignore','ignore','ipc']});c.on('message',()=>writeFileSync(${JSON.stringify(proof)},JSON.stringify([process.pid,c.pid])))}setInterval(()=>{},1000);`);
  tmux('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}',`exec ${process.execPath} ${script}`);
  for(let i=0;i<100;i++){try{family=JSON.parse(await fs.readFile(proof,'utf8'));break}catch{}await delay(10)}
  assert.equal(family?.length,2);
  const identities=await Promise.all(family.map(pid=>readOwnedProcess(pid,key)));assert.ok(identities.every(Boolean));
  if(absentAtEntry){tmux('kill-session','-t','=target');await delay(50);for(const pid of family)assert.ok(await readOwnedProcess(pid,key))}
  // Limit enumeration to independently recorded fixture PIDs; stat, UID, env
  // and signals still use real /proc/kernel. Host-owned unreadable processes
  // deliberately are not treated as absent by the production scanner.
  const scan=runId=>findRunProcesses(runId,{withIdentity:true,filesystem:{...fs,readdir:async()=>family.map(String)}});
  const adapter=new SessionAdapter({findRunProcesses:scan,tmux:{binary,socketPath,sessionName:'origin'},stopGraceMs:50,signalProcess:(pid,sig)=>{signals.push([pid,sig]);process.kill(pid,sig)}});
  await adapter.stop({tmuxName:'target',expectedRunId:key});
  assert.deepEqual(await scan(key),[]);
  assert.ok(signals.some(x=>x[1]==='SIGTERM'));assert.equal(signals.some(x=>x[1]==='SIGKILL'),absentAtEntry);
  assert.equal(tmux('list-sessions','-F','#{session_name}'),'origin');assert.equal(tmux('list-panes','-t','=origin','-F','#{pane_id}:#{pane_pid}'),origin);
  t.diagnostic(JSON.stringify({absentAtEntry,identities,signals,ownedGone:true,originUnchanged:true,scanDomain:"known fixture parent and child; real proc reads"}));
 }finally{for(const pid of family||[]){try{if(await readOwnedProcess(pid,key))process.kill(pid,'SIGKILL')}catch{}}try{tmux('kill-server')}catch{}await fs.rm(dir,{recursive:true,force:true})}
});
