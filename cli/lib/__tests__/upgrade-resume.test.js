import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resumeFinalize } from '../upgrade-resume.js';
import { loadPostUpgradeSync, preparePostCutoff } from '../upgrade-post-cutoff.js';

const sync = await loadPostUpgradeSync();

const actual=createRequire(import.meta.url)('../upgrade-maintenance.cjs');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resume-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id='upgrade-1-fixture',dir=path.join(root,'.backup/self-upgrade',id),db=path.join(root,'.backup/db',id);
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(db,{recursive:true});
  const manifest={formatVersion:2,function:'core-self-upgrade-db',status:'complete',id,
    databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db','components/dashboard/dashboard.db'].map(source=>({source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  actual.durable(path.join(db,'manifest.json'),manifest);
  const hash=actual.hash(path.join(db,'manifest.json'));
  let journal={formatVersion:1,transactionId:id,zylosDir:root,initialIdentity:{},installationIntent:true,
    dbBackupDir:db,snapshotManifestHash:hash,phase:'compensation_closed',from:'old',to:'new',originalServices:[],
    compensationCutoff:{formatVersion:1,closed:true,transactionId:id,snapshotManifestHash:hash,writer:'finalizer',closedAt:new Date().toISOString()},
    postCutoff:preparePostCutoff({sync,zylosDir:root,transactionDir:dir,homeDir:root,runtime:'claude',replacements:[]})};
  actual.durable(path.join(dir,'journal.json'),journal);
  const calls=[];
  const m={...actual,canRecognizeProcesses:platform=>platform==='linux',discover:()=>({candidates:[{dir,journal:structuredClone(journal)}],diagnostics:[]}),
    acquire:()=>{calls.push('lock');return()=>calls.push('unlock');},
    transaction:()=>structuredClone(journal),
    update:(_dir,j,changes)=>{calls.push('update');Object.assign(j,changes);journal=structuredClone(j);},
    marker:()=>calls.push('marker'),stop:()=>calls.push('stop'),finishTerminal:()=>{calls.push('cleanup');return {complete:true};}};
  return {root,dir,db,m,calls,get journal(){return journal;},set journal(value){journal=value;}};
}

test('snapshot hash drift is rejected before any modifications even when closed facts agree',async t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.db,'manifest.json'),' ');
  await assert.rejects(resumeFinalize(f.root,{}, {maintenance:f.m,platform:'linux'}),{code:'CUTOFF_UNTRUSTED'});
  assert.deepEqual(f.calls,['lock','unlock']);
});

for(const status of [false,true]) test(`installing transaction is NOT_RESUMABLE (${status?'status':'repair'}) and retains compensation`,async t=>{
  const f=fixture(t);
  const {compensationCutoff,...open}=f.journal;
  f.journal={...open,phase:'installing'};
  const before=structuredClone(f.journal);
  await assert.rejects(resumeFinalize(f.root,{status},{maintenance:f.m,platform:'linux',finalize:()=>assert.fail('finalizer called')}),{code:'NOT_RESUMABLE'});
  assert.deepEqual(f.journal,before);
  assert.deepEqual(f.calls,[]);
  assert.equal(actual.classifyCutoff(f.journal),'none');
});


test('unconfirmed finalizer exit blocks isolation and publication and preserves the journal',async t=>{
  const f=fixture(t),before=structuredClone(f.journal);
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,platform:'linux',quiesce:()=>{f.calls.push('quiesce');throw Error('finalizer still active');},finalize:()=>assert.fail('published')});
  assert.equal(result.ok,false);assert.equal(result.error.code,'FINALIZE_INCOMPLETE');
  assert.match(result.error.message,/still active/);assert.equal(result.data.core.state,'failed');
  assert.deepEqual(f.journal,before);assert.deepEqual(f.calls,['lock','quiesce','unlock']);
});
