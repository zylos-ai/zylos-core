import nativeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import cp,{spawn,spawnSync} from 'node:child_process';
import {LEGACY_CORE_DATABASES as CORE_DATABASES,createCoreDbSnapshot as snapshot,prepareRecoveryDependencies,runCoreDbWorker} from '../core-db-backup.js';
import {upgradeStartupPrompt} from '../runtime/upgrade-context.js';
import {runUpgradeEntry} from '../upgrade-entry.js';
import {runSelfUpgradeFinalize} from '../self-upgrade.js';
import {generateManifest} from '../manifest.js';
import {beginUpgrade,maintenance as protectionMaintenance,prepareProtectedInstall,protectedDataReady,recovery} from '../upgrade-protection.js';
import {SUPPORTED_SCHEMA_VERSION as C4_VERSION} from '../../../skills/comm-bridge/scripts/c4-schema.js';
import {SUPPORTED_SCHEMA_VERSION as SCHEDULER_VERSION} from '../../../skills/scheduler/scripts/schema.js';
import {SUPPORTED_SCHEMA_VERSION as WEB_VERSION} from '../../../skills/web-console/scripts/schema.js';

const require=createRequire(import.meta.url);
const automaticRecovery = require('../upgrade-maintenance.cjs').canRecognizeProcesses();
// These crash-takeover scenarios require observable process identities. The
// capability suite separately verifies rejection and live ownership without them.
const test = (name, options, fn) => nativeTest(name, {
 ...(typeof options === 'function' ? {} : options),
 ...(process.platform === 'linux' && !automaticRecovery ? {skip:'automatic process recognition unavailable'} : {}),
}, typeof options === 'function' ? options : fn);
const Database=require(path.resolve('skills/comm-bridge/node_modules/better-sqlite3'));
const currentVersions=[C4_VERSION,SCHEDULER_VERSION,WEB_VERSION];
function dependencyDirectory(source, destination) {
 fs.mkdirSync(destination,{recursive:true});
 for(const name of fs.readdirSync(source))fs.symlinkSync(path.join(source,name),path.join(destination,name));
}
function interceptSync(check) {
 const sync=fs.fsyncSync;
 fs.fsyncSync=fd=>{check(fd);return sync(fd);};
 return ()=>{fs.fsyncSync=sync;};
}
// Each test loads private copies of the real recovery and maintenance modules.
// Only service calls are replaced: database/native worker, hashes, journal,
// rescue, rename intents, isolation discovery, and terminal marker removal are real.
async function fixture(t,{missing=false,wal=false,formatVersion=2,dashboard=false,dashboardVersion=12}={}) {
 const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.UPGRADE_RECOVERY_TEST_TMPDIR || os.tmpdir(),'upgrade-recovery-')));
 const previousHome=process.env.HOME,previousPm2Home=process.env.PM2_HOME;
 process.env.HOME=root;process.env.PM2_HOME=path.join(root,'.pm2');
 t.after(()=>{
  if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
  if(previousPm2Home===undefined)delete process.env.PM2_HOME;else process.env.PM2_HOME=previousPm2Home;
 });
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
 for(const [src,dst] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dst));
 const m=require(path.join(stable,'maintenance.cjs')),r=require(path.join(stable,'recovery.cjs'));
 const skillsDir=path.join(root,'.claude/skills');
 for(const item of CORE_DATABASES){const owner=path.join(skillsDir,item.owner);fs.mkdirSync(path.join(owner,'scripts'),{recursive:true});fs.writeFileSync(path.join(owner,'package.json'),'{"type":"module"}');dependencyDirectory(path.resolve('skills/comm-bridge/node_modules'),path.join(owner,'node_modules'));
  fs.copyFileSync(path.resolve('skills',item.owner,item.schema),path.join(owner,item.schema));
  const migration=item.owner==='comm-bridge'?'c4-migrations.js':'migrations.js';
  fs.copyFileSync(path.resolve('skills',item.owner,'scripts',migration),path.join(owner,'scripts',migration));
  if(item.owner==='scheduler')fs.copyFileSync(path.resolve('skills/scheduler/scripts/migrations-v2.js'),path.join(owner,'scripts/migrations-v2.js'));
 }
 for(const file of ['sqlite-schema.js','c4-migrations-v2.js','upgrade-admission.js']) fs.copyFileSync(path.resolve('skills/comm-bridge/scripts',file),path.join(skillsDir,'comm-bridge/scripts',file));
 for(const item of CORE_DATABASES){if(missing&&item.owner==='scheduler')continue;const mod=await import(pathToFileURL(path.join(skillsDir,item.owner,item.schema)));const p=path.join(root,item.source);fs.mkdirSync(path.dirname(p),{recursive:true});const db=new Database(p);
  for(const [name,columns] of Object.entries(mod.TABLES)) {
   const defs=mod.COLUMN_DEFINITIONS?.[name]||{};
   const primary=columns.filter(c=>defs[c]?.pk);
   const declarations=columns.map(c=>`"${c}" ${defs[c]?.type||'TEXT'}`);
   if(primary.length) declarations.push(`PRIMARY KEY (${primary.map(c=>`"${c}"`).join(',')})`);
   db.exec(`CREATE TABLE "${name}" (${declarations.join(',')})`);
  }
  db.pragma(`user_version=${mod.SUPPORTED_SCHEMA_VERSION}`);if(wal)db.pragma('journal_mode=WAL');db.close();
 }
 const dir=path.join(root,'.backup/self-upgrade','tx');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const dashboardRoot=path.join(skillsDir,'dashboard');fs.mkdirSync(path.join(dashboardRoot,'src/lib'),{recursive:true});
 fs.writeFileSync(path.join(dashboardRoot,'package.json'),'{"type":"module","main":"index.js"}');
 fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`export const dashboardSchemaOwner={inspectSchema(db){const currentVersion=db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()?db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n:null;return {currentVersion,targetVersion:20,needsMigration:currentVersion!==20};},migrate(){throw Error('recovery must not migrate Dashboard');}};`);
 if(dashboard){const file=path.join(root,'components/dashboard/dashboard.db');fs.mkdirSync(path.dirname(file),{recursive:true});const db=new Database(file);db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);CREATE TABLE events(value TEXT);INSERT INTO events VALUES (\'original\')');db.prepare('INSERT INTO schema_migrations VALUES (?)').run(dashboardVersion);db.close();}
 const snapshotResult=snapshot({zylosDir:root,transactionId:'tx',formatVersion}),closure=prepareRecoveryDependencies(dir,root,{dashboardRoot});
 fs.copyFileSync(path.join(stable,'recovery.cjs'),path.join(dir,'runner.cjs'));fs.chmodSync(path.join(dir,'runner.cjs'),0o600);
 for(const [src,dst] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-finalizer.cjs','finalizer.cjs']]){fs.copyFileSync(path.resolve('cli/lib',src),path.join(dir,dst));fs.chmodSync(path.join(dir,dst),0o600);}
 const coreManifest=CORE_DATABASES.map(item=>({name:item.owner,existedBefore:true,backedUp:true,originalHash:m.treeHash(path.join(skillsDir,item.owner)),dependencies:{kind:'directory',sha256:m.treeHash(path.join(skillsDir,item.owner,'node_modules'),{excludeNodeModules:false,includeModes:true})}}));
 for(const e of coreManifest)fs.cpSync(path.join(skillsDir,e.name),path.join(dir,'code/skills',e.name),{recursive:true,filter:p=>!p.split(path.sep).includes('node_modules')});
 for(const e of coreManifest)fs.cpSync(path.join(skillsDir,e.name,'node_modules'),path.join(dir,'code/dependencies',e.name),{recursive:true,verbatimSymlinks:true});
 // Match saveProtectedCode: the disposable code root is private.
 fs.chmodSync(path.join(dir,'code'),0o700);
 const packageJson=path.join(root,'package.json');fs.writeFileSync(packageJson,'{}');const originalCli=path.join(root,'baseline-cli');fs.mkdirSync(originalCli,{mode:0o700});
 const j={formatVersion:1,from:dashboard?'0.9.4':'0.9.3',firstTakeover:!dashboard,dashboardOwnerManaged:false,transactionId:'tx',zylosDir:root,skillsDir,nodePath:process.execPath,phase:'installing',installationIntent:true,dbBackupDir:snapshotResult.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshotResult.dbBackupDir,'manifest.json')),coreManifest,originalServices:[],initialIdentity:{nodePath:process.execPath,packageJson,packageHash:m.hash(packageJson),cliRoot:originalCli,cliHash:m.treeHash(originalCli),workerPath:closure.workerPath,workerHash:m.hash(closure.workerPath),ecosystemHash:null,databases:snapshotResult.manifest.databases.map(d=>({source:d.source,exists:d.status!=='missing'}))}};
 // Package restoration has already completed in this database recovery fixture;
 // dedicated package tests exercise the installer and preservation failures.
 const originalArchive=path.join(dir,'original.tgz');fs.writeFileSync(originalArchive,'retained fixture package',{mode:0o600});
 j.originalPackage={path:originalArchive,sha256:m.hash(originalArchive),sourceVersion:j.from};j.originalPackageRestored=true;
 const descriptor={formatVersion:1,transactionId:'tx',...closure,runnerPath:path.join(dir,'runner.cjs'),hashes:Object.fromEntries(['runner.cjs','maintenance.cjs','finalizer.cjs'].map(name=>[name,m.hash(path.join(dir,name))]))};j.recoveryHashes=descriptor.hashes;m.durable(path.join(dir,'descriptor.json'),descriptor);m.update(dir,j);m.marker(root,dir,j);
 const calls=[];m.stop=()=>calls.push('stop');m.start=()=>calls.push('start');m.verifyServices=()=>calls.push('verify');
 // These state-machine tests exercise same-owner retries on Mac, not crash
 // takeover. Dedicated admission tests prove standalone resume is refused.
 if(process.platform==='darwin') {
  const resume=r.resume;let owner;
  r.resume=(target,options={})=>{
   owner ||= m.acquire(dir);
   const result=resume(target,{...options,ownership:owner.withOwnership});
   if(!result.recovery_required){owner();owner=null;}
   return result;
  };
 }

 return {root,dir,j,m,r,calls,snapshot:snapshotResult,dashboardRoot,load:()=>m.read(path.join(dir,'journal.json')),db:p=>path.join(root,p)};
}
function change(f){const p=f.db('comm-bridge/c4.db'),db=new Database(p);db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(1,'new-generation');db.close();fs.writeFileSync(p+'-wal','old-wal');fs.writeFileSync(p+'-shm','old-shm');fs.appendFileSync(path.join(f.j.skillsDir,'comm-bridge/package.json'),'\n');}
function unchanged(f) {
 f.j.databaseMode='unchanged';
 f.m.update(f.dir,f.j);
 f.m.preflight=()=>{throw Error('database preflight must not run');};
 f.m.worker=()=>{throw Error('database worker must not run');};
}

