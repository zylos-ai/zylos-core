import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {recoverBeforeUpgrade} from '../upgrade-discovery.js';

function fixture() {
  let complete = false;
  const dir = '/isolated/.backup/self-upgrade/upgrade-1-fixture';
  const hashes = Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs'].map(name => [name, 'a'.repeat(64)]));
  const m = {discover:() => ({candidates:complete ? [] : [{dir,journal:{recoveryHashes:hashes}}], diagnostics:[], marker:null}),
    canRecognizeProcesses:() => true, privatePath() {}, hash:() => 'a'.repeat(64)};
  m.validateRecoveryFiles=(_dir,j)=>{if(Object.values(j.recoveryHashes).some(value=>value!==m.hash()))throw Error('transaction recovery material changed');};
  return {m, dir, finish:() => {complete = true;}};
}

test('a live controller prevents runner execution even with valid recovery hashes', t => {
  const f = fixture(), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discovery-live-'));
  t.after(() => fs.rmSync(dir, {recursive:true, force:true}));
  fs.writeFileSync(path.join(dir, 'controller.json'), '{}');
  const journal = f.m.discover().candidates[0].journal;
  let spawned = false;
  f.m.discover = () => ({candidates:spawned ? [] : [{dir,journal}],diagnostics:[],marker:null});
  f.m.read = () => ({pid:123}); f.m.alive = () => true;
  assert.throws(() => recoverBeforeUpgrade('/isolated', {maintenance:f.m,spawn() {spawned=true; return {status:0,stdout:JSON.stringify({completed:true,recovery_required:false})};}}), /controller is still running/);
  assert.equal(spawned, false);
});

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

for (const kind of ['ambiguous','diagnostics','unrecognizable','changed','failed','remaining']) test(`upgrade discovery rejects ${kind} recovery without starting a new upgrade`, () => {
  const f = fixture();
  if (kind==='ambiguous') {
    const candidate=f.m.discover().candidates[0];
    f.m.discover=()=>({candidates:[candidate,candidate],diagnostics:[],marker:null});
    f.m.classifyCutoff=()=> 'closed';
  }
  if (kind==='diagnostics') f.m.discover=()=>({candidates:[],diagnostics:['unsafe'],marker:null});
  if (kind==='unrecognizable') {
    f.m.canRecognizeProcesses=()=>false;
    f.m.classifyCutoff=()=> 'closed';
  }
  if (kind==='changed') f.m.hash=()=> 'b'.repeat(64);
  let calls=0;
  assert.throws(()=>recoverBeforeUpgrade('/isolated',{maintenance:f.m,spawn() {
    calls++;
    return {status:kind==='failed'?1:0,stdout:JSON.stringify({recovery_required:kind==='failed'})};
  }}),error=>{
    assert.equal(error.code,kind==='unrecognizable'?'MANUAL_RECOVERY_REQUIRED':'UPGRADE_RECOVERY_REQUIRED');
    assert.equal(error.recovery_required,true);
    assert.deepEqual(error.persisted,[]);
    assert.match(error.next,/zylos recovery status.*zylos recovery resume/);
    return true;
  });
  assert.equal(calls,['failed','remaining'].includes(kind)?1:0);
});

test('closed recovery failure directs the caller to forward finalization', () => {
  const f=fixture();
  f.m.classifyCutoff=()=> 'closed';
  assert.throws(()=>recoverBeforeUpgrade('/isolated',{maintenance:f.m,spawn(){
    return {status:1,stdout:JSON.stringify({recovery_required:true,error:'compensation is closed'})};
  }}),error=>{
    assert.equal(error.code,'UPGRADE_RECOVERY_REQUIRED');
    assert.match(error.next,/zylos upgrade --resume-finalize/);
    assert.doesNotMatch(error.next,/zylos recovery resume/);
    return true;
  });
});
