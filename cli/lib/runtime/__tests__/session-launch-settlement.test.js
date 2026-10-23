import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {settleLaunch,executableIdentity} from '../session-launch.js';
import {writeSessionLaunchScript} from '../session-command.js';
const binary=process.env.TEST_TMUX_BIN || 'tmux';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function setup(t) {
  const scripts=[];
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-settlement-'));
  const socketPath=path.join(dir,'socket');
  const tmux=(...args)=>execFileSync(binary,['-S',socketPath,...args],{encoding:'utf8',timeout:3000});
  tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 60');
  const server=Number(tmux('display-message','-p','#{pid}').trim());
  t.after(async()=>{try{process.kill(server,'SIGCONT');}catch{} try{tmux('kill-server');}catch{} for(const script of scripts) script.cleanup(); await fs.rm(dir,{recursive:true,force:true});});
  async function launch(command='/bin/sleep',args=['30'],name='target',onNotice=()=>{}) {
    const identity=await executableIdentity(command,process.env);
    const script=writeSessionLaunchScript({command,args,env:{PATH:'/usr/bin:/bin'},root:dir,multi:false});
    scripts.push(script);
    return settleLaunch({tmuxName:name,runId:'isolated-run',launchConfig:{runtime:'claude',mode:'default'},sessionGroup:null,root:dir,script,identity,args,tmux:{binary,socketPath,configFile:'/dev/null'},noticeMs:50,onNotice});
  }
  return {launch,tmux,server,dir};
}
test('paused original server preserves promise, then confirms exec and F2 without READY',async t=>{
  const f=await setup(t);let notices=0,done=false;
  process.kill(f.server,'SIGSTOP');
  const pending=f.launch('/bin/sleep',['30'],'target',()=>{notices++;throw new Error('notice consumer failed');}).finally(()=>{done=true;});
  await delay(150);assert.equal(done,false);assert.equal(notices,1);
  process.kill(f.server,'SIGCONT');
  const result=await pending;assert.equal(result.tmuxName,'target');
  assert.equal(result.createdAt,Number(f.tmux('list-sessions','-F','#{session_name} #{session_created}').split('\n').find(v=>v.startsWith('target ')).split(' ')[1]));
  const pid=f.tmux('list-panes','-t','target','-F','#{pane_pid}').trim();
  assert.equal(await fs.readlink(`/proc/${pid}/exe`),await fs.realpath('/bin/sleep'));
  assert.match(f.tmux('show-environment','-t','target'),/ZYLOS_RUN_ID=isolated-run/);
  assert.doesNotMatch(f.tmux('show-environment','-t','target'),/^ZYLOS_SESSION_GROUP=/m);
  await delay(100);assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim().split('\n').length,2);
});
test('paused creation race rejects NAME_CONFLICT only after original response',async t=>{
  const f=await setup(t);process.kill(f.server,'SIGSTOP');let done=false;
  const pending=f.launch('/bin/sleep',['30'],'keeper').finally(()=>{done=true;});
  const rejection=assert.rejects(pending,{code:'NAME_CONFLICT'});
  await delay(100);assert.equal(done,false);process.kill(f.server,'SIGCONT');await rejection;
  await delay(100);assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'keeper');
});
test('exec failure settles after acknowledged pane exits, with no later creation',async t=>{
  const f=await setup(t);
  await assert.rejects(f.launch('/bin/false',[]),{code:'LAUNCH_FAILED'});
  await delay(100);assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'keeper');
});

// This opt-in integration consumes the actual A/P01 checkout, never a parser mock.
test('adapter launch consumes real A/P01 paths and observers with script runtime', {skip:!process.env.P02_REAL_A_ROOT}, async t=>{
  const f=await setup(t);
  const {pathToFileURL}=await import('node:url');
  const base=process.env.P02_REAL_A_ROOT;
  const paths=await import(pathToFileURL(path.join(base,'cli/lib/session-group-paths.js')));
  const deps={...await import(pathToFileURL(path.join(base,'cli/lib/runtime/tmux-connection.js'))),...await import(pathToFileURL(path.join(base,'cli/lib/runtime/session-target.js')))};
  const {SessionAdapter}=await import('../session-adapter.js');
  class Adapter extends SessionAdapter {get runtimeId(){return 'claude';}}
  const command=path.join(f.dir,'runtime');
  await fs.writeFile(command,`#!${process.execPath}\nif(process.argv.includes('--help')) { console.log(' --model MODEL --effort EFFORT '); } else if(process.argv[2]==='auth' && process.argv[3]==='status') { console.log('{\"loggedIn\":false}'); } else { setInterval(()=>{},1000); }\n`,{mode:0o700});
  const adapter=new Adapter({root:f.dir,paths,dependencies:deps,env:{...process.env,CLAUDE_BIN:command},tmux:{binary,socketPath:path.join(f.dir,'socket'),configFile:'/dev/null'}});
  const input={sessionGroup:'telegram:g-123',runId:'actual-adapter-run',sessionMode:'multi',launchConfig:{runtime:'claude',mode:'override',model:'model with spaces',effort:'high'}};
  const result=await adapter.launch(input);
  assert.equal(result.tmuxName,paths.tmuxNameForGroup(input.sessionGroup));
  const pid=f.tmux('list-panes','-t',result.tmuxName,'-F','#{pane_pid}').trim();
  const argv=(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0');
  assert.equal(argv[argv.indexOf('--model')+1],'model with spaces');
  assert.equal(await fs.readlink(`/proc/${pid}/exe`),await fs.realpath(process.execPath));
  assert.equal(await fs.readlink(`/proc/${pid}/cwd`),f.dir);
  const env=await fs.readFile(`/proc/${pid}/environ`,'utf8');
  assert.ok(env.split('\0').includes('ZYLOS_SESSION_GROUP=telegram:g-123'));
  const stat=await fs.readFile(`/proc/${pid}/stat`,'utf8');
  assert.equal(Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]),f.server);
  await assert.rejects(adapter.launch(input),{code:'NAME_CONFLICT'});
});

test('lost original client cannot bind to replacement server at the same socket',async t=>{
  const f=await setup(t);process.kill(f.server,'SIGSTOP');let settled=false;
  const pending=f.launch().then(()=>{settled=true;},()=>{settled=true;});
  await delay(100);
  const children=(await fs.readFile(`/proc/${process.pid}/task/${process.pid}/children`,'utf8')).trim().split(/\s+/);
  let killed=false;
  for(const pid of children) {
    if(!pid) continue;
    try {
      const argv=(await fs.readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0');
      if(argv.includes(path.join(f.dir,'socket')) && argv.includes('-C')) { process.kill(Number(pid),'SIGKILL');killed=true; }
    } catch(error) {if(error.code!=='ENOENT') throw error;}
  }
  assert.equal(killed,true);await delay(50);assert.equal(settled,false);
  process.kill(f.server,'SIGCONT');await delay(100);
  f.tmux('kill-server');await delay(50);
  f.tmux('-f','/dev/null','new-session','-d','-s','target','sleep 30');
  await delay(100);assert.equal(settled,false);
  void pending; // Deliberately unresolved; no client/retry/poll timer survives pre-ack loss.
});

test('first creation on isolated socket confirms original new server',async t=>{
  const f=await setup(t);f.tmux('kill-server');await delay(50);
  const result=await f.launch();
  assert.equal(result.tmuxName,'target');
  assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'target');
  assert.equal(Number.isInteger(result.createdAt),true);
});
