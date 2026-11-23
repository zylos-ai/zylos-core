import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
// Run for durable upgrade journals, marker validation or controller identity
// changes. Skip for unrelated changes. All copied modules and journal data live
// in a per-test temporary tree, with no service or database startup.
let root, m;
beforeEach(() => {
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-contracts-')));
  const stable=path.join(root,'.zylos','upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
  fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(stable,'maintenance.cjs'));fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/remove-owned-tree.js'),path.join(path.dirname(path.join(stable,'maintenance.cjs')),'remove-owned-tree.mjs'));
  fs.chmodSync(path.join(stable,'maintenance.cjs'),0o600);
  m=createRequire(import.meta.url)(path.join(stable,'maintenance.cjs'));
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
function transaction(id, phase, extra={}) {
  const dir=path.join(root,'.backup','self-upgrade',id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const journal={formatVersion:1,transactionId:id,zylosDir:root,phase,initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:'a'.repeat(64),cliRoot:path.join(root,'original-cli'),cliHash:'b'.repeat(64),workerPath:path.join(root,'original-cli/lib/worker.js'),workerHash:'c'.repeat(64),ecosystemHash:null,databases:[...m.DB_PATHS,'components/dashboard/dashboard.db'].map(source=>({source,exists:true}))},nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db',id),snapshotManifestHash:'d'.repeat(64),coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:'e'.repeat(64)}],originalServices:[],installationIntent:true,cleanup:{complete:false},...extra};
  m.durable(path.join(dir,'journal.json'),journal);return {dir,journal};
}
function terminal(id) {return transaction(id,'restored_complete',{cleanup:{complete:true,markerRemoved:true,servicesRestored:true},terminalEvidence:{verified:true,kind:'code_data_services'}});}
test('100 verified terminal directories do not hide one active transaction',()=>{
 for(let i=0;i<100;i++)terminal('done-'+i);
 transaction('active','restoring');
 const result=m.discover(root);assert.deepEqual(result.diagnostics, []);assert.deepEqual(result.candidates.map(c=>c.journal.transactionId), ['active']);assert.equal(result.blocked, true);
});
test('restored data ready allows normal DB access while recovery remains discoverable',()=>{
 for(const phase of ['restored_data_ready','restored_verifying']) {
  const {dir,journal}=transaction('ready',phase);m.marker(root,dir,journal);
  assert.equal(m.discover(root).blocked, false);assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(root));
 }
});
test('removed new-generation READY phases keep normal DB access isolated',()=>{
 for(const phase of ['new_data_ready','new_verifying']) {
  const {dir,journal}=transaction('obsolete-ready',phase);m.marker(root,dir,journal);
  assert.equal(m.discover(root).blocked, true);assert.throws(()=>m.assertCoreDatabaseAvailable(root));
 }
});
test('unmarked preparation stays visible to explicit discovery without gating ordinary writes',()=>{
 transaction('interrupted','preparing',{installationIntent:false});assert.equal(m.discover(root).blocked, true);assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(root));
});
test('malformed journal and malformed marker remain isolated',()=>{
 const {dir}=transaction('broken','restoring');fs.writeFileSync(path.join(dir,'journal.json'),'{',{mode:0o600});
 assert.ok(m.discover(root).diagnostics.length > 0);assert.equal(m.discover(root).blocked, true);
 fs.rmSync(dir,{recursive:true});m.durable(path.join(root,'.zylos/upgrade/active.json'),{formatVersion:1,transactionId:'missing',transactionDir:path.join(root,'.backup/self-upgrade/missing')});
 assert.equal(m.discover(root).blocked, true);assert.match(m.discover(root).diagnostics.join(' '), /marker has no valid transaction/);
});
test('verified terminal marker permits DB access and clears while retaining its journal',()=>{
 const {dir,journal}=terminal('done');m.marker(root,dir,journal);
 assert.equal(m.discover(root).blocked, false);assert.equal(m.discover(root).candidates.length, 1);
 assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(root));
 assert.equal(m.finishTerminal(dir,journal).complete, true);
 assert.equal(fs.existsSync(path.join(dir,'journal.json')), true);
 assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade/active.json')), false);
 assert.deepEqual(m.discover(root).candidates, []);
});
test('terminal marker remains isolated until durable child exit confirmation',()=>{
 const {dir,journal}=terminal('child');m.update(dir,journal,{finalizerStarted:true,finalizerExitConfirmed:false});m.marker(root,dir,journal);
 assert.equal(m.discover(root).blocked, true);assert.equal(m.finishTerminal(dir,journal).complete, false);
 assert.equal(fs.existsSync(path.join(root,'.zylos/upgrade/active.json')), true);
 // A caller's in-memory confirmation cannot substitute for durable evidence.
 journal.finalizerExitConfirmed=true;assert.equal(m.finishTerminal(dir,journal).complete, false);
 m.update(dir,journal);assert.equal(m.finishTerminal(dir,journal).complete, true);
 assert.equal(fs.existsSync(path.join(dir,'journal.json')), true);
});
test('terminal marker with a missing transaction stays isolated',()=>{
 const {dir,journal}=terminal('missing');m.marker(root,dir,journal);
 fs.renameSync(dir,path.join(root,'.backup','moved-terminal'));
 assert.equal(m.discover(root).blocked, true);assert.match(m.discover(root).diagnostics.join(' '), /marker has no valid transaction/);
});
(process.platform === 'linux' ? test : test.skip)('live controller rejects duplicate; PID reuse identity allows stale takeover',()=>{
 const {dir}=transaction('lock','offline');const first=m.acquire(dir);
 assert.throws(()=>m.acquire(dir), /still alive/);first();
 const stale={...m.identity(),start:'not-the-current-start'};assert.equal(m.alive(stale), false);m.durable(path.join(dir,'controller.json'),stale);
 const release=m.acquire(dir);assert.equal(m.alive(m.read(path.join(dir,'controller.json'))), true);release();assert.equal(fs.existsSync(path.join(dir,'controller.json')), false);
});
test('verified aborted terminal allows original services to open before cleanup completes',()=>{
 transaction('abort','aborted_before_install',{installationIntent:false,terminalEvidence:{verified:true,kind:'original_deployment_and_readonly_data'}});
 const result=m.discover(root);assert.equal(result.candidates.length, 1);assert.equal(result.blocked, false);assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(root));
});
