import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { classifyCutoff, commitCutoff } from '../upgrade-cutoff.js';
import { recovery } from '../upgrade-protection.js';

const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');
const hash = 'a'.repeat(64);

test('snapshot validates original database identities before executing its worker', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cutoff-snapshot-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.copyFileSync(new URL('../upgrade-maintenance.cjs',import.meta.url),path.join(root,'maintenance.cjs'));
  fs.copyFileSync(new URL('../upgrade-recovery.cjs',import.meta.url),path.join(root,'recovery.cjs'));
  const controller=require(path.join(root,'maintenance.cjs')),runner=require(path.join(root,'recovery.cjs'));
  const manifest={formatVersion:2,id:'tx',status:'complete',databases:controller.databasePaths(2).map(source=>({source}))};
  const file=path.join(root,'manifest.json');controller.durable(file,manifest);
  const j={transactionId:'tx',zylosDir:root,dbBackupDir:root,snapshotManifestHash:controller.hash(file),
    initialIdentity:{databases:manifest.databases.map(d=>({...d,exists:false}))}};
  let calls=0;controller.worker=()=>{calls++;};
  assert.equal(runner.validateSnapshot(root,j).formatVersion,2);
  assert.equal(calls,1);
  const original=structuredClone(j.initialIdentity.databases);
  for(const alter of [databases=>{databases[0].source='unrelated/database.db';},databases=>{databases.pop();}]) {
    j.initialIdentity.databases=structuredClone(original);alter(j.initialIdentity.databases);
    assert.throws(()=>runner.validateSnapshot(root,j),/snapshot and original database identity differ/);
    assert.equal(calls,1,'invalid original identity must not reach snapshot worker');
  }
});
function journal(phase = 'compensation_closed') {
  return { transactionId: 'tx', phase, snapshotManifestHash: hash,
    compensationCutoff: { formatVersion: 1, closed: true, transactionId: 'tx',
      closedAt: '2026-10-27T00:00:00.000Z', snapshotManifestHash: hash, writer: 'finalizer' } };
}

test('cutoff classification covers every recovery row without modifying input', () => {
  const cases = [
    [{phase:'installing'}, 'none'],
    ...['installing','new_data_ready','new_verifying','restoring','restored_complete','aborted_before_install','unknown'].map(p => [journal(p),'untrusted']),
    [journal(), 'closed'],
    [{...journal('recovery_required'), resumePhase:'compensation_closed'}, 'closed'],
    [journal('upgrade_complete'), 'closed'],
    [{phase:'upgrade_complete'}, 'none'],
    [{phase:'compensation_closed'}, 'untrusted'],
    [{phase:'recovery_required',resumePhase:'compensation_closed'}, 'untrusted']
  ];
  for (const [value, expected] of cases) {
    const before = structuredClone(value);
    assert.equal(classifyCutoff(value), expected);
    assert.deepEqual(value, before);
  }
  for (const key of Object.keys(journal().compensationCutoff)) {
    const value = journal(); delete value.compensationCutoff[key];
    assert.equal(classifyCutoff(value),'untrusted', key);
  }
  for (const [key,value] of [['transactionId','other'],['snapshotManifestHash','b'.repeat(64)],['closed',false],['closedAt','invalid']]) {
    const j=journal(); j.compensationCutoff[key]=value;
    assert.equal(classifyCutoff(j),'untrusted',key);
  }
});

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

test('closed cutoff freezes publication bytes but permits item progress', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutoff-inputs-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const j={...journal(),postCutoff:{formatVersion:1,items:{hooks:{state:'pending',attempts:0,input:{sha256:hash,path:'staged-settings'}}}},
    dashboardInstall:{items:{registration:{state:'pending',payload:{route:'/dashboard'}}}}};
  m.durable(path.join(dir,'journal.json'),j);
  const before=fs.readFileSync(path.join(dir,'journal.json'));
  for(const field of ['postCutoff','dashboardInstall']) {
    const next=structuredClone(j);
    if(field==='postCutoff') next.postCutoff.items.hooks.input.sha256='b'.repeat(64);
    else next.dashboardInstall.items.registration.payload.route='/other';
    assert.throws(()=>m.update(dir,next),/publication inputs are immutable/,field);
    assert.deepEqual(fs.readFileSync(path.join(dir,'journal.json')),before);
  }
  const next=structuredClone(j);
  Object.assign(next.postCutoff.items.hooks,{state:'done',attempts:1,lastError:null});
  assert.doesNotThrow(()=>m.update(dir,next));
});

