import { launchSession } from '../launch-flow.js';
import { createSessionOps } from '../session-ops.js';
import { checkAuth as claudeCheckAuth } from '../claude/auth.js';
import { checkAuth as codexCheckAuth } from '../codex/auth.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { buildRuntimeArgs, validateLaunchConfig, writeSessionLaunchScript, runtimeHelpAsync } from '../session-command.js';

function fixture({present = true, runId = 'r', openError, runtime = 'claude'} = {}) {
  const calls = [], target = {present, runId, runtime, tmuxSessionId:'$7', paneId:'%8'};
  const connection = {cleanupBuffer:async name => calls.push(['delete-buffer','-b',name]), close:() => calls.push(['close']), command:async argv => { calls.push(argv); if (argv[0] === 'kill-session') target.present = false; if (argv[0] === 'display-message') {if(!target.present)throw error('TARGET_GONE');return '$7';} return 'screen'; }};
  const dependencies = {
    openTmuxConnection:async () => { if (openError) throw openError; return connection; },
    observeSessionTarget:async () => target,
    revalidateSessionTarget:async () => { calls.push(['validate']); },
    readTargetRuntime:async () => { throw Error('isRunning must use pane observation'); },
  };
  const options = { dependencies };
  const adapter = createSessionOps(options);
  return {adapter, options, dependencies, target, connection, calls};
}
const error = (code,cause) => Object.assign(new Error(code),{code,cause});

