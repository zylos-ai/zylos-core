import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {maintenance as m,recovery,protectedSuccess} from '../upgrade-protection.js';

function fixture(t,{terminal=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-parent-reentry-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const active=path.join(root,'.backup/self-upgrade/tx'),dir=active;
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
  for(const [src,dest] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dest));
  const parent={formatVersion:1,transactionId:'tx',zylosDir:root,initialIdentity:{nodePath:process.execPath},nodePath:process.execPath,skillsDir:path.join(root,'.claude/skills'),phase:'installing',installationIntent:true,originalServices:[],cleanup:{complete:false}};
  parent.dbBackupDir=path.join(root,'.backup/db/tx');parent.snapshotManifestHash='a'.repeat(64);parent.coreManifest=[{name:'core',existedBefore:true,backedUp:true,originalHash:'b'.repeat(64)}];Object.assign(parent.initialIdentity,{packageJson:path.join(root,'package.json'),packageHash:'c'.repeat(64),cliRoot:path.join(root,'original-cli'),cliHash:'d'.repeat(64),workerPath:path.join(root,'original-cli/lib/worker.js'),workerHash:'e'.repeat(64),ecosystemHash:null,databases:m.DB_PATHS.map(source=>({source,exists:true}))});
  const saved={...structuredClone(parent),phase:terminal?'upgrade_complete':'new_verifying',...(terminal?{cleanup:{complete:true,servicesRestored:true},terminalEvidence:{verified:true,kind:'code_data_services'},finalizerExitConfirmed:true}:{})};
  m.durable(path.join(dir,'journal.json'),saved);
  const executed=path.join(root,'unsafe-runner-executed');fs.writeFileSync(path.join(dir,'runner.cjs'),`require('node:fs').writeFileSync(${JSON.stringify(executed)},'executed');process.exit(99);`,{mode:0o600});
  const ctx={journal:parent,transactionId:'tx',transactionDir:active,releaseControl:m.acquire(dir)};
  return {root,active,dir,ctx,saved,executed};
}
test('parent finalizer blocker preserves newer child phase, identity and creation intent',t=>{
  const f=fixture(t);Object.assign(f.saved,{finalizerStarted:true,finalizerPid:7,ecosystemCreationIntent:{target:'child-target',originalMissing:true,intendedHash:'a'.repeat(64)},actions:{durableChildStep:{done:true}}});m.update(f.dir,f.saved);
  f.ctx.finalizerExitUnconfirmed=true;const stop=m.stop;m.stop=()=>{};let result;try{result=recovery(f.ctx);}finally{m.stop=stop;}
  assert.equal(result.recovery_required,true);const current=m.read(path.join(f.dir,'journal.json'));
  assert.equal(current.phase,'recovery_required');assert.equal(current.resumePhase,'restoring');assert.equal(current.finalizerPid,f.saved.finalizerPid);assert.deepEqual(current.ecosystemCreationIntent,f.saved.ecosystemCreationIntent);assert.deepEqual(current.actions,f.saved.actions);assert.equal(m.discover(f.root).blocked,true);assert.equal(fs.existsSync(f.executed),false);
});
test('lost finalizer response retains verified active terminal without executing rollback runner',t=>{
 const f=fixture(t,{terminal:true});const result=recovery(f.ctx);assert.equal(result.recovery_required,false);assert.equal(result.stage,'upgrade_complete');assert.equal(result.attempted,false);assert.equal(result.completed,false);assert.equal(fs.existsSync(f.active),true);assert.equal(fs.existsSync(f.executed),false);assert.equal(m.discover(f.root).blocked,false);
});
test('restored terminal resolves in place without executing rollback runner',t=>{
 const f=fixture(t,{terminal:true});f.saved.phase='restored_complete';m.update(f.dir,f.saved);const result=recovery(f.ctx);
 assert.equal(result.recovery_required,false);assert.equal(result.stage,'restored_complete');assert.equal(result.completed,true);assert.equal(fs.existsSync(f.active),true);assert.equal(fs.existsSync(f.executed),false);assert.equal(fs.existsSync(path.join(f.dir,'controller.json')),false);
});
test('unconfirmed finalizer retains terminal evidence and marks service restoration required',t=>{
 const f=fixture(t,{terminal:true});f.saved.finalizerStarted=true;f.saved.finalizerPid=8;m.update(f.dir,f.saved);f.ctx.finalizerExitUnconfirmed=true;
 const stop=m.stop;m.stop=()=>{};let result;try{result=recovery(f.ctx);}finally{m.stop=stop;}
 const current=m.read(path.join(f.dir,'journal.json'));assert.equal(result.recovery_required,true);assert.equal(current.phase,'upgrade_complete');assert.equal(current.terminalEvidence.verified,true);assert.equal(current.finalizerPid,8);assert.equal(current.terminalServicesStopped,true);assert.equal(fs.existsSync(f.active),true);const marker=m.read(path.join(f.root,'.zylos/upgrade/active.json'));assert.equal(marker.transactionDir,f.active);assert.equal(m.discover(f.root).blocked,true);assert.equal(fs.existsSync(f.executed),false);
});

test('child success retains the marker until parent durably confirms finalizer exit',t=>{
 const f=fixture(t);m.update(f.dir,f.saved,{finalizerStarted:true,finalizerPid:123,finalizerExitConfirmed:false});
 m.marker(f.root,f.dir,f.saved);
 const cleanup=protectedSuccess({transactionDir:f.dir});assert.equal(cleanup.complete,false);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),true);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/cleanup.json')),false);
 const saved=m.read(path.join(f.dir,'journal.json'));assert.equal(saved.phase,'upgrade_complete');
 m.update(f.dir,saved,{finalizerExitConfirmed:true,finalizerExitUnconfirmed:false});
 assert.equal(m.finishTerminal(f.dir,saved).complete,true);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),false);
 assert.equal(fs.existsSync(f.dir),true);
});
