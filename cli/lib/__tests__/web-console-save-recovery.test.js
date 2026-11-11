import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { resumeFinalize } from '../upgrade-resume.js';
import { savePm2ProcessList } from '../pm2-save.js';

const maintenance=createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function fixture(t,{pending=true,marked=false}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'console-save-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id='removed-console',dir=path.join(root,'.backup/self-upgrade',id);
  const dbBackupDir=path.join(root,'.backup/db',id);
  fs.mkdirSync(dir,{recursive:true});
  fs.mkdirSync(dbBackupDir,{recursive:true});
  const manifest={formatVersion:3,function:'core-self-upgrade-db',status:'complete',id,
    databases:maintenance.databasePaths(3).map(source=>({source,status:'missing',file:null,
      bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  maintenance.durable(path.join(dbBackupDir,'manifest.json'),manifest);
  const snapshotManifestHash=maintenance.hash(path.join(dbBackupDir,'manifest.json'));
  const journal={formatVersion:1,transactionId:id,zylosDir:root,nodePath:process.execPath,
    skillsDir:path.join(root,'.claude/skills'),phase:'upgrade_complete',installationIntent:true,
    dbBackupDir,snapshotManifestHash,originalServices:[],webConsolePm2SavePending:pending,
    cleanup:{complete:true,codeRemoved:true,servicesRestored:true},
    terminalEvidence:{verified:true,kind:'code_data_services'},
    compensationCutoff:{formatVersion:1,closed:true,transactionId:id,snapshotManifestHash,
      writer:'finalizer',closedAt:new Date().toISOString()},
    coreManifest:[{name:'core',existedBefore:false,backedUp:false,originalHash:null}],
    initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),
      packageHash:'a'.repeat(64),cliRoot:path.join(root,'cli'),cliHash:'b'.repeat(64),
      workerPath:path.join(root,'worker.js'),workerHash:'c'.repeat(64),ecosystemHash:null,
      databases:maintenance.databasePaths(2).map(source=>({source,exists:false}))}};
  maintenance.update(dir,journal);
  if(marked)maintenance.marker(root,dir,journal);
  return {root,dir,read:()=>maintenance.transaction(root,dir)};
}

test('terminal pending save is discoverable without a marker and status leaves it unchanged',async t=>{
  const f=fixture(t);
  assert.equal(maintenance.hasRecoveryMaterials(f.root),false);
  const found=maintenance.discover(f.root);
  assert.equal(found.candidates.length,1);
  assert.deepEqual(found.diagnostics,[]);
  const before=fs.readFileSync(path.join(f.dir,'journal.json'));
  const result=await resumeFinalize(f.root,{status:true});
  assert.equal(result.ok,true);
  assert.match(result.data.next,/save the PM2 startup list/);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'journal.json')),before);
});

test('terminal resume saves with the real guard and preserves terminal journal state',async t=>{
  const f=fixture(t);
  let saves=0;
  const result=await resumeFinalize(f.root,{}, {
    finalize:()=>assert.fail('terminal save must not replay finalization'),
    savePm2ProcessList:options=>savePm2ProcessList({...options,save:()=>{
      assert.equal(maintenance.hasRecoveryMaterials(f.root),false);
      saves++;
    }}),
  });
  assert.equal(result.ok,true);
  assert.equal(saves,1);
  assert.equal(result.data.next,null);
  assert.equal(f.read().webConsolePm2SavePending,false);
  assert.equal(f.read().phase,'upgrade_complete');
  assert.equal(f.read().cleanup.complete,true);
  assert.equal(maintenance.discover(f.root).candidates.length,0);
  await assert.rejects(()=>resumeFinalize(f.root),{code:'NOT_RESUMABLE'});
});

test('terminal save failure remains discoverable and a later resume retries successfully',async t=>{
  const f=fixture(t);
  const result=await resumeFinalize(f.root,{}, {
    savePm2ProcessList:options=>savePm2ProcessList({...options,save:()=>{throw Error('PM2 unavailable');}}),
  });
  assert.equal(result.ok,true);
  assert.equal(f.read().webConsolePm2SavePending,true);
  assert.match(result.data.warnings.join(' '),/Could not save the PM2 startup list/);
  assert.match(result.data.next,/resume-finalize/);
  assert.equal(maintenance.discover(f.root).candidates.length,1);
  let saves=0;
  await resumeFinalize(f.root,{}, {
    savePm2ProcessList:options=>savePm2ProcessList({...options,save:()=>{saves++;}}),
  });
  assert.equal(saves,1);
  assert.equal(f.read().webConsolePm2SavePending,false);
});

test('terminal retry retains pending intent when the real save guard rejects',async t=>{
  const f=fixture(t);
  const result=await resumeFinalize(f.root,{}, {
    savePm2ProcessList:options=>{
      maintenance.durable(path.join(f.root,'.zylos/upgrade/active.json'),{formatVersion:1,transactionId:'ambiguous'});
      return savePm2ProcessList({...options,save:()=>assert.fail('guard must reject native save')});
    },
  });
  assert.equal(result.ok,true);
  assert.equal(f.read().webConsolePm2SavePending,true);
  assert.match(result.data.warnings.join(' '),/Skipped PM2 save/);
  assert.match(result.data.next,/resume-finalize/);
});

test('terminal cleanup with cleared intent does not save again',async t=>{
  const f=fixture(t,{pending:false,marked:true});
  const result=await resumeFinalize(f.root,{}, {
    savePm2ProcessList:()=>assert.fail('cleared intent must not save'),
  });
  assert.equal(result.ok,true);
  assert.equal(result.data.next,null);
  assert.equal(maintenance.hasRecoveryMaterials(f.root),false);
  assert.equal(maintenance.discover(f.root).candidates.length,0);
});
