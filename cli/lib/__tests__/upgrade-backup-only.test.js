import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {runSelfUpgrade,createFinalizeState,runSelfUpgradeFinalize} from '../self-upgrade.js';
import {CORE_DATABASES,runCoreDbWorker} from '../core-db-backup.js';
import {maintenance as m} from '../upgrade-protection.js';
const require=createRequire(import.meta.url);
const Database=require(path.resolve('skills/comm-bridge/node_modules/better-sqlite3'));

function fixture(t) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-backup-only-')));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const skillsDir=path.join(root,'.claude/skills'),tempDir=path.join(root,'new-package'),calls=[];
 for(const item of CORE_DATABASES) {
  const owner=path.join(skillsDir,item.owner);fs.mkdirSync(owner,{recursive:true});
  fs.writeFileSync(path.join(owner,'package.json'),'{"type":"module"}');
  fs.symlinkSync(path.resolve('skills',item.owner,'node_modules'),path.join(owner,'node_modules'));
  const file=path.join(root,item.source);fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);db.exec('CREATE TABLE preserved(value TEXT)');
  db.prepare('INSERT INTO preserved VALUES (?)').run(item.source);db.close();
 }
 fs.mkdirSync(path.join(tempDir,'skills'),{recursive:true});
 const bin=path.join(root,'bin'),state=path.join(root,'pm2-state'),pm2Calls=path.join(root,'pm2-calls');
 fs.mkdirSync(bin);fs.writeFileSync(state,'online');
 fs.writeFileSync(path.join(bin,'pm2'),`#!${process.execPath}
 const fs=require('node:fs'),args=process.argv.slice(2),state=${JSON.stringify(state)};
 fs.appendFileSync(${JSON.stringify(pm2Calls)},JSON.stringify(args)+'\\n');
 if(args[0]==='jlist')console.log(JSON.stringify([{name:'fixture-service',pid:0,pm2_env:{status:fs.readFileSync(state,'utf8'),pm_exec_path:${JSON.stringify(path.join(skillsDir,'comm-bridge/service.js'))}}}]));
 else if(args[0]==='stop')fs.writeFileSync(state,'stopped');
 else {console.error('unexpected PM2 boundary '+args[0]);process.exit(19);}
 `,{mode:0o700});
 const prior=process.env.PATH;process.env.PATH=bin+path.delimiter+prior;t.after(()=>{process.env.PATH=prior;});
 function snapshots() {
  const dir=path.join(root,'.backup/db');
  const groups=fs.existsSync(dir)?fs.readdirSync(dir).filter(n=>!n.startsWith('.')):[];
  assert.equal(groups.length,1,'one published snapshot must exist before npm');
  const dbBackupDir=path.join(dir,groups[0]),manifest=JSON.parse(fs.readFileSync(path.join(dbBackupDir,'manifest.json')));
  assert.equal(manifest.status,'complete');assert.equal(manifest.databases.length,3);
  for(const row of manifest.databases) {
   assert.equal(row.status,'backed_up');
   const db=new Database(path.join(dbBackupDir,row.file),{readonly:true});
   try {assert.equal(db.prepare('SELECT value FROM preserved').get().value,row.source);}finally{db.close();}
  }
  assert.equal(runCoreDbWorker({action:'verify',zylosDir:root,dbBackupDir,manifest}).databases.length,3);
  return dbBackupDir;
 }
 function untouchedMaintenance() {
  const found=m.discover(root);assert.deepEqual(found.candidates,[]);assert.deepEqual(found.diagnostics,[]);assert.ok(!found.marker);
  for(const item of CORE_DATABASES)assert.doesNotThrow(()=>m.assertCoreDatabaseAvailable(root,path.join(root,item.source)));
 }
 const deps={zylosDir:root,skillsDir,protectionSupported:()=>false,getCurrentVersion:()=>({success:true,version:'old'}),
  step1:{zylosDir:root,skillsDir,backupDir:path.join(root,'code-backup')},
  step4:{execSync:command=>{snapshots();assert.equal(fs.readFileSync(state,'utf8'),'stopped');calls.push(command);return command.startsWith('npm pack')?'fixture.tgz':'';}},
  runInstalledFinalizer:ctx=>{assert.equal(ctx.backupOnly,true);assert.equal(ctx.preInstallProtection,false);return {success:true,steps:[]};}};
 return {root,skillsDir,tempDir,calls,deps,snapshots,untouchedMaintenance,state,pm2Calls,run:()=>runSelfUpgrade({tempDir,newVersion:'new'},deps)};
}

