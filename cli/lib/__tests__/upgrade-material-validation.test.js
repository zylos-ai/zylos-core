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
  const hashes={};for(const name of ['runner.cjs','maintenance.cjs','finalizer.cjs',...(process.platform==='darwin'?['macos-recovery-helper','macos-recovery-helper.sha256']:[])]){const file=path.join(dir,name);fs.writeFileSync(file,'// trusted fixture '+name,{mode:0o600});hashes[name]=m.hash(file);}
  const closureFiles=['package.json','core-db-backup-worker.js','node_modules/better-sqlite3/lib/index.js'];
  for(const file of closureFiles){const p=path.join(closure,file);fs.mkdirSync(path.dirname(p),{recursive:true,mode:0o700});fs.writeFileSync(p,'fixture '+file,{mode:0o600});}
  const j={transactionId:'tx',nodePath:process.execPath,initialIdentity:{nodePath:process.execPath}};
  const d={formatVersion:1,transactionId:'tx',nodePath:process.execPath,runnerPath:path.join(dir,'runner.cjs'),workerPath:path.join(closure,'core-db-backup-worker.js'),driverPath:path.join(closure,'node_modules/better-sqlite3/lib/index.js'),driverClosureRoot:closure,hashes};
  return {dir,closure,j,d};
}
test('complete fixed recovery layout validates',t=>{const f=fixture(t);assert.doesNotThrow(()=>m.validateDescriptor(f.dir,f.j,f.d));});
test('omitted hash set never executes an unverified runner',t=>{
  const f=fixture(t);f.d.hashes={};assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/required recovery material hashes/);
});
for(const key of ['runnerPath','workerPath','driverPath','driverClosureRoot'])test(`private in-transaction redirect of ${key} is rejected`,t=>{
  const f=fixture(t);f.d[key]=path.join(f.dir,'unexpected-private-file');fs.writeFileSync(f.d[key],'untrusted',{mode:0o600});assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/fixed layout/);
});
test('matching journal and descriptor cannot nominate another executable as Node',t=>{
  const f=fixture(t),fake=path.join(f.dir,'node');fs.writeFileSync(fake,'#!/bin/sh\nexit 0\n',{mode:0o700});f.j.nodePath=f.j.initialIdentity.nodePath=f.d.nodePath=fake;
  assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/untrusted recovery Node/);
});
test('required recovery controller hash tampering is rejected',t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.dir,'finalizer.cjs'),'changed');assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/material hash mismatch/);
});
for(const key of ['workerPath','driverPath'])test(`missing or symlinked fixed closure ${key} is rejected`,t=>{
 const f=fixture(t),file=f.d[key];fs.unlinkSync(file);
 assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/ENOENT/);
 const outside=path.join(f.dir,'outside-file');fs.writeFileSync(outside,'untrusted');fs.symlinkSync(outside,file);
 assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/invalid driver closure entry/);
});
test('terminal label needs consistent installation boundary and complete cleanup evidence',t=>{
  const base=readyFixture(t).j;
  const complete={complete:true,markerRemoved:true,servicesRestored:true};
  const aborted={...base,phase:'aborted_before_install',installationIntent:false,cleanup:complete,terminalEvidence:{verified:true,kind:'original_deployment_and_readonly_data'}};
  assert.equal(m.terminalValid(aborted),true);assert.equal(m.terminalValid({...aborted,installationIntent:true}),false);
  const restored={...base,phase:'restored_complete',installationIntent:true,cleanup:complete,terminalEvidence:{verified:true,kind:'code_data_services'}};
  assert.equal(m.terminalValid(restored),true);assert.equal(m.terminalValid({...restored,installationIntent:false}),false);
  assert.equal(m.terminalValid({...restored,terminalEvidence:{verified:true}}),false);
  assert.equal(m.terminalValid({...restored,cleanup:{complete:true}}),false);
});
test('legal skills-root symlink resolves while dangling individual target symlink is rejected',t=>{
  const f=fixture(t),skills=path.join(f.dir,'real-skills'),alias=path.join(f.dir,'skills-alias');fs.mkdirSync(skills,{mode:0o700});fs.symlinkSync(skills,alias);
  const journal={skillsDir:alias,coreManifest:[{name:'core'}]};assert.equal(m.target(journal,'core'),path.join(skills,'core'));
  fs.symlinkSync(path.join(f.dir,'unrelated-missing-directory'),path.join(skills,'core'));
  assert.throws(()=>m.target(journal,'core'),/individual core skill symlink rejected/);
  assert.equal(fs.lstatSync(path.join(skills,'core')).isSymbolicLink(),true);
  assert.equal(fs.existsSync(path.join(f.dir,'unrelated-missing-directory')),false);
});
for(const relative of ['.zylos/upgrade/active.json','.backup/self-upgrade','.zylos/upgrade','.zylos','.backup'])test(`dangling ${relative} cannot silently disable maintenance isolation`,t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-discovery-link-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.symlinkSync(path.join(root,'missing-target'),file);
  const result=m.discover(root);assert.equal(result.blocked,true);assert.match(result.diagnostics.join(' '),/unsafe recovery path/);
  assert.throws(()=>m.assertCoreDatabaseAvailable(root),/core database maintenance/);
  assert.equal(fs.lstatSync(file).isSymbolicLink(),true);assert.equal(fs.existsSync(path.join(root,'missing-target')),false);
});
test('absent recovery directories permit ordinary database access',t=>{
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-discovery-absent-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.deepEqual(m.discover(root),{marker:null,candidates:[],diagnostics:[],blocked:false});assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(root));
});
function readyFixture(t){
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-ready-identity-')));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const dir=path.join(root,'.backup/self-upgrade/tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const j={formatVersion:1,transactionId:'tx',zylosDir:root,phase:'new_data_ready',installationIntent:true,nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db/tx'),snapshotManifestHash:'a'.repeat(64),coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:'b'.repeat(64)}],originalServices:[],initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:'c'.repeat(64),cliRoot:path.join(root,'original-cli'),cliHash:'d'.repeat(64),workerPath:path.join(root,'original-cli/lib/worker.js'),workerHash:'e'.repeat(64),ecosystemHash:null,databases:m.DB_PATHS.map(source=>({source,exists:true}))}};
  return {root,dir,j,save:()=>m.durable(path.join(dir,'journal.json'),j)};
}
const badReadyRecords={
  'absent installation intent':j=>delete j.installationIntent,
  'preinstall boundary':j=>j.installationIntent=false,
  'empty original identity':j=>j.initialIdentity={},
  'missing CLI provenance':j=>delete j.initialIdentity.cliHash,
  'redirected skills path':j=>j.skillsDir=path.join(j.zylosDir,'unrelated-skills'),
  'redirected snapshot path':j=>j.dbBackupDir=path.join(j.zylosDir,'.backup/db/another'),
  'missing snapshot hash':j=>delete j.snapshotManifestHash,
  'incomplete core backup':j=>j.coreManifest[0].backedUp=false,
  'duplicate core member':j=>j.coreManifest.push({...j.coreManifest[0]}),
  'missing database identity':j=>j.initialIdentity.databases.pop(),
  'missing original service set':j=>delete j.originalServices,
};
for(const [label,alter] of Object.entries(badReadyRecords))test(`data-ready ${label} stays isolated without touching business files`,t=>{
  const f=readyFixture(t);alter(f.j);f.save();const business=path.join(f.root,'ordinary-business-file');fs.writeFileSync(business,'normal writes');
  const result=m.discover(f.root);assert.equal(result.blocked,true);assert.match(result.diagnostics.join(' '),/data-ready/);assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),/maintenance/);assert.equal(fs.readFileSync(business,'utf8'),'normal writes');
});
test('complete data-ready records allow subsequent legitimate writes without frozen hash revalidation',t=>{
  const f=readyFixture(t);for(const phase of ['new_data_ready','new_verifying','restored_data_ready','restored_verifying']){f.j.phase=phase;f.save();m.marker(f.root,f.dir,f.j);assert.equal(m.discover(f.root).blocked,false);assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(f.root));}
});
for(const phase of ['upgrade_complete','restored_complete','aborted_before_install'])test(`${phase} cannot hide incomplete original identity or directory manifest`,t=>{
  const f=readyFixture(t);Object.assign(f.j,{phase,installationIntent:phase!=='aborted_before_install',cleanup:{complete:true,markerRemoved:true,servicesRestored:true},terminalEvidence:{verified:true,kind:phase==='aborted_before_install'?'original_deployment_and_readonly_data':'code_data_services'}});
  assert.equal(m.terminalValid(f.j),true);
  for(const field of ['initialIdentity','coreManifest','originalServices']){const damaged={...f.j};delete damaged[field];m.durable(path.join(f.dir,'journal.json'),damaged);assert.equal(m.terminalValid(damaged),false);assert.equal(m.discover(f.root).blocked,true);}
});
test('verified preinstall abort before any completed backup requires original identity but no snapshot',t=>{
  const f=readyFixture(t);Object.assign(f.j,{phase:'aborted_before_install',installationIntent:false,cleanup:{complete:false},terminalEvidence:{verified:true,kind:'original_deployment_and_readonly_data'}});f.j.coreManifest[0].backedUp=false;delete f.j.dbBackupDir;delete f.j.snapshotManifestHash;f.save();assert.equal(m.discover(f.root).blocked,false);
  f.j.initialIdentity={};f.save();assert.equal(m.discover(f.root).blocked,true);assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),/maintenance/);
});
test('active overflow retains bounded candidate records and fails closed after the full scan',t=>{
  const f=readyFixture(t);for(let n=0;n<32;n++){const id='active-'+n,dir=path.join(f.root,'.backup/self-upgrade',id);fs.mkdirSync(dir,{mode:0o700});m.durable(path.join(dir,'journal.json'),{...f.j,transactionId:id,phase:'restoring'});}
  const found=m.discover(f.root);assert.equal(found.candidates.length,8);assert.equal(found.blocked,true);assert.match(found.diagnostics.join(' '),/active transaction limit exceeded/);assert.throws(()=>m.assertCoreDatabaseAvailable(f.root),/maintenance/);
  const budget=m.discover(f.root,{budget:8});assert.equal(budget.blocked,true);assert.match(budget.diagnostics.join(' '),/scan budget exhausted/);
});

