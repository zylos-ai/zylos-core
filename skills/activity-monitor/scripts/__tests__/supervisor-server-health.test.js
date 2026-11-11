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
test('successful observations end the alert episode and a new outage starts its own delay', async () => {
  const f = fixture(); f.fail(); f.advance(60000); await f.guard.advance();
  f.success(); assert.deepEqual(await f.guard.advance(),{status:'observable'});
  f.fail(); f.advance(59999); await f.guard.advance(); assert.equal(f.alerts.length,1);
  f.advance(1); await f.guard.advance(); assert.equal(f.alerts.length,2);
});
const ORIGIN = {channel:'dashboard',endpoint:'origin'};
test('failed configured alert falls back to the Origin conversation once per interval, including overlapping advances', async () => {
  const f = fixture();
  f.guard.sendAlert = async (target,message) => { f.alerts.push({target,message}); throw Error('offline'); };
  f.fail(); f.advance(60000);
  await Promise.all([f.guard.advance(),f.guard.advance()]);
  assert.deepEqual(f.alerts.map(item=>item.target),[{channel:'fake',endpoint:'owner'},ORIGIN]);
  f.advance(1800000); await f.guard.advance();
  assert.deepEqual(f.alerts.map(item=>item.target.channel),['fake','dashboard','fake','dashboard']);
});
test('unset, default and invalid targets send to the Origin conversation once', async () => {
  for (const target of [null,{default:true},{channel:'',endpoint:'x'},{channel:'x'}]) {
    const f = fixture(); f.guard.readAlertTarget = ()=>target;
    f.fail(); f.advance(60000); await f.guard.advance();
    assert.deepEqual(f.alerts.map(item=>item.target),[ORIGIN],JSON.stringify(target));
  }
  const thrown = fixture(); thrown.guard.readAlertTarget = ()=>{throw Error('config unreadable');};
  thrown.fail(); thrown.advance(60000); await thrown.guard.advance();
  assert.deepEqual(thrown.alerts.map(item=>item.target),[ORIGIN]);
});
test('a failed send to the Origin conversation is logged and not repeated', async () => {
  for (const target of [null,{default:true},{...ORIGIN}]) {
    const logged = [];
    const f = fixture(); f.guard.readAlertTarget = ()=>target; f.guard.log = error=>logged.push(error.message);
    f.guard.sendAlert = async (destination,message) => {f.alerts.push({target:destination,message});throw Error('dashboard down');};
    f.fail(); f.advance(60000); await f.guard.advance();
    assert.deepEqual(f.alerts.map(item=>item.target),[ORIGIN],JSON.stringify(target));
    assert.deepEqual(logged,['dashboard down']);
  }
  // A false result is a failure too; the fallback that also fails only logs.
  const logged = [];
  const f = fixture(); f.guard.log = error=>logged.push(error.message);
  f.guard.sendAlert = async destination => { f.alerts.push({target:destination}); if (destination.channel==='fake') return false; throw Error('fallback down'); };
  f.fail(); f.advance(60000); await f.guard.advance();
  assert.deepEqual(f.alerts.map(item=>item.target),[{channel:'fake',endpoint:'owner'},ORIGIN]);
  assert.deepEqual(logged,['fallback down']);
});
test('web-console:console is an ordinary target: sent there first, Origin conversation after a failure', async () => {
  const f = fixture(); f.guard.readAlertTarget = ()=>({channel:'web-console',endpoint:'console'});
  f.guard.sendAlert = async (destination,message) => {f.alerts.push({target:destination,message});return destination.channel==='dashboard';};
  f.fail(); f.advance(60000); await f.guard.advance();
  assert.deepEqual(f.alerts.map(item=>item.target),[{channel:'web-console',endpoint:'console'},ORIGIN]);
  const ok = fixture(); ok.guard.readAlertTarget = ()=>({channel:'web-console',endpoint:'console'});
  ok.fail(); ok.advance(60000); await ok.guard.advance();
  assert.deepEqual(ok.alerts.map(item=>item.target),[{channel:'web-console',endpoint:'console'}]);
});
test('server outage episodes are independent and other errors are not tmux outages', async () => {
  const f = fixture(); f.fail();
  f.guard.observeSuccess({socketKey:'other'}); f.advance(60000); await f.guard.advance();
  assert.equal(f.alerts.length,1);
  assert.throws(()=>f.guard.observeFailure({error:Object.assign(Error(),{code:'EACCES'})}),{code:'EACCES'});
});