for(const platform of ['linux','darwin'])test(`${platform} without automatic recovery still publishes and verifies three databases before npm`,t=>{
 const f=fixture(t);f.deps.platform=platform;const result=f.run();
 assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.backupOnly,true);assert.equal(result.automaticRecovery,false);
 assert.equal(result.dbBackupDir,f.snapshots());assert.equal(result.databases.length,3);assert.equal(f.calls.length,2);
 assert.match(result.protectionUnavailableReason,/manual|automatic/i);assert.equal(result.manualRecovery.required,false);
 assert.ok(fs.readFileSync(f.pm2Calls,'utf8').includes('["stop","fixture-service"]'));
 f.untouchedMaintenance();
});

for(const fault of ['stop','snapshot','verify','sync'])test(`backup-only ${fault} failure prevents npm and finalizer without publishing a recovery transaction`,t=>{
 const f=fixture(t);let finalized=false;
 f.deps.runInstalledFinalizer=()=>{finalized=true;throw Error('finalizer must not run');};
 if(fault==='snapshot') {fs.mkdirSync(path.join(f.root,'.backup'),{recursive:true});fs.writeFileSync(path.join(f.root,'.backup/db'),'blocked');}
 if(fault==='stop')f.deps.step3={stop:()=>{throw Error('injected stop failure');}};
 if(fault==='verify')f.deps.step3={verifySnapshot:()=>{throw Error('injected snapshot verification failure');}};
 if(fault==='sync')f.deps.step3={probeSnapshotSync:()=>{throw Error('injected snapshot sync unavailable');}};
 const result=f.run();assert.equal(result.success,false,JSON.stringify(result));assert.equal(result.backupOnly,true);
 assert.equal(f.calls.length,0);assert.equal(finalized,false);assert.notEqual(result.rollback?.performed,true);
 assert.match(result.error,/injected|EEXIST|ENOTDIR/);f.untouchedMaintenance();
});

for(const fault of ['installer','finalizer-result','finalizer-throw'])test(`backup-only ${fault} failure retains snapshots and never restores live databases`,t=>{
 const f=fixture(t);let changed=false;
 const change=()=>{for(const item of CORE_DATABASES){const db=new Database(path.join(f.root,item.source));db.prepare('UPDATE preserved SET value=?').run('post-install');db.close();}changed=true;};
 const exec=f.deps.step4.execSync;
 f.deps.step4.execSync=command=>{const value=exec(command);if(command.startsWith('npm install')){change();if(fault==='installer')throw Error('injected npm failure');}return value;};
 f.deps.runInstalledFinalizer=()=>{if(fault==='finalizer-throw')throw Error('injected finalizer failure');return {success:false,error:'injected finalizer failure',steps:[]};};
 f.deps.rollbackSelf=()=>{throw Error('legacy automatic rollback must not run');};
 const result=f.run();assert.equal(result.success,false,JSON.stringify(result));assert.equal(changed,true);assert.equal(result.backupOnly,true);
 assert.equal(result.automaticRecovery,false);assert.notEqual(result.rollback?.performed,true);assert.equal(result.manualRecovery.required,true);
 assert.equal(result.dbBackupDir,f.snapshots());assert.equal(result.manualRecovery.dbBackupDir,result.dbBackupDir);
 for(const item of CORE_DATABASES){const db=new Database(path.join(f.root,item.source));try{assert.equal(db.prepare('SELECT value FROM preserved').get().value,'post-install');}finally{db.close();}}
 f.untouchedMaintenance();
});

// Exercise the actual capability implementation with narrowly simulated Linux
// OS boundaries. This is not a native Linux execution on the macOS test host.
function capabilityModule({missingProc=false,missingFlock=false,platform='linux',macFault=null}={}) {
 const filename=path.resolve('cli/lib/upgrade-maintenance.cjs');
 const source=fs.readFileSync(filename,'utf8'),module={exports:{}};
 const fakeFs={...fs,
  readFileSync(file,...args) {
   if(file===`/proc/${process.pid}/stat`) {
    if(missingProc)throw Object.assign(Error('proc unavailable'),{code:'ENOENT'});
    return `${process.pid} (fixture) `+Array.from({length:20},(_,i)=>i===19?'12345':'0').join(' ');
   }
   if(file==='/proc/sys/kernel/random/boot_id')return 'fixture-boot';
   return fs.readFileSync(file,...args);
  },
  realpathSync(file,...args) {
   if(['/usr/bin/flock','/bin/flock'].includes(file)) {
    if(missingFlock)throw Object.assign(Error('flock absent'),{code:'ENOENT'});
    return '/fixture/trusted-flock';
   }
   return fs.realpathSync(file,...args);
  },
  statSync(file,...args) {
   if(file==='/fixture/trusted-flock')return {isFile:()=>true,mode:0o100755,uid:0};
   return fs.statSync(file,...args);
  }
 };
 vm.runInNewContext(source,{module,exports:module.exports,__filename:filename,__dirname:path.dirname(filename),
  process:{...process,platform},require:id=>{
   if(id==='node:fs')return fakeFs;
   if(id==='node:child_process' && platform==='darwin')return {...require(id),spawnSync(file,args,opts){
    if(args[0]==='identity')return {status:0,stdout:JSON.stringify(macFault==='identity'?{pid:process.pid,status:'absent'}:{pid:process.pid,status:'present',boot:'fixture-boot',start:'123:456'})};
    if(args[0]==='probe')return {status:macFault==='probe'?1:0,stdout:JSON.stringify({protocol:1})};
    throw Error('unexpected mock helper command '+args[0]);
   }};
   return require(id);
  }});
 return module.exports;
}

