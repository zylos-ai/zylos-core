import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { beforeEach, afterEach, test, expect } from '@jest/globals';
let root, m;
beforeEach(() => {
  root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-contracts-')));
  const stable=path.join(root,'.zylos','upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
  fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(stable,'maintenance.cjs'));
  fs.chmodSync(path.join(stable,'maintenance.cjs'),0o600);
  m=createRequire(import.meta.url)(path.join(stable,'maintenance.cjs'));
});
afterEach(()=>fs.rmSync(root,{recursive:true,force:true}));
function transaction(id, phase, extra={}) {
  const dir=path.join(root,'.backup','self-upgrade',id);fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const journal={formatVersion:1,transactionId:id,zylosDir:root,phase,initialIdentity:{nodePath:process.execPath,packageJson:path.join(root,'package.json'),packageHash:'a'.repeat(64),cliRoot:path.join(root,'original-cli'),cliHash:'b'.repeat(64),workerPath:path.join(root,'original-cli/lib/worker.js'),workerHash:'c'.repeat(64),ecosystemHash:null,databases:m.DB_PATHS.map(source=>({source,exists:true}))},nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),dbBackupDir:path.join(root,'.backup/db',id),snapshotManifestHash:'d'.repeat(64),coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:'e'.repeat(64)}],originalServices:[],installationIntent:true,cleanup:{complete:false},...extra};
  m.durable(path.join(dir,'journal.json'),journal);return {dir,journal};
}
function terminal(id) {return transaction(id,'restored_complete',{cleanup:{complete:true,markerRemoved:true,servicesRestored:true},terminalEvidence:{verified:true,kind:'code_data_services'}});}
test('100 verified terminal directories do not hide one active transaction',()=>{
 for(let i=0;i<100;i++)terminal('done-'+i);
 transaction('active','restoring');
 const result=m.discover(root);expect(result.diagnostics).toEqual([]);expect(result.candidates.map(c=>c.journal.transactionId)).toEqual(['active']);expect(result.blocked).toBe(true);
});
test('full data ready allows normal DB access while recovery remains discoverable',()=>{
 for(const phase of ['new_data_ready','new_verifying','restored_data_ready','restored_verifying']) {
  const {dir,journal}=transaction('ready',phase);m.marker(root,dir,journal);
  expect(m.discover(root).blocked).toBe(false);expect(()=>m.assertCoreDatabaseAvailable(root)).not.toThrow();
 }
});
test('missing marker does not hide unfinished transaction',()=>{
 transaction('interrupted','offline');expect(m.discover(root).blocked).toBe(true);expect(()=>m.assertCoreDatabaseAvailable(root)).toThrow(/maintenance/);
});
test('malformed journal and malformed marker remain isolated',()=>{
 const {dir}=transaction('broken','restoring');fs.writeFileSync(path.join(dir,'journal.json'),'{',{mode:0o600});
 expect(m.discover(root).diagnostics.length).toBeGreaterThan(0);expect(m.discover(root).blocked).toBe(true);
 fs.rmSync(dir,{recursive:true});m.durable(path.join(root,'.zylos/upgrade/active.json'),{formatVersion:1,transactionId:'missing',transactionDir:path.join(root,'.backup/self-upgrade/missing')});
 expect(m.discover(root).blocked).toBe(true);expect(m.discover(root).diagnostics.join(' ')).toMatch(/marker has no valid transaction/);
});
test('verified terminal marker permits DB access and clears while retaining its journal',()=>{
 const {dir,journal}=terminal('done');m.marker(root,dir,journal);
 expect(m.discover(root).blocked).toBe(false);expect(m.discover(root).candidates).toHaveLength(1);
 expect(()=>m.assertCoreDatabaseAvailable(root)).not.toThrow();
 expect(m.finishTerminal(dir,journal).complete).toBe(true);
 expect(fs.existsSync(path.join(dir,'journal.json'))).toBe(true);
 expect(fs.existsSync(path.join(root,'.zylos/upgrade/active.json'))).toBe(false);
 expect(m.discover(root).candidates).toEqual([]);
});
test('terminal marker remains isolated until durable child exit confirmation',()=>{
 const {dir,journal}=terminal('child');m.update(dir,journal,{finalizerStarted:true,finalizerExitConfirmed:false});m.marker(root,dir,journal);
 expect(m.discover(root).blocked).toBe(true);expect(m.finishTerminal(dir,journal).complete).toBe(false);
 expect(fs.existsSync(path.join(root,'.zylos/upgrade/active.json'))).toBe(true);
 // A caller's in-memory confirmation cannot substitute for durable evidence.
 journal.finalizerExitConfirmed=true;expect(m.finishTerminal(dir,journal).complete).toBe(false);
 m.update(dir,journal);expect(m.finishTerminal(dir,journal).complete).toBe(true);
 expect(fs.existsSync(path.join(dir,'journal.json'))).toBe(true);
});
test('terminal marker with a missing transaction stays isolated',()=>{
 const {dir,journal}=terminal('missing');m.marker(root,dir,journal);
 fs.renameSync(dir,path.join(root,'.backup','moved-terminal'));
 expect(m.discover(root).blocked).toBe(true);expect(m.discover(root).diagnostics.join(' ')).toMatch(/marker has no valid transaction/);
});
(process.platform === 'linux' ? test : test.skip)('live controller rejects duplicate; PID reuse identity allows stale takeover',()=>{
 const {dir}=transaction('lock','offline');const first=m.acquire(dir);
 expect(()=>m.acquire(dir)).toThrow(/still alive/);first();
 const stale={...m.identity(),start:'not-the-current-start'};expect(m.alive(stale)).toBe(false);m.durable(path.join(dir,'controller.json'),stale);
 const release=m.acquire(dir);expect(m.alive(m.read(path.join(dir,'controller.json')))).toBe(true);release();expect(fs.existsSync(path.join(dir,'controller.json'))).toBe(false);
});
test('verified aborted terminal allows original services to open before cleanup completes',()=>{
 transaction('abort','aborted_before_install',{installationIntent:false,terminalEvidence:{verified:true,kind:'original_deployment_and_readonly_data'}});
 const result=m.discover(root);expect(result.candidates).toHaveLength(1);expect(result.blocked).toBe(false);expect(()=>m.assertCoreDatabaseAvailable(root)).not.toThrow();
});
