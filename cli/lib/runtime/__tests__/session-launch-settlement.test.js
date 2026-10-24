import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { LAUNCH_TIMEOUT_MS, LAUNCH_CLEANUP_TIMEOUT_MS } from '../session-launch.js';
import { setupLaunch, delay, binary, assertGone } from './launch-tmux-fixture.js';
const bound = LAUNCH_TIMEOUT_MS + LAUNCH_CLEANUP_TIMEOUT_MS;

test('shell wrapper execs runtime and settles within the confirmation budget', async t => {
  const f = await setupLaunch(t);
  const wrapper = path.join(f.dir, 'runtime-wrapper');
  await fs.writeFile(wrapper, '#!/bin/sh\nexec /bin/sleep 30\n', {mode:0o700});
  const client = await f.clientWrapper();
  const start = performance.now();
  const result = await f.launch({command:wrapper, args:[], tmuxBinary:client.file});
  const elapsed = performance.now()-start;
  assert.equal(result.tmuxName, 'target');
  assert.ok(elapsed < LAUNCH_TIMEOUT_MS);
  assert.equal(f.tmux('list-panes', '-t', '=target', '-F', '#{pane_current_command}').trim(), 'sleep');
  assertGone(assert, Number(await fs.readFile(client.pidFile, 'utf8')));
  t.diagnostic(JSON.stringify({wrapperSuccessMs:Math.round(elapsed)}));
});

test('server stopped before submission: bounded failure, natural caller exit and no client left', {timeout:10000}, async t => {
  const f = await setupLaunch(t);
  const wrapper = await f.clientWrapper();
  process.kill(f.server, 'SIGSTOP');
  const program = `import {settleLaunch} from ${JSON.stringify(new URL('../session-launch.js',import.meta.url).href)};
import {writeSessionLaunchScript} from ${JSON.stringify(new URL('../session-command.js',import.meta.url).href)};
const script=writeSessionLaunchScript({command:'/bin/sleep',args:['30'],env:{PATH:process.env.PATH},root:${JSON.stringify(f.dir)},multi:false});
const start=performance.now();
try { await settleLaunch({tmuxName:'target',runId:'frozen-run',launchConfig:{runtime:'claude',mode:'default'},sessionGroup:null,root:${JSON.stringify(f.dir)},script,tmux:{binary:${JSON.stringify(wrapper.file)},socketPath:${JSON.stringify(f.socketPath)},configFile:'/dev/null'}}); process.exitCode=1; }
catch(error) { console.log(JSON.stringify({code:error.code,elapsed:performance.now()-start})); if(error.code!=='LAUNCH_FAILED') process.exitCode=2; }`;
  const child = spawn(process.execPath, ['--input-type=module','-e',program], {stdio:['ignore','pipe','pipe']});
  let stdout='',stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d);
  t.after(()=>{ if(child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); });
  const exited = new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  let watchdog;
  const result = await Promise.race([exited, new Promise((_,reject)=>{watchdog=setTimeout(()=>reject(new Error('caller retained timer, client, or stdio')),bound+2000);})]).finally(()=>clearTimeout(watchdog));
  assert.deepEqual(result,{code:0,signal:null},stderr);
  const report=JSON.parse(stdout.trim());
  assert.equal(report.code,'LAUNCH_FAILED');
  assert.ok(report.elapsed>=LAUNCH_TIMEOUT_MS-100);
  assert.ok(report.elapsed<bound+1000);
  assertGone(assert,Number(await fs.readFile(wrapper.pidFile,'utf8')));
  // The caller has exited while the server is still stopped: no resumed server
  // or test teardown is responsible for releasing its streams/child/timers.
  f.killFrozenServer();
  await delay(50);
  t.diagnostic(JSON.stringify({...report,naturalCallerExit:true,clientGone:true,serverKilledAfterExit:true}));
});

test('immediate runtime exit fails and removes its retained dead session', async t => {
  const f=await setupLaunch(t);
  f.tmux('set-option','-g','remain-on-exit','on');
  const wrapper=await f.clientWrapper();
  await assert.rejects(f.launch({command:'/bin/false',args:[],tmuxBinary:wrapper.file}),{code:'LAUNCH_FAILED'});
  assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'keeper');
  assertGone(assert,Number(await fs.readFile(wrapper.pidFile,'utf8')));
});