test('untrusted cutoff cannot advance phase or rewrite its recovery phase', t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutoff-untrusted-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const j={...journal('recovery_required'),resumePhase:'compensation_closed'};
  j.compensationCutoff.closedAt='invalid';
  m.durable(path.join(dir,'journal.json'),j);
  const before=fs.readFileSync(path.join(dir,'journal.json'));
  for(const changes of [{phase:'upgrade_complete'},{resumePhase:'installing'}]) {
    assert.throws(()=>m.update(dir,structuredClone(j),changes),/untrusted cutoff requires manual recovery/);
    assert.deepEqual(fs.readFileSync(path.join(dir,'journal.json')),before);
  }
});

for(const missing of ['postCutoff','dashboardInstall']) test(`cutoff first write requires atomic ${missing}`, t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cutoff-atomic-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const j={transactionId:'tx',phase:'installing',snapshotManifestHash:hash};
  m.durable(path.join(dir,'journal.json'),j);
  const changes={...journal(),postCutoff:{items:{hooks:{state:'pending'}}},dashboardInstall:null};
  delete changes[missing];
  assert.throws(()=>m.update(dir,j,changes),/must atomically publish/);
  assert.equal(m.read(path.join(dir,'journal.json')).phase,'installing');
});

for(const invalid of ['phase','manifest']) test(`commit rejects ${invalid} before durable write`, () => {
  const ctx={transactionId:'tx',zylosDir:'/isolated',transactionDir:'/isolated/tx'};
  const saved={transactionId:'tx',phase:invalid==='phase'?'prepared':'installing',installationIntent:true,
    dbBackupDir:'/isolated/backup',snapshotManifestHash:hash};
  let writes=0;
  const controller={transaction:()=>structuredClone(saved),hash:()=>invalid==='manifest'?'b'.repeat(64):hash,
    update:()=>{writes++;}};
  assert.throws(()=>commitCutoff(ctx,{postCutoff:{formatVersion:1,items:{hooks:{state:'pending'}}}},
    {maintenance:controller}),invalid==='phase'?/own installing transaction/:/manifest changed before cutoff/);
  assert.equal(writes,0);
});

for(const corrupt of [false,true]) test(`parent recovery handles ${corrupt?'untrusted':'closed'} cutoff before runner dispatch`, () => {
  const root='/isolated',dir=path.join(root,'.backup/self-upgrade/tx');
  let saved={...journal(),zylosDir:root,installationIntent:true};
  if(corrupt) saved.compensationCutoff.closedAt='invalid';
  const calls=[];
  const controller={transaction:()=>structuredClone(saved),classifyCutoff,marker:()=>calls.push('marker'),
    stop:()=>calls.push('stop'),update:(_dir,_journal,changes)=>{calls.push('update');saved={...saved,...changes};},
    terminalValid:()=>false,READY:new Set(),canRecognizeProcesses:()=>true,
    read:()=>assert.fail('cutoff must not dispatch a recovery runner')};
  const ctx={transactionId:'tx',transactionDir:dir,journal:saved,maintenance:controller,releaseControl:()=>calls.push('release')};
  const result=recovery(ctx);
  assert.equal(result.attempted,false);assert.equal(result.completed,false);assert.equal(result.recovery_required,true);
  assert.match(result.error,corrupt?/untrusted cutoff/:/compensation is closed; use zylos upgrade --resume-finalize/);
  if(corrupt) assert.deepEqual(calls,['release']);
  else {
    assert.deepEqual(calls,['marker','stop','update','release']);
    assert.equal(saved.phase,'recovery_required');assert.equal(saved.resumePhase,'compensation_closed');
  }
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
  for(const [source,target] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']]) {
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