for (const relative of ['.zylos', '.backup']) test(`legacy ${relative} mode0775 permits DB access without recovery materials`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-legacy-parent-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const parent = path.join(root, relative);
  fs.mkdirSync(parent, {mode:0o775});
  fs.chmodSync(parent, 0o775);
  assert.equal(m.discover(root).blocked, false);
  assert.doesNotThrow(() => m.assertCoreDatabaseAvailable(root));
  assert.equal(fs.statSync(parent).mode & 0o777, 0o775);
});
for (const relative of ['.zylos/upgrade', '.backup/self-upgrade', '.backup/self-upgrade-archive']) test(`writable recovery ${relative} remains fail closed when materials exist`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-writable-material-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const material = path.join(root, relative);
  fs.mkdirSync(material, {recursive:true, mode:0o700});
  fs.chmodSync(material, 0o775);
  m.durable(path.join(root, '.zylos/upgrade/active.json'), {});
  assert.equal(m.discover(root).blocked, true);
  assert.throws(() => m.assertCoreDatabaseAvailable(root), /maintenance/);
});
test('deployment root alias discovers canonical transaction and marker consistently', t => {
  const f = readyFixture(t);
  f.save();
  m.marker(f.root, f.dir, f.j);
  const alias = f.root + '-alias';
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.unlinkSync(alias));
  const canonical = m.discover(f.root);
  assert.deepEqual(m.discover(alias), canonical);
  assert.doesNotThrow(() => m.assertCoreDatabaseAvailable(alias));
});
test('staged initial journal controller follows atomic active publication', t => {
  const f = readyFixture(t);
  const staged = path.join(f.root, '.backup/self-upgrade-staging/tx');
  fs.mkdirSync(path.dirname(staged), {mode:0o700});
  fs.renameSync(f.dir, staged);
  m.durable(path.join(staged, 'journal.json'), f.j);
  const release = m.acquire(staged, {publishedDir:f.dir});
  fs.renameSync(staged, f.dir);
  assert.throws(() => m.acquire(f.dir), /still alive/);
  release();
  assert.equal(fs.existsSync(path.join(f.dir, 'controller.json')), false);
});
test('staged controller rejects publication outside the fixed transaction identity', t => {
  const f = readyFixture(t);
  const staged = path.join(f.root, '.backup/self-upgrade-staging/tx');
  fs.mkdirSync(path.dirname(staged), {mode:0o700});
  fs.renameSync(f.dir, staged);
  m.durable(path.join(staged, 'journal.json'), f.j);
  assert.throws(() => m.acquire(staged, {publishedDir:path.join(f.root, '.backup/self-upgrade/other')}), /invalid controller publication path/);
  assert.equal(fs.existsSync(path.join(staged, 'controller.json')), false);
});