test('absence only: no server is false; timeout remains unavailable',async () => {
  assert.deepEqual(await fixture({openError:error('TMUX_NO_SERVER')}).adapter.isRunning({tmuxName:'x'}),{tmux:false,process:false});
  await assert.rejects(fixture({openError:error('TMUX_UNAVAILABLE','timeout')}).adapter.isRunning({tmuxName:'x'}),{code:'TMUX_UNAVAILABLE',cause:'timeout'});
});
test('pane liveness remains available when runtime identity is unknown',async () => {
  assert.deepEqual(await fixture({runtime:'unknown'}).adapter.isRunning({tmuxName:'x'}),{tmux:true,process:true});
});
for (const bracketedPaste of [false, true]) test(`multiline text preserves bracketed paste=${bracketedPaste} in one guarded batch`,async () => {
  const f=fixture(); let file;
  f.connection.commandBatch=async commands=> {
    f.calls.push(['batch',commands]);
    assert.deepEqual(commands.map(c=>c[0]),['load-buffer','paste-buffer']);
    const load=commands[0],paste=commands[1];file=load[3];
    assert.equal(paste.includes('-p'), bracketedPaste);
    assert.equal(await fs.readFile(file,'utf8'),'one\ntwo');
    assert.equal((await fs.stat(file)).mode & 0o777,0o600);
    assert.equal(load[2],paste[paste.indexOf('-b')+1]);
  };
  await f.adapter.sendText({ runtime: 'claude', target:f.target,connection:f.connection,text:'one\ntwo',bracketedPaste});
  assert.deepEqual(f.calls.map(c=>c[0]),['validate','batch','delete-buffer']);
  await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('changed target refuses load and paste and still cleans temporary data',async () => {
  const f=fixture();f.connection.commandBatch=async()=>assert.fail('No batch after failed validation');
  f.dependencies.revalidateSessionTarget=async()=>{throw error('RUNID_MISMATCH');};
  await assert.rejects(f.adapter.sendText({ runtime: 'claude', target:f.target,connection:f.connection,text:'hello'}),{code:'RUNID_MISMATCH'});
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
for (const bypassPermissions of [true, false]) {
  for (const mode of ['default', 'override']) {
    test(`Claude disables interactive tools with bypassPermissions=${bypassPermissions} and ${mode} model`, () => {
      const config = { runtime: 'claude', mode, ...(mode === 'override' ? { model: 'model name', effort: 'high' } : {}) };
      const args = buildRuntimeArgs('claude', config, { root: '/isolated root', bypassPermissions });
      assert.deepEqual(args.filter(arg => arg.startsWith('--disallowedTools')),
        ['--disallowedTools=AskUserQuestion,EnterPlanMode,ExitPlanMode,Artifact,ReportFindings,Workflow']);
      assert.equal(args.includes('--disallowedTools'), false);
      assert.equal(args.includes('--dangerously-skip-permissions'), bypassPermissions);
      const codexArgs = buildRuntimeArgs('codex', { ...config, runtime: 'codex' },
        { root: '/isolated root', bypassPermissions });
      assert.equal(codexArgs.some(arg => arg.startsWith('--disallowedTools')), false);
    });
    test(`Codex disables interactive tools with bypassPermissions=${bypassPermissions} and ${mode} model`, () => {
      const settings = ['tools.experimental_request_user_input.enabled=false', 'features.goals=false', 'features.apps=false'];
      const config = { runtime: 'codex', mode, ...(mode === 'override' ? { model: 'model name', effort: 'high' } : {}) };
      const args = buildRuntimeArgs('codex', config, { root: '/isolated root', bypassPermissions });
      for (const setting of settings) {
        assert.equal(args.filter(arg => arg === setting).length, 1);
        const index = args.indexOf(setting);
        assert.equal(args[index - 1], '-c');
        assert.ok(index < args.length - 1);
      }
      assert.match(args.at(-1), /System startup trigger/);
      assert.equal(args.includes('--dangerously-bypass-approvals-and-sandbox'), bypassPermissions);
      for (const runtime of ['claude', 'agy']) {
        if (runtime === 'agy' && mode === 'override') continue;
        const otherArgs = buildRuntimeArgs(runtime, { ...config, runtime }, { root: '/isolated root', bypassPermissions });
        assert.equal(settings.some(setting => otherArgs.includes(setting)), false);
        assert.equal(otherArgs.includes('-c'), false);
      }
    });
  }
}
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
  const home=await fs.mkdtemp(path.join(os.tmpdir(),'session-runtime-auth-')); const env={HOME:home,PATH:'/empty',CODEX_HOME:path.join(home,'codex')};
  try {
    const claudeOptions = {root:home,env,execFile:async (_,__,options)=>{assert.equal(options.env.HOME,home);return {stdout:'ok'};}};
    assert.equal((await claudeCheckAuth(claudeOptions)).status,'success');
    const codexOptions = {env,execFile:async (_,__,options)=>{assert.equal(options.env,env);return {stderr:'Not logged in'};}};
    assert.equal((await codexCheckAuth(codexOptions)).status,'failure');
  } finally {await fs.rm(home,{recursive:true,force:true});}
});
test('launch rejects conflicts before binary/config, then missing binary before config',async()=> {
  const f=fixture(); f.options.paths={tmuxNameForGroup:()=> 'isolated'};
  let lookedUp=false;
  f.options.runtimeExecutable=()=>{lookedUp=true;throw error('RUNTIME_NOT_INSTALLED');};
  const input={sessionGroup:null,runId:'r',sessionMode:'single',launchConfig:null};
  await assert.rejects(launchSession({ runtime: 'claude', ...input }, f.options),{code:'NAME_CONFLICT'});
  assert.equal(lookedUp,false);
  f.target.present=false;
  await assert.rejects(launchSession({ runtime: 'claude', ...input }, f.options),{code:'RUNTIME_NOT_INSTALLED'});
  f.options.runtimeExecutable=()=>'/fake';
  await assert.rejects(launchSession({ runtime: 'claude', ...input }, f.options),{code:'MODEL_CONFIG_REJECTED'});
  assert.equal(f.calls.some(c=>c[0]==='new-session'),false);
});
test('launch preflight failures retain sanitized timing and close the executor',async()=>{
  const f=fixture({present:false});
  f.options.paths={tmuxNameForGroup:()=> 'isolated'};
  f.dependencies.observeSessionTarget=async()=>{
    await new Promise(resolve=>setTimeout(resolve,20));
    throw new Error('private preflight detail');
  };
  await assert.rejects(launchSession({ runtime: 'claude', sessionGroup:null,runId:'r',sessionMode:'single',
    launchConfig:{runtime:'claude',mode:'default'}}, f.options),error=>{
    assert.equal(error.code,'LAUNCH_FAILED');
    const timing=error.launchTiming;
    assert.equal(timing.last_phase,'preflight');
    assert.equal(timing.timeout_ms,10000);
    assert.ok(timing.total_ms>=15);
    assert.equal(timing.preflight_ms,timing.total_ms);
    for(const key of ['new_session_ms','executor_init_ms','exec_confirm_ms','cleanup_ms'])assert.equal(timing[key],0);
    assert.equal(JSON.stringify(timing).includes('private'),false);
    return true;
  });
  assert.deepEqual(f.calls,[['close']]);
});
test('launch preflight commands receive the shared remaining deadline',async()=> {
  const f=fixture({present:false});
  f.options.paths={tmuxNameForGroup:()=> 'isolated'};
  f.options.runtimeExecutable=()=>{throw error('RUNTIME_NOT_INSTALLED');};
  f.dependencies.openTmuxConnection=async options=>{
    assert.ok(options.timeoutMs>9000 && options.timeoutMs<=10000);
    return f.connection;
  };
  f.connection.command=async (argv,options)=>{
    assert.ok(options.timeoutMs>9000 && options.timeoutMs<=10000);
    return '';
  };
  f.dependencies.observeSessionTarget=async ({connection})=>{
    await connection.command(['list-sessions']);
    return f.target;
  };
  await assert.rejects(launchSession({ runtime: 'claude', sessionGroup:null,runId:'r',sessionMode:'single',
    launchConfig:{runtime:'claude',mode:'default'}}, f.options),{code:'RUNTIME_NOT_INSTALLED'});
});
test('unreadable executable identity fails preflight before creation',async()=> {
  const f=fixture({present:false});f.options.paths={tmuxNameForGroup:()=> 'isolated'};
  f.options.runtimeExecutable=()=>'/fake';
  await assert.rejects(launchSession({ runtime: 'claude', sessionGroup:null,runId:'r',sessionMode:'single',launchConfig:{runtime:'claude',mode:'default'}}, f.options),{code:'LAUNCH_FAILED'});
  assert.equal(f.calls.some(c=>c[0]==='new-session'),false);
});

// A managed session is present until its runtime-owned pane exits.
test('isRunning projects session presence without another process read', async () => {
  for (const runtime of ['claude', 'codex', 'unknown']) {
    const f = fixture({runtime});
    assert.deepEqual(await f.adapter.isRunning({tmuxName:'x'}), {tmux:true, process:true});
    assert.deepEqual(f.calls, [['close']]);
  }
  const absent = fixture({present:false});
  assert.deepEqual(await absent.adapter.isRunning({tmuxName:'x'}), {tmux:false, process:false});
  assert.deepEqual(absent.calls, [['close']]);
});
test('isRunning reports deterministic disappearance during observation as false',async()=>{
  const f=fixture();f.dependencies.observeSessionTarget=async()=>{throw error('TARGET_GONE')};
  assert.deepEqual(await f.adapter.isRunning({tmuxName:'x'}),{tmux:false,process:false});
  assert.deepEqual(f.calls,[['close']]);
});
test('isRunning cannot infer absence when the server generation changes',async()=>{
  const f=fixture();f.dependencies.observeSessionTarget=async()=>{throw error('GENERATION_CHANGED')};
  await assert.rejects(f.adapter.isRunning({tmuxName:'x'}),{code:'TMUX_UNAVAILABLE',cause:'error'});
  assert.deepEqual(f.calls,[['close']]);
});

test('runtime help leaves the event loop available and maps execution errors',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-runtime-help-'));
  const command=path.join(root,'runtime');
  try {
    await fs.writeFile(command,'#!/bin/sh\nsleep 0.2\nprintf " --model MODEL --effort EFFORT "\n',{mode:0o700});
    let ticked=false;
    const timer=setTimeout(()=>{ticked=true;},10);
    try {
      assert.match(await runtimeHelpAsync(command),/--model/);
      assert.equal(ticked,true);
    } finally {clearTimeout(timer);}
    await assert.rejects(runtimeHelpAsync(path.join(root,'missing')),{code:'LAUNCH_FAILED',cause:'error'});
  } finally {await fs.rm(root,{recursive:true,force:true});}
});

test('runtime capability query honors the remaining launch timeout',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-runtime-help-timeout-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const command=path.join(root,'runtime');
  await fs.writeFile(command,`#!${process.execPath}\nsetTimeout(()=>console.log('--model MODEL'),2000);\n`,{mode:0o700});
  const startedAt=performance.now();
  await assert.rejects(runtimeHelpAsync(command,process.env,{timeoutMs:100}),{code:'LAUNCH_FAILED',cause:'timeout'});
  assert.ok(performance.now()-startedAt<1000);
});