test('Linux capability probe distinguishes trusted flock and present identity from each missing capability',()=>{
 assert.equal(capabilityModule().platformSupported('linux'),true,'positive control requires both capabilities');
 assert.equal(capabilityModule({missingFlock:true}).platformSupported('linux'),false);
 assert.equal(capabilityModule({missingProc:true}).identity().absent,true);
 assert.equal(capabilityModule({missingProc:true}).platformSupported('linux'),false);
});

for(const missing of ['missingFlock','missingProc'])test(`actual capability decision for Linux ${missing} still requires verified snapshots before installation`,t=>{
 const f=fixture(t),capability=capabilityModule({[missing]:true});
 f.deps.platform='linux';f.deps.protectionSupported=()=>capability.platformSupported('linux');
 const result=f.run();assert.equal(result.success,true,JSON.stringify(result));
 assert.equal(result.backupOnly,true);assert.equal(result.dbSnapshotVerified,true);
 assert.equal(result.dbBackupDir,f.snapshots());assert.equal(f.calls.length,2);f.untouchedMaintenance();
});

for(const fail of [false,true])test(`backup-only serialized finalizer state preserves snapshots and manual recovery on ${fail?'failure':'success'}`,t=>{
 const f=fixture(t);
 f.deps.runInstalledFinalizer=ctx=>{
  const state=JSON.parse(JSON.stringify(createFinalizeState(ctx)));
  assert.equal(state.schemaVersion,1);assert.equal(state.backupOnly,true);assert.equal(state.dbSnapshotVerified,true);
  assert.equal(state.backupDir,ctx.backupDir);assert.ok(state.backupDir);
  assert.equal(state.dbManifest.databases.length,3);assert.equal(state.dbBackupDir,ctx.dbBackupDir);
  return runSelfUpgradeFinalize(state,{steps:[restored=>{
   assert.equal(restored.backupDir,ctx.backupDir);assert.equal(restored.backupOnly,true);assert.equal(restored.dbSnapshotVerified,true);
   assert.equal(restored.dbBackupDir,ctx.dbBackupDir);assert.deepEqual(restored.dbManifest,ctx.dbManifest);
   assert.deepEqual(restored.servicesWereRunning,ctx.servicesWereRunning);
   return {step:5,name:'fixture_finalize',status:fail?'failed':'done',...(fail?{error:'injected serialized finalizer failure'}:{})};
  }]});
 };
 const result=f.run();assert.equal(result.success,!fail,JSON.stringify(result));
 if(fail)assert.equal(result.error,'injected serialized finalizer failure');
 assert.equal(result.backupDir,path.join(f.root,'code-backup'));assert.ok(fs.existsSync(result.backupDir));
 assert.equal(result.manualRecovery.required,fail);assert.equal(result.dbBackupDir,f.snapshots());
 assert.equal(result.dbSnapshotVerified,true);assert.equal(result.automaticRecovery,false);
 assert.notEqual(result.rollback?.performed,true);f.untouchedMaintenance();
});

for(const macFault of ['identity','probe'])test(`macOS ${macFault} capability failure permits real native fullsync snapshots before installation`,{skip:process.platform!=='darwin'},t=>{
 const positive=capabilityModule({platform:'darwin'});
 assert.equal(positive.platformSupported('darwin'),true);
 const capability=capabilityModule({platform:'darwin',macFault});
 assert.equal(capability.platformSupported('darwin'),false);
 const f=fixture(t);f.deps.platform='darwin';f.deps.protectionSupported=()=>capability.platformSupported('darwin');
 const result=f.run();assert.equal(result.success,true,JSON.stringify(result));
 assert.equal(result.backupOnly,true);assert.equal(result.dbSnapshotVerified,true);
 assert.equal(result.dbBackupDir,f.snapshots());assert.equal(f.calls.length,2);f.untouchedMaintenance();
});
