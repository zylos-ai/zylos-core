import {isolatedTmux,tmuxClientEnv} from '../../../test/helpers/isolated-tmux.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const driver=fileURLToPath(new URL('../../../test/helpers/public-reader-driver.js',import.meta.url));
async function fixture(t,{server=true}={}) {
  const f=isolatedTmux(t,{prefix:'session-runtime-public-reader-',socketName:'private.sock'});
  const {dir,tmux}=f;
  const env=tmuxClientEnv(f,{...process.env,ZYLOS_DIR:dir});
  if(server) tmux('-f','/dev/null','new-session','-d','-s','zylos-group-origin','-e','ZYLOS_RUN_ID=r1','-e','ZYLOS_MODEL_CONFIG={"runtime":"claude","mode":"default"}','sleep','120');
  const run=path.join(dir,'activity-monitor','session-groups','origin'); await fs.mkdir(run,{recursive:true});
  const write=(name,value)=>fs.writeFile(path.join(run,name),JSON.stringify(value));
  const call=(method,args,extra={})=>JSON.parse(execFileSync(process.execPath,[driver],{encoding:'utf8',timeout:20000,env:{...env,...extra,SESSION_READER_CALL:JSON.stringify({method,args})}}));
  return {dir,env,call,write,tmux};
}
test('public async reader returns live identity and valid real F2/F3/status/usage',async t=>{
  const {call,write}=await fixture(t);
  await write('current-session.json',{runId:'r1',sessionId:'s1',ts:Date.now(),startupControlIds:[]});
  await write('agent-status.json',{runId:'r1',sessionId:'s1',state:'idle'});
  await write('statusline.json',{session_id:'s1',zylos:{v:1,runId:'r1',capturedAt:Date.now()},context_window:{used_percentage:20}});
  const live=call('readLiveIdentity',[null]);
  assert.equal(live.promise,true); assert.equal(live.value.ready,true); assert.equal(live.value.runtime,'claude'); assert.equal(live.value.sessionId,'s1');
  const state=call('readSessionState',[null,{freshnessMs:60000}]);
  assert.equal(state.promise,true); assert.equal(state.value.status.valid,true); assert.equal(state.value.status.value.state,'idle'); assert.equal(state.value.usage.valid,true);
  assert.deepEqual(call('resolveTargetRuntime',[null]),{value:'claude',promise:true});
});
test('public no-server observation is absent and status not_running without server creation',async t=>{
  const {call,dir}=await fixture(t,{server:false});
  const live=call('readLiveIdentity',[null]); assert.equal(live.promise,true); assert.equal(live.value.present,false);
  const state=call('readSessionState',[null,{freshnessMs:5000}]); assert.equal(state.value.status.reason,'not_running');
  assert.equal(state.value.usage.reason,'not_running');
  assert.equal((await fs.readdir(dir)).some(name=>name.startsWith('tmux-')),false);
  // The connected provider resolves absent live targets from strict F1.
  assert.deepEqual(call('resolveTargetRuntime',[null]),{value:'claude',promise:true});
  await fs.mkdir(path.join(dir,'.zylos'),{recursive:true});
  await fs.writeFile(path.join(dir,'.zylos/config.json'),JSON.stringify({runtime:'codex'}));
  assert.deepEqual(call('resolveTargetRuntime',[null]),{value:'codex',promise:true});
  await fs.writeFile(path.join(dir,'.zylos/config.json'),'{broken');
  assert.equal(call('resolveTargetRuntime',[null]).error.code,'CONFIG_UNREADABLE');
});
test('public async reader rejects invalid options and unavailable tmux',async t=>{
  const {call}=await fixture(t,{server:false});
  assert.match(call('readSessionState',[null,{freshnessMs:-1}]).error.message,/freshnessMs/);
  const unavailable=call('readLiveIdentity',[null],{PATH:'/session-runtime-no-binaries'});
  assert.equal(unavailable.error.code,'TMUX_UNAVAILABLE');
  assert.equal(unavailable.error.cause,'error');
});
