import test from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorServerHealth } from '../supervisor-server-health.js';
const failure = cause => Object.assign(new Error('unavailable'), {code:'TMUX_UNAVAILABLE',cause});
function fixture() {
  let now = 1000000;
  const alerts = [];
  const guard = new SupervisorServerHealth({now:()=>now,
    readAlertTarget:()=>({channel:'fake',endpoint:'owner'}),
    sendAlert:(target,message)=>{alerts.push({target,message});return true;}});
  return {guard,alerts,advance:ms=>now+=ms,
    success:()=>guard.observeSuccess(),fail:()=>guard.observeFailure({error:failure('timeout')})};
}
test('unavailable alerts at 60 seconds then every thirty minutes, and remains unknown indefinitely', async () => {
  const f = fixture();
  f.fail(); f.advance(59999); await f.guard.advance(); assert.equal(f.alerts.length,0);
  f.advance(1); await f.guard.advance(); await f.guard.advance(); assert.equal(f.alerts.length,1);
  f.advance(600000); await f.guard.advance(); assert.equal(f.alerts.length,1);
  f.advance(1199999); await f.guard.advance(); assert.equal(f.alerts.length,1);
  f.advance(1); assert.deepEqual(await f.guard.advance(),{status:'unavailable'}); assert.equal(f.alerts.length,2);
  f.advance(24*60*60000); assert.deepEqual(await f.guard.advance(),{status:'unavailable'}); assert.equal(f.alerts.length,3);
  for (const alert of f.alerts) assert.match(alert.message,/Sessions remain unconfirmed/);
});