async function originalDashboardTakeover(t) {
 const f=await fixture(t,{dashboard:true,dashboardVersion:20});
 fs.rmSync(f.dashboardRoot,{recursive:true});
 f.m.update(f.dir,f.j,{firstTakeover:true,dashboardOwnerManaged:true});
 return f;
}

test('protected preparation checks an original deployment without a Dashboard owner',async t=>{
 const f=await originalDashboardTakeover(t);
 f.m.update(f.dir,f.j,{installationIntent:false,phase:'code_saved'});
 assert.doesNotThrow(()=>f.r.originalVerified(f.dir,f.load()));
 fs.rmSync(f.snapshot.dbBackupDir,{recursive:true});
 fs.rmSync(path.join(f.dir,'sqlite-runtime'),{recursive:true});
 const before=fs.readFileSync(f.db('components/dashboard/dashboard.db'));
 const ctx={maintenance:f.m,journal:f.j,transactionDir:f.dir,transactionId:'tx',coreDir:path.resolve('.'),snapshotFormatVersion:2};
 assert.doesNotThrow(()=>prepareProtectedInstall(ctx));
 assert.equal(f.load().phase,'prepared');
 assert.equal(ctx.dbSnapshotVerified,true);
 assert.deepEqual(fs.readFileSync(f.db('components/dashboard/dashboard.db')),before);
 assert.equal(fs.existsSync(f.dashboardRoot),false);
});

test('post-install compensation and restored startup accept an original deployment without a Dashboard owner',async t=>{
 const f=await originalDashboardTakeover(t);
 const dashboardFile=f.db('components/dashboard/dashboard.db');
 const saved=f.snapshot.manifest.databases.find(row=>row.source==='components/dashboard/dashboard.db');
 const changed=new Database(dashboardFile);changed.exec("UPDATE events SET value='new-generation'");changed.close();
 change(f);
 const phases=[],update=f.m.update;
 f.m.update=(dir,j,changes)=>{if(changes?.phase)phases.push(changes.phase);return update(dir,j,changes);};
 const result=f.r.resume(f.dir);
 assert.equal(result.completed,true,JSON.stringify(result));
 assert.equal(result.recovery_required,false,JSON.stringify(result));
 assert.equal(f.load().phase,'restored_complete');
 assert.ok(phases.includes('restored_data_ready'));
 assert.ok(phases.includes('restored_verifying'));
 assert.equal(f.m.hash(dashboardFile),saved.sha256);
 const restored=new Database(dashboardFile,{readonly:true,fileMustExist:true});
 try {assert.deepEqual(restored.prepare('SELECT value FROM events').all(),[{value:'original'}]);}
 finally {restored.close();}
 assert.equal(fs.existsSync(f.dashboardRoot),false);
 assert.ok(f.calls.includes('start'));assert.ok(f.calls.includes('verify'));
});

test('beginning persists both true Dashboard decisions in the published journal',async t=>{
 const f=await originalDashboardTakeover(t),root=path.join(f.root,'fresh');
 const coreDir=path.join(root,'package'),skillsDir=path.join(root,'.claude/skills');
 fs.mkdirSync(path.join(coreDir,'skills/core'),{recursive:true});
 fs.mkdirSync(path.join(coreDir,'cli/lib'),{recursive:true});
 fs.mkdirSync(path.join(skillsDir,'core'),{recursive:true});
 fs.writeFileSync(path.join(coreDir,'package.json'),'{}');
 fs.copyFileSync(path.resolve('cli/lib/core-db-backup-worker.js'),path.join(coreDir,'cli/lib/core-db-backup-worker.js'));
 const services=protectionMaintenance.services;
 protectionMaintenance.services=()=>[];
 const ctx={coreDir,tempDir:coreDir,from:'0.9.3',to:'1.0.0',firstTakeover:true,dashboardOwnerManaged:true};
 try {
  beginUpgrade(ctx,{zylosDir:root,skillsDir});
  const journal=ctx.maintenance.read(path.join(ctx.transactionDir,'journal.json'));
  assert.equal(journal.firstTakeover,true);assert.equal(journal.dashboardOwnerManaged,true);
 } finally {ctx.releaseControl?.();protectionMaintenance.services=services;}
});

test('data-ready preserves a legacy Dashboard without invoking its owner on subsequent takeover',async t=>{
 const f=await fixture(t,{dashboard:true,dashboardVersion:13});
 const calls=path.join(f.root,'dashboard-owner-calls');
 fs.writeFileSync(path.join(f.dashboardRoot,'src/lib/schema-owner.js'),`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(calls)},'loaded');throw Error('legacy Dashboard owner must not load');`);
 f.m.update(f.dir,f.j,{firstTakeover:false,dashboardOwnerManaged:false});
 const before=fs.readFileSync(f.db('components/dashboard/dashboard.db'));
 const ctx={maintenance:f.m,transactionDir:f.dir,transactionId:'tx'};
 assert.doesNotThrow(()=>protectedDataReady(ctx));
 assert.equal(ctx.databases.find(row=>row.source==='components/dashboard/dashboard.db').ownerSkipped,true);
 assert.equal(fs.existsSync(calls),false);
 assert.deepEqual(fs.readFileSync(f.db('components/dashboard/dashboard.db')),before);
});

for(const firstTakeover of [false,true]) for(const dashboardOwnerManaged of [false,true]) {
 test(`original deployment preflight uses persisted owner=${dashboardOwnerManaged}, takeover=${firstTakeover}`,async t=>{
  const f=await fixture(t,{dashboard:true});
  f.m.update(f.dir,f.j,{firstTakeover,dashboardOwnerManaged});
  if(firstTakeover)fs.rmSync(f.dashboardRoot,{recursive:true});
  const result=f.m.preflight(f.dir,f.load(),null,{originalDeployment:true});
  const row=result.databases.find(item=>item.source==='components/dashboard/dashboard.db');
  const usesOwner=dashboardOwnerManaged&&!firstTakeover;
  assert.equal(row.ownerSkipped===true,!usesOwner);
  assert.equal(row.currentVersion,usesOwner?12:undefined);
 });
 test(`original verification uses persisted owner=${dashboardOwnerManaged}, takeover=${firstTakeover}`,async t=>{
  const f=await fixture(t,{dashboard:true});
  f.m.update(f.dir,f.j,{firstTakeover,dashboardOwnerManaged,installationIntent:false,phase:'prepared'});
  // Exercise the original-worker path, independently of descriptor preflight.
  fs.renameSync(path.join(f.dir,'descriptor.json'),path.join(f.dir,'descriptor.held.json'));
  const owner=path.join(f.dashboardRoot,'src/lib/schema-owner.js');
  if(firstTakeover)fs.rmSync(f.dashboardRoot,{recursive:true});
  else fs.writeFileSync(owner,"export const dashboardSchemaOwner={inspectSchema(){throw Error('persisted owner invoked');},migrate(){throw Error('must not migrate');}};");
  if(dashboardOwnerManaged&&!firstTakeover)assert.throws(()=>f.r.originalVerified(f.dir,f.load()),/persisted owner invoked/);
  else assert.doesNotThrow(()=>f.r.originalVerified(f.dir,f.load()));
 });
}

for(const item of CORE_DATABASES) test(`${item.owner} controlled migration preserves structured migration failure`,async t=>{
 const f=await fixture(t),schema=path.join(f.j.skillsDir,item.owner,item.schema);
 fs.writeFileSync(schema,`export const SUPPORTED_SCHEMA_VERSION=1,supportsNewDatabase=true,TABLES={};
 export function inspectSchema(db){return {version:db.pragma('user_version',{simple:true}),empty:false,extensions:{tables:[],columns:[]}};}
 export const MIGRATIONS={0:{to:1,migrate(){throw Error('controlled migration fixture failure');}}};`);
 const db=new Database(f.db(item.source));db.pragma('user_version=0');db.close();
 assert.throws(()=>runCoreDbWorker({action:'upgrade-migrate',zylosDir:f.root,schemaRoot:f.j.skillsDir,
  transactionDir:f.dir,transactionId:'tx',manifest:f.snapshot.manifest}),error=>{
   assert.equal(error.code,'SCHEMA_MIGRATION_FAILED');
   assert.match(error.message,/controlled migration fixture failure/);
   return true;
  });
});

test('frozen worker preserves structured schema rejection across its subprocess boundary',async t=>{
 const f=await fixture(t),db=new Database(f.db('comm-bridge/c4.db'));
 db.pragma('user_version=999');db.close();
 assert.throws(()=>f.m.worker(f.dir,f.load(),{action:'offline-preflight',zylosDir:f.root,
  schemaRoot:f.j.skillsDir,dashboardOwnerManaged:false,formatVersion:2}),error=>{
   assert.equal(error.code,'SCHEMA_TOO_NEW');
   assert.match(error.message,/999/);
   return true;
  });
});

