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
test('T02 unavailable alerts at 60 seconds then every ten minutes, and remains unknown indefinitely', async () => {
  const f = fixture();
  f.fail(); f.advance(59999); await f.guard.advance(); assert.equal(f.alerts.length,0);
  f.advance(1); await f.guard.advance(); await f.guard.advance(); assert.equal(f.alerts.length,1);
  f.advance(599999); await f.guard.advance(); assert.equal(f.alerts.length,1);
  f.advance(1); assert.deepEqual(await f.guard.advance(),{status:'unavailable'}); assert.equal(f.alerts.length,2);
  f.advance(24*60*60000); assert.deepEqual(await f.guard.advance(),{status:'unavailable'}); assert.equal(f.alerts.length,3);
  for (const alert of f.alerts) assert.match(alert.message,/Sessions remain unconfirmed/);
});
test('T02 successful observations end the alert episode and a new outage starts its own delay', async () => {
  const f = fixture(); f.fail(); f.advance(60000); await f.guard.advance();
  f.success(); assert.deepEqual(await f.guard.advance(),{status:'observable'});
  f.fail(); f.advance(59999); await f.guard.advance(); assert.equal(f.alerts.length,1);
  f.advance(1); await f.guard.advance(); assert.equal(f.alerts.length,2);
});
test('T02 failed configured alert falls back to Web Console once per interval, including overlapping advances', async () => {
  const f = fixture();
  f.guard.sendAlert = async (target,message) => { f.alerts.push({target,message}); throw Error('offline'); };
  f.fail(); f.advance(60000);
  await Promise.all([f.guard.advance(),f.guard.advance()]);
  assert.deepEqual(f.alerts.map(item=>item.target.channel),['fake','web-console']);
  f.advance(600000); await f.guard.advance();
  assert.deepEqual(f.alerts.map(item=>item.target.channel),['fake','web-console','fake','web-console']);
});
test('T02 absent alert target uses Web Console and a failed Web Console target is not duplicated', async () => {
  for (const target of [null,{channel:'web-console',endpoint:'console'}]) {
    const f = fixture(); f.guard.readAlertTarget = ()=>target;
    f.guard.sendAlert = async (destination,message) => {f.alerts.push({target:destination,message});return false;};
    f.fail(); f.advance(60000); await f.guard.advance();
    assert.deepEqual(f.alerts.map(item=>item.target),[{channel:'web-console',endpoint:'console'}]);
  }
});
test('T02 server outage episodes are independent and other errors are not tmux outages', async () => {
  const f = fixture(); f.fail();
  f.guard.observeSuccess({socketKey:'other'}); f.advance(60000); await f.guard.advance();
  assert.equal(f.alerts.length,1);
  assert.throws(()=>f.guard.observeFailure({error:Object.assign(Error(),{code:'EACCES'})}),{code:'EACCES'});
});
