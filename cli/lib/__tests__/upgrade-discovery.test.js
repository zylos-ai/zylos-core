import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {recoverBeforeUpgrade} from '../upgrade-discovery.js';

function fixture() {
  let complete = false;
  const dir = '/isolated/.backup/self-upgrade/upgrade-1-fixture';
  const hashes = Object.fromEntries(['runner.cjs','maintenance.cjs','finalizer.cjs'].map(name => [name, 'a'.repeat(64)]));
  const m = {discover:() => ({candidates:complete ? [] : [{dir,journal:{recoveryHashes:hashes}}], diagnostics:[], marker:null}),
    canRecognizeProcesses:() => true, privatePath() {}, hash:() => 'a'.repeat(64)};
  return {m, dir, finish:() => {complete = true;}};
}

test('upgrade discovery delegates only to the verified transaction runner before continuing', () => {
  const f = fixture();
  const result = recoverBeforeUpgrade('/isolated', {maintenance:f.m, spawn(node,args,options) {
    assert.equal(node,process.execPath);
    assert.deepEqual(args,[path.join(f.dir,'runner.cjs'),'resume','--transaction-dir',f.dir]);
    assert.equal(Object.hasOwn(options,'timeout'),false);
    f.finish();
    return {status:0,stdout:JSON.stringify({completed:true,recovery_required:false})};
  }});
  assert.equal(result.active,true);
  assert.equal(result.result.completed,true);
});

for (const kind of ['ambiguous','unrecognizable','changed','failed','remaining']) test(`upgrade discovery rejects ${kind} recovery without starting a new upgrade`, () => {
  const f = fixture();
  if (kind==='ambiguous') f.m.discover=()=>({candidates:[],diagnostics:['unsafe'],marker:null});
  if (kind==='unrecognizable') f.m.canRecognizeProcesses=()=>false;
  if (kind==='changed') f.m.hash=()=> 'b'.repeat(64);
  let calls=0;
  assert.throws(()=>recoverBeforeUpgrade('/isolated',{maintenance:f.m,spawn() {
    calls++;
    return {status:kind==='failed'?1:0,stdout:JSON.stringify({recovery_required:kind==='failed'})};
  }}),error=>error.recovery_required===true);
  assert.equal(calls,['failed','remaining'].includes(kind)?1:0);
});