test('known session still in launch shell times out and is killed before rejection', {timeout:8000}, async t => {
  const f=await setupLaunch(t);
  const held=path.join(f.dir,'held-shell');
  await fs.writeFile(held,'#!/bin/sh\nwhile :; do :; done\n',{mode:0o700});
  const wrapper=await f.clientWrapper();
  const start=performance.now();
  await assert.rejects(f.launch({command:held,args:[],tmuxBinary:wrapper.file}),{code:'LAUNCH_FAILED'});
  const elapsed=performance.now()-start;
  assert.ok(elapsed>=LAUNCH_TIMEOUT_MS-100);
  assert.ok(elapsed<bound+1000);
  assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'keeper','timeout must kill the created session, not just reject a Promise.race');
  assertGone(assert,Number(await fs.readFile(wrapper.pidFile,'utf8')));
  t.diagnostic(JSON.stringify({knownSessionTimeoutMs:Math.round(elapsed),sessionKilled:true,clientGone:true}));
});

test('duplicate session is NAME_CONFLICT and retains the original pane', async t => {
  const f=await setupLaunch(t);
  const original=f.tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim();
  await assert.rejects(f.launch({tmuxName:'keeper'}),{code:'NAME_CONFLICT'});
  assert.equal(f.tmux('list-panes','-t','=keeper','-F','#{pane_id}:#{pane_pid}').trim(),original);
});

for(const mode of ['default','override']) test(`adapter ${mode} consumes real A/P01 paths and runtime self-report`,async t=>{
  const f=await setupLaunch(t);
  const paths=await import('../../session-group-paths.js');
  const {SessionAdapter}=await import('../session-adapter.js');
  class Adapter extends SessionAdapter {get runtimeId(){return 'claude';}}
  const command=path.join(f.dir,'runtime'),report=path.join(f.dir,'runtime.json');
  await fs.writeFile(command,`#!${process.execPath}\nconst fs=require('node:fs');if(process.argv.includes('--help'))console.log(' --model MODEL --effort EFFORT ');else if(process.argv[2]==='auth')console.log('{"loggedIn":false}');else{fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({argv:process.argv,env:process.env,cwd:process.cwd()}));setInterval(()=>{},1000);}\n`,{mode:0o700});
  const adapter=new Adapter({root:f.dir,env:{PATH:process.env.PATH,HOME:f.dir,CLAUDE_BIN:command},tmux:{binary,socketPath:f.socketPath,configFile:'/dev/null'}});
  const launchConfig={runtime:'claude',mode,...(mode==='override'?{model:'model with spaces',effort:'high'}:{})};
  const group=mode==='default'?null:'telegram:g-123';
  const input={sessionGroup:group,runId:'real-adapter-run',sessionMode:group?'multi':'single',launchConfig};
  const result=await adapter.launch(input);
  assert.equal(result.tmuxName,paths.tmuxNameForGroup(group || 'origin'));
  for(let i=0;i<100;i++){try{await fs.access(report);break;}catch{}await delay(10);}
  const observed=JSON.parse(await fs.readFile(report,'utf8'));
  assert.equal(observed.cwd,await fs.realpath(f.dir));
  assert.equal(observed.env.ZYLOS_RUN_ID,input.runId);
  assert.equal(observed.env.ZYLOS_SESSION_GROUP,group ?? undefined);
  assert.equal(observed.env.ZYLOS_MODEL_CONFIG,JSON.stringify(launchConfig));
  if(mode==='override')assert.equal(observed.argv[observed.argv.indexOf('--model')+1],'model with spaces');
  else assert.equal(observed.argv.includes('--model'),false);
  await assert.rejects(adapter.launch(input),{code:'NAME_CONFLICT'});
});

test('missing tmux executable fails without retaining the launch script or child',async t=>{
  const f=await setupLaunch(t);
  await assert.rejects(f.launch({tmuxBinary:path.join(f.dir,'missing-tmux')}),{code:'LAUNCH_FAILED'});
  assert.equal(f.tmux('list-sessions','-F','#{session_name}').trim(),'keeper');
});
