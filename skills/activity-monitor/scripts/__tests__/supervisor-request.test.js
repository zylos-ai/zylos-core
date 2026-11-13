import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readyForConfigReclaim } from '../supervisor-request.js';

test('CLI derives only own environment and refuses missing or invalid scope', async () => {
  for(const env of [{},{ZYLOS_SESSION_GROUP:'origin'},{ZYLOS_SESSION_GROUP:'../bad',ZYLOS_RUN_ID:'r'}]) {
    const result=await readyForConfigReclaim({env,send:()=>{throw new Error('must not send');}});
    assert.equal(result.error.code,'NO_SESSION_ENV');assert.deepEqual(result.error.persisted,[]);
  }
  let sent;
  const result=await readyForConfigReclaim({env:{ZYLOS_SESSION_GROUP:'telegram:a',ZYLOS_RUN_ID:'r'},send:async request=>{sent=request;return {kind:'accepted',sent:true,reply:{result:'unchanged'}};}});
  assert.equal(sent.sessionGroup,'telegram:a');assert.equal(sent.expectedRunId,'r');assert.equal(sent.type,'ready_for_config_reclaim');
  assert.deepEqual(result,{ok:true,data:{result:'unchanged',sessionGroup:'telegram:a',expectedRunId:'r'}});
});
test('CLI reports unknown persistence for all connected U results without resubmission', async () => {
  const env={ZYLOS_SESSION_GROUP:'origin',ZYLOS_RUN_ID:'r'};
  for(const kind of ['no_reply','invalid_reply','timeout','deadline_exceeded']) {
    let calls=0;const result=await readyForConfigReclaim({env,send:async()=>{calls++;return {kind,sent:true};}});
    assert.equal(result.ok,false);assert.equal(result.error.persisted,null);assert.match(result.error.message,/unknown/);assert.equal(calls,1);
  }
  const connect=await readyForConfigReclaim({env,send:async()=>({kind:'connect_failed',sent:false})});assert.deepEqual(connect.error.persisted,[]);
  const reject=await readyForConfigReclaim({env,send:async()=>({kind:'rejected',sent:true,reply:{reason:'not_ready'}})});assert.equal(reject.error.code,'not_ready');assert.deepEqual(reject.error.persisted,[]);
  const unreadable=await readyForConfigReclaim({env,send:async()=>({kind:'rejected',sent:true,reply:{reason:'requests_unreadable'}})});
  assert.equal(unreadable.error.code,'requests_unreadable');assert.deepEqual(unreadable.error.persisted,[]);
  assert.match(unreadable.error.message,/completed handoff/);assert.match(unreadable.error.message,/repair/);assert.match(unreadable.error.message,/retry/);assert.match(unreadable.error.message,/do not exit/);
});

test('CLI errors retain one JSON envelope and exit 1', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script=fileURLToPath(new URL('../supervisor-request.js',import.meta.url));
  const env={...process.env};delete env.ZYLOS_RUN_ID;delete env.ZYLOS_SESSION_GROUP;
  for(const [args,code] of [[['ready-for-config-reclaim','--json'],'NO_SESSION_ENV'],[['wrong','--json'],'INVALID_ARGS']]) {
    const result=spawnSync(process.execPath,[script,...args],{env,encoding:'utf8',timeout:10000});assert.equal(result.status,1);
    const output=JSON.parse(result.stdout);assert.equal(output.ok,false);assert.equal(output.error.code,code);assert.deepEqual(output.error.persisted,[]);
  }
});

test('deferral request carries only current session identity and reason', async () => {
  const { deferReclaim } = await import('../supervisor-request.js');
  const env = { ZYLOS_SESSION_GROUP: 'telegram:a', ZYLOS_RUN_ID: 'run' }; let sent;
  const result = await deferReclaim({ reason: 'watcher', env, send: async request => {
    sent = request; return { kind: 'accepted', sent: true, reply: { result: 'accepted' } };
  } });
  assert.equal(sent.type, 'defer_reclaim'); assert.equal(sent.expectedRunId, 'run');
  assert.equal(sent.sessionGroup, 'telegram:a'); assert.equal(sent.reason, 'watcher');
  assert.equal(Object.hasOwn(sent, 'minutes'), false);
  assert.deepEqual(result, { ok: true, data: { result: 'accepted', sessionGroup: 'telegram:a', expectedRunId: 'run' } });
  for (const missing of [{}, { ZYLOS_SESSION_GROUP: 'telegram:a' }]) {
    assert.equal((await deferReclaim({ reason: 'watcher', env: missing, send: () => assert.fail() })).error.code, 'NO_SESSION_ENV');
  }
  for (const reason of ['', '   ', undefined]) {
    assert.equal((await deferReclaim({ reason, env, send: () => assert.fail() })).error.code, 'INVALID_ARGS');
  }
  const rejected = await deferReclaim({ reason: 'watcher', env,
    send: async () => ({ kind: 'rejected', sent: true, reply: { reason: 'preparation_expired' } }) });
  assert.equal(rejected.error.code, 'preparation_expired');
  assert.deepEqual(rejected.error.persisted, []);
  const unknown = await deferReclaim({ reason: 'watcher', env, send: async () => ({ kind: 'no_reply', sent: true }) });
  assert.equal(unknown.error.persisted, null); assert.match(unknown.error.message, /do not assume/);
});

test('deferral CLI rejects removed duration option before submission', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const script = fileURLToPath(new URL('../supervisor-request.js', import.meta.url));
  const result = spawnSync(process.execPath, [script, 'defer-reclaim', '--minutes', '3', '--reason', 'watcher'],
    { env: { ...process.env, ZYLOS_SESSION_GROUP: 'telegram:a', ZYLOS_RUN_ID: 'run' }, encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGS');
});
