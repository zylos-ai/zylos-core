import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const bootstrap=fileURLToPath(new URL('../../../test/helpers/public-reader-bootstrap.js',import.meta.url));
const driver=fileURLToPath(new URL('../../../test/helpers/public-reader-driver.js',import.meta.url));
async function fixture(t,{server=true}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'p02-public-reader-'));
  const socket=path.join(dir,'private.sock');
  const env={...process.env,TMUX_TMPDIR:dir,TMUX:`${socket},0,0`,ZYLOS_DIR:dir};
  const tmux=(...args)=>execFileSync('tmux',['-S',socket,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],env}).trim();
  if(server) tmux('-f','/dev/null','new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=r1','-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}','sleep','120');
  t.after(async()=>{if(server) try{tmux('kill-server');}catch{} await fs.rm(dir,{recursive:true,force:true});});
  const run=path.join(dir,'activity-monitor','session-groups','origin'); await fs.mkdir(run,{recursive:true});
  const write=(name,value)=>fs.writeFile(path.join(run,name),JSON.stringify(value));
  const call=(method,args,extra={})=>JSON.parse(execFileSync(process.execPath,['--import',bootstrap,driver],{encoding:'utf8',timeout:20000,env:{...env,...extra,P02_READER_CALL:JSON.stringify({method,args})}}));
  return {dir,env,call,write,tmux};
}
test('public worker returns synchronous live identity and valid real F2/F3/status/usage',async t=>{
  const {call,write}=await fixture(t);
  await write('current-session.json',{runId:'r1',sessionId:'s1',ts:Date.now(),startupControlIds:[]});
  await write('agent-status.json',{runId:'r1',sessionId:'s1',state:'idle'});
  await write('statusline.json',{session_id:'s1',zylos:{v:1,runId:'r1',capturedAt:Date.now()},context_window:{used_percentage:20}});
  const live=call('readLiveIdentity',[null]);
  assert.equal(live.promise,false); assert.equal(live.value.ready,true); assert.equal(live.value.runtime,'claude'); assert.equal(live.value.sessionId,'s1');
  const state=call('readSessionState',[null,{freshnessMs:60000}]);
  assert.equal(state.promise,false); assert.equal(state.value.status.valid,true); assert.equal(state.value.status.value.state,'idle'); assert.equal(state.value.usage.valid,true);
  assert.deepEqual(call('resolveTargetRuntime',[null]),{value:'claude',promise:false});
});
test('public no-server observation is absent and status not_running without server creation',async t=>{
  const {call,dir}=await fixture(t,{server:false});
  const live=call('readLiveIdentity',[null]); assert.equal(live.promise,false); assert.equal(live.value.present,false);
  const state=call('readSessionState',[null,{freshnessMs:5000}]); assert.equal(state.value.status.reason,'not_running');
  assert.equal(state.value.usage.reason,'not_running');
  assert.equal((await fs.readdir(dir)).some(name=>name.startsWith('tmux-')),false);
  // The explicit parser-only fixture has no resolver; the real provider fails
  // closed while its strict F1 reader has not been connected.
  assert.equal(call('resolveTargetRuntime',[null]).error.code,
    process.env.P02_PARSER_FIXTURE === '1' ? 'DEPENDENCY_UNAVAILABLE' : 'CONFIG_UNREADABLE');
});
test('public errors cross worker boundary without promises',async t=>{
  const {call}=await fixture(t,{server:false});
  assert.match(call('readSessionState',[null,{freshnessMs:-1}]).error.message,/freshnessMs/);
  const unavailable=call('readLiveIdentity',[null],{PATH:'/p02-no-binaries'});
  assert.equal(unavailable.error.code,'TMUX_UNAVAILABLE');
  assert.equal(unavailable.error.cause,'error');
});
