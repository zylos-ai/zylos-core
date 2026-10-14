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
  fs.mkdirSync(path.join(owner,'scripts'));
  fs.writeFileSync(path.join(owner,item.schema),`export const supportsNewDatabase=true;export const TABLES={preserved:['value']};export function inspectSchema(db){db.prepare('SELECT value FROM preserved').all();return {extensions:{tables:[],columns:[]}};}`);
  fs.writeFileSync(path.join(owner,'scripts/sqlite-schema.js'),'export {}; // pre-chain compatibility fixture');
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
 if(args[0]==='jlist')console.log(JSON.stringify([{name:'fixture-service',pid:fs.readFileSync(state,'utf8')==='online'?process.pid:0,pm2_env:{status:fs.readFileSync(state,'utf8'),pm_exec_path:${JSON.stringify(path.join(skillsDir,'comm-bridge/service.js'))}}},{name:'previously-stopped',pid:0,pm2_env:{status:'stopped',pm_exec_path:${JSON.stringify(path.join(skillsDir,'comm-bridge/stopped.js'))}}}]));
 else if(args[0]==='stop')fs.writeFileSync(state,'stopped');
 else if(args[0]==='restart'){if(args[1]!=='fixture-service')throw Error('must not restart previously stopped service');fs.writeFileSync(state,'online');}
 else if(args[0]!=='save'){console.error('unexpected PM2 boundary '+args[0]);process.exit(19);}
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
  probeCoreDbVersions:()=>({needsMigration:true,databases:CORE_DATABASES.map((item,index)=>({source:item.source,status:'present',fromVersion:index?1:0,toVersion:1,needsMigration:index===0}))}),
  rehearseCoreDbUpgrade:()=>({databases:[]}),
  step1:{zylosDir:root,skillsDir,backupDir:path.join(root,'code-backup')},
  step4:{execSync:command=>{snapshots();assert.equal(fs.readFileSync(state,'utf8'),'stopped');calls.push(command);return command.startsWith('npm pack')?'fixture.tgz':'';}},
  runInstalledFinalizer:ctx=>{assert.equal(ctx.backupOnly,true);assert.equal(ctx.preInstallProtection,false);return {success:true,steps:[]};}};
 return {root,skillsDir,tempDir,calls,deps,snapshots,untouchedMaintenance,state,pm2Calls,run:()=>runSelfUpgrade({tempDir,newVersion:'new'},deps)};
}

test('matching versions clean old rehearsals and snapshot databases without rehearsal or migration', t => {
 const f=fixture(t);
 fs.mkdirSync(path.join(f.tempDir,'cli/lib'),{recursive:true});
 fs.writeFileSync(path.join(f.tempDir,'cli/lib/core-db-upgrade-protocol.json'),'{"codeOnlyVersion":1}');
 const rehearsalRoot=path.join(f.root,'.backup/db');fs.mkdirSync(rehearsalRoot,{recursive:true});
 const fixed=path.join(rehearsalRoot,'.rehearsal'),legacy=path.join(rehearsalRoot,'.rehearsal-old');
 fs.mkdirSync(fixed);fs.mkdirSync(legacy);
 const before=CORE_DATABASES.map(item=>fs.readFileSync(path.join(f.root,item.source)));
 f.deps.probeCoreDbVersions=()=>({needsMigration:false,databases:CORE_DATABASES.map(item=>({source:item.source,status:'present',fromVersion:1,toVersion:1,needsMigration:false}))});
 f.deps.preflightCoreDbUpgrade=()=>assert.fail('database preflight must be skipped');
 f.deps.rehearseCoreDbUpgrade=()=>assert.fail('rehearsal must be skipped');
 f.deps.step4={execSync:command=>{f.snapshots();assert.equal(fs.readFileSync(f.state,'utf8'),'stopped');f.calls.push(command);return command.startsWith('npm pack')?'fixture.tgz':'';}};
 const result=f.run();
 assert.equal(result.success,true,JSON.stringify(result));
 assert.equal(result.dbBackupDir,f.snapshots());
 assert.equal(result.dbSnapshotVerified,true);
 assert.equal(f.calls.length,2);
 assert.deepEqual(result.rehearsalCleanup.removed.sort(),[fixed,legacy].sort());
 assert.equal(fs.existsSync(fixed),false);assert.equal(fs.existsSync(legacy),false);
 assert.deepEqual(CORE_DATABASES.map(item=>fs.readFileSync(path.join(f.root,item.source))),before);
 f.untouchedMaintenance();
});
test('an unsafe leftover rehearsal link rejects before service stop', t => {
 const f=fixture(t),root=path.join(f.root,'.backup/db');fs.mkdirSync(root,{recursive:true});
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);fs.symlinkSync(outside,path.join(root,'.rehearsal'));
 const result=f.run();
 assert.equal(result.success,false);assert.match(result.error,/Unsafe rehearsal copy/);
 assert.equal(fs.readFileSync(f.state,'utf8'),'online');assert.equal(f.calls.length,0);
 assert.equal(fs.lstatSync(path.join(root,'.rehearsal')).isSymbolicLink(),true);
});