test('original deployment verification preserves structured schema rejection without a descriptor',async t=>{
 const f=await fixture(t);
 f.m.update(f.dir,f.j,{installationIntent:false,phase:'prepared'});
 fs.renameSync(path.join(f.dir,'descriptor.json'),path.join(f.dir,'descriptor.held.json'));
 const db=new Database(f.db('comm-bridge/c4.db'));db.pragma('user_version=999');db.close();
 assert.throws(()=>f.r.originalVerified(f.dir,f.load()),error=>{
  assert.equal(error.code,'SCHEMA_TOO_NEW');
  assert.match(error.message,/999/);
  return true;
 });
});

for (const mutation of ['source', 'manifest']) test(`${mutation} mutation before baseline staging rejects before cutoff and compensates code/data`, async t => {
 const f=await fixture(t);
 const download=path.join(f.root,'download'),source=path.join(download,'skills/comm-bridge');
 fs.mkdirSync(source,{recursive:true});
 const sourceFile=path.join(source,'SKILL.md');fs.writeFileSync(sourceFile,'target baseline\n');
 const expected=generateManifest(source);
 const originalSnapshot=f.snapshot.manifest.databases.find(item=>item.source==='comm-bridge/c4.db');
 const beforeCode=fs.readFileSync(path.join(f.j.skillsDir,'comm-bridge/package.json'));
 let prepareCalls=0,cutoffCalls=0,recoveryCalls=0;
 const result=await runUpgradeEntry({schemaVersion:1,fromVersion:'0.9.3',tempDir:download,
   installedRoot:f.root,zylosDir:f.root},{
   maintenance:{...f.m,discover:()=>({candidates:[],diagnostics:[]})},
   inspect:()=>({zylosDir:f.root,skillsDir:f.j.skillsDir,tempDir:download,from:'0.9.3',to:'0.9.4',
     transactionId:'tx',transactionDir:f.dir,journal:f.load(),maintenance:f.m,steps:[]}),
   resolveNpm:()=>'/unused/npm-cli.js',begin:()=>{},savePackage:()=>{},saveCode:()=>{},prepare:()=>{},install:()=>{},
   finalize:()=>runSelfUpgradeFinalize({zylosDir:f.root,
     transactionId:'tx',transactionDir:f.dir,tempDir:download},{
     maintenance:f.m,assertDashboardUninstalled:()=>{},
     syncSkills:ctx=>{
       change(f);
       ctx.pendingBaselines=[{destDir:path.join(f.j.skillsDir,'comm-bridge'),srcDir:source,manifest:expected}];
       return {step:5,status:'done'};
     },
     installDependencies:()=>{
       if(mutation==='source')fs.writeFileSync(sourceFile,'changed after manifest generation\n');
       else expected.files['SKILL.md']='0'.repeat(64);
       return {step:6,status:'done'};
     },
     prepareRuntimeClis:()=>{prepareCalls++;throw Error('must reject before runtime preparation');},
     commitCutoff:()=>{cutoffCalls++;throw Error('must reject before cutoff');},
   }),
   recover:()=>{
     recoveryCalls++;
     assert.equal(f.load().phase,'installing');
     assert.equal(f.m.classifyCutoff(f.load()),'none');
     return f.r.resume(f.dir);
   },
 });
 assert.equal(result.success,false,JSON.stringify(result));
 assert.match(result.error,/skill baseline source changed/);
 assert.equal(prepareCalls,0);assert.equal(cutoffCalls,0);assert.equal(recoveryCalls,1);
 assert.equal(result.rollback.attempted,true);assert.equal(result.rollback.completed,true,JSON.stringify(result));
 assert.equal(result.recovery_required,false);
 assert.equal(f.load().phase,'restored_complete');
 assert.equal(f.m.hash(f.db('comm-bridge/c4.db')),originalSnapshot.sha256);
 assert.deepEqual(fs.readFileSync(path.join(f.j.skillsDir,'comm-bridge/package.json')),beforeCode);
 assert.deepEqual(f.calls,['stop','start','verify']);
});

for (const corrupt of [false,true]) test(`pre-publication orchestrator rejects ${corrupt?'untrusted':'closed'} cutoff before any step`, async t => {
 const f=await fixture(t);
 f.m.update(f.dir,f.j,{phase:'compensation_closed',compensationCutoff:{formatVersion:1,closed:true,transactionId:'tx',snapshotManifestHash:f.j.snapshotManifestHash,closedAt:'2026-10-27T00:00:00.000Z',writer:'finalizer'},postCutoff:{items:{hooks:{state:'pending'}}},dashboardInstall:null});
 if(corrupt){f.j.compensationCutoff.snapshotManifestHash='0'.repeat(64);f.m.durable(path.join(f.dir,'journal.json'),f.j);}
 const before=fs.readFileSync(path.join(f.dir,'journal.json'));
 const script=`const state=JSON.parse(process.argv[1]);process.argv[1]=undefined;const {runSelfUpgradeFinalize}=await import(${JSON.stringify(pathToFileURL(path.resolve('cli/lib/self-upgrade.js')).href)});let calls=0;const result=await runSelfUpgradeFinalize(state,{syncSkills:()=>{calls++;throw Error('must not execute');}});console.log(JSON.stringify({result,calls}));`;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify({transactionDir:f.dir,transactionId:'tx'})],{env:{...process.env,ZYLOS_DIR:f.root},encoding:'utf8'});
 assert.equal(child.status,0,child.stderr);
 const {result,calls}=JSON.parse(child.stdout);
 assert.equal(calls,0);assert.equal(result.success,false);
 assert.equal(result.recovery_required,undefined);
 assert.equal(result.recoveryError,undefined);
 assert.equal(result.next,undefined);
 assert.match(result.error,corrupt?/untrusted cutoff/:/compensation is closed/);
 assert.deepEqual(fs.readFileSync(path.join(f.dir,'journal.json')),before);
});

for(const entry of ['runner','controller'])test(`${entry} compensation refusal persists only lastError after the cutoff`,async t=>{
 const f=await fixture(t);
 f.m.update(f.dir,f.j,{phase:'compensation_closed',compensationCutoff:{formatVersion:1,closed:true,transactionId:'tx',snapshotManifestHash:f.j.snapshotManifestHash,closedAt:'2026-10-27T00:00:00.000Z',writer:'finalizer'},postCutoff:{items:{hooks:{state:'pending'}}},dashboardInstall:null});
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const result=entry==='runner'?f.r.resume(f.dir):recovery({maintenance:f.m,journal:f.j,transactionDir:f.dir,transactionId:'tx'});
 assert.equal(result.recovery_required,true);
 assert.match(result.error,/compensation is closed/);
 const saved=f.load();
 assert.equal(saved.phase,'recovery_required');
 assert.equal(saved.resumePhase,'compensation_closed');
 assert.equal(saved.lastError,result.error);
 assert.equal(Object.hasOwn(saved,'error'),false);
 assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
 assert.equal(f.calls.includes('start'),false);
});

for(const code of ['EACCES','MODULE_NOT_FOUND','ERR_UNKNOWN','SQLITE_BUSY','SCHEMA_TOO_NEW'])test(`recovery controller normalizes ${code} during transaction read`,async t=>{
 const f=await fixture(t);
 const result=recovery({maintenance:{...f.m,transaction(){throw Object.assign(Error('recovery journal read failed'),{code});}},journal:f.j,transactionDir:f.dir,transactionId:'tx'});
 assert.equal(result.recovery_required,true);
 assert.equal(result.code,code==='SCHEMA_TOO_NEW'?code:'UPGRADE_FAILED');
 assert.equal(result.error,'recovery journal read failed');
 assert.deepEqual(f.calls,[]);
});

for(const failure of [null,'thresholds','ensure','state'])test(`closed writer access follows hooks completion when prerequisites ${failure?'fail at '+failure:'succeed'}`,async t=>{
 const f=await fixture(t);
 const cutoff={formatVersion:1,closed:true,transactionId:'tx',snapshotManifestHash:f.j.snapshotManifestHash,closedAt:'2026-10-27T00:00:00.000Z',writer:'finalizer'};
 f.m.update(f.dir,f.j,{phase:'compensation_closed',compensationCutoff:cutoff,postCutoff:{items:{hooks:{state:'pending'}}},dashboardInstall:null});
 const stable=path.join(f.root,'.zylos/upgrade/maintenance.cjs');
 const before=fs.readFileSync(stable);
 const blocked=()=>assert.throws(()=>require(stable).assertCoreDatabaseAvailable(f.root),{code:'ZYLOS_MAINTENANCE'});
 blocked();
 f.m.update(f.dir,f.j,{postCutoff:{items:{hooks:{state:'done'}}}});
 const available=()=>assert.doesNotThrow(()=>require(stable).assertCoreDatabaseAvailable(f.root));
 available();
 if(failure==='state')fs.mkdirSync(path.join(f.root,'memory/state.md'),{recursive:true});
 const {completeUpgradeFinalization}=await import('../self-upgrade.js');
 const ctx={zylosDir:f.root,transactionDir:f.dir,transactionId:'tx',journal:f.j,maintenance:f.m,upgradeProtected:true,
   from:'old',to:'new',steps:[],servicesWereRunning:[],mergeConflicts:[],mergedFiles:[],
   };
 let started=0;
 const result=await completeUpgradeFinalization(ctx,{
   updateConfig:()=>{available();if(failure==='thresholds')throw Error('threshold failure');},
   ensureMemoryMigration:()=>{available();if(failure==='ensure')throw Error('ensure failure');},
   commitBaselines:()=>{available();return {status:'done'};},
   startServices:()=>{assert.doesNotThrow(()=>require(stable).assertCoreDatabaseAvailable(f.root));started++;return {status:'done'};},
   verifyServices:()=>({status:'done'}),dashboardOwner:{verifyDashboard:()=>({state:'ready',errors:[]})},
   readMode:()=>({mode:'single',keyPresent:true}),readTransition:()=>null,restart:()=>({ok:true}),audit:()=>[],protectedSuccess:()=>{}
 });
 assert.equal(result.success,!failure,JSON.stringify(result));
 assert.equal(started,failure?0:1);
 if(failure){available();assert.deepEqual(fs.readFileSync(stable),before);}
 else {
   assert.doesNotThrow(()=>require(stable).assertCoreDatabaseAvailable(f.root));
   f.m.update(f.dir,f.j,{phase:'recovery_required',resumePhase:'compensation_closed'});
   available();
 }
});

