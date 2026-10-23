import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, execFileSync} from 'node:child_process';
import {settleLaunch, executableIdentity} from '../session-launch.js';

const delay=ms=>new Promise(r=>setTimeout(r,ms));
const binary=process.env.TEST_TMUX_BIN || 'tmux';
const scenarios=['before-create-ack','after-create-before-env','after-header-before-exec','after-exec-before-env','malformed-create-ack','original-server-exit','replacement-server','before-ack-server-exit','before-ack-replacement','wrong-f2','replacement-session'];

// Multi-mode needs no single-mode tombstone commands. Every worker has a private socket and controlled sleep image. A proxy transports
// real tmux control frames, dropping only the selected reply boundary. It neither
// invents a successful frame nor changes the product's observation logic.
async function worker(scenario) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-tloss-'));
  const socket=path.join(dir,'s'), gate=path.join(dir,'go'), marker=path.join(dir,'cut');
  const command=(...args)=>execFileSync(binary,['-S',socket,...args],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']});
  let result={scenario,initial:'pending'}, outcome='pending', server;
  try {
    command('-f','/dev/null','new-session','-d','-s','keeper','sleep 60');
    server=Number(command('display-message','-p','#{pid}').trim());
    const origin=command('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim();
    const proxy=path.join(dir,'proxy.mjs');
    await fs.writeFile(proxy,`#!${process.execPath}\nimport {spawn} from 'node:child_process';import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(path.join(dir,'invocations'))},'launch\\n');
const argv=process.argv.slice(2);if(${JSON.stringify(scenario)}==='wrong-f2'){const i=argv.indexOf('ZYLOS_RUN_ID=transport-run');argv[i]='ZYLOS_RUN_ID=incorrect';}
const child=spawn(${JSON.stringify(binary)},argv,{stdio:['pipe','pipe','pipe']});
let requests=[];process.stdin.on('data',data=>{requests.push(data.toString());child.stdin.write(data);});child.stdin.on('error',()=>{});child.stderr.resume();
let buffer='',frame=[],inside=false,count=0,cut=false,panePid,execAtCut=null;
function stop(){if(cut)return;cut=true;fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({pid:child.pid,count,requests,execAtCut}));child.kill('SIGKILL');setTimeout(()=>process.exit(0),30);}
child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\\n'))>=0){let line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(cut)continue;
if(line.startsWith('%begin ')){inside=true;frame=[line];continue;}if(inside){frame.push(line);if(!line.startsWith('%end ')&&!line.startsWith('%error '))continue;inside=false;count++;
const s=${JSON.stringify(scenario)};if(count===1){const m=frame.join('\\n').match(/\\$(?:[0-9]+)\\t%(?:[0-9]+)\\t([0-9]+)/);if(m)panePid=Number(m[1]);}
if(count===1&&['before-create-ack','before-ack-server-exit','before-ack-replacement'].includes(s)){stop();continue;}
if(count===1&&s==='malformed-create-ack'){process.stdout.write(frame.map((v,j)=>j>0&&j<frame.length-1?'malformed target':v).join('\\n')+'\\n');stop();continue;}
if(count===1&&s==='after-exec-before-env'){(async()=>{for(let n=0;n<200;n++){try{execAtCut=fs.readlinkSync('/proc/'+panePid+'/exe');if(execAtCut===${JSON.stringify(await fs.realpath('/bin/sleep'))})break;}catch{}await new Promise(r=>setTimeout(r,5));}process.stdout.write(frame.join('\\n')+'\\n');stop();})();continue;}\n
process.stdout.write(frame.join('\\n')+'\\n');if(count===1&&s!=='after-header-before-exec'||count===2&&s==='after-header-before-exec')stop();
}else process.stdout.write(line+'\\n');}});child.on('close',()=>{if(!cut)process.exit(0)});
`,{mode:0o700});
    const scriptFile=path.join(dir,'launch.sh');
    const gated=scenario!=='after-exec-before-env';
    await fs.writeFile(scriptFile,`#!/bin/sh\n${gated ? `while [ ! -f '${gate}' ]; do sleep 0.02; done\n`:''}exec /bin/sleep 30\n`,{mode:0o700});
    let cleanups=0;
    settleLaunch({tmuxName:'target',runId:'transport-run',launchConfig:{runtime:'claude',mode:'default'},sessionGroup:'telegram:transport',root:dir,script:{file:scriptFile,cleanup(){cleanups++;}},identity:await executableIdentity('/bin/sleep',process.env),args:['30'],tmux:{binary:proxy,socketPath:socket,configFile:'/dev/null'},noticeMs:80,onNotice(){}}).then(()=>{outcome='success'},e=>{outcome=e.code});
    for(let i=0;i<100;i++){try{await fs.access(marker);break;}catch{await delay(20);}}
    const cut=JSON.parse(await fs.readFile(marker,'utf8'));
    await delay(120);
    result.cutFrame=cut.count;result.initial=outcome;result.commands=cut.requests;result.execAtCut=cut.execAtCut;
    assert.ok(cut.requests.every(v=>!v.includes('new-session')&&!v.includes('set-environment')),'followups only read the original connection');
    if(scenario==='after-exec-before-env')assert.equal(cut.execAtCut,await fs.realpath('/bin/sleep'));
    result.panePid=Number(command('list-panes','-t','=target','-F','#{pane_pid}').trim());
    result.serverPid=server;
    result.sessionEnv=command('show-environment','-t','=target').split('\n').filter(v=>v.startsWith('ZYLOS_'));
    result.initialExe=await fs.readlink(`/proc/${result.panePid}/exe`);
    assert.equal(outcome,'pending','creation ACK alone cannot replace the completion header');
    if(['after-header-before-exec','after-create-before-env'].includes(scenario)) {
      await fs.writeFile(gate,'go');
      for(let i=0;i<100&&outcome==='pending';i++)await delay(20);
      assert.equal(outcome,scenario==='after-header-before-exec'?'success':'pending');
      result.finalExe=await fs.readlink(`/proc/${result.panePid}/exe`);
      assert.equal(result.finalExe,await fs.realpath('/bin/sleep'));
    } else if(scenario==='replacement-session') {
      command('kill-session','-t','=target');
      command('new-session','-d','-s','target','sleep 30');
      const replacement=command('list-panes','-t','=target','-F','#{pane_id}:#{pane_pid}').trim();
      await delay(250);assert.equal(outcome,'LAUNCH_FAILED');
      assert.equal(command('list-panes','-t','=target','-F','#{pane_id}:#{pane_pid}').trim(),replacement);
      result.replacement=replacement;
    } else if(scenario==='after-exec-before-env') {
      assert.equal(outcome,'pending');
      await delay(150);assert.equal(outcome,'pending');
    } else if(['original-server-exit','replacement-server','before-ack-server-exit','before-ack-replacement'].includes(scenario)) {
      command('kill-server');await delay(80);
      if(scenario.endsWith('replacement')||scenario==='replacement-server')command('-f','/dev/null','new-session','-d','-s','target','sleep 30');
      await delay(250);
      assert.equal(outcome,scenario.startsWith('before-ack-')?'pending':'LAUNCH_FAILED');
      if(scenario.endsWith('replacement')||scenario==='replacement-server') {result.replacementPid=Number(command('list-panes','-t','=target','-F','#{pane_pid}').trim());assert.notEqual(result.replacementPid,result.panePid);assert.equal(await fs.readlink(`/proc/${result.replacementPid}/exe`),await fs.realpath('/bin/sleep'));}
    } else {
      if(scenario==='wrong-f2'){await fs.writeFile(gate,'go');await delay(150);assert.equal(outcome,'pending','wrong F2 must never confirm success');}
      command('kill-session','-t','=target');
      await delay(250);
      assert.equal(outcome,['before-create-ack','malformed-create-ack'].includes(scenario)?'pending':'LAUNCH_FAILED');
    }
    if(!['original-server-exit','replacement-server','before-ack-server-exit','before-ack-replacement'].includes(scenario)) {
      assert.equal(command('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim(),origin);
      result.originUnchanged=true;
    }
    if(outcome==='success'){
      await delay(150);
      assert.equal(Number(command('list-panes','-t','=target','-F','#{pane_pid}').trim()),result.panePid);
      assert.deepEqual(command('list-sessions','-F','#{session_name}').trim().split('\n').sort(),['keeper','target']);
      result.noLateCreationObserved=true;
    }
    result.final=outcome;result.cleanups=cleanups;result.launchCount=(await fs.readFile(path.join(dir,'invocations'),'utf8')).trim().split('\n').length;
    assert.equal(result.launchCount,1);
    assert.equal(cleanups,outcome==='pending'?0:1);
    process.stdout.write(JSON.stringify(result)+'\n');
  } finally {try{command('kill-server')}catch{} await fs.rm(dir,{recursive:true,force:true});}
}

if(process.env.P02_TRANSPORT_WORKER) {
  try {await worker(process.env.P02_TRANSPORT_WORKER);process.exit(0);} catch(e) {console.error(e);process.exit(1);}
} else {
  for(const scenario of scenarios)test(`transport phase evidence: ${scenario}`,async t=>{
    const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,P02_TRANSPORT_WORKER:scenario},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
    const timer=setTimeout(()=>child.kill('SIGKILL'),10000);
    const code=await new Promise(resolve=>child.on('close',resolve));clearTimeout(timer);
    assert.equal(code,0,stderr);const record=JSON.parse(stdout.trim());t.diagnostic(JSON.stringify(record));
    // True EOF before the completion header retains pending even with a live
    // runtime; a delivered header plus original ACK can complete after EOF.
  });
}
