import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {HealthStore} from '../health-store.js';
import {HealthController} from '../health-controller.js';
import {HealthEngine} from '../health-engine.js';
const identity={runtime:'claude',session_id:'session',claude_pid:123};
function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-evidence-file-'));t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  let clock=Date.now();
  const store=new HealthStore({zylosDir,now:()=>clock});
  const event=(change={})=>({schema_version:1,event_id:randomUUID(),source:'hook',runtime:'claude',...identity,prompt_id:'prompt',event:'stop_failure',error:'rate_limit',received_at:clock,...change});
  return {store,zylosDir,event,now:()=>clock,advance:()=>++clock,consume:input=>store.consume(input,{identity})};
}
test('terminal marker and health survive restart; exact and older events replay safely',t=>{
  const f=fixture(t);const event=f.event();f.consume(event);
  assert.equal(f.store.read().health,'rate_limited');assert.equal(f.consume(event).reason,'replay');
  const reopened=new HealthStore({zylosDir:f.zylosDir,now:f.now});assert.equal(reopened.consume(event,{identity}).reason,'replay');
  assert.deepEqual(reopened.read(),f.store.read());
});
test('wrong or missing pid, session and stale/future/invalid events do not change state',t=>{
  const f=fixture(t);
  for(const change of [{claude_pid:124},{claude_pid:null},{claude_pid:0},{session_id:'other'},{received_at:f.now()-300001},{received_at:f.now()+1},{schema_version:2}]) {
    assert.equal(f.consume(f.event(change)).status,'ignored');assert.equal(f.store.read().health,'ok');
    assert.equal(f.store.read().last_processed,undefined);
  }
});
test('SessionStart and UserPromptSubmit do not alter health, identity or marker',t=>{
  const f=fixture(t);f.consume(f.event());const before=f.store.read();f.advance();
  for(const event of ['session_start','prompt_submit']) assert.equal(f.consume(f.event({event,error:null})).reason,'nonterminal_event');
  assert.deepEqual(f.store.read(),before);
});
test('Stop never clears failure and telemetry does not replace outage anchor',t=>{
  const f=fixture(t);f.consume(f.event());const before=f.store.read();f.advance();
  const stop=f.event({event:'stop',error:null});f.consume(stop);const after=f.store.read();
  assert.equal(after.health,'rate_limited');assert.equal(after.revision,before.revision);
  assert.deepEqual(after.hook_failure,before.hook_failure);assert.equal(after.last_hook.event_id,stop.event_id);
  assert.equal(after.last_processed.received_at,stop.received_at);
});
test('verified normal Stop has Hook priority over stale screen evidence',t=>{
  const f=fixture(t);f.consume(f.event({event:'stop',error:null}));
  assert.equal(f.store.read().hook_ok,true);
  assert.equal(f.store.transition('rate_limited','',{identity,kind:'screen'}).accepted,false);
  assert.equal(f.store.transition('rate_limited','',{identity:{...identity,claude_pid:124},kind:'screen'}).accepted,true);
});
test('recovery fences reject old revisions and late failure cannot undo recovery',t=>{
  const f=fixture(t);f.consume(f.event());const revision=f.store.read().revision;
  assert.equal(f.store.transition('ok','',{identity,kind:'recovery',expectedRevision:revision-1}).accepted,false);
  f.advance();const queued=f.event({prompt_id:'queued'});f.advance();
  assert.equal(f.store.transition('ok','',{identity,kind:'recovery',expectedRevision:revision,screenFingerprint:'clear'}).accepted,true);
  const result=f.consume(queued);
  assert.equal(result.reason,'pre_recovery_event');assert.equal(f.store.read().health,'ok');
  assert.equal(f.store.read().recovered.screen_fingerprint,'clear');
});
test('missing prompt requests verification but newer different prompts are recognized',t=>{
  const f=fixture(t);assert.equal(f.consume(f.event({prompt_id:null})).reason,'missing_prompt');
  f.advance();f.consume(f.event());f.advance();
  assert.equal(f.consume(f.event({prompt_id:'different',error:'authentication_failed'})).reason,'hook_failure');
  assert.equal(f.store.read().health,'auth_failed');
});
test('screen recovery before the first Hook retains its process identity fence',t=>{
  const f=fixture(t);
  f.store.transition('rate_limited','',{identity,kind:'screen'});
  f.store.transition('ok','',{identity,kind:'recovery'});
  const result=f.consume(f.event());
  assert.equal(result.reason,'pre_recovery_event');assert.equal(f.store.read().health,'ok');
});
test('legacy recovery without timestamp does not permanently suppress newer failures',t=>{
  const f=fixture(t);const original=f.event();f.consume(original);
  f.store.transition('ok','',{identity,kind:'recovery'});
  const state=f.store.read();delete state.recovered.observed_at;f.store.write(state);
  assert.equal(f.consume(original).reason,'replay');
  f.advance();const later=f.consume(f.event({prompt_id:'next',error:'authentication_failed'}));
  assert.equal(later.state.health,'auth_failed');assert.equal(later.state.recovered,null);
});
test('scheduling updates preserve revision and stale writes are rejected',t=>{
  const f=fixture(t);f.consume(f.event());const revision=f.store.read().revision;
  assert.equal(f.store.saveScheduling({cooldownUntil:123},revision),true);
  assert.equal(f.store.saveScheduling({cooldownUntil:999},revision-1),false);
  const reopened=new HealthStore({zylosDir:f.zylosDir});assert.equal(reopened.read().scheduling.cooldownUntil,123);
  assert.equal(reopened.read().revision,revision);
});
test('atomic write failure leaves health and marker unchanged',t=>{
  const f=fixture(t);const before=f.store.read();
  f.store.write=()=>{throw new Error('injected write failure');};
  assert.throws(()=>f.consume(f.event()),/injected/);assert.deepEqual(f.store.read(),before);
});
test('controller consumes committed health and restores scheduling without touching unrelated state',t=>{
  const f=fixture(t);let current=identity;const engine=new HealthEngine({}, {now:f.now});
  f.store.saveScheduling({...f.store.read().scheduling,rateLimitResetTime:'14:30'},0);
  t.after(()=>engine.destroy());
  let pending=f.event();
  const controller=new HealthController({store:f.store,engine,identity:()=>current,zylosDir:f.zylosDir,quota:()=>null,
    drainEvents:()=>{if(pending){controller.consume(pending);pending=null;}}});
  assert.equal(engine.rateLimitResetTime,'14:30');
  const fence=controller.captureFence();controller.drain();assert.equal(engine.health,'rate_limited');assert.equal(controller.validFence(fence),false);
  const stable=controller.captureFence();current={...identity,claude_pid:124};assert.equal(controller.validFence(stable),false);
});
