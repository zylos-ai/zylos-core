import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SessionAdapter } from '../session-adapter.js';
import { buildRuntimeArgs, validateLaunchConfig, writeSessionLaunchScript } from '../session-command.js';
import { ClaudeAdapter } from '../claude.js';
import { CodexAdapter } from '../codex.js';

class Adapter extends SessionAdapter { get runtimeId() { return 'claude'; } }
function fixture({present = true, runId = 'r', openError, runtime = 'claude'} = {}) {
  const calls = [], target = {present, runId, tmuxSessionId:'$7', paneId:'%8'};
  const connection = {close:() => calls.push(['close']), command:async argv => { calls.push(argv); if (argv[0] === 'kill-session') target.present = false; if (argv[0] === 'display-message') {if(!target.present)throw error('TARGET_GONE');return '$7';} return 'screen'; }};
  const dependencies = {
    openTmuxConnection:async () => { if (openError) throw openError; return connection; },
    observeSessionTarget:async () => target,
    revalidateSessionTarget:async () => { calls.push(['validate']); },
    readTargetRuntime:async () => ({runtime}),
  };
  const adapter = new Adapter({dependencies});
  return {adapter, dependencies, target, connection, calls};
}
const error = (code,cause) => Object.assign(new Error(code),{code,cause});

