import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { classifyCutoff, commitCutoff } from '../upgrade-cutoff.js';

const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');
const hash = 'a'.repeat(64);

function journal(phase = 'compensation_closed') {
  return { transactionId: 'tx', phase, snapshotManifestHash: hash,
    compensationCutoff: { formatVersion: 1, closed: true, transactionId: 'tx',
      closedAt: '2026-10-27T00:00:00.000Z', snapshotManifestHash: hash, writer: 'finalizer' } };
}

test('journal update preserves cutoff facts and refuses every backwards phase', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutoff-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const j=journal(); m.durable(path.join(dir,'journal.json'),j);
  for(const phase of ['installing','new_data_ready','restoring','restored_complete']) {
    assert.throws(()=>m.update(dir,structuredClone(j),{phase}),/cannot reopen/);
  }
  assert.throws(()=>m.update(dir,{...j,compensationCutoff:null}),/immutable/);
  m.update(dir,structuredClone(j),{phase:'recovery_required',resumePhase:'compensation_closed'});
  m.update(dir,m.read(path.join(dir,'journal.json')),{phase:'upgrade_complete'});
  assert.equal(classifyCutoff(m.read(path.join(dir,'journal.json'))),'closed');
});

test('cutoff commit atomically publishes and verifies all facts; readback mismatch is uncertain', () => {
  const initial={transactionId:'tx',zylosDir:'/isolated',phase:'installing',installationIntent:true,
    dbBackupDir:'/isolated/backup',snapshotManifestHash:hash};
  const ctx={transactionId:'tx',zylosDir:'/isolated',transactionDir:'/isolated/tx'};
  const postCutoff={formatVersion:1,items:{hooks:{state:'pending',attempts:0}}};
  let saved=structuredClone(initial), writes=0;
  const controller={transaction:()=>structuredClone(saved),hash:()=>hash,
    update:(_dir,_j,changes)=>{writes++; saved={...saved,...changes};}};
  const result=commitCutoff(ctx,{postCutoff},{maintenance:controller});
  assert.equal(writes,1); assert.equal(classifyCutoff(result),'closed');
  assert.deepEqual(result.postCutoff,postCutoff); assert.equal(result.dashboardInstall,null);
  saved=structuredClone(initial);
  controller.update=(_dir,_j,changes)=>{saved={...saved,...changes,postCutoff:null};};
  assert.throws(()=>commitCutoff(ctx,{postCutoff},{maintenance:controller}),{code:'CUTOFF_WRITE_UNCERTAIN'});
  assert.equal(saved.phase,'compensation_closed');
});

for (const corrupt of [false,true]) test(`recovery ${corrupt?'rejects untrusted facts without mutation':'retains current data after cutoff'}`, t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'cutoff-recovery-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'.backup/self-upgrade/tx'),stable=path.join(root,'.zylos/upgrade');
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(stable,{recursive:true});
  for(const [source,target] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']]) {
    fs.copyFileSync(new URL('../'+source,import.meta.url),path.join(stable,target));
  }
  const controller=require(path.join(stable,'maintenance.cjs')),recovery=require(path.join(stable,'recovery.cjs'));
  const saved={...journal(),formatVersion:1,zylosDir:root,initialIdentity:{},installationIntent:true};
  if(corrupt) saved.compensationCutoff.snapshotManifestHash='b'.repeat(64);
  controller.durable(path.join(dir,'journal.json'),saved);
  const current=path.join(root,'current.db');fs.writeFileSync(current,'current-generation');
  const before=fs.readFileSync(path.join(dir,'journal.json'));
  const calls=[];controller.stop=()=>calls.push('stop');controller.start=()=>calls.push('start');
  if(process.platform==='darwin') {t.skip('automatic recovery is Linux only');return;}
  if(corrupt) {
    assert.throws(()=>recovery.resume(dir),{code:'CUTOFF_UNTRUSTED'});
    assert.deepEqual(fs.readFileSync(path.join(dir,'journal.json')),before);
    assert.deepEqual(calls,[]);
  } else {
    const result=recovery.resume(dir);
    assert.equal(result.recovery_required,true);
    assert.match(result.error,/compensation is closed; use zylos upgrade --resume-finalize/);
    const after=controller.read(path.join(dir,'journal.json'));
    assert.equal(after.phase,'recovery_required');assert.equal(after.resumePhase,'compensation_closed');
    assert.deepEqual(after.compensationCutoff,saved.compensationCutoff);
    assert.deepEqual(calls,['stop']);
  }
  assert.equal(fs.readFileSync(current,'utf8'),'current-generation');
  assert.equal(fs.existsSync(path.join(dir,'rescue')),false);
});