for (const relative of ['.zylos', '.backup']) test(`legacy ${relative} directory symlink permits ordinary DB access`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-parent-alias-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const target = path.join(root, 'legacy-parent');
  fs.mkdirSync(target, {mode:0o775});
  fs.symlinkSync(target, path.join(root, relative));
  assert.doesNotThrow(() => m.assertCoreDatabaseAvailable(root));
  assert.equal(fs.lstatSync(path.join(root, relative)).isSymbolicLink(), true);
  m.durable(path.join(root, '.zylos/upgrade/active.json'), {});
  assert.throws(() => m.assertCoreDatabaseAvailable(root), /maintenance/);
});
for (const relative of ['.zylos/upgrade', '.backup/self-upgrade', '.backup/self-upgrade-archive']) test(`empty0775 ${relative} permits ordinary DB access`, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-empty-writable-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const directory = path.join(root, relative);
  fs.mkdirSync(directory, {recursive:true});
  fs.chmodSync(directory, 0o775);
  assert.doesNotThrow(() => m.assertCoreDatabaseAvailable(root));
  assert.equal(fs.statSync(directory).mode & 0o777, 0o775);
});
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

test('macOS frozen helper bytes are included in required descriptor hashes',{skip:process.platform!=='darwin'},t=>{
 const f=fixture(t);delete f.d.hashes['macos-recovery-helper'];
 assert.throws(()=>m.validateDescriptor(f.dir,f.j,f.d),/required recovery material hashes/);
 const g=fixture(t);fs.appendFileSync(path.join(g.dir,'macos-recovery-helper'),'tamper');
 assert.throws(()=>m.validateDescriptor(g.dir,g.j,g.d),/material hash mismatch/);
});