test('absence only: no server is false; timeout remains unavailable',async () => {
  assert.deepEqual(await fixture({openError:error('TMUX_NO_SERVER')}).adapter.isRunning({tmuxName:'x'}),{tmux:false,process:false});
  await assert.rejects(fixture({openError:error('TMUX_UNAVAILABLE','timeout')}).adapter.isRunning({tmuxName:'x'}),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
});
test('configured runtime alone cannot establish process liveness',async () => {
  await assert.rejects(fixture({runtime:'unknown'}).adapter.isRunning({tmuxName:'x'}),{code:'TMUX_UNAVAILABLE'});
});
test('run mismatch does not signal or kill',async () => {
  const f = fixture();
  await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'other'}),{code:'RUNID_MISMATCH'});
  assert.equal(f.calls.some(c => c[0] === 'kill-session'),false);
});
test('stop bound object and confirm its removal with session guards',async () => {
  const f=fixture();
  await f.adapter.stop({tmuxName:'x',expectedRunId:'r'});
  assert.deepEqual(f.calls,[['validate'],['kill-session','-t','$7'],['display-message','-p','-t','$7','#{session_id}'],['close']]);
});
test('process cleanup dependencies are never consumed for present or absent targets',async () => {
  for (const present of [false,true]) {
    const f=fixture({present});
    for(const key of ['findRunProcesses','readOwnedProcess','pinProcess','signalProcess','stopGraceMs'])
      Object.defineProperty(f.adapter.options,key,{get(){throw new Error('Obsolete process cleanup dependency read')}});
    await f.adapter.stop({tmuxName:'x',expectedRunId:'r'});
    assert.equal(f.calls.some(c=>c[0]==='kill-session'),present);
  }
});
test('null absent succeeds without process-unknown logs; unobservable tmux refuses',async () => {
  const f=fixture({present:false});const logs=[];f.adapter.options.log=s=>logs.push(s);
  await f.adapter.stop({tmuxName:'x',expectedRunId:null});assert.deepEqual(logs,[]);
  await assert.rejects(fixture({openError:error('TMUX_UNAVAILABLE')}).adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED'});
});
test('target still present after kill cannot be reported stopped',async () => {
  const f=fixture();f.connection.command=async argv=>{f.calls.push(argv);return '$7'};
  await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED'});
});
test('multiline text loads a private file and pastes in one guarded batch',async () => {
  const f=fixture(); let file;
  f.connection.commandBatch=async commands=> {
    f.calls.push(['batch',commands]);
    assert.deepEqual(commands.map(c=>c[0]),['load-buffer','paste-buffer']);
    const load=commands[0],paste=commands[1];file=load[3];
    assert.equal(await fs.readFile(file,'utf8'),'one\ntwo');
    assert.equal((await fs.stat(file)).mode & 0o777,0o600);
    assert.equal(load[2],paste[paste.indexOf('-b')+1]);
  };
  await f.adapter.sendText({target:f.target,connection:f.connection,text:'one\ntwo'});
  assert.deepEqual(f.calls.map(c=>c[0]),['validate','batch','delete-buffer']);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('changed target refuses load and paste and still cleans temporary data',async () => {
  const f=fixture();f.connection.commandBatch=async()=>assert.fail('No batch after failed validation');
  f.dependencies.revalidateSessionTarget=async()=>{throw error('RUNID_MISMATCH');};
  await assert.rejects(f.adapter.sendText({target:f.target,connection:f.connection,text:'hello'}),{code:'RUNID_MISMATCH'});
  assert.equal(f.calls.some(c=>c[0]==='load-buffer'||c[0]==='paste-buffer'),false);
});
test('keystroke options and command syntax are rejected before any target I/O',async()=>{
  for(const key of ['-l','-R',';','Enter;run-shell','C-c\n','']){
    const f=fixture();await assert.rejects(f.adapter.sendKeys({target:f.target,connection:f.connection,keys:[key]}));
    assert.deepEqual(f.calls,[]);
  }
  const f=fixture();await f.adapter.sendKeys({target:f.target,connection:f.connection,keys:['Escape','Enter','C-c','M-x','F1']});
  assert.deepEqual(f.calls,[['validate'],['send-keys','-t','%8','Escape','Enter','C-c','M-x','F1']]);
});
test('default argv omits model and effort and both runtimes attach per-process MCP',()=> {
  for(const runtime of ['claude','codex']) {
    const args=buildRuntimeArgs(runtime,{runtime,mode:'default'},{root:'/isolated root'});
    assert.equal(args.includes('--model'),false);
    assert.equal(args.some(x=>x.includes('model_reasoning_effort')),false);
    assert.match(args.join(' '),/memory-mcp-server/);
  }
});
test('override preserves model as independent argv and rejects unsupported capability',()=> {
  const config={runtime:'claude',mode:'override',model:'model name',effort:'high'};
  assert.throws(()=>validateLaunchConfig('claude',config,''),{code:'MODEL_CONFIG_REJECTED'});
  validateLaunchConfig('claude',config,' --model MODEL --effort EFFORT ');
  const args=buildRuntimeArgs('claude',config,{root:'/tmp'});
  assert.equal(args[args.indexOf('--model')+1],'model name');
});
test('launch script is private, execs runtime, and omits group in single',async()=> {
  const s=writeSessionLaunchScript({command:'/fake',args:['a b'],env:{HOME:'/private'},root:'/tmp',multi:false});
  try { const content=await fs.readFile(s.file,'utf8'); assert.match(content,/exec env -i/); assert.equal(content.includes('ZYLOS_SESSION_GROUP'),false); assert.equal((await fs.stat(s.file)).mode & 0o777,0o600); } finally {s.cleanup();}
});
test('auth checks use injected home/environment/executor without production auth',async()=> {
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'p02-auth-')); const env={HOME:home,PATH:'/empty',CODEX_HOME:path.join(home,'codex')};
  try {
    const claude=new ClaudeAdapter({root:home,env,execFile:async (_,__,options)=>{assert.equal(options.env.HOME,home);return {stdout:'ok'};}});
    assert.equal((await claude.checkAuth()).status,'success');
    const codex=new CodexAdapter({env,execFile:async (_,__,options)=>{assert.equal(options.env,env);return {stderr:'Not logged in'};}});
    assert.equal((await codex.checkAuth()).status,'failure');
  } finally {await fs.rm(home,{recursive:true,force:true});}
});
test('launch rejects conflicts before binary/config, then missing binary before config',async()=> {
  const f=fixture(); f.adapter.options.paths={tmuxNameForGroup:()=> 'isolated'};
  let lookedUp=false;
  f.adapter.options.runtimeExecutable=()=>{lookedUp=true;throw error('RUNTIME_NOT_INSTALLED');};
  const input={sessionGroup:null,runId:'r',sessionMode:'single',launchConfig:null};
  await assert.rejects(f.adapter.launch(input),{code:'NAME_CONFLICT'});
  assert.equal(lookedUp,false);
  f.target.present=false;
  await assert.rejects(f.adapter.launch(input),{code:'RUNTIME_NOT_INSTALLED'});
  f.adapter.options.runtimeExecutable=()=>'/fake';
  await assert.rejects(f.adapter.launch(input),{code:'MODEL_CONFIG_REJECTED'});
  assert.equal(f.calls.some(c=>c[0]==='new-session'),false);
});
test('unreadable executable identity fails preflight before creation',async()=> {
  const f=fixture({present:false});f.adapter.options.paths={tmuxNameForGroup:()=> 'isolated'};
  f.adapter.options.runtimeExecutable=()=>'/fake';
  await assert.rejects(f.adapter.launch({sessionGroup:null,runId:'r',sessionMode:'single',launchConfig:{runtime:'claude',mode:'default'}}),{code:'LAUNCH_FAILED'});
  assert.equal(f.calls.some(c=>c[0]==='new-session'),false);
});

test('historical null-run target can close after normal identity revalidation',async () => {
  const f=fixture({runId:null});await f.adapter.stop({tmuxName:'legacy',expectedRunId:null});
  assert.deepEqual(f.calls.slice(0,2),[['validate'],['kill-session','-t','$7']]);
});
// Internal reader evidence keeps a readable shell-only tree distinct from failure.
test('readable runtime absence is false; unreadable and ambiguous remain unavailable', async () => {
  for (const runtimeObservation of ['absent', 'unavailable', 'ambiguous', undefined]) {
    const f = fixture({runtime:'unknown'});
    f.dependencies.readTargetRuntime = async () => ({runtime:'unknown', runtimeObservation});
    if (runtimeObservation === 'absent') assert.deepEqual(await f.adapter.isRunning({tmuxName:'x'}), {tmux:true,process:false});
    else await assert.rejects(f.adapter.isRunning({tmuxName:'x'}), {code:'TMUX_UNAVAILABLE'});
  }
});
test('a kill command error cannot be replaced by later absence',async () => {
  const f=fixture();f.connection.command=async()=>{throw error('TMUX_COMMAND_FAILED','error')};
  await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED',cause:'error'});
});