test('unchanged database transaction resumes restored code without database inspection',async t=>{
 const f=await fixture(t);unchanged(f);
 f.m.update(f.dir,f.j,{phase:'restored_data_ready'});
 const result=f.r.resume(f.dir);
 assert.equal(result.recovery_required,false,JSON.stringify(result));
 assert.equal(result.stage,'restored_complete');
 assert.equal(f.m.discover(f.root).blocked,false);
 assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));
});

test('unchanged database transaction restores code and preserves live database files',async t=>{
 const f=await fixture(t);unchanged(f);
 const source=f.db('comm-bridge/c4.db');
 const db=new Database(source);db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(31,'keep');db.close();
 const before=fs.readFileSync(source);
 fs.appendFileSync(path.join(f.j.skillsDir,'comm-bridge/package.json'),'\nchanged');
 const result=f.r.resume(f.dir);
 assert.equal(result.stage,'restored_complete',JSON.stringify(result));
 assert.equal(result.recovery_required,false);
 assert.deepEqual(fs.readFileSync(source),before);
 assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));
 assert.equal(f.load().codeRestore['comm-bridge'].complete,true);
 assert.equal(f.m.discover(f.root).blocked,false);
});

test('unchanged database transaction aborts before install without database inspection',async t=>{
 const f=await fixture(t);unchanged(f);
 f.m.update(f.dir,f.j,{phase:'prepared',installationIntent:false});
 const result=f.r.resume(f.dir);
 assert.equal(result.stage,'aborted_before_install',JSON.stringify(result));
 assert.equal(result.recovery_required,false);
 assert.equal(f.m.discover(f.root).blocked,false);
});

test('ready journal requires snapshot identity even with unchanged database versions',async t=>{
 const f=await fixture(t);
 f.m.update(f.dir,f.j,{phase:'restored_data_ready'});
 assert.doesNotThrow(()=>f.m.transaction(f.root,f.dir));
 f.j.databaseMode='unchanged';
 f.m.update(f.dir,f.j);
 assert.doesNotThrow(()=>f.m.transaction(f.root,f.dir));
 delete f.j.dbBackupDir;
 delete f.j.snapshotManifestHash;
 f.m.update(f.dir,f.j);
 assert.throws(()=>f.m.transaction(f.root,f.dir),/invalid data-ready installation\/material identity/);
 f.j.databaseMode='migrate';
 f.m.update(f.dir,f.j);
 assert.throws(()=>f.m.transaction(f.root,f.dir),/invalid data-ready installation\/material identity/);
});

for(const verificationFails of [false,true]) test(`protected unchanged-version snapshot ${verificationFails?'verification failure prevents preparation':'is verified before installation intent'}`,async t=>{
 const f=await fixture(t);unchanged(f);
 f.m.update(f.dir,f.j,{installationIntent:false,phase:'offline'});
 fs.rmSync(f.snapshot.dbBackupDir,{recursive:true});
 fs.rmSync(path.join(f.dir,'sqlite-runtime'),{recursive:true});
 const before=CORE_DATABASES.map(item=>fs.readFileSync(f.db(item.source)));
 const {prepareProtectedInstall}=await import('../upgrade-protection.js');
 const ctx={maintenance:f.m,journal:f.j,transactionDir:f.dir,transactionId:'tx',coreDir:path.resolve('.'),snapshotFormatVersion:2};
 if(verificationFails) assert.throws(()=>prepareProtectedInstall(ctx,{verifySnapshot:()=>{throw Error('injected snapshot verification failure');}}),/injected snapshot verification failure/);
 else {
  prepareProtectedInstall(ctx);
  assert.equal(ctx.dbSnapshotVerified,true);
  assert.equal(f.load().phase,'prepared');
  assert.equal(ctx.dbManifest.databases.length,4);
 }
 assert.equal(f.load().installationIntent,false);
 assert.deepEqual(CORE_DATABASES.map(item=>fs.readFileSync(f.db(item.source))),before);
});

for(const legacy of ['group-writable','backup-alias'])test(`completed upgrade permits ordinary owners after retained materials become ${legacy}`,async t=>{
 const f=await fixture(t);
 f.m.update(f.dir,f.j,{phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:false,codeRemoved:false,servicesRestored:true}});
 const result=f.r.resume(f.dir);
 assert.equal(result.stage,'upgrade_complete',JSON.stringify(result));
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),false);
 assert.equal(f.load().terminalEvidence.verified,true);
 // Deploy the actual owner openers only after code verification has finished.
 for(const item of CORE_DATABASES)fs.cpSync(path.resolve('skills',item.owner,'scripts'),path.join(f.j.skillsDir,item.owner,'scripts'),{recursive:true});
 const monitor=path.join(f.j.skillsDir,'activity-monitor');fs.mkdirSync(path.join(monitor,'scripts'),{recursive:true});
 fs.writeFileSync(path.join(monitor,'package.json'),'{"type":"module"}');
 for(const script of ['shard-registry.js','bootstrap-identity.js','bootstrap-scope.js']) {
  fs.copyFileSync(path.resolve('skills/activity-monitor/scripts',script),path.join(monitor,'scripts',script));
 }
 if(legacy==='group-writable') {
  const shared=file=>{const stat=fs.lstatSync(file);if(stat.isSymbolicLink())return;fs.chmodSync(file,stat.mode|0o020);if(stat.isDirectory())for(const name of fs.readdirSync(file))shared(path.join(file,name));};
  shared(path.join(f.root,'.zylos'));shared(path.join(f.root,'.backup'));
 } else {
  fs.renameSync(path.join(f.root,'.backup'),path.join(f.root,'retained-backup'));
  fs.symlinkSync(path.join(f.root,'retained-backup'),path.join(f.root,'.backup'));
 }
 const discovery=f.m.discover(f.root);assert.equal(discovery.blocked,false);assert.deepEqual(discovery.diagnostics,[]);assert.deepEqual(discovery.candidates,[]);
 assert.equal(upgradeStartupPrompt(f.root),null);
 const runner=path.join(f.root,'open-owners.mjs');
 fs.writeFileSync(runner,`import assert from 'node:assert/strict';
 import {getDb,close} from './.claude/skills/comm-bridge/scripts/c4-db.js';
 import {getDb as scheduler} from './.claude/skills/scheduler/scripts/database.js';
 import {openDb} from './.claude/skills/web-console/scripts/db.js';
 for(const [index,open] of [getDb,scheduler,openDb].entries()){const db=open();assert.equal(db.pragma('user_version',{simple:true}),${JSON.stringify(currentVersions)}[index]);db.close();}
 close();`);
 const alias=path.join(f.root,'deployment-alias');fs.symlinkSync(f.root,alias);
 for(const deploymentRoot of [f.root,alias]) {
  const opened=spawnSync(process.execPath,[runner],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:deploymentRoot,ZYLOS_PACKAGE_ROOT:path.resolve('.')}});
  assert.equal(opened.status,0,opened.stderr);
 }
 const hook=path.join(f.j.skillsDir,'comm-bridge/scripts/c4-session-init.js');
 const checkpoint=spawnSync(process.execPath,[hook],{encoding:'utf8',env:{...process.env,ZYLOS_DIR:f.root,ZYLOS_PACKAGE_ROOT:path.resolve('.')}});
 assert.equal(checkpoint.status,0,checkpoint.stderr);assert.doesNotMatch(checkpoint.stdout,/UPGRADE RECOVERY TASK/);
});

test('interrupted data-ready upgrade resumes while retaining an extra column',async t=>{
 const f=await fixture(t);
 const db=new Database(f.db('comm-bridge/c4.db'));
 try {db.exec('ALTER TABLE conversations ADD COLUMN extension_value TEXT');}
 finally {db.close();}
 f.m.update(f.dir,f.j,{phase:'restored_data_ready'});
 const result=f.r.resume(f.dir);
 assert.equal(result.recovery_required,false,JSON.stringify(result));
 const retained=new Database(f.db('comm-bridge/c4.db'),{readonly:true});
 try {assert.ok(retained.prepare('PRAGMA table_info(conversations)').all().some(column=>column.name==='extension_value'));}
 finally {retained.close();}
});