test('matching versions reject a target without the code-only finalizer protocol before stop', t => {
 const f=fixture(t);
 f.deps.probeCoreDbVersions=()=>({needsMigration:false,databases:CORE_DATABASES.map(item=>({source:item.source,status:'present',fromVersion:1,toVersion:1,needsMigration:false}))});
 const result=f.run();
 assert.equal(result.success,false);
 assert.match(result.error,/code-only database upgrade/);
 assert.equal(fs.readFileSync(f.state,'utf8'),'online');
 assert.equal(f.calls.length,0);
 f.untouchedMaintenance();
});

test('one database needing migration retains preflight, rehearsal, and snapshot', t => {
 const f=fixture(t);
 let preflight=0,rehearsal=0;
 f.deps.preflightCoreDbUpgrade=()=>{preflight++;return {databases:[]};};
 f.deps.rehearseCoreDbUpgrade=()=>{rehearsal++;return {databases:[]};};
 const result=f.run();
 assert.equal(result.success,true,JSON.stringify(result));
 assert.equal(preflight,1);
 assert.equal(rehearsal,1);
 assert.equal(result.dbBackupDir,f.snapshots());
 assert.equal(f.calls.length,2);
});

test('real pre-stop rehearsal sees committed source WAL and rejects before service stop', t => {
 const f=fixture(t);
 delete f.deps.rehearseCoreDbUpgrade;
 const target=path.join(f.tempDir,'skills');
 fs.mkdirSync(path.join(f.tempDir,'cli/lib'),{recursive:true});
 fs.writeFileSync(path.join(f.tempDir,'package.json'),'{"type":"module"}');
 fs.copyFileSync(path.resolve('cli/lib/core-db-backup-worker.js'),path.join(f.tempDir,'cli/lib/core-db-backup-worker.js'));
 for(const item of CORE_DATABASES){
  const owner=path.join(target,item.owner);fs.mkdirSync(path.join(owner,'scripts'),{recursive:true});
  fs.writeFileSync(path.join(owner,'package.json'),'{"type":"module"}');
  fs.copyFileSync(path.join(f.skillsDir,item.owner,item.schema),path.join(owner,item.schema));
 }
 fs.writeFileSync(path.join(target,'comm-bridge/scripts/sqlite-schema.js'),
  `export function migrateDatabase(db){const value=db.prepare('SELECT value FROM preserved').get().value;if(value!=='committed-in-WAL')throw Error('online backup missed committed WAL');throw Error('injected target migration rejection after WAL read');}`);
 const source=path.join(f.root,'comm-bridge/c4.db');
 const writer=new Database(source);t.after(()=>{if(writer.open)writer.close();});
 writer.pragma('journal_mode=WAL');writer.pragma('wal_autocheckpoint=0');
 writer.prepare('UPDATE preserved SET value=?').run('committed-in-WAL');
 assert.ok(fs.statSync(source+'-wal').size>0);
 const result=f.run();
 assert.equal(result.success,false,JSON.stringify(result));
 assert.match(result.error,/injected target migration rejection after WAL read/);
 assert.equal(fs.readFileSync(f.state,'utf8'),'online');
 assert.equal(f.calls.length,0);
 assert.equal(fs.existsSync(f.pm2Calls),false);
 assert.equal(writer.prepare('SELECT value FROM preserved').get().value,'committed-in-WAL');
 f.untouchedMaintenance();
});

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
 if(fault==='snapshot') f.deps.step3={snapshot:()=>{throw Error('injected snapshot failure');}};
 if(fault==='stop')f.deps.step3={stop:()=>{fs.writeFileSync(f.state,'stopped');throw Error('injected partial stop failure');}};
 if(fault==='verify')f.deps.step3={verifySnapshot:()=>{throw Error('injected snapshot verification failure');}};
 if(fault==='sync')f.deps.step3={probeSnapshotSync:()=>{throw Error('injected snapshot sync unavailable');}};
 const result=f.run();assert.equal(result.success,false,JSON.stringify(result));assert.equal(result.backupOnly,true);
 assert.equal(f.calls.length,0);assert.equal(finalized,false);assert.notEqual(result.rollback?.performed,true);
 assert.match(result.error,/injected|EEXIST|ENOTDIR/);assert.equal(fs.readFileSync(f.state,'utf8'),'online');if(fault!=='sync'){assert.equal(result.preInstallServicesRestored,true);assert.equal(result.manualRecovery.required,false);assert.equal(fs.readFileSync(f.pm2Calls,'utf8').includes('["restart","previously-stopped"'),false);}f.untouchedMaintenance();
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
function capabilityModule({missingProc=false,missingFlock=false,platform='linux'}={}) {
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
    assert.fail('Mac capability must not invoke a native helper: '+file+' '+args[0]);
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

test('Mac protected compensation is available without a native helper or process identity',()=>{
 const capability=capabilityModule({platform:'darwin'});
 assert.equal(capability.platformSupported('darwin'),true);
 assert.equal(capability.identity().unsupported,true);
});

for (const protectedMode of [false,true]) for (const fault of ['driver','schema','destination']) test(`${protectedMode?'protected':'backup-only'} pre-stop ${fault} rejection leaves services running without a transaction`, t => {
 const f=fixture(t);f.deps.protectionSupported=()=>protectedMode;
 if(fault==='driver') fs.unlinkSync(path.join(f.skillsDir,'scheduler/node_modules'));
 if(fault==='schema') fs.writeFileSync(path.join(f.skillsDir,'scheduler/scripts/schema.js'),`export const supportsNewDatabase=true;export function inspectSchema(){throw Error('unsupported schema fixture');}`);
 if(fault==='destination'){fs.mkdirSync(path.join(f.root,'.backup'));fs.writeFileSync(path.join(f.root,'.backup/db'),'blocked');}
 const result=f.run();assert.equal(result.success,false);assert.equal(result.recovery_required,false);
 assert.equal(fs.readFileSync(f.state,'utf8'),'online');assert.equal(f.calls.length,0);
 assert.equal(fs.existsSync(f.pm2Calls),false,'preflight must precede even PM2 discovery');f.untouchedMaintenance();
});

test('backup-only restart failure remains explicit and never claims services restored', t => {
 const f=fixture(t);f.deps.step3={snapshot:()=>{throw Error('snapshot fault');},start:()=>{throw Error('restart fault');}};
 const result=f.run();assert.equal(result.success,false);assert.equal(result.preInstallServicesRestored,false);
 assert.equal(result.manualRecovery.required,true);assert.match(result.error,/snapshot fault.*restart fault/);
 assert.equal(fs.readFileSync(f.state,'utf8'),'stopped');assert.equal(f.calls.length,0);
});
