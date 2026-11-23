import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {recoverBeforeUpgrade} from '../upgrade-discovery.js';

function fixture() {
  let complete = false;
  const dir = '/isolated/.backup/self-upgrade/upgrade-1-fixture';
  const hashes = Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs'].map(name => [name, 'a'.repeat(64)]));
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