test('complete compensation restores old code/data, preserves rescue, removes sidecars and retains terminal materials',async t=>{
 const f=await fixture(t,{missing:true});change(f);fs.mkdirSync(path.dirname(f.db('scheduler/scheduler.db')),{recursive:true});fs.writeFileSync(f.db('scheduler/scheduler.db'),'new-db');
 const original=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.equal(result.stage,'restored_complete');assert.ok(!fs.existsSync(f.db('scheduler/scheduler.db')));assert.ok(!fs.existsSync(f.db('comm-bridge/c4.db-wal')));
 const archived=path.join(f.root,'.backup/self-upgrade/tx');assert.deepEqual(fs.readFileSync(path.join(archived,'rescue/comm-bridge_c4.db')),original);assert.equal(f.m.discover(f.root).blocked,false);assert.deepEqual(f.calls,['stop','start','verify']);
});
for(const dashboard of [false,true])test(`format 2 compensation ${dashboard?'restores backed up Dashboard':'refuses unexpected Dashboard created after a missing snapshot'}`,async t=>{
 const f=await fixture(t,{formatVersion:2,dashboard});
 assert.equal(f.snapshot.manifest.formatVersion,2);assert.equal(f.snapshot.manifest.databases.length,4);
 const file=f.db('components/dashboard/dashboard.db');fs.mkdirSync(path.dirname(file),{recursive:true});
 const snapshotRow=f.snapshot.manifest.databases.find(row=>row.source==='components/dashboard/dashboard.db');
 const original=dashboard?fs.readFileSync(path.join(f.snapshot.dbBackupDir,snapshotRow.file)):null;
 if(dashboard){const db=new Database(file);db.exec("INSERT INTO events VALUES ('changed')");db.close();}
 else fs.writeFileSync(file,'new Dashboard generation is outside compensation');
 fs.writeFileSync(file+'-wal','new-wal');fs.writeFileSync(file+'-shm','new-shm');
 const before=[file,file+'-wal',file+'-shm'].map(p=>fs.readFileSync(p));
 change(f);
 const result=f.r.resume(f.dir);
 if(!dashboard){
  assert.equal(result.recovery_required,true,JSON.stringify(result));
  assert.match(result.error,/Expected missing database exists/);
  assert.deepEqual([file,file+'-wal',file+'-shm'].map(p=>fs.readFileSync(p)),before);
  assert.equal(f.load().dbRestore?.['components/dashboard/dashboard.db'],undefined);
  assert.deepEqual(f.calls,['stop','stop']);
  return;
 }
 assert.equal(result.stage,'restored_complete',JSON.stringify(result));assert.equal(result.recovery_required,false);
 if(dashboard){assert.deepEqual(fs.readFileSync(file),original);assert.equal(fs.existsSync(file+'-wal'),false);assert.equal(fs.existsSync(file+'-shm'),false);assert.equal(f.load().dbRestore['components/dashboard/dashboard.db'].complete,true);}
 assert.deepEqual(f.calls,['stop','start','verify']);
});
test('Dashboard controlled migration rejects an owner still needing migration', async t => {
 const f=await fixture(t,{formatVersion:2,dashboard:true});
 f.m.update(f.dir,f.j,{dashboardOwnerManaged:true});
 const owner=path.join(f.dashboardRoot,'src/lib/schema-owner.js');
 fs.writeFileSync(owner,fs.readFileSync(owner,'utf8').replace("throw Error('recovery must not migrate Dashboard');",''));
 const file=f.db('components/dashboard/dashboard.db');
 const before=fs.readFileSync(file);
 assert.throws(()=>runCoreDbWorker({action:'upgrade-migrate',zylosDir:f.root,schemaRoot:f.j.skillsDir,dashboardRoot:f.dashboardRoot,transactionDir:f.dir,transactionId:'tx',manifest:f.snapshot.manifest}),/SCHEMA_MIGRATION_FAILED dashboard migration remains incomplete/);
 assert.deepEqual(fs.readFileSync(file),before);
 assert.equal(f.load().phase,'installing');
});

test('Dashboard controlled migration requires transaction identity before invoking its owner', async t => {
 const f=await fixture(t,{formatVersion:2,dashboard:true});
 const file=f.db('components/dashboard/dashboard.db');
 const before=fs.readFileSync(file);
 assert.throws(()=>runCoreDbWorker({action:'upgrade-migrate',zylosDir:f.root,schemaRoot:f.j.skillsDir,dashboardRoot:f.dashboardRoot}),/controlled migration requires transaction identity/);
 assert.deepEqual(fs.readFileSync(file),before);
 assert.equal(f.load().phase,'installing');
});

test('snapshot and original database identities must agree before compensation', async t => {
 const f=await fixture(t,{formatVersion:2});
 f.j.initialIdentity.databases.pop();
 f.m.durable(path.join(f.dir,'journal.json'),f.j);
 change(f);
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const result=f.r.resume(f.dir);
 assert.equal(result.recovery_required,true);
 assert.match(result.error,/snapshot and original database identity differ/);
 assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
 assert.equal(fs.existsSync(path.join(f.dir,'rescue')),false);
 assert.ok(!f.calls.includes('start'));
});

for(const phase of ['rescue','restore'])test(`${phase} staging platform sync failure prevents publication and preserves retry evidence`,async t=>{
 const f=await fixture(t);change(f);
 const source=f.db('comm-bridge/c4.db'),originalHash=f.m.hash(source);
 const rescue=path.join(f.dir,'rescue/comm-bridge_c4.db');
 const staging=phase==='rescue'?rescue+'.staging':source+'.tx.restore';
 const snapshot=f.snapshot.manifest.databases.find(d=>d.source==='comm-bridge/c4.db');
 if(phase==='restore'){f.r.rescue(f.dir,f.j);f.r.restoreCore(f.dir,f.j);}
 let hit=false;
 const restoreSync=interceptSync(fd=>{
  if(!fs.existsSync(staging))return;
  const expected=fs.statSync(staging),actual=fs.fstatSync(fd);
  if(expected.dev===actual.dev&&expected.ino===actual.ino){hit=true;throw Error('staging platform sync failed');}
 });
 try{assert.throws(()=>phase==='rescue'?f.r.rescue(f.dir,f.j):f.r.replaceDatabases(f.dir,f.j,f.snapshot.manifest),/staging platform sync failed/);}finally{restoreSync();}
 assert.equal(hit,true);
 const saved=f.load();
 if(phase==='rescue'){
  assert.equal(fs.existsSync(rescue),false);assert.equal(f.m.hash(source),originalHash);
  assert.equal(f.m.hash(staging),originalHash);assert.equal(saved.rescue['comm-bridge/c4.db'].complete,false);
  assert.equal(saved.actions?.['rescue_comm-bridge_c4.db'],undefined);
 }else{
  // Replacement first displaces the failed generation; sync failure must leave
  // that retained generation intact without publishing the staged old snapshot.
  assert.equal(fs.existsSync(source),false);assert.equal(f.m.hash(rescue),originalHash);
  assert.equal(f.m.hash(path.join(f.dir,'rescue/displaced_comm-bridge_c4.db')),originalHash);
  assert.equal(f.m.hash(staging),snapshot.sha256);assert.notEqual(saved.dbRestore?.['comm-bridge/c4.db']?.complete,true);
  assert.equal(saved.actions?.['install_comm-bridge_c4.db'],undefined);
 }
 assert.ok(!f.calls.includes('start'));
 const result=f.r.resume(f.dir);assert.equal(result.stage,'restored_complete',JSON.stringify(result));assert.equal(result.completed,true);
 assert.equal(f.m.hash(source),snapshot.sha256);assert.equal(f.m.hash(rescue),originalHash);
});
test('damaged snapshot is rejected before rescue or replacement',async t=>{
 const f=await fixture(t);change(f);const before=fs.readFileSync(f.db('comm-bridge/c4.db'));fs.appendFileSync(path.join(f.snapshot.dbBackupDir,f.snapshot.manifest.databases[0].file),'bad');
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/hash mismatch/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));assert.equal(f.m.discover(f.root).blocked,true);
});
test('crash after physical DB rename but before done journal resumes existing intent without recapturing rescue',async t=>{
 const f=await fixture(t);change(f);f.r.rescue(f.dir,f.j);f.r.restoreCore(f.dir,f.j);
 const real=f.m.renameIntent;let crashed=false;f.m.renameIntent=(dir,j,key,...args)=>{const result=real(dir,j,key,...args);if(!crashed&&key==='install_comm-bridge_c4.db'){crashed=true;j.actions[key].done=false;f.m.update(dir,j);throw Error('simulated power loss after install rename');}return result;};
 assert.throws(()=>f.r.replaceDatabases(f.dir,f.j,f.snapshot.manifest),/power loss/);const rescueHash=f.m.hash(path.join(f.dir,'rescue/comm-bridge_c4.db'));f.m.renameIntent=real;
 const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.equal(f.m.hash(path.join(f.root,'.backup/self-upgrade/tx/rescue/comm-bridge_c4.db')),rescueHash);
});
test('partial rescue resumes recorded generation and refuses changed rescue evidence',async t=>{
 const f=await fixture(t);change(f);const real=f.m.renameIntent;let crashed=false;f.m.renameIntent=(dir,j,key,...args)=>{const result=real(dir,j,key,...args);if(!crashed&&key==='rescue_comm-bridge_c4.db'){crashed=true;throw Error('simulated crash');}return result;};assert.throws(()=>f.r.rescue(f.dir,f.j),/crash/);f.m.renameIntent=real;
 fs.appendFileSync(path.join(f.dir,'rescue/comm-bridge_c4.db'),'tampered');const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/rescue hash conflict/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});
