import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');
import {CORE_DATABASES, LEGACY_CORE_DATABASES, databasesForFormat, validateSnapshotManifest} from './core-db-backup-worker.js';
export {CORE_DATABASES, LEGACY_CORE_DATABASES, databasesForFormat, validateSnapshotManifest};
const WORKER=fileURLToPath(new URL('./core-db-backup-worker.js',import.meta.url));
export function inspectFirstDashboardTakeover(installedRoot) {
  const directory=path.join(installedRoot,'skills/dashboard');
  try {
    const stat=fs.lstatSync(directory);
    if(!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Installed Dashboard must be a regular directory');
    fs.accessSync(directory,fs.constants.R_OK);
    return false;
  } catch(error) {
    if(error.code==='ENOENT')return true;
    throw Object.assign(Error(`Cannot inspect installed Dashboard: ${error.message}`),{code:'DASHBOARD_TAKEOVER_INVALID'});
  }
}
export function inspectDashboardOwnerManaged(zylosDir, options={}) {
  return runCoreDbWorker({action:'dashboard-state',zylosDir,...options}).dashboardOwnerManaged;
}
function syncDir(dir){const fd=fs.openSync(dir,'r');try{maintenance.fsyncFd(fd);}finally{fs.closeSync(fd);}}
function durableJson(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');maintenance.fsyncFd(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(file));}
export function runCoreDbWorker(payload,{workerPath=WORKER,nodePath=process.execPath,timeout=120000}={}) {
  const result=spawnSync(nodePath,[workerPath,JSON.stringify(payload)],{encoding:'utf8',timeout,maxBuffer:4*1024*1024,windowsHide:true});
  if(result.error||result.status!==0) throw new Error(`SQLite ${payload.action} failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  try{return JSON.parse(result.stdout);}catch{throw new Error('Invalid SQLite worker response');}
}
function validComplete(manifest) {
  try {validateSnapshotManifest(manifest);return true;} catch {return false;}
}
// Probe only snapshot durability, independently of recovery locks and process
// identity. All platforms use Node synchronization and propagate its errors.
export function probeCoreDbSnapshotSync(zylosDir) {
  let probe;
  try {
    probe=fs.mkdtempSync(path.join(zylosDir,'.snapshot-sync-'));
    const file=path.join(probe,'probe');
    const fd=fs.openSync(file,'wx',0o600);
    try {fs.writeFileSync(fd,'snapshot durability probe\n');maintenance.fsyncFd(fd);} finally {fs.closeSync(fd);}
    syncDir(probe);syncDir(zylosDir);
  } catch(error) {
    throw new Error(`Reliable database snapshot synchronization unavailable; installation was not started: ${error.message}`);
  } finally {
    if(probe) fs.rmSync(probe,{recursive:true,force:true});
  }
}
// Run before any service is stopped or maintenance marker is published. This
// opens existing databases read-only using the installed Core native driver.
export function preflightCoreDbUpgrade(zylosDir, {dashboardOwnerManaged=true,driverRoot,schemaRoot}={}) {
  let destination = zylosDir;
  for (const relative of ['.backup', '.backup/db']) {
    const file = path.join(zylosDir, relative);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe database snapshot destination: ' + file);
      destination = file;
    }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  probeCoreDbSnapshotSync(zylosDir);
  if (destination !== zylosDir) probeCoreDbSnapshotSync(destination);
  return runCoreDbWorker({action:'offline-preflight',zylosDir,formatVersion:2,dashboardOwnerManaged,driverRoot,schemaRoot});
}
// Pure owner inspection decides compatibility; Dashboard owns its separate
// schema_migrations authority and never uses user_version for admission.
export function probeCoreDbVersions(zylosDir, tempDir, {driverRoot=path.join(zylosDir,'.claude','skills'),dashboardOwnerManaged=true}={}) {
  const schemaRoot=path.join(tempDir,'skills');
  return runCoreDbWorker({action:'version-probe',zylosDir,schemaRoot,driverRoot,formatVersion:2,dashboardOwnerManaged});
}
// Clear a fixed-name rehearsal left by an interrupted upgrade, plus older
// random-name copies. Refuse ambiguous paths before stopping services.
export function cleanupCoreDbRehearsals(zylosDir) {
  const removed=[];
  const root=path.join(zylosDir,'.backup','db');
  for(const dir of [path.join(zylosDir,'.backup'),root]) {
    let stat;
    try {stat=fs.lstatSync(dir);} catch(error) {if(error.code==='ENOENT') return {removed};throw error;}
    if(!stat.isDirectory()||stat.isSymbolicLink()) throw Error(`Unsafe rehearsal cleanup directory: ${dir}`);
  }
  const candidates=[];
  for(const name of fs.readdirSync(root)) {
    if(name!=='.rehearsal'&&!/^\.rehearsal-[A-Za-z0-9_-]+$/.test(name)) continue;
    const dir=path.join(root,name);
    const stat=fs.lstatSync(dir);
    if(!stat.isDirectory()||stat.isSymbolicLink()) throw Error(`Unsafe rehearsal copy: ${dir}`);
    candidates.push(dir);
  }
  for(const dir of candidates) {
    try {fs.rmSync(dir,{recursive:true});}
    catch(error) {error.removedRehearsals=removed;throw error;}
    removed.push(dir);
  }
  return {removed};
}
// Run the downloaded release's real migration code against SQLite online
// backup copies while services are still running. This is an early warning;
// the stopped, snapshotted databases are migrated and checked again later.
export function rehearseCoreDbUpgrade(zylosDir, tempDir, {driverRoot=path.join(zylosDir,'.claude','skills'),onCleanup,dashboardOwnerManaged=true}={}) {
  const schemaRoot=path.join(tempDir,'skills');
  const workerPath=path.join(tempDir,'cli','lib','core-db-backup-worker.js');
  if (!fs.existsSync(workerPath) || !fs.existsSync(path.join(schemaRoot,'comm-bridge','scripts','sqlite-schema.js'))) {
    throw new Error('Target release does not provide database rehearsal code');
  }
  // Keep complete chat/database copies under Zylos's private backup tree.
  // Parent cleanup also covers a worker timeout; an abrupt parent kill leaves
  // the copies in this known local directory rather than the system temp area.
  const created=[];
  try {
    for (const relative of ['.backup','.backup/db']) {
      const directory=path.join(zylosDir,relative);
      try {
        const stat=fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('Unsafe database rehearsal destination: '+directory);
      } catch(error) {
        if (error.code!=='ENOENT') throw error;
        fs.mkdirSync(directory,{mode:0o700});
        created.push(directory);
      }
    }
    const cleanup=cleanupCoreDbRehearsals(zylosDir);
    onCleanup?.(cleanup);
    const rehearsalDir=path.join(zylosDir,'.backup','db','.rehearsal');
    fs.mkdirSync(rehearsalDir,{mode:0o700});
    fs.chmodSync(rehearsalDir,0o700);
    try {return runCoreDbWorker({action:'rehearse',zylosDir,schemaRoot,driverRoot,rehearsalDir,formatVersion:2,dashboardOwnerManaged},{workerPath});}
    finally {fs.rmSync(rehearsalDir,{recursive:true,force:true});}
  } finally {
    for (const directory of created.reverse()) {
      try {fs.rmdirSync(directory);}
      catch(error) {if (!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code)) throw error;}
    }
  }
}
export function createCoreDbSnapshot({zylosDir,transactionId,fromVersion,toVersion,onProgress,verifySnapshot=runCoreDbWorker,formatVersion=2}) {
  if(formatVersion!==2) throw Error('New database snapshots require formatVersion 2');
  if(!/^[a-zA-Z0-9_-]+$/.test(transactionId)) throw new Error('Invalid snapshot transaction ID');
  const root=path.join(zylosDir,'.backup','db');fs.mkdirSync(root,{recursive:true,mode:0o700});
  syncDir(path.dirname(root));syncDir(zylosDir);
  const staging=fs.mkdtempSync(path.join(root,'.staging-'));fs.chmodSync(staging,0o700);syncDir(root);
  let manifest;
  try {
    const result=runCoreDbWorker({action:'snapshot',zylosDir,stagingDir:staging,formatVersion});
    manifest={formatVersion,function:'core-self-upgrade-db',status:'complete',id:transactionId,from:fromVersion,to:toVersion,createdAt:new Date().toISOString(),databases:result.databases};
    if(!validComplete(manifest)) throw new Error('Incomplete snapshot group');
    durableJson(path.join(staging,'manifest.json'),manifest);
    const destination=path.join(root,transactionId);if(fs.existsSync(destination)) throw new Error(`Snapshot already exists: ${destination}`);
    fs.renameSync(staging,destination);syncDir(root);
    // Verify the published group before retiring a previously verified one.
    verifySnapshot({action:'verify',zylosDir,dbBackupDir:destination,manifest});
    const warnings=[];
    for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
      if(!entry.isDirectory()||entry.name===transactionId||entry.name.startsWith('.')) continue;
      const oldDir=path.join(root,entry.name);
      if(!fs.existsSync(path.join(oldDir,'manifest.json'))) continue;
      try {
        const old=JSON.parse(fs.readFileSync(path.join(oldDir,'manifest.json'),'utf8'));
        if(!validComplete(old)||old.id!==entry.name||!Number.isFinite(Date.parse(old.createdAt))||Date.parse(old.createdAt)>Date.parse(manifest.createdAt)) continue;
        runCoreDbWorker({action:'verify',zylosDir,dbBackupDir:oldDir,manifest:old});
        fs.rmSync(oldDir,{recursive:true});syncDir(root);
      }catch(error){warnings.push(`Retained ${oldDir}: ${error.message}`);}
    }
    try {onProgress?.({dbBackupDir:destination,manifest,warnings});}catch(error){warnings.push(`Progress reporting failed: ${error.message}`);}
    return {dbBackupDir:destination,manifest,warnings};
  }catch(error) {
    if(fs.existsSync(staging)) {
      try {durableJson(path.join(staging,'failure.json'),{status:'failed',error:error.message,transactionId,failure:{code:'SNAPSHOT_FAILED',next:'Fix the database backup failure, then retry the upgrade; installation was not started.'}});}
      catch(writeError) {error.message+=`; failure record could not be persisted: ${writeError.message}`;}
    }
    error.code='SNAPSHOT_FAILED';error.stagingDir=staging;throw error;
  }
}
// Freeze the native driver and its runtime dependency closure before npm changes.
export function prepareRecoveryDependencies(transactionDir,zylosDir) {
  const target=path.join(transactionDir,'sqlite-runtime');fs.mkdirSync(target,{recursive:true,mode:0o700});
  fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}\n',{mode:0o600});
  const packages=path.join(target,'node_modules');fs.mkdirSync(packages,{mode:0o700});
  const copied=new Set();
  function copyPackage(name,req) {
    if(copied.has(name)) return;
    const packageFile=req.resolve(`${name}/package.json`), packageDir=path.dirname(packageFile);
    fs.cpSync(packageDir,path.join(packages,name),{recursive:true,dereference:true});copied.add(name);
    const data=JSON.parse(fs.readFileSync(packageFile,'utf8'));
    const own=createRequire(packageFile);
    // prebuild-install is an install-time dependency, never invoked at recovery time.
    for(const dependency of Object.keys(data.dependencies||{})) if(dependency!=='prebuild-install') copyPackage(dependency,own);
  }
  const installed=createRequire(path.join(zylosDir,'.claude','skills','comm-bridge','package.json'));
  installed.resolve('better-sqlite3');
  copyPackage('better-sqlite3',installed);
  const workerPath=path.join(target,'core-db-backup-worker.js');fs.copyFileSync(WORKER,workerPath);
  const driverPath=path.join(packages,'better-sqlite3','lib','index.js');
  runCoreDbWorker({action:'probe',driverPath},{workerPath});
  function syncTree(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      // A link's directory entry is persisted by syncDir; never chmod its target.
      if(entry.isSymbolicLink()) continue;
      if(entry.isDirectory()) syncTree(file);
      else {fs.chmodSync(file,0o600);const fd=fs.openSync(file,'r');try{maintenance.fsyncFd(fd);}finally{fs.closeSync(fd);}}
    }
    fs.chmodSync(dir,0o700);syncDir(dir);
  }
  syncTree(target);syncDir(transactionDir);
  return {workerPath,driverPath,nodePath:process.execPath,driverClosureRoot:target};
}
