// covers: cli/lib/core-db-backup.js cli/lib/runtime/upgrade-context.js cli/lib/upgrade-entry.js cli/lib/self-upgrade.js cli/lib/manifest.js cli/lib/upgrade-protection.js cli/lib/upgrade-resume.js skills/comm-bridge/scripts/c4-schema.js skills/scheduler/scripts/schema.js skills/comm-bridge/scripts/sqlite-schema.js cli/lib/upgrade-maintenance.cjs cli/lib/upgrade-installer.cjs cli/lib/core-db-backup-worker.js cli/lib/__tests__/fixtures/legacy-web-console-schema.js cli/lib/__tests__/helpers/legacy-web-console.js cli/lib/__tests__/helpers/released-snapshot.js skills/comm-bridge/scripts/__tests__/fixtures/migration-history/
import nativeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {LEGACY_CORE_DATABASES as CORE_DATABASES,createCoreDbSnapshot as snapshot,prepareRecoveryDependencies} from '../core-db-backup.js';
import {SUPPORTED_SCHEMA_VERSION as C4_VERSION} from '../../../skills/comm-bridge/scripts/c4-schema.js';
import {SUPPORTED_SCHEMA_VERSION as SCHEDULER_VERSION} from '../../../skills/scheduler/scripts/schema.js';
import {SUPPORTED_SCHEMA_VERSION as WEB_VERSION} from './fixtures/legacy-web-console-schema.js';
import {installLegacyWebConsoleSchema} from './helpers/legacy-web-console.js';
import {createReleasedSnapshotFixture} from './helpers/released-snapshot.js';

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
// Each test loads private copies of the real recovery and maintenance modules.
// Only service calls are replaced: database/native worker, hashes, journal,
// rescue, rename intents, isolation discovery, and terminal marker removal are real.
async function fixture(t,{missing=false,wal=false,formatVersion=3,dashboard=false,dashboardVersion=12,olderDatabases=false,sourceVersion=dashboard?'0.9.4':'0.9.3',webConsole=true}={}) {
 // webConsole=false is the 1.0 layout: neither the Web Console skill nor its database.
 const owners=CORE_DATABASES.filter(item=>webConsole||item.owner!=='web-console');
 const root=fs.realpathSync(fs.mkdtempSync(path.join(process.env.UPGRADE_RECOVERY_TEST_TMPDIR || os.tmpdir(),'upgrade-recovery-')));
 const previousHome=process.env.HOME,previousPm2Home=process.env.PM2_HOME,previousPackageRoot=process.env.ZYLOS_PACKAGE_ROOT;
 process.env.HOME=root;process.env.PM2_HOME=path.join(root,'.pm2');
 // Copied schemas and recovery subprocesses must use this candidate package.
 process.env.ZYLOS_PACKAGE_ROOT=path.resolve('.');
 t.after(()=>{
  if(previousHome===undefined)delete process.env.HOME;else process.env.HOME=previousHome;
  if(previousPm2Home===undefined)delete process.env.PM2_HOME;else process.env.PM2_HOME=previousPm2Home;
  if(previousPackageRoot===undefined)delete process.env.ZYLOS_PACKAGE_ROOT;else process.env.ZYLOS_PACKAGE_ROOT=previousPackageRoot;
 });
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const stable=path.join(root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
 for(const [src,dst] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',src),path.join(stable,dst));
 let m=require(path.join(stable,'maintenance.cjs')),r=require(path.join(stable,'recovery.cjs'));
 const skillsDir=path.join(root,'.claude/skills');
 for(const item of owners){const owner=path.join(skillsDir,item.owner);fs.mkdirSync(path.join(owner,'scripts'),{recursive:true});fs.writeFileSync(path.join(owner,'package.json'),'{"type":"module"}');dependencyDirectory(path.resolve('skills/comm-bridge/node_modules'),path.join(owner,'node_modules'));
  if(item.owner==='web-console'){installLegacyWebConsoleSchema(skillsDir);continue;}
  fs.copyFileSync(path.resolve('skills',item.owner,item.schema),path.join(owner,item.schema));
  const migration=item.owner==='comm-bridge'?'c4-migrations.js':'migrations.js';
  fs.copyFileSync(path.resolve('skills',item.owner,'scripts',migration),path.join(owner,'scripts',migration));
  if(item.owner==='scheduler')for(const file of ['migrations-v2.js','migrations-v3.js'])fs.copyFileSync(path.resolve('skills/scheduler/scripts',file),path.join(owner,'scripts',file));
 }
 for(const file of ['sqlite-schema.js','c4-migrations-v2.js','c4-migrations-v3.js','c4-migrations-v4.js','c4-migrations-v5.js','core-config-loader.js','upgrade-admission.js']) fs.copyFileSync(path.resolve('skills/comm-bridge/scripts',file),path.join(skillsDir,'comm-bridge/scripts',file));
 const loader=await import(pathToFileURL(path.join(skillsDir,'comm-bridge/scripts/core-config-loader.js')));
 assert.equal(loader.resolveCoreConfigModule(),path.resolve('cli/lib/config.js'));
 assert.equal(await loader.loadCoreConfig(),await import(pathToFileURL(path.resolve('cli/lib/config.js'))));
 for(const item of owners){if(missing&&item.owner==='scheduler')continue;const mod=await import(pathToFileURL(path.join(skillsDir,item.owner,item.schema)));const p=path.join(root,item.source);fs.mkdirSync(path.dirname(p),{recursive:true});const db=new Database(p);
  // Older C4/scheduler layouts come from the released v1 samples.
  const older=olderDatabases&&{'comm-bridge':'c4-v0.9.0-v1.sql',scheduler:'scheduler-v0.9.0-v1.sql'}[item.owner];
  if(older){db.exec(fs.readFileSync(path.resolve('skills/comm-bridge/scripts/__tests__/fixtures/migration-history',older),'utf8'));if(wal)db.pragma('journal_mode=WAL');db.close();continue;}
  for(const [name,columns] of Object.entries(mod.TABLES)) {
   const defs=mod.COLUMN_DEFINITIONS?.[name]||{};
   const primary=columns.filter(c=>defs[c]?.pk);
   const declarations=columns.map(c=>`"${c}" ${defs[c]?.type||'TEXT'}`);
   if(primary.length) declarations.push(`PRIMARY KEY (${primary.map(c=>`"${c}"`).join(',')})`);
   db.exec(`CREATE TABLE "${name}" (${declarations.join(',')})`);
  }
  db.pragma(`user_version=${mod.SUPPORTED_SCHEMA_VERSION}`);if(wal)db.pragma('journal_mode=WAL');db.close();
 }
 const dir=path.join(root,'.backup/self-upgrade','tx'),staging=path.join(root,'.backup/self-upgrade-staging','tx');
 fs.mkdirSync(path.dirname(dir),{recursive:true,mode:0o700});fs.mkdirSync(staging,{recursive:true,mode:0o700});
 const dashboardRoot=path.join(skillsDir,'dashboard');fs.mkdirSync(path.join(dashboardRoot,'src/lib'),{recursive:true});
 fs.writeFileSync(path.join(dashboardRoot,'package.json'),'{"type":"module","main":"index.js"}');
 fs.writeFileSync(path.join(dashboardRoot,'src/lib/schema-owner.js'),`export const dashboardSchemaOwner={inspectSchema(db){const currentVersion=db.prepare("SELECT name FROM sqlite_master WHERE name='schema_migrations'").get()?db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get().n:null;return {currentVersion,targetVersion:20,needsMigration:currentVersion!==20};},migrate(){throw Error('recovery must not migrate Dashboard');}};`);
 if(dashboard){const file=path.join(root,'components/dashboard/dashboard.db');fs.mkdirSync(path.dirname(file),{recursive:true});const db=new Database(file);db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);CREATE TABLE events(value TEXT);INSERT INTO events VALUES (\'original\')');db.prepare('INSERT INTO schema_migrations VALUES (?)').run(dashboardVersion);db.close();}
 fs.copyFileSync(path.join(stable,'recovery.cjs'),path.join(staging,'runner.cjs'));fs.chmodSync(path.join(staging,'runner.cjs'),0o600);
 for(const [src,dst] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-installer.cjs','installer.cjs']]){fs.copyFileSync(path.resolve('cli/lib',src),path.join(staging,dst));fs.chmodSync(path.join(staging,dst),0o600);}
 // Match beginUpgrade's controller timing: authenticate/load while staged,
 // retain that module across rename. The state-machine runner shares it so
 // service fault injection stays private; publication itself is tested through beginUpgrade.
 m=require(path.join(staging,'maintenance.cjs'));m.retainRemoval(m.hash(path.join(staging,'remove-owned-tree.mjs')));r=require(path.join(staging,'runner.cjs'));
 fs.renameSync(staging,dir);
 const snapshotResult=await createReleasedSnapshotFixture({Database,zylosDir:root,transactionId:'tx',formatVersion,snapshot}),closure=prepareRecoveryDependencies(dir,root,{dashboardRoot});
 const coreManifest=owners.map(item=>({name:item.owner,existedBefore:true,backedUp:true,originalHash:m.treeHash(path.join(skillsDir,item.owner),{excludeNodeModules:false})}));
 for(const e of coreManifest)fs.cpSync(path.join(skillsDir,e.name),path.join(dir,'code/skills',e.name),{recursive:true,verbatimSymlinks:true});
 // Match saveProtectedCode: the disposable code root is private.
 fs.chmodSync(path.join(dir,'code'),0o700);
 const prefix=path.join(root,'npm-prefix'),installedRoot=path.join(prefix,'lib/node_modules/zylos'),packageJson=path.join(installedRoot,'package.json'),originalCli=path.join(installedRoot,'cli'),binDir=path.join(prefix,'bin');
 fs.mkdirSync(originalCli,{recursive:true,mode:0o700});fs.mkdirSync(binDir,{recursive:true});fs.writeFileSync(packageJson,JSON.stringify({name:'zylos',version:sourceVersion,bin:{zylos:'cli/entry.js'}}));fs.writeFileSync(path.join(originalCli,'entry.js'),'original CLI\n');
 fs.symlinkSync(path.relative(binDir,path.join(originalCli,'entry.js')),path.join(binDir,'zylos'));
 const j={formatVersion:1,from:sourceVersion,firstTakeover:!dashboard,dashboardOwnerManaged:false,transactionId:'tx',zylosDir:root,skillsDir,nodePath:process.execPath,phase:'installing',installationIntent:true,installerStarted:true,installerStage:'install',installerExitConfirmed:true,dbBackupDir:snapshotResult.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshotResult.dbBackupDir,'manifest.json')),coreManifest,originalServices:[],initialIdentity:{nodePath:process.execPath,packageJson,packageHash:m.hash(packageJson),cliRoot:originalCli,cliHash:m.treeHash(originalCli),workerPath:closure.workerPath,workerHash:m.hash(closure.workerPath),ecosystemHash:null,databases:m.databasePaths(2).map(source=>({source,exists:fs.existsSync(path.join(root,source))}))}};
 // Package restoration has already completed in this database recovery fixture;
 // dedicated package tests exercise replacement and verification failures.
 const originalSnapshot=path.join(dir,'code/original-package');fs.cpSync(installedRoot,originalSnapshot,{recursive:true,verbatimSymlinks:true});
 fs.chmodSync(originalSnapshot,fs.statSync(installedRoot).mode);
 fs.chmodSync(path.join(originalSnapshot,'cli'),fs.statSync(originalCli).mode);
 j.originalPackage={path:originalSnapshot,treeHash:m.treeHash(originalSnapshot,{excludeNodeModules:false,includeModes:true}),sourceVersion:j.from,sourceRoot:installedRoot};j.originalPackageRestored=true;
 const descriptor={formatVersion:1,transactionId:'tx',...closure,runnerPath:path.join(dir,'runner.cjs'),hashes:Object.fromEntries(['runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs'].map(name=>[name,m.hash(path.join(dir,name))]))};j.recoveryHashes=descriptor.hashes;m.durable(path.join(dir,'descriptor.json'),descriptor);m.update(dir,j);m.marker(root,dir,j);
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


test('complete compensation restores old code/data, preserves rescue, removes sidecars and retains terminal materials',async t=>{
 const f=await fixture(t,{missing:true});change(f);fs.mkdirSync(path.dirname(f.db('scheduler/scheduler.db')),{recursive:true});fs.writeFileSync(f.db('scheduler/scheduler.db'),'new-db');
 const original=fs.readFileSync(f.db('comm-bridge/c4.db'));const result=f.r.resume(f.dir);assert.equal(result.completed,true);assert.equal(result.stage,'restored_complete');assert.ok(!fs.existsSync(f.db('scheduler/scheduler.db')));assert.ok(!fs.existsSync(f.db('comm-bridge/c4.db-wal')));
 const archived=path.join(f.root,'.backup/self-upgrade/tx');assert.deepEqual(fs.readFileSync(path.join(archived,'rescue/comm-bridge_c4.db')),original);assert.deepEqual(fs.readFileSync(path.join(archived,'rescue/scheduler_scheduler.db')),Buffer.from('new-db'));assert.equal(f.m.discover(f.root).blocked,false);assert.deepEqual(f.calls,['stop','start','verify']);
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

test('failed stop verification refuses physical replacement and service start',async t=>{
 const f=await fixture(t);change(f);const before=fs.readFileSync(f.db('comm-bridge/c4.db'));f.m.stop=()=>{f.calls.push('stop');throw Error('PM2 stop not confirmed');};const result=f.r.resume(f.dir);assert.equal(result.recovery_required,true);assert.match(result.error,/not confirmed/);assert.deepEqual(fs.readFileSync(f.db('comm-bridge/c4.db')),before);assert.ok(!fs.existsSync(path.join(f.dir,'rescue')));assert.ok(!f.calls.includes('start'));
});

// Another program keeps the failed scheduler database open: a real SQLite
// connection in a child process running a script file, inside a read
// transaction, closed on request or, with closeAfterMs, by itself.
const HOLDER_SCRIPT=`const Database=require(${JSON.stringify(path.resolve('skills/comm-bridge/node_modules/better-sqlite3'))});
const [file,closeAfterMs]=process.argv.slice(2);
const db=new Database(file);db.pragma('wal_autocheckpoint=0');
db.exec('BEGIN');db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
const close=()=>{db.exec('COMMIT');db.close();process.stdout.write('closed\\n');};
process.stdout.write('ready\\n');
if(closeAfterMs)setTimeout(close,Number(closeAfterMs));else process.stdin.once('data',close);`;
async function databaseHolder(t,f,file,{closeAfterMs}={}){
 const script=path.join(f.root,'database-holder.js');
 fs.writeFileSync(script,HOLDER_SCRIPT);
 const child=spawn(process.execPath,[script,file,...(closeAfterMs?[String(closeAfterMs)]:[])],{stdio:['pipe','pipe','inherit']});
 t.after(()=>{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');});
 const exited=new Promise(resolve=>child.once('exit',resolve));
 const line=expected=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Error('database holder did not report '+expected)),10000);
  const onData=chunk=>{if(String(chunk).includes(expected)){clearTimeout(timer);child.stdout.off('data',onData);resolve();}};
  child.stdout.on('data',onData);child.once('exit',()=>{clearTimeout(timer);reject(Error('database holder exited'));});
 });
 await line('ready');
 return {pid:child.pid,exited,
  close:async()=>{const closed=line('closed');child.stdin.end('close\n');await closed;await exited;}};
}
// The failed scheduler database in WAL mode, as the services leave it.
function walScheduler(f){const p=f.db('scheduler/scheduler.db'),db=new Database(p);try{db.pragma('journal_mode=WAL');db.exec("INSERT INTO system_state(key,value) VALUES ('generation','failed')");}finally{db.close();}return p;}
const snapshotBytes=(f,source)=>fs.readFileSync(path.join(f.snapshot.dbBackupDir,f.snapshot.manifest.databases.find(item=>item.source===source).file));
const fileState=p=>['','-wal','-shm'].map(suffix=>fs.existsSync(p+suffix)?f_hash(p+suffix):null);
function f_hash(file){return require('node:crypto').createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
const holderMessage=pids=>`Core databases are still open in another process (pid ${pids.join(', ')}). Stop the related services, then run zylos recovery resume.`;

test('rollback stops before touching any file while another process has a database open, and resume completes once it closes',{timeout:60000},async t=>{
 const f=await fixture(t);change(f);const p=walScheduler(f);
 const holder=await databaseHolder(t,f,p);
 assert.ok(fs.existsSync(p+'-wal')&&fs.existsSync(p+'-shm'));
 const before={scheduler:fileState(p),c4:fileState(f.db('comm-bridge/c4.db'))};
 const first=f.r.resume(f.dir);
 assert.equal(first.recovery_required,true,JSON.stringify(first));
 // The process id only: no program name or command line.
 assert.ok(first.error.includes(holderMessage([holder.pid])),first.error);
 assert.doesNotMatch(first.error,/database-holder|node/);
 assert.equal(fs.existsSync(path.join(f.dir,'rescue')),false);
 assert.equal(f.load().actions,undefined);assert.equal(f.load().databaseHolderCheck,undefined);
 assert.deepEqual({scheduler:fileState(p),c4:fileState(f.db('comm-bridge/c4.db'))},before);
 assert.ok(!f.calls.includes('start'));
 await holder.close();
 const second=f.r.resume(f.dir);
 assert.equal(second.completed,true,JSON.stringify(second));
 for(const source of ['comm-bridge/c4.db','scheduler/scheduler.db']){
  assert.ok(fs.readFileSync(f.db(source)).equals(snapshotBytes(f,source)),source);
  assert.ok(!fs.existsSync(f.db(source)+'-wal')&&!fs.existsSync(f.db(source)+'-shm'));
 }
 assert.ok(f.calls.includes('start'));
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
   if(source.startsWith('web-console'))assert.equal(db.prepare('SELECT count(*) AS n FROM sessions').get().n,1);
  }finally{db.close();}
 }
 const journal=f.load();
 for(const item of CORE_DATABASES.filter(item=>item.owner!=='web-console'))assert.equal(journal.dbRestore?.[item.source]?.complete,true);
 assert.equal(journal.dbRestore?.['web-console/web-console.db'],undefined);
});
test('orphan installer with durable identity is quiesced before compensation',{timeout:30000},async t=>{
 const f=await fixture(t);change(f);const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});t.after(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}});
 f.m.update(f.dir,f.j,{installerStarted:true,installerPid:child.pid,installerIdentity:f.m.identity(child.pid),installerExitUnconfirmed:true});
 const exited=new Promise(resolve=>child.once('exit',resolve)),result=f.r.resume(f.dir);
 if(process.platform==='darwin'){
  assert.equal(result.recovery_required,true);assert.equal(result.error,'installer process identity changed or cannot be verified; manual recovery required');
  assert.doesNotThrow(()=>process.kill(child.pid,0));process.kill(-child.pid,'SIGKILL');await exited;return;
 }
 await exited;
 assert.equal(result.completed,true,JSON.stringify(result));assert.equal(f.load().installerExitConfirmed,true);assert.equal(f.load().installerExitUnconfirmed,false);
 assert.equal(require(path.join(f.dir,'installer.cjs')).members(child.pid).length,0);assert.ok(f.calls.includes('start'));
});



test('successful cleanup deletes only code copies and unlinks nested symlinks without following them', async t => {
 const f=await fixture(t),code=path.join(f.dir,'code');
 const outside=path.join(f.root,'external.txt');fs.writeFileSync(outside,'external data');
 fs.symlinkSync(outside,path.join(code,'external-link'));
 for(const name of ['install.log','recovery.log','rescue/evidence']){const file=path.join(f.dir,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,name);}
 const retained=['descriptor.json','runner.cjs','maintenance.cjs','installer.cjs','remove-owned-tree.mjs','install.log','recovery.log','rescue/evidence'];
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
