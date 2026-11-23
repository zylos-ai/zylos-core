import { isolatedTmux } from '../../../../test/helpers/isolated-tmux.js';
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Set isolated roots before importing the real C4 database/config modules.
const root=await fs.mkdtemp(path.join(os.tmpdir(),'session-runtime-guard-'));
process.env.ZYLOS_DIR=root;process.env.HOME=root;
process.env.ZYLOS_PACKAGE_ROOT=fileURLToPath(new URL('../../../../',import.meta.url));
await fs.mkdir(path.join(root,'.zylos'));
await fs.writeFile(path.join(root,'.zylos/config.json'),JSON.stringify({runtime:'claude',session_mode:'multi'}));
const {openTmuxConnection}=await import('../tmux-connection.js');
const {resolveSessionTarget}=await import('../session-target.js');
const {createSessionOps}=await import('../session-ops.js');
const c4=await import('../../../../skills/comm-bridge/scripts/c4-db.js');
const db=c4.getDb();
assert.equal(db.name,path.join(root,'comm-bridge/c4.db'));
after(async()=>{db.close();await fs.rm(root,{recursive:true,force:true});});
const binary=process.env.TEST_TMUX_BIN||'tmux';
const actualBinary=execFileSync('sh',['-c','command -v "$1"','sh',binary],{encoding:'utf8'}).trim();
const delay=ms=>new Promise(r=>setTimeout(r,ms));

async function fixture(t){
  const {dir,socketPath,tmux}=isolatedTmux(t,{parentDir:root,prefix:'case-',tmuxArgs:['-u'],timeout:2000});
  tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 120');
  const input=path.join(dir,'received');
  tmux('new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=guard-run',
    '-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}','-e','ZYLOS_SESSION_GROUP=origin',
    `exec cat > '${input}'`);
  const readyDir=path.join(root,'activity-monitor/session-groups/origin');await fs.mkdir(readyDir,{recursive:true});
  await fs.writeFile(path.join(readyDir,'current-session.json'),JSON.stringify({runId:'guard-run',sessionId:'runtime-session',ts:1,startupControlIds:[]}));
  const flag=path.join(dir,'hang'),calls=path.join(dir,'calls'),wrapper=path.join(dir,'tmux-wrapper');
  await fs.writeFile(wrapper,`#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(a)+'\\n');if(fs.existsSync(${JSON.stringify(flag)})){setInterval(()=>{},1000);}else{const r=cp.spawnSync(${JSON.stringify(actualBinary)},a,{stdio:'inherit'});process.exit(r.status??1);}\n`,{mode:0o700});
  // The deadline includes a new Node process for every wrapper invocation.
  // Leave startup headroom under parallel runtime/stress load so these cases
  // exercise the deliberate hang rather than killing the wrapper before logging.
  const options={socketPath,binary:wrapper,timeoutMs:1000};
  return {dir,tmux,input,flag,calls,options};
}

test('marker-looking pane content and message syntax are data, not guard output or commands',async t=>{
  const f=await fixture(t),connection=await openTmuxConnection(f.options);t.after(()=>connection.close());
  const target=await resolveSessionTarget({sessionGroup:'origin',connection}),adapter=createSessionOps();
  const marker=path.join(f.dir,'must-not-exist');
  const payload=`ZYLOS_STALE 999:1 ; run-shell 'touch ${marker}' ; $HOME \\ end`;
  await adapter.sendText({ runtime: 'claude', connection,target,text:payload});await adapter.sendKeys({connection,target,keys:['Enter']});
  let received='';for(let i=0;i<50;i++){try{received=await fs.readFile(f.input,'utf8');}catch{}if(received.includes(payload))break;await delay(10);}
  assert.equal(received.trim(),payload);
  const screen=await adapter.captureScreen({connection,target});assert.match(screen,/ZYLOS_STALE 999:1/);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});
  const calls=(await fs.readFile(f.calls,'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.every(a=>a.includes('-N')&&!a.includes('-C')&&!a.includes('-CC')),'Every generated probe/guard argv must be an ordinary no-start client');
  assert.equal(calls.some(a=>a.some(arg=>arg.includes(payload))),false,'Message body must never enter a tmux command string');
});

test('replacing the bound server blocks old text and keys from the new pane',async t=>{
  const f=await fixture(t),connection=await openTmuxConnection(f.options);t.after(()=>connection.close());
  const target=await resolveSessionTarget({sessionGroup:'origin',connection}),adapter=createSessionOps();
  f.tmux('kill-server');await delay(50);
  f.tmux('-f','/dev/null','new-session','-d','-s','keeper','sleep 120');
  f.tmux('new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=guard-run',`exec cat > '${f.input}'`);
  for(const method of ['sendText','sendKeys'])await assert.rejects(adapter[method]({runtime:'claude',connection,target,text:'must-not-arrive',keys:['Enter']}),{code:'GENERATION_CHANGED'});
  await assert.rejects(connection.command(['send-keys','-t',target.paneId,'Enter']),{code:'GENERATION_CHANGED'});
  await delay(25);assert.equal(await fs.readFile(f.input,'utf8'),'');
  // Direct ordinary commands below are a deliberately unsafe test control.
  // Reused IDs demonstrate that the preceding zero-input assertion is useful.
  assert.equal(f.tmux('display-message','-p','-t','=zylos-group-origin:','#{pane_id}'),target.paneId);
  f.tmux('send-keys','-t',target.paneId,'unsafe-control','Enter');
  let received='';for(let i=0;i<50;i++){received=await fs.readFile(f.input,'utf8');if(received)break;await delay(10);}
  assert.equal(received,'unsafe-control\n');
});
