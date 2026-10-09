import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {maintenance as m,recovery} from '../upgrade-protection.js';

function fixture(t,{archived=false,terminal=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-parent-reentry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const active=path.join(root,'.backup/self-upgrade/tx'),archive=path.join(root,'.backup/self-upgrade-archive/tx'),dir=archived?archive:active;
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
  for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dest));
  const parent={formatVersion:1,transactionId:'tx',zylosDir:root,initialIdentity:{nodePath:process.execPath},nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),phase:'installing',installationIntent:true,originalServices:[],cleanup:{complete:false}};
  parent.dbBackupDir=path.join(root,'.backup/db/tx');parent.snapshotManifestHash='a'.repeat(64);parent.coreManifest=[{name:'core',existedBefore:true,backedUp:true,originalHash:'b'.repeat(64)}];Object.assign(parent.initialIdentity,{packageJson:path.join(root,'package.json'),packageHash:'c'.repeat(64),cliRoot:path.join(root,'original-cli'),cliHash:'d'.repeat(64),workerPath:path.join(root,'original-cli/lib/worker.js'),workerHash:'e'.repeat(64),ecosystemHash:null,databases:m.DB_PATHS.map(source=>({source,exists:true}))});
  const saved={...structuredClone(parent),phase:terminal?'upgrade_complete':'new_verifying',...(terminal?{cleanup:{complete:true,markerRemoved:true,servicesRestored:true},terminalEvidence:{verified:true,kind:'code_data_services'},cleanupPending:true,finalizerExitConfirmed:true}:{})};
  m.durable(path.join(dir,'journal.json'),saved);
  const executed=path.join(root,'unsafe-runner-executed');fs.writeFileSync(path.join(dir,'runner.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(executed)},'executed');process.exit(99);`,{mode:0o600});
  const ctx={journal:parent,transactionId:'tx',transactionDir:active,releaseControl:m.acquire(dir)};
  return {root,active,archive,dir,ctx,saved,executed};
}
test('parent finalizer blocker preserves newer child phase, identity and creation intent',t=>{
  const f=fixture(t);Object.assign(f.saved,{finalizerExecution:{pid:7,start:'child-start',boot:'child-boot',nonce:'saved'},ecosystemCreationIntent:{target:'child-target',originalMissing:true,intendedHash:'a'.repeat(64)},actions:{durableChildStep:{done:true}}});m.update(f.dir,f.saved);
  f.ctx.finalizerExitUnconfirmed=true;const stop=m.stop;m.stop=()=>{};let result;try{result=recovery(f.ctx);}finally{m.stop=stop;}
  assert.equal(result.recovery_required,true);const current=m.read(path.join(f.dir,'journal.json'));
  assert.equal(current.phase,'recovery_required');assert.equal(current.resumePhase,'restoring');assert.deepEqual(current.finalizerExecution,f.saved.finalizerExecution);assert.deepEqual(current.ecosystemCreationIntent,f.saved.ecosystemCreationIntent);assert.deepEqual(current.actions,f.saved.actions);assert.equal(m.discover(f.root).blocked,true);assert.equal(fs.existsSync(f.executed),false);
});
test('lost finalizer response uses verified active terminal cleanup without executing rollback runner',t=>{
  const f=fixture(t,{terminal:true});const result=recovery(f.ctx);assert.equal(result.recovery_required,false);assert.equal(result.stage,'upgrade_complete');assert.equal(result.attempted,false);assert.equal(result.completed,false);assert.equal(fs.existsSync(f.active),false);assert.equal(fs.existsSync(f.archive),true);assert.equal(fs.existsSync(f.executed),false);assert.equal(m.discover(f.root).blocked,false);
});
test('already archived terminal is resolved and never recreates original active directory',t=>{
  const f=fixture(t,{archived:true,terminal:true});f.saved.phase='restored_complete';m.update(f.dir,f.saved);const result=recovery(f.ctx);
  assert.equal(result.recovery_required,false);assert.equal(result.stage,'restored_complete');assert.equal(result.completed,true);assert.equal(fs.existsSync(f.active),false);assert.equal(fs.existsSync(f.executed),false);assert.equal(fs.existsSync(path.join(f.archive,'controller.json')),false);
});
test('archived unconfirmed finalizer retains terminal evidence and canonical isolation pointer',t=>{
  const f=fixture(t,{archived:true,terminal:true});f.saved.finalizerExecution={pid:8,start:'retained-start',boot:'retained-boot'};m.update(f.dir,f.saved);f.ctx.finalizerExitUnconfirmed=true;
  const stop=m.stop;m.stop=()=>{};let result;try{result=recovery(f.ctx);}finally{m.stop=stop;}
  const current=m.read(path.join(f.archive,'journal.json'));assert.equal(result.recovery_required,true);assert.equal(current.phase,'upgrade_complete');assert.equal(current.terminalEvidence.verified,true);assert.deepEqual(current.finalizerExecution,f.saved.finalizerExecution);assert.equal(current.archiveServicesStopped,true);assert.equal(current.archiveRecoveryRequired,true);assert.equal(fs.existsSync(f.active),false);const marker=m.read(path.join(f.root,'.zylos/upgrade/active.json'));assert.equal(marker.transactionDir,f.active);assert.equal(m.discover(f.root).blocked,true);assert.equal(fs.existsSync(f.executed),false);
});
test('active and archived material conflict refuses execution',t=>{
  const f=fixture(t,{terminal:true});fs.mkdirSync(f.archive,{recursive:true,mode:0o700});m.durable(path.join(f.archive,'journal.json'),f.saved);const result=recovery(f.ctx);assert.equal(result.recovery_required,true);assert.match(result.error,/ambiguous active and archived/);assert.equal(fs.existsSync(f.executed),false);assert.equal(fs.existsSync(f.active),true);
});
