import { getRuntime } from '../../../../cli/lib/runtime/index.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {HealthStore} from '../health-store.js';

const hookHealth = (await getRuntime('claude')).health.hookHealth;
const identity={runtime:'claude',session_id:'session',claude_pid:123};
function fixture(t) {
  const zylosDir=fs.mkdtempSync(path.join(os.tmpdir(),'health-evidence-file-'));t.after(()=>fs.rmSync(zylosDir,{recursive:true,force:true}));
  let clock=Date.now();
  const store=new HealthStore({zylosDir,now:()=>clock});
  const event=(change={})=>({schema_version:1,event_id:randomUUID(),source:'hook',runtime:'claude',...identity,prompt_id:'prompt',event:'stop_failure',error:'rate_limit',received_at:clock,...change});
  return {store,zylosDir,event,now:()=>clock,advance:()=>++clock,consume:(input,options)=>store.consume(input,{hookHealth, identity,...options})};
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
test('recovery fences reject old revisions and late failure cannot undo recovery',t=>{
  const f=fixture(t);f.consume(f.event());const revision=f.store.read().revision;
  assert.equal(f.store.transition('ok','',{identity,kind:'recovery',expectedRevision:revision-1}).accepted,false);
  f.advance();const queued=f.event({prompt_id:'queued'});f.advance();
  assert.equal(f.store.transition('ok','',{identity,kind:'recovery',expectedRevision:revision,screenFingerprint:'clear'}).accepted,true);
  const result=f.consume(queued);
  assert.equal(result.reason,'pre_recovery_event');assert.equal(f.store.read().health,'ok');
  assert.equal(f.store.read().recovered.screen_fingerprint,'clear');
});

