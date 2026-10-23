// Opt-in real CLI stop smoke. Run only in a fresh private PID/network namespace
// with a sanitized environment, temporary HOME/config roots and explicit paths.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {getSessionAdapter} from '../../../cli/lib/runtime/index.js';
import {readProcessImage} from '../../../cli/lib/runtime/session-process-observation.js';
import {shellQuote} from '../../../cli/lib/runtime/session-command.js';
import {fixture,service,until,actualDependencies} from '../../../cli/lib/runtime/__tests__/stop-tmux-fixture.js';

assert.equal(process.pid,1,'requires a new private PID namespace');
assert.match(await fs.readFile('/proc/self/status','utf8'),/^NSpid:\s+1$/m);
assert.ok(process.env.P02_STOP_HOST_NETNS);
assert.notEqual(await fs.readlink('/proc/self/ns/net'),process.env.P02_STOP_HOST_NETNS,'requires a private network namespace');
assert.ok(process.env.HOME.startsWith('/tmp/'),'requires temporary HOME');
assert.match(process.env.LC_ALL || process.env.LANG || '',/UTF-?8/i,'requires an explicit UTF-8 tmux locale');
for(const key of ['ANTHROPIC_API_KEY','CLAUDE_CODE_OAUTH_TOKEN','OPENAI_API_KEY','COCO_API_KEY'])assert.equal(process.env[key],undefined);
const results=[];
const runtimes=process.env.P02_STOP_RUNTIME ? [process.env.P02_STOP_RUNTIME] : ['claude','codex'];
assert.ok(runtimes.every(runtime=>['claude','codex'].includes(runtime)));
for(const runtime of runtimes){
 const cleanups=[];const f=await fixture({after:fn=>cleanups.push(fn)});
 const trace=[];let version;
 try {
  const command=process.env[`P02_${runtime.toUpperCase()}_CLI`];assert.ok(path.isAbsolute(command || ''),`missing explicit ${runtime} CLI`);
  version=execFileSync(command,['--version'],{encoding:'utf8',timeout:10000,stdio:['ignore','pipe','pipe']}).trim();
  const key=`native-stop-${runtime}`,independent=await service(f,key);
  const env={HOME:f.dir,CLAUDE_CONFIG_DIR:path.join(f.dir,'claude'),CODEX_HOME:path.join(f.dir,'codex'),
   XDG_CONFIG_HOME:path.join(f.dir,'config'),PATH:process.env.PATH,TERM:'xterm-256color',
   LANG:process.env.LANG,LC_ALL:process.env.LC_ALL || process.env.LANG,ZYLOS_RUN_ID:key};
  for(const name of ['CLAUDE_CONFIG_DIR','CODEX_HOME','XDG_CONFIG_HOME'])await fs.mkdir(env[name],{recursive:true});
  const program=`exec env -i ${Object.entries(env).map(([k,v])=>shellQuote(`${k}=${v}`)).join(' ')} ${shellQuote(command)}`;
  f.command('new-session','-d','-s','target','-c',f.dir,'-e',`ZYLOS_RUN_ID=${key}`,
   '-e',`ZYLOS_MODEL_CONFIG=${JSON.stringify({runtime,mode:'default'})}`,'sleep 60');
  f.command('set-window-option','-t','=target:','remain-on-exit','on');
  f.command('respawn-pane','-k','-t','=target:',program);
  const panePid=Number(f.command('display-message','-p','-t','=target:','#{pane_pid}'));
  const realCommand=await fs.realpath(command);
  const image=await until(()=>readProcessImage(panePid),value=>!value.uncertain&&!value.gone&&
   (value.exe===realCommand || value.argv.some(arg=>arg===command || arg===realCommand)));
  // This smoke stops the real interactive CLI during startup. Do not wait for
  // authentication/network setup in an intentionally offline empty config.
  // It is not an authenticated or stabilized model-session stop test.
  assert.equal((await readProcessImage(panePid)).start,image.start);
  assert.equal(f.command('list-sessions','-F','#{session_name}'),'origin\ntarget');
  const dependencies={...actualDependencies};
  for(const name of ['openTmuxConnection','observeSessionTarget','revalidateSessionTarget']){
   dependencies[name]=async(...args)=>{try{
    const value=await actualDependencies[name](...args);
    if(name==='openTmuxConnection'){
     const command=value.command;
     value.command=async argv=>{try{
      const output=await command(argv);
      if(argv[0]==='display-message')trace.push({stage:argv[0],format:argv.at(-1),output});
      return output;
     }catch(error){trace.push({stage:argv[0],code:error.code,message:error.message});throw error}};
    }
    return value;
   }catch(error){trace.push({stage:name,code:error.code,message:error.message});throw error}};
  }
  const adapter=getSessionAdapter(runtime,{dependencies,tmux:f.adapter.options.tmux});
  await adapter.stop({tmuxName:'target',expectedRunId:key});
  assert.equal(f.command('list-sessions','-F','#{session_name}'),'origin');assert.equal(f.snapshot('origin'),f.origin);
  results.push({runtime,version,panePid,start:image.start,executable:path.basename(image.exe),
   actualCLIObserved:true,targetAbsent:true,stopReturned:true,originUnchanged:true,
   independentService:await independent.verify(),phase:'interactive CLI startup',authenticatedModelSession:false});
 }catch(error){
  let screen='';try{screen=f.command('capture-pane','-p','-t','=target:')}catch{}
  results.push({runtime,version,blocked:true,reason:error.message,screen,trace});
 }finally {for(const cleanup of cleanups)await cleanup()}
}
console.log(JSON.stringify({networkIsolated:true,temporaryConfig:true,credentialsSupplied:false,results}));
if(results.some(result=>result.blocked))process.exitCode=1;
