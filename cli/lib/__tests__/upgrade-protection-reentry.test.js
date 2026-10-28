import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {maintenance as m,recovery,protectedSuccess,deployUpgradeBootstrap} from '../upgrade-protection.js';

function fixture(t,{terminal=false}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-parent-reentry-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const active=path.join(root,'.backup/self-upgrade/tx'),dir=active;
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
  for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dest));
  const parent={formatVersion:1,transactionId:'tx',zylosDir:root,initialIdentity:{nodePath:process.execPath},nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),phase:'installing',installationIntent:true,originalServices:[],cleanup:{complete:false}};
  parent.dbBackupDir=path.join(root,'.backup/db/tx');parent.snapshotManifestHash='a'.repeat(64);parent.coreManifest=[{name:'core',existedBefore:true,backedUp:true,originalHash:'b'.repeat(64)}];Object.assign(parent.initialIdentity,{packageJson:path.join(root,'package.json'),packageHash:'c'.repeat(64),cliRoot:path.join(root,'original-cli'),cliHash:'d'.repeat(64),workerPath:path.join(root,'original-cli/lib/worker.js'),workerHash:'e'.repeat(64),ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:true}))});
  const saved={...structuredClone(parent),phase:terminal?'upgrade_complete':'installing',...(terminal?{cleanup:{complete:true,servicesRestored:true},terminalEvidence:{verified:true,kind:'code_data_services'},finalizerExitConfirmed:true}:{})};
  m.durable(path.join(dir,'journal.json'),saved);
  const executed=path.join(root,'unsafe-runner-executed');fs.writeFileSync(path.join(dir,'runner.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(executed)},'executed');process.exit(99);`,{mode:0o600});
  const ctx={journal:parent,transactionId:'tx',transactionDir:active,releaseControl:m.acquire(dir),frozenRecoveryPath:path.join(stable,'recovery.cjs'),frozenRecoveryHash:m.hash(path.join(stable,'recovery.cjs'))};
  return {root,active,dir,ctx,saved,executed};
}
test('lost finalizer response retains verified active terminal without executing rollback runner',t=>{
 const f=fixture(t,{terminal:true});const result=recovery(f.ctx);assert.equal(result.recovery_required,false);assert.equal(result.stage,'upgrade_complete');assert.equal(result.attempted,false);assert.equal(result.completed,false);assert.equal(fs.existsSync(f.active),true);assert.equal(fs.existsSync(f.executed),false);assert.equal(m.discover(f.root).blocked,false);
});
test('restored terminal resolves in place without executing rollback runner',t=>{
 const f=fixture(t,{terminal:true});f.saved.phase='restored_complete';m.update(f.dir,f.saved);const result=recovery(f.ctx);
 assert.equal(result.recovery_required,false);assert.equal(result.stage,'restored_complete');assert.equal(result.completed,true);assert.equal(fs.existsSync(f.active),true);assert.equal(fs.existsSync(f.executed),false);assert.equal(fs.existsSync(path.join(f.dir,'controller.json')),false);
});



test('stable deployment reloads all frozen modules across same-process attempts',t=>{
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-frozen-generation-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const require=createRequire(import.meta.url),entry=deployUpgradeBootstrap(root),stable=path.dirname(entry);
 const first=new Map();
 for(const name of ['maintenance.cjs','recovery.cjs','finalizer.cjs','bootstrap.cjs']) first.set(name,require(path.join(stable,name)));
 deployUpgradeBootstrap(root);
 for(const [name,previous] of first) assert.notEqual(require(path.join(stable,name)),previous,name+' reused the prior generation');
});