for(const phase of ['restored_data_ready','restored_verifying'])test(`${phase} resumes validation and retains valid normal writes`,async t=>{
 const f=await fixture(t);
 const snapshotHash=f.m.hash(f.db('comm-bridge/c4.db'));
 f.m.start=()=>{
  f.calls.push('start');
  const db=new Database(f.db('comm-bridge/c4.db'));
  try{db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(7,'normal-write');}finally{db.close();}
 };
 const dbRestore=Object.fromEntries(f.snapshot.manifest.databases.filter(row=>row.status!=='missing').map(row=>[row.source,{complete:true}]));
 f.m.update(f.dir,f.j,{phase,dbRestore});
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,false);assert.ok(!f.calls.includes('stop'));const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=7').get().summary,'normal-write');read.close();assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));
 assert.notEqual(f.m.hash(f.db('comm-bridge/c4.db')),snapshotHash);
 assert.deepEqual(f.calls,['start','verify']);
});
test('restored verification failure isolates without a second database replacement',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.m.verifyServices=()=>{throw Error('service failed');};
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.equal(f.load().resumePhase,'restored_verifying');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.equal(f.m.discover(f.root).blocked,true);
});
test('trusted preinstall abort verifies original data without snapshot restore',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.stage,'aborted_before_install',JSON.stringify(result));assert.equal(result.attempted,false);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));assert.equal(f.m.discover(f.root).blocked,false);
});
test('group-writable original npm CLI root permits verified preinstall abort',async t=>{
 const f=await fixture(t);fs.chmodSync(f.j.initialIdentity.cliRoot,0o775);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);
 assert.equal(result.stage,'aborted_before_install',JSON.stringify(result));assert.equal(result.recovery_required,false);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(f.m.discover(f.root).blocked,false);
});
test('interrupted original service restart only resumes verified abort cleanup',async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});let first=true;f.m.start=()=>{f.calls.push('start');if(first){first=false;throw Error('start interrupted');}};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.load().resumePhase,'aborted_before_install');assert.equal(f.m.discover(f.root).blocked,true);assert.equal(f.r.resume(f.dir).stage,'aborted_before_install');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
});
test('failed stop verification refuses physical replacement and service start',async t=>{
 const f=await fixture(t);change(f);const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.m.stop=()=>{f.calls.push('stop');throw Error('PM2 stop not confirmed');};const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/not confirmed/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));
});
test('initial journal without descriptor or snapshots aborts through trusted original readonly worker',async t=>{
 const f=await fixture(t);const descriptor=f.m.read(path.join(f.dir,'descriptor.json'));f.j.initialIdentity.workerPath=descriptor.workerPath;f.j.initialIdentity.workerHash=f.m.hash(descriptor.workerPath);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});fs.unlinkSync(path.join(f.dir,'descriptor.json'));fs.rmSync(f.snapshot.dbBackupDir,{recursive:true});
 const db=new Database(f.db('comm-bridge/c4.db'));db.pragma('journal_mode=WAL');db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(4,'pre-stop-commit');db.pragma('wal_checkpoint(TRUNCATE)');db.close();
 const result=f.r.resume(f.dir);assert.equal(result.stage,'aborted_before_install');assert.equal(result.recovery_required,false);const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=4').get().summary,'pre-stop-commit');read.close();
});
for(const action of ['terminal-write','marker-remove'])test(`abort ${action} interruption stays isolated then continues without replacement`,async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});let first=true;const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 if(action==='terminal-write'){const real=f.m.update;f.m.update=(dir,j,changes={})=>{if(first&&changes.phase==='aborted_before_install'){first=false;throw Error('terminal fsync failed');}return real(dir,j,changes);};}
 else{const real=fs.unlinkSync;t.after(()=>{fs.unlinkSync=real;});fs.unlinkSync=file=>{if(first&&file===path.join(f.root,'.zylos/upgrade/active.json')){first=false;throw Error('marker remove failed');}return real(file);};}
 assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.m.discover(f.root).blocked,action==='terminal-write');if(action==='terminal-write')assert.ok(!f.calls.includes('start'));else assert.ok(f.calls.includes('start'));assert.equal(f.r.resume(f.dir).stage,'aborted_before_install');assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));
});
test('partial core restore skips verified completed members after interruption',async t=>{
 const f=await fixture(t);change(f);f.r.rescue(f.dir,f.j);const real=f.m.sync,seen=[];let crash=true;f.m.sync=(src,dest)=>{seen.push(path.basename(dest));real(src,dest);if(crash&&path.basename(dest)==='scheduler'){crash=false;throw Error('core-copy crash');}};
 assert.throws(()=>f.r.restoreCore(f.dir,f.j),/core-copy crash/);assert.equal(f.load().codeRestore['comm-bridge'].complete,true);seen.length=0;const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.deepEqual(seen,['scheduler','web-console']);
});
for(const installationIntent of [true,false])test(`unknown phase with installationIntent=${installationIntent} never restores or aborts`,async t=>{
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'unknown-future-stage',installationIntent});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/unrecognized .* recovery phase/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));assert.equal(f.m.discover(f.root).blocked,true);
 assert.equal(f.load().lastError,result.error);
 assert.equal(Object.hasOwn(f.load(),'error'),false);
});
test('ecosystem copy fsync failure cannot publish completed restore and retry is durable',async t=>{
 const f=await fixture(t),dest=path.join(f.root,'pm2/ecosystem.config.cjs'),backup=path.join(f.dir,'code/pm2/ecosystem.config.cjs');
 fs.mkdirSync(path.dirname(dest),{recursive:true});fs.mkdirSync(path.dirname(backup),{recursive:true});fs.writeFileSync(dest,'new ecosystem');fs.writeFileSync(backup,'original ecosystem');f.j.initialIdentity.ecosystemHash=f.m.hash(backup);f.m.update(f.dir,f.j);
 const target=fs.statSync(dest);let hit=false;const restoreSync=interceptSync(fd=>{const stat=fs.fstatSync(fd);if(stat.dev===target.dev&&stat.ino===target.ino){hit=true;throw Error('ecosystem file fsync failed');}});
 try{assert.throws(()=>f.r.restoreCore(f.dir,f.j),/ecosystem file fsync failed/);}finally{restoreSync();}
 assert.equal(hit,true);assert.notEqual(f.load().codeRestore.ecosystem?.complete,true);
 f.r.restoreCore(f.dir,f.j);assert.equal(f.load().codeRestore.ecosystem.complete,true);assert.equal(fs.readFileSync(dest,'utf8'),'original ecosystem');
});
test('verified abort reentry allows legitimate original-service writes after partial restart',async t=>{
 const f=await fixture(t);const checked=f.m.preflight(f.dir,f.j,null);f.m.update(f.dir,f.j,{installationIntent:false,phase:'prepared',stableDataEvidence:checked.databases.map(d=>d.logicalHash)});
 let first=true;f.m.start=()=>{f.calls.push('start');if(first){first=false;const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(11,'legitimate partially restarted service write');db.close();throw Error('another original service failed to restart');}};
 const interrupted=f.r.resume(f.dir);assert.equal(interrupted.recovery_required,true);assert.equal(f.load().resumePhase,'aborted_before_install');
 const result=f.r.resume(f.dir);assert.equal(result.stage,'aborted_before_install');assert.equal(result.recovery_required,false);assert.equal(result.attempted,false);
 const read=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(read.prepare('SELECT summary FROM checkpoints WHERE id=11').get().summary,'legitimate partially restarted service write');read.close();assert.ok(!fs.existsSync(path.join(f.root,'.backup/self-upgrade/tx/rescue')));
});
test('originally missing ecosystem is removed only with durable matching creation provenance',async t=>{
 const f=await fixture(t),dest=path.join(f.root,'pm2/ecosystem.config.cjs');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'failed upgrade created ecosystem',{mode:0o600});
 f.j.initialIdentity.ecosystemHash=null;f.j.ecosystemCreationIntent={target:dest,originalMissing:true,intendedHash:f.m.hash(dest)};f.m.update(f.dir,f.j);f.r.restoreCore(f.dir,f.j);
 assert.equal(fs.existsSync(dest),false);assert.deepEqual(f.load().codeRestore.ecosystem,{complete:true,missing:true});assert.doesNotThrow(()=>f.r.restoreCore(f.dir,f.j));
});
for(const changed of [false,true])test(`unknown or changed new ecosystem provenance preserves file (changed=${changed})`,async t=>{
 const f=await fixture(t),dest=path.join(f.root,'pm2/ecosystem.config.cjs');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,'unattributed ecosystem',{mode:0o600});f.j.initialIdentity.ecosystemHash=null;
 if(changed){f.j.ecosystemCreationIntent={target:dest,originalMissing:true,intendedHash:f.m.hash(dest)};fs.appendFileSync(dest,' externally changed');}
 f.m.update(f.dir,f.j);const before=fs.readFileSync(dest);assert.throws(()=>f.r.restoreCore(f.dir,f.j),changed?/creation hash changed/:/provenance unknown/);assert.deepEqual(fs.readFileSync(dest),before);assert.notEqual(f.load().codeRestore.ecosystem?.complete,true);
});

