import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),m=require('../upgrade-maintenance.cjs');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-material-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'tx'),closure=path.join(dir,'sqlite-runtime');fs.mkdirSync(closure,{recursive:true,mode:0o700});
  const hashes={};for(const name of ['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs']){const file=path.join(dir,name);fs.writeFileSync(file,'// trusted fixture '+name,{mode:0o600});hashes[name]=m.hash(file);}
  const closureFiles=['package.json','core-db-backup-worker.js','node_modules/better-sqlite3/lib/index.js'];
  for(const file of closureFiles){const p=path.join(closure,file);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,'fixture '+file,{mode:0o600});}
  const j={transactionId:'tx',nodePath:process.execPath,initialIdentity:{nodePath:process.execPath}};
  const d={formatVersion:1,transactionId:'tx',nodePath:process.execPath,runnerPath:path.join(dir,'runner.cjs'),workerPath:path.join(closure,'core-db-backup-worker.js'),driverPath:path.join(closure,'node_modules/better-sqlite3/lib/index.js'),driverClosureRoot:closure,hashes};
  return {dir,closure,j,d};
}
test('required recovery controller hash tampering is rejected',t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.dir,'installer.cjs'),'changed');assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/material hash mismatch/);
});
function readyFixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-ready-identity-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const j={formatVersion:1,transactionId:'tx',zylosDir:root,phase:'restored_data_ready',installationIntent:true,nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db/tx'),snapshotManifestHash:'a'.repeat(64),coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:'b'.repeat(64)}],originalServices:[],initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:'c'.repeat(64),cliRoot:path.join(root,'original-cli'),cliHash:'d'.repeat(64),workerPath:path.join(root,'original-cli/lib/worker.js'),workerHash:'e'.repeat(64),ecosystemHash:null,databases:[...m.DB_PATHS,'components/dashboard/dashboard.db'].map(source=>({source,exists:true}))}};
  return {root,dir,j,save:()=>m.durable(path.join(dir,'journal.json'),j)};
}


for (const blocker of ['installer', 'finalizer', 'services']) test(`terminal marker stays until durable ${blocker} completion is confirmed`, t => {
  const f = readyFixture(t);
  Object.assign(f.j, {phase:'restored_complete', cleanup:{complete:true, servicesRestored:true}, terminalEvidence:{verified:true, kind:'code_data_services'}});
  f.save();m.marker(f.root, f.dir, f.j);
  const stale = structuredClone(f.j);
  const pending = blocker === 'services' ? {terminalServicesStopped:true} : {[blocker+'Started']:true, [blocker+'ExitConfirmed']:false};
  m.update(f.dir, f.j, pending);
  assert.equal(m.finishTerminal(f.dir, stale).complete, false);
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/upgrade/active.json')), true);
  if (blocker !== 'services') assert.equal(m.discover(f.root).blocked, true);
  const confirmed = blocker === 'services' ? {terminalServicesStopped:false} : {[blocker+'ExitConfirmed']:true};
  m.update(f.dir, f.j, confirmed);
  assert.equal(m.finishTerminal(f.dir, f.j).complete, true);
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/upgrade/active.json')), false);
  assert.equal(fs.existsSync(f.dir), true);
  assert.equal(m.discover(f.root).candidates.length, 0);
});
