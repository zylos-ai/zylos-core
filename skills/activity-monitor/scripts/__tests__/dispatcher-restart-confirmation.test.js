import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DispatcherRestartConfirmation } from '../dispatcher-restart-confirmation.js';
const flush = async () => { for(let n=0;n<5;n++)await Promise.resolve(); };
test('confirms only online dispatcher newer than committed config, without phase/fence writes', async () => {
  let clock=1000,restarts=0,rows=[]; const calls=[];
  const checker=new DispatcherRestartConfirmation({now:()=>clock,restart:async arg=>{calls.push(arg);restarts++;},list:async()=>rows});
  const input={runId:'transition',writtenAt:1000};
  assert.deepEqual(await checker.advance(input),{confirmed:false,pending:true}); await flush();
  for(const [status,uptime] of [['online',999],['online',1000],['stopped',1001]]) {
    rows=[{name:'c4-dispatcher',pm2_env:{status,pm_uptime:uptime}}]; assert.equal((await checker.advance(input)).confirmed,false);
  }
  rows=[{name:'another',pm2_env:{status:'online',pm_uptime:1001}}]; assert.equal((await checker.advance(input)).confirmed,false);
  rows=[{name:'c4-dispatcher',pm2_env:{status:'online',pm_uptime:1001}}]; assert.equal((await checker.advance(input)).confirmed,true);
  assert.equal(restarts,1); assert.equal(calls[0].timeoutMs,30000);
});
