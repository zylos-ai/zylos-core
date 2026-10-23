import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {settleLaunch,executableIdentity} from '../session-launch.js';
import {writeSessionLaunchScript} from '../session-command.js';
const binary=process.env.TEST_TMUX_BIN || 'tmux';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const scenarios=['switch-hook','replace-hook','delete-hook','rename-hook','empty-after-cleanup','lost-cleanup-ack','lost-target-ack','lost-absence-ack'];
async function worker(scenario){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-single-'));
  const socketPath=path.join(dir,'s'),events=path.join(dir,'events');
  const tmux=(...a)=>execFileSync(binary,['-S',socketPath,...a],{encoding:'utf8',timeout:3000,stdio:['ignore','pipe','pipe']});
  let script;
  try{
    tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 30');
    tmux('set-environment','-g','ZYLOS_SESSION_GROUP','global-sentinel');
    const origin=tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim();
    if(scenario==='switch-hook')tmux('set-hook','-g','after-new-session','switch-client -t keeper ; display-message -p hook-output');
    if(scenario==='delete-hook')tmux('set-hook','-g','after-new-session','switch-client -t keeper ; kill-session -t =target');
    if(scenario==='replace-hook')tmux('set-hook','-g','after-new-session','switch-client -t keeper ; kill-session -t =target ; new-session -d -s target "sleep 30"');
    if(scenario==='rename-hook')tmux('set-hook','-g','after-new-session','rename-session -t =target renamed ; new-session -d -s target "sleep 30"');
    if(scenario==='empty-after-cleanup')tmux('set-hook','-g','after-set-environment','set-environment -t =target ZYLOS_SESSION_GROUP "" ; display-message -p -- "-ZYLOS_SESSION_GROUP"');
    const proxy=path.join(dir,'proxy.mjs');
    await fs.writeFile(proxy,`#!${process.execPath}\nimport {spawn} from 'node:child_process';import fs from 'node:fs';
const child=spawn(${JSON.stringify(binary)},process.argv.slice(2),{stdio:['pipe','pipe','pipe']});
const record=v=>fs.appendFileSync(${JSON.stringify(events)},JSON.stringify(v)+'\\n');
record({create:true});process.stdin.on('data',d=>{record({request:d.toString()});child.stdin.write(d)});child.stdin.on('error',()=>{});child.stderr.resume();
let buffer='',frame=[],inside=false,count=0,cut=false;
child.stdout.setEncoding('utf8');child.stdout.on('data',data=>{buffer+=data;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(cut)continue;if(line.startsWith('%begin ')){frame=[line];inside=true;continue;}if(inside){frame.push(line);if(!line.startsWith('%end ')&&!line.startsWith('%error '))continue;inside=false;const control=frame[0].split(' ').at(-1)==='1';if(control)count++;record({frame,control,count});if(control&&${JSON.stringify(scenario)}==='lost-cleanup-ack'&&frame.slice(1,-1).join('\\n')==='' || control&&${JSON.stringify(scenario)}==='lost-target-ack'&&frame[1]?.startsWith('launch-proof:') || control&&${JSON.stringify(scenario)}==='lost-absence-ack'&&frame[1]==='-ZYLOS_SESSION_GROUP'){cut=true;child.kill('SIGKILL');setTimeout(()=>process.exit(0),20);continue;}process.stdout.write(frame.join('\\n')+'\\n');}else process.stdout.write(line+'\\n');}});child.on('close',()=>{if(!cut)process.exit(0)});
`,{mode:0o700});
    script=writeSessionLaunchScript({command:'/bin/sleep',args:['20'],env:{PATH:'/usr/bin:/bin'},root:dir,multi:false});
    let outcome='pending';
    settleLaunch({tmuxName:'target',runId:'single-run',launchConfig:{runtime:'claude',mode:'default'},sessionGroup:null,root:dir,script,identity:await executableIdentity('/bin/sleep',process.env),args:['20'],tmux:{binary:proxy,socketPath,configFile:'/dev/null'},noticeMs:50,onNotice(){}}).then(()=>{outcome='success'},e=>{outcome=e.code});
    let records=[],creation;
    for(let i=0;i<200;i++){try{records=(await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse);creation=records.find(r=>r.frame?.[1]?.match(/^\$\d+\t%\d+\t/));if(creation)break;}catch{}await delay(10)}
    assert.ok(creation,'real original creation ACK recorded');
    const [originalSession,originalPane,originalPid]=creation.frame[1].split('\t');
    await delay(200);
    if(scenario==='switch-hook'){
      for(let i=0;i<100&&outcome==='pending';i++)await delay(10);
      assert.equal(outcome,'success');
      assert.equal(tmux('show-environment','-t',originalSession,'ZYLOS_SESSION_GROUP').trim(),'-ZYLOS_SESSION_GROUP');
    }else{
      assert.notEqual(outcome,'success');
      if(scenario==='delete-hook'||scenario==='replace-hook')assert.ok(outcome==='pending'||outcome==='LAUNCH_FAILED');
      else assert.equal(outcome,'pending');
    }
    let originalRuntimeClean=null;
    if(!['delete-hook','replace-hook'].includes(scenario)){
      assert.equal(await fs.readlink(`/proc/${originalPid}/exe`),await fs.realpath('/bin/sleep'));
      originalRuntimeClean=!(await fs.readFile(`/proc/${originalPid}/environ`,'utf8')).split('\0').some(v=>v.startsWith('ZYLOS_SESSION_GROUP='));
      assert.equal(originalRuntimeClean,true,'initial runtime is the generated env-i launch, not a later window');
    }
    let replacement;
    if(['replace-hook','rename-hook'].includes(scenario)){
      replacement=tmux('list-panes','-t','=target','-F','#{session_id}:#{pane_id}:#{pane_pid}').trim();
      assert.notEqual(replacement.split(':')[0],originalSession);
      assert.doesNotMatch(tmux('show-environment','-t','=target'),/^-ZYLOS_SESSION_GROUP$/m);
    }
    if(outcome==='pending'&&!['delete-hook','replace-hook'].includes(scenario)){
      tmux('kill-pane','-t',originalPane);
      for(let i=0;i<100&&outcome==='pending';i++)await delay(10);
      assert.equal(outcome,'LAUNCH_FAILED');
    }
    assert.equal(tmux('show-environment','-g','ZYLOS_SESSION_GROUP').trim(),'ZYLOS_SESSION_GROUP=global-sentinel');
    assert.equal(tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim(),origin);
    assert.doesNotMatch(tmux('show-environment','-t','=keeper'),/^-ZYLOS_SESSION_GROUP$/m);
    if(replacement)assert.equal(tmux('list-panes','-t','=target','-F','#{session_id}:#{pane_id}:#{pane_pid}').trim(),replacement);
    records=(await fs.readFile(events,'utf8')).trim().split('\n').map(JSON.parse);
    const requests=records.filter(r=>r.request).map(r=>r.request);
    assert.equal(records.filter(r=>r.create).length,1);
    assert.ok(requests.every(r=>!r.includes('new-session')&&!r.includes("'=target'")));
    const mutations=requests.join('').split('\n').filter(r=>r.includes('set-environment'));
    assert.ok(mutations.every(r=>r.includes(`'${originalSession}'`)));
    assert.ok(mutations.length<=1);
    console.log(JSON.stringify({scenario,outcome,originalSession,originalPane,originalRuntimeClean,replacement,requests,originUnchanged:true,globalUnchanged:true}));
  }finally{try{tmux('kill-server')}catch{}script?.cleanup();await fs.rm(dir,{recursive:true,force:true});}
}
if(process.env.P02_SINGLE_WORKER){try{await worker(process.env.P02_SINGLE_WORKER);process.exit(0)}catch(e){console.error(e);process.exit(1)}}
else for(const scenario of scenarios)test(`single immutable cleanup: ${scenario}`,async t=>{
  const child=spawn(process.execPath,[fileURLToPath(import.meta.url)],{env:{...process.env,P02_SINGLE_WORKER:scenario},stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',d=>stdout+=d);child.stderr.on('data',d=>stderr+=d);
  const timer=setTimeout(()=>child.kill('SIGKILL'),8000);
  const code=await new Promise(r=>child.on('close',r));clearTimeout(timer);
  assert.equal(code,0,stderr||stdout);t.diagnostic(stdout.trim());
});