test('protected recovery restores all databases after a partial migration failure',async t=>{
 const f=await fixture(t);
 const inserts=[['comm-bridge/c4.db',"INSERT INTO checkpoints(id,summary) VALUES (91,'new generation')"],['scheduler/scheduler.db',"INSERT INTO system_state(key,value) VALUES ('generation','new')"],['web-console/web-console.db',"INSERT INTO sessions(token) VALUES ('new-generation')"]];
 for(const [source,sql] of inserts){const db=new Database(f.db(source));try{db.exec(sql);}finally{db.close();}}
 const c4=new Database(f.db('comm-bridge/c4.db'));
 try{c4.exec('ALTER TABLE checkpoints ADD COLUMN migration_two TEXT');}finally{c4.close();}
 f.m.update(f.dir,f.j,{error:'scheduler migration failed after C4 success'});
 const result=f.r.resume(f.dir);
 assert.equal(result.stage,'restored_complete',JSON.stringify(result));
 assert.equal(result.completed,true);
 for(const [source] of inserts){
  const db=new Database(f.db(source),{readonly:true});try{
   assert.equal(db.pragma('user_version',{simple:true}),currentVersions[CORE_DATABASES.findIndex(item=>item.source===source)]);
   if(source.startsWith('comm-bridge')){assert.equal(db.prepare('SELECT count(*) AS n FROM checkpoints').get().n,0);assert.equal(db.pragma('table_info(checkpoints)').some(col=>col.name==='migration_two'),false);}
   if(source.startsWith('scheduler'))assert.equal(db.prepare('SELECT count(*) AS n FROM system_state').get().n,0);
   if(source.startsWith('web-console'))assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n,0);
  }finally{db.close();}
 }
 const journal=f.load();
 for(const item of CORE_DATABASES)assert.equal(journal.dbRestore?.[item.source]?.complete,true);
});
test('early abort refuses altered original CLI tree before service restart or database writes',async t=>{
 const f=await fixture(t),cli=path.join(f.root,'original-cli');fs.mkdirSync(cli,{mode:0o700});fs.writeFileSync(path.join(cli,'command.js'),'original',{mode:0o600});f.j.initialIdentity.cliRoot=cli;f.j.initialIdentity.cliHash=f.m.treeHash(cli);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});fs.writeFileSync(path.join(cli,'command.js'),'changed',{mode:0o600});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/original installed CLI identity changed/);assert.ok(!f.calls.includes('start'));assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
});
test('orphan installer with durable identity is quiesced before compensation',async t=>{
 const f=await fixture(t);change(f);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 f.m.update(f.dir,f.j,{installerStarted:true,installerPid:child.pid,installerIdentity:f.m.identity(child.pid),installerExitUnconfirmed:true});
 const exited=new Promise(resolve=>child.once('exit',resolve)),result=f.r.resume(f.dir);await exited;
 assert.equal(result.completed,true,JSON.stringify(result));assert.equal(f.load().installerExitConfirmed,true);assert.equal(f.load().installerExitUnconfirmed,false);
 assert.equal(require(path.join(f.dir,'finalizer.cjs')).members(child.pid).length,0);assert.ok(f.calls.includes('start'));
});
for(const dangling of [false,true])test(`original CLI ${dangling?'dangling':'live'} symlink prevents preinstall abort provenance`,async t=>{
 const f=await fixture(t),cli=path.join(f.root,'original-cli'),outside=path.join(f.root,'outside.js');fs.mkdirSync(cli,{mode:0o700});if(!dangling)fs.writeFileSync(outside,'fixture',{mode:0o600});fs.symlinkSync(outside,path.join(cli,'linked.js'));f.j.initialIdentity.cliRoot=cli;f.j.initialIdentity.cliHash=f.m.treeHash(cli);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const before=fs.readFileSync(f.db('comm-bridge/c4.db')),result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/CLI symlink rejected/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!f.calls.includes('start'));
});

test('resume uses phase durably changed before controller acquisition instead of stale pre-lock journal', async t => {
  const f = await fixture(t);
  change(f);
  const before = fs.readFileSync(f.db('comm-bridge/c4.db'));
  const acquire = f.m.acquire;
  f.m.acquire = (dir, ...args) => {
    // Model another controller finishing data restoration before ownership is
    // acquired. The new ready phase must validate normal writes, not restore.
    const latest = f.m.read(path.join(dir, 'journal.json'));
    f.m.update(dir, latest, {phase:'restored_data_ready'});
    return acquire(dir, ...args);
  };
  const result = f.r.resume(f.dir);
  assert.equal(result.stage, 'restored_complete');
  assert.equal(result.recovery_required, false);
  assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')), before);
  assert.deepEqual(f.calls, ['start', 'verify']);
  assert.equal(fs.existsSync(path.join(f.root, '.backup/self-upgrade/tx/rescue')), false);
});
test('journal deployment identity changed before acquisition is rejected without writing or starting services', {skip:process.platform==='darwin'}, async t => {
  const f = await fixture(t);
  const acquire = f.m.acquire;
  f.m.acquire = (dir, ...args) => {
    const release = acquire(dir, ...args);
    const latest = f.m.read(path.join(dir, 'journal.json'));
    f.m.update(dir, latest, {zylosDir:path.join(f.root, 'redirected')});
    return release;
  };
  assert.throws(() => f.r.resume(f.dir), /invalid journal identity/);
  assert.deepEqual(f.calls, []);
  assert.equal(f.load().phase, 'installing');
  assert.equal(fs.existsSync(path.join(f.root, 'redirected')), false);
  assert.equal(fs.existsSync(path.join(f.dir, 'controller.json')), false);
});
test('resume through deployment root alias validates canonical journal identity under lock', async t => {
  const f = await fixture(t);
  f.m.update(f.dir, f.j, {phase:'restored_data_ready'});
  const alias = f.root + '-alias';
  fs.symlinkSync(f.root, alias);
  t.after(() => fs.unlinkSync(alias));
  const result = f.r.resume(path.join(alias, '.backup/self-upgrade/tx'));
  assert.equal(result.stage, 'restored_complete');
  assert.equal(result.recovery_required, false);
  assert.deepEqual(f.calls, ['start', 'verify']);
});
test('restored WAL-mode snapshot remains resumable after readonly preflight and interrupted READY publication', async t => {
  const f = await fixture(t, {wal:true});
  change(f);
  let interrupted = false;
  const update = f.m.update;
  f.m.update = (dir, j, changes={}) => {
    if (!interrupted && changes.phase==='restored_data_ready') {
      interrupted=true;
      throw Error('READY publication interrupted after readonly preflight');
    }
    return update(dir, j, changes);
  };
  const first = f.r.resume(f.dir);
  assert.equal(first.recovery_required, true);
  assert.match(first.error, /READY publication interrupted/);
  assert.equal(f.load().resumePhase, 'installing');
  const second = f.r.resume(f.dir);
  assert.equal(second.stage, 'restored_complete', JSON.stringify(second));
  assert.equal(second.recovery_required, false);
});
test('preinstall readonly verification still includes committed uncheckpointed original WAL data', async t => {
  const f = await fixture(t, {wal:true});
  const writer = new Database(f.db('comm-bridge/c4.db'));
  t.after(() => {if(writer.open)writer.close();});
  writer.pragma('wal_autocheckpoint=0');
  writer.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(82, 'committed-live-WAL');
  assert.ok(fs.statSync(f.db('comm-bridge/c4.db-wal')).size > 0);
  f.m.update(f.dir, f.j, {installationIntent:false, phase:'preparing'});
  const result = f.r.resume(f.dir);
  assert.equal(result.stage, 'aborted_before_install', JSON.stringify(result));
  assert.equal(result.recovery_required, false);
  assert.equal(writer.prepare('SELECT summary FROM checkpoints WHERE id=82').get().summary, 'committed-live-WAL');
});

for(const phase of ['restored_data_ready']) test(`${phase}: terminal marker clear failure retries without replacing committed data`, async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase});const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const unlink=fs.unlinkSync;let first=true;t.after(()=>{fs.unlinkSync=unlink;});
 fs.unlinkSync=file=>{if(first&&file===path.join(f.root,'.zylos/upgrade/active.json')){first=false;throw Error('terminal marker clear failed');}return unlink(file);};
 const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/marker clear failed/);
 assert.equal(f.load().phase,phase.startsWith('restored')?'restored_complete':'upgrade_complete');
 assert.equal(f.m.discover(f.root).blocked,false);assert.equal(f.m.discover(f.root).candidates.length,1);assert.ok(!f.calls.includes('stop'));
 f.calls.length=0;assert.equal(f.r.resume(f.dir).complete,true);assert.deepEqual(f.calls,[]);
 assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(fs.existsSync(f.dir));
 assert.equal(fs.existsSync(path.join(f.root,'.backup/self-upgrade-archive')),false);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/cleanup.json')),false);
 assert.equal(f.m.discover(f.root).candidates.length,0);
});
test('terminal marker unlink followed by fsync interruption recreates the marker and resumes in place', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});const unlink=fs.unlinkSync;let removed=false,first=true;
 const restoreSync=interceptSync(()=>{if(removed&&first){first=false;throw Error('marker directory fsync interrupted');}});
 t.after(()=>{fs.unlinkSync=unlink;restoreSync();});
 fs.unlinkSync=file=>{const value=unlink(file);if(file===path.join(f.root,'.zylos/upgrade/active.json'))removed=true;return value;};
 assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.m.discover(f.root).blocked,false);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),true);
 f.calls.length=0;assert.equal(f.r.resume(f.dir).complete,true);assert.deepEqual(f.calls,[]);assert.ok(fs.existsSync(f.dir));
});
for(const phase of ['restored_data_ready']) test(`${phase}: terminal journal write failure resumes verification without compensation`, async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase});const update=f.m.update;let first=true;
 f.m.update=(dir,j,changes={})=>{if(first&&changes.phase?.endsWith('_complete')){first=false;throw Error('terminal journal fsync failed');}return update(dir,j,changes);};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));assert.equal(f.r.resume(f.dir).recovery_required,true);
 assert.equal(f.load().resumePhase,'restored_verifying');
 assert.equal(f.m.discover(f.root).blocked,true);assert.equal(f.r.resume(f.dir).recovery_required,false);
 assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.equal(fs.existsSync(path.join(f.dir,'rescue')),false);
});
test('terminal marker is removed only after original services and durable terminal journal validate', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});const start=f.m.start,verify=f.m.verifyServices,unlink=fs.unlinkSync;t.after(()=>{fs.unlinkSync=unlink;});
 f.m.start=j=>{assert.ok(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')));assert.equal(f.m.discover(f.root).blocked,false);return start(j);};
 f.m.verifyServices=j=>{assert.ok(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')));return verify(j);};
 fs.unlinkSync=file=>{if(file===path.join(f.root,'.zylos/upgrade/active.json')){assert.equal(f.m.terminalValid(f.load()),true);assert.deepEqual(f.calls,['start','verify']);}return unlink(file);};
 assert.equal(f.r.resume(f.dir).recovery_required,false);assert.ok(fs.existsSync(f.dir));assert.equal(f.m.discover(f.root).candidates.length,0);
});
test('terminal directory remains in place and explicit repeat resume performs no service or DB work', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});assert.equal(f.r.resume(f.dir).completed,true);
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.calls.length=0;
 assert.equal(f.r.resume(f.dir).completed,true);assert.deepEqual(f.calls,[]);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
 assert.equal(f.m.discover(f.root).candidates.length,0);assert.ok(fs.existsSync(path.join(f.dir,'descriptor.json')));
});