test('launch awaits runtime help and classifies invalid launch arguments as a launch failure',async()=>{
  const f=fixture({present:false});
  f.options.paths={tmuxNameForGroup:()=> 'isolated'};
  f.options.runtimeExecutable=()=>'/fake';
  let queried=false, helpOptions;
  f.options.runtimeHelp=async(_command,_env,options)=>{
    helpOptions=options;
    await new Promise(resolve=>setImmediate(resolve));
    queried=true;
    return ' --model MODEL --effort EFFORT ';
  };
  const launchConfig={runtime:'claude',mode:'override',model:'test',effort:'high'};
  for(const input of [
    {sessionGroup:null,runId:'',sessionMode:'single'},
    {sessionGroup:null,runId:'r',sessionMode:'invalid'},
    {sessionGroup:'group',runId:'r',sessionMode:'single'},
  ]){
    queried=false; helpOptions=undefined;
    await assert.rejects(launchSession({ runtime: 'claude', ...input,launchConfig}, f.options),{code:'LAUNCH_FAILED',cause:'error'});
    assert.equal(queried,true);
    assert.ok(Number.isInteger(helpOptions?.timeoutMs) && helpOptions.timeoutMs > 0 && helpOptions.timeoutMs <= 10000);
  }
  f.options.runtimeHelp=()=>'';
  await assert.rejects(launchSession({ runtime: 'claude', sessionGroup:null,runId:'r',sessionMode:'single',launchConfig}, f.options),{code:'MODEL_CONFIG_REJECTED'});
  assert.equal(f.calls.some(c=>c[0]==='new-session'),false);
});

test('stop cannot infer session absence from a pane-level observation failure',async()=>{
  const f=fixture();
  f.dependencies.observeSessionTarget=async()=>{throw error('TARGET_GONE')};
  await assert.rejects(f.adapter.stop({tmuxName:'x',expectedRunId:'r'}),{code:'STOP_UNCONFIRMED'});
  assert.deepEqual(f.calls,[['close']]);
});
