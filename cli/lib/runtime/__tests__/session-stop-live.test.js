import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fixture,service,actualDependencies,until} from './stop-tmux-fixture.js';
import {shellQuote} from '../session-command.js';

for(const present of [true,false])test(`real tmux stop: present=${present}; independent same-run service and origin survive`,async t=>{
 const f=await fixture(t),key=randomUUID();
 if(present)f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
 const original=present?f.snapshot('target'):null;
 const independent=await service(f,key);
 await f.adapter.stop({tmuxName:'target',expectedRunId:key});
 assert.equal(f.command('list-sessions','-F','#{session_name}'),'origin');
 assert.equal(f.snapshot('origin'),f.origin);
 const preserved=await independent.verify();
 t.diagnostic(JSON.stringify({present,original,service:preserved,originUnchanged:true,targetAbsent:true}));
});

test('real no-server stop succeeds with nonempty/null key and preserves the independent service',async t=>{
 const f=await fixture(t,{origin:false}),key=randomUUID(),independent=await service(f,key);
 for(const expectedRunId of [key,null])await f.adapter.stop({tmuxName:'absent',expectedRunId});
 t.diagnostic(JSON.stringify({explicitNoServer:true,service:await independent.verify()}));
});

test('unreadable process environment/runtime tree cannot block observable tmux removal',async t=>{
 const f=await fixture(t),key=randomUUID(),independent=await service(f,key);
 f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,'sleep 60');
 let unavailableReads=0;
 f.adapter.options.dependencies={...actualDependencies,observeSessionTarget:options=>actualDependencies.observeSessionTarget({
  ...options,readProcessTree:async()=>{unavailableReads++;throw Object.assign(new Error('process information denied'),{code:'EACCES'})},
 })};
 for(const option of ['findRunProcesses','readOwnedProcess','pinProcess','signalProcess','processSignal','stopGraceMs'])
  Object.defineProperty(f.adapter.options,option,{get(){throw Object.assign(new Error('process environment denied'),{code:'EACCES'})}});
 await f.adapter.stop({tmuxName:'target',expectedRunId:key});
 assert.equal(f.command('list-sessions','-F','#{session_name}'),'origin');assert.equal(f.snapshot('origin'),f.origin);
 assert.ok(unavailableReads>0,'actual resolver exercised unavailable runtime observation');
 t.diagnostic(JSON.stringify({processObservationUnavailable:true,service:await independent.verify(),originUnchanged:true,targetAbsent:true}));
});

test('service actually spawned by target inherits run ID and survives both present and absent stop',async t=>{
 const f=await fixture(t),key=randomUUID(),proof=path.join(f.dir,'inherited.json'),done=path.join(f.dir,'finish');
 const childScript=path.join(f.dir,'inherited-service.mjs'),parentScript=path.join(f.dir,'agent-parent.mjs');
 await fs.writeFile(childScript,`import{writeFileSync,existsSync}from'node:fs';import{randomUUID}from'node:crypto';let tick=0;const signals=[],start=randomUUID();
 for(const s of ['SIGHUP','SIGTERM'])process.on(s,()=>signals.push(s));
 const beat=()=>{if(existsSync(${JSON.stringify(done)}))process.exit(0);writeFileSync(${JSON.stringify(proof)},JSON.stringify({pid:process.pid,ppid:process.ppid,start,exe:process.execPath,runId:process.env.ZYLOS_RUN_ID,tick:++tick,signals}))};
 beat();setInterval(beat,20);setTimeout(()=>process.exit(0),30000);`);
 await fs.writeFile(parentScript,`import{spawn}from'node:child_process';import{existsSync}from'node:fs';
 const child=spawn(process.execPath,[${JSON.stringify(childScript)}],{detached:true,stdio:'ignore'});child.unref();
 setInterval(()=>{if(existsSync(${JSON.stringify(done)}))process.exit(0)},20);setTimeout(()=>process.exit(0),30000);`);
 let child;
 f.cleanup.push(async()=>{
  await fs.writeFile(done,'done');
  if(child)await until(()=>{try{process.kill(child.pid,0);return false;}catch(error){if(error.code!=='ESRCH')throw error;return true;}},gone=>gone);
 });
 f.command('new-session','-d','-s','target','-e',`ZYLOS_RUN_ID=${key}`,
  `exec env -i HOME=${shellQuote(f.dir)} ZYLOS_RUN_ID="$ZYLOS_RUN_ID" ${shellQuote(process.execPath)} ${shellQuote(parentScript)}`);
 const panePid=Number(f.command('display-message','-p','-t','=target:','#{pane_pid}'));
 child=await until(async()=>JSON.parse(await fs.readFile(proof,'utf8')),value=>value.runId===key);
 assert.equal(child.ppid,panePid,'service must really originate in the target');
 assert.equal(child.runId,key);assert.equal(child.exe,process.execPath);assert.ok(child.start);
 for(const phase of ['present','absent']){
  await f.adapter.stop({tmuxName:'target',expectedRunId:key});
  const checkpoint=JSON.parse(await fs.readFile(proof,'utf8'));
  const after=await until(async()=>JSON.parse(await fs.readFile(proof,'utf8')),value=>value.tick>checkpoint.tick+1);
  assert.deepEqual(after.signals,[]);assert.equal(after.pid,child.pid);assert.equal(after.start,child.start);assert.equal(after.exe,child.exe);assert.equal(after.runId,key);
  assert.equal(f.command('list-sessions','-F','#{session_name}'),'origin');assert.equal(f.snapshot('origin'),f.origin);
  t.diagnostic(JSON.stringify({phase,originalPanePid:panePid,servicePid:child.pid,start:child.start,
   actualInheritedRunId:true,checkpointTick:checkpoint.tick,afterTick:after.tick,signals:after.signals,originUnchanged:true}));
 }
});