test('verified terminal with stopped services retries startup without database compensation', async t => {
 const f=await fixture(t);f.m.update(f.dir,f.j,{phase:'restored_data_ready'});assert.equal(f.r.resume(f.dir).completed,true);
 const terminal=f.load();f.m.update(f.dir,terminal,{terminalServicesStopped:true});f.m.marker(f.root,f.dir,terminal);
 const start=f.m.start;let first=true;f.m.start=j=>{start(j);if(first){first=false;const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(74,'partially restarted service write');db.close();throw Error('terminal startup interrupted');}};
 f.calls.length=0;assert.equal(f.r.resume(f.dir).recovery_required,true);assert.equal(f.load().phase,'restored_complete');assert.equal(f.load().terminalServicesStopped,true);
 assert.equal(f.m.discover(f.root).blocked,false);assert.equal(f.m.discover(f.root).candidates.length,1);
 f.calls.length=0;assert.equal(f.r.resume(f.dir).completed,true);assert.deepEqual(f.calls,['start','verify']);assert.equal(f.load().terminalServicesStopped,false);
 const db=new Database(f.db('comm-bridge/c4.db'),{readonly:true});assert.equal(db.prepare('SELECT summary FROM checkpoints WHERE id=74').get().summary,'partially restarted service write');db.close();assert.equal(fs.existsSync(path.join(f.dir,'rescue')),false);
});

test('Mac production recovery aborts preinstall failure through held frozen ownership', {skip:process.platform!=='darwin'}, async t=>{
 const f=await fixture(t),runner=path.join(f.root,'.zylos/upgrade/recovery.cjs');
 f.m.update(f.dir,f.j,{installationIntent:false,phase:'preparing'});
 delete require.cache[runner]; // fixture wrapper is not the production entry.
 const {recovery}=await import('../upgrade-protection.js');
 const ctx={maintenance:f.m,journal:f.load(),transactionId:'tx',transactionDir:f.dir,releaseControl:f.m.acquire(f.dir),frozenRecoveryPath:runner,frozenRecoveryHash:f.m.hash(runner)};
 const before=fs.readFileSync(f.db('comm-bridge/c4.db'));
 const result=recovery(ctx);
 assert.equal(result.recovery_required,false,JSON.stringify(result));
 assert.equal(result.stage,'aborted_before_install');assert.equal(result.attempted,false);
 assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);
 assert.equal(fs.existsSync(path.join(f.dir,'controller.json')),false);
 assert.equal(ctx.releaseControl,null);
});

test('successful cleanup deletes only code copies and unlinks nested symlinks without following them', async t => {
 const f=await fixture(t),code=path.join(f.dir,'code');
 const outside=path.join(f.root,'external.txt');fs.writeFileSync(outside,'external data');
 fs.symlinkSync(outside,path.join(code,'external-link'));
 for(const name of ['install.log','recovery.log','rescue/evidence']){const file=path.join(f.dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name);}
 const retained=['descriptor.json','runner.cjs','maintenance.cjs','finalizer.cjs','install.log','recovery.log','rescue/evidence'];
 const hashes=Object.fromEntries(retained.map(name=>[name,f.m.hash(path.join(f.dir,name))]));
 const snapshotHash=f.m.treeHash(f.snapshot.dbBackupDir);
 f.m.update(f.dir,f.j,{phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:false,codeRemoved:false,servicesRestored:true}});
 const result=f.r.resume(f.dir);
 assert.equal(result.complete,true,JSON.stringify(result));assert.equal(fs.existsSync(code),false);
 assert.equal(f.load().cleanup.codeRemoved,true);assert.equal(f.load().cleanup.complete,true);
 for(const name of retained)assert.equal(f.m.hash(path.join(f.dir,name)),hashes[name]);
 assert.equal(f.m.treeHash(f.snapshot.dbBackupDir),snapshotHash);assert.equal(fs.readFileSync(outside,'utf8'),'external data');
 assert.equal(fs.existsSync(path.join(f.dir,'sqlite-runtime')),true);
 f.calls.length=0;assert.equal(f.r.resume(f.dir).complete,true);assert.deepEqual(f.calls,[]);
});

for(const phase of ['restored_data_ready','preparing'])test(`${phase} terminal retains code copies`,async t=>{
 const f=await fixture(t),code=path.join(f.dir,'code'),hash=f.m.treeHash(code);
 f.m.update(f.dir,f.j,{phase,...(phase==='preparing'?{installationIntent:false}:{})});
 const result=f.r.resume(f.dir);assert.equal(result.complete,true,JSON.stringify(result));
 assert.equal(f.m.treeHash(code),hash);assert.notEqual(f.load().cleanup.codeRemoved,true);
});

for(const gate of ['installerExitUnconfirmed','finalizerExitUnconfirmed','terminalServicesStopped','installerStarted','finalizerStarted'])test(`durable ${gate} prevents cleanup despite stale caller`,async t=>{
 const f=await fixture(t),code=path.join(f.dir,'code');
 const terminal={phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:false,codeRemoved:false,servicesRestored:true}};
 f.m.update(f.dir,f.j,terminal);const stale=structuredClone(f.j);
 f.m.update(f.dir,f.j,{[gate]:true});
 assert.equal(f.m.finishTerminal(f.dir,stale).complete,false);
 assert.equal(fs.existsSync(code),true);assert.equal(f.load().cleanup.complete,false);
 assert.equal(fs.existsSync(path.join(f.root,'.zylos/upgrade/active.json')),true);
});

test('partial code removal failure retries without compensation or service restart and preserves new writes',async t=>{
 const f=await fixture(t),code=path.join(f.dir,'code'),rm=fs.rmSync;let fail=true;
 t.after(()=>{fs.rmSync=rm;});
 fs.rmSync=(file,options)=>{if(file===code&&fail){fail=false;rm(path.join(code,'skills/comm-bridge'),{recursive:true});throw Error('partial code removal failed');}return rm(file,options);};
 f.m.update(f.dir,f.j,{phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:false,codeRemoved:false,servicesRestored:true}});
 const first=f.r.resume(f.dir);assert.equal(first.complete,false);assert.match(first.warnings.join('\n'),/partial code removal failed/);
 assert.equal(f.load().phase,'upgrade_complete');assert.equal(f.load().cleanup.complete,false);assert.equal(f.load().cleanup.codeRemoved,false);
 const db=new Database(f.db('comm-bridge/c4.db'));db.prepare('INSERT INTO checkpoints(id,summary) VALUES (?,?)').run(99,'post-ready write');db.close();
 // Missing marker must not hide pending cleanup from admission discovery.
 fs.unlinkSync(path.join(f.root,'.zylos/upgrade/active.json'));
 assert.equal(f.m.discover(f.root).candidates.length,1);
 f.calls.length=0;assert.equal(f.r.resume(f.dir).complete,true);assert.deepEqual(f.calls,[]);
 const check=new Database(f.db('comm-bridge/c4.db'));assert.equal(check.prepare('SELECT summary FROM checkpoints WHERE id=99').get().summary,'post-ready write');check.close();
 assert.equal(fs.existsSync(code),false);assert.equal(f.m.discover(f.root).candidates.length,0);
});

for(const targetExists of [true,false])test(`code root symlink is refused (target exists=${targetExists})`,async t=>{
 const f=await fixture(t),code=path.join(f.dir,'code'),target=path.join(f.root,'other-code');
 fs.renameSync(code,target);fs.symlinkSync(targetExists?target:path.join(f.root,'absent'),code);
 const before=f.m.treeHash(target);f.m.update(f.dir,f.j,{phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:false,codeRemoved:false,servicesRestored:true}});
 const result=f.r.resume(f.dir);assert.equal(result.complete,false);assert.match(result.warnings.join('\n'),/unsafe recovery path/);
 assert.equal(fs.lstatSync(code).isSymbolicLink(),true);assert.equal(f.m.treeHash(target),before);
 assert.equal(f.load().cleanup.complete,false);assert.equal(f.load().cleanup.codeRemoved,false);
});

for(const failure of ['directory-sync','completion-journal'])test(`code cleanup resumes after ${failure} failure with code already absent`,async t=>{
 const f=await fixture(t),code=path.join(f.dir,'code'),rename=fs.renameSync;let hit=false;
 const restoreSync=interceptSync(fd=>{
  if(failure!=='directory-sync'||hit||fs.existsSync(code))return;
  const actual=fs.fstatSync(fd),expected=fs.statSync(f.dir);
  if(actual.dev===expected.dev&&actual.ino===expected.ino){hit=true;throw Error('cleanup directory sync failed');}
 });
 fs.renameSync=(source,target)=>{
  if(failure==='completion-journal'&&!hit&&!fs.existsSync(code)&&target===path.join(f.dir,'journal.json')){hit=true;throw Error('cleanup completion journal failed');}
  return rename(source,target);
 };
 t.after(()=>{restoreSync();fs.renameSync=rename;});
 f.m.update(f.dir,f.j,{phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:false,codeRemoved:false,servicesRestored:true}});const first=f.r.resume(f.dir);
 assert.equal(hit,true);assert.equal(first.complete,false);assert.equal(fs.existsSync(code),false);
 assert.equal(f.load().cleanup.complete,false);assert.equal(f.load().cleanup.codeRemoved,false);
 f.calls.length=0;const retry=f.r.resume(f.dir);assert.equal(retry.complete,true,JSON.stringify(retry));assert.deepEqual(f.calls,[]);
 assert.equal(f.load().cleanup.codeRemoved,true);assert.equal(f.load().cleanup.complete,true);
});
