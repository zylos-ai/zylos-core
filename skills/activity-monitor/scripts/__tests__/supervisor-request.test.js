import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readyForConfigReclaim } from '../supervisor-request.js';

test('IB-41 CLI derives only own environment and refuses missing or invalid scope', async () => {
  for(const env of [{},{ZYLOS_SESSION_GROUP:'origin'},{ZYLOS_SESSION_GROUP:'../bad',ZYLOS_RUN_ID:'r'}]) {
    const result=await readyForConfigReclaim({env,send:()=>{throw new Error('must not send');}});
    assert.equal(result.error.code,'NO_SESSION_ENV');assert.deepEqual(result.error.persisted,[]);
  }
  let sent;
  const result=await readyForConfigReclaim({env:{ZYLOS_SESSION_GROUP:'telegram:a',ZYLOS_RUN_ID:'r'},send:async request=>{sent=request;return {kind:'accepted',sent:true,reply:{result:'unchanged'}};}});
  assert.equal(sent.sessionGroup,'telegram:a');assert.equal(sent.expectedRunId,'r');assert.equal(sent.type,'ready_for_config_reclaim');
  assert.deepEqual(result,{ok:true,data:{result:'unchanged',sessionGroup:'telegram:a',expectedRunId:'r'}});
});
test('IB-41 CLI reports unknown persistence for all connected U results without resubmission', async () => {
  const env={ZYLOS_SESSION_GROUP:'origin',ZYLOS_RUN_ID:'r'};
  for(const kind of ['no_reply','invalid_reply','timeout','deadline_exceeded']) {
    let calls=0;const result=await readyForConfigReclaim({env,send:async()=>{calls++;return {kind,sent:true};}});
    assert.equal(result.ok,false);assert.equal(result.error.persisted,null);assert.match(result.error.message,/unknown/);assert.equal(calls,1);
  }
  const connect=await readyForConfigReclaim({env,send:async()=>({kind:'connect_failed',sent:false})});assert.deepEqual(connect.error.persisted,[]);
  const reject=await readyForConfigReclaim({env,send:async()=>({kind:'rejected',sent:true,reply:{reason:'not_ready'}})});assert.equal(reject.error.code,'not_ready');assert.deepEqual(reject.error.persisted,[]);
});

test('IB-41 CLI errors retain one JSON envelope and exit 1', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script=fileURLToPath(new URL('../supervisor-request.js',import.meta.url));
  const env={...process.env};delete env.ZYLOS_RUN_ID;delete env.ZYLOS_SESSION_GROUP;
  for(const [args,code] of [[['ready-for-config-reclaim','--json'],'NO_SESSION_ENV'],[['wrong','--json'],'INVALID_ARGS']]) {
    const result=spawnSync(process.execPath,[script,...args],{env,encoding:'utf8',timeout:10000});assert.equal(result.status,1);
    const output=JSON.parse(result.stdout);assert.equal(output.ok,false);assert.equal(output.error.code,code);assert.deepEqual(output.error.persisted,[]);
  }
});
