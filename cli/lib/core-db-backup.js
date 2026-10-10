import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const maintenance = createRequire(import.meta.url)('./upgrade-maintenance.cjs');
export const CORE_DATABASES=Object.freeze([
  {source:'comm-bridge/c4.db',owner:'comm-bridge',schema:'scripts/c4-schema.js'},
  {source:'scheduler/scheduler.db',owner:'scheduler',schema:'scripts/schema.js'},
  {source:'web-console/web-console.db',owner:'web-console',schema:'scripts/schema.js'},
]);
const WORKER=fileURLToPath(new URL('./core-db-backup-worker.js',import.meta.url));
function syncDir(dir){const fd=fs.openSync(dir,'r');try{maintenance.fsyncFd(fd);}finally{fs.closeSync(fd);}}
function durableJson(file,value){const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(value,null,2)+'\n');maintenance.fsyncFd(fd);}finally{fs.closeSync(fd);}syncDir(path.dirname(file));}
export function runCoreDbWorker(payload,{workerPath=WORKER,nodePath=process.execPath,timeout=120000}={}) {
  if(process.platform==='darwin') payload={nativeHelperPath:maintenance.nativeHelper(),...payload};
  const result=spawnSync(nodePath,[workerPath,JSON.stringify(payload)],{encoding:'utf8',timeout,maxBuffer:4*1024*1024,windowsHide:true});
  if(result.error||result.status!==0) throw new Error(`SQLite ${payload.action} failed: ${result.error?.message || result.stderr || `exit ${result.status}`}`);
  try{return JSON.parse(result.stdout);}catch{throw new Error('Invalid SQLite worker response');}
}
function validComplete(manifest) {
  return manifest?.formatVersion===1&&manifest.function==='core-self-upgrade-db'&&manifest.status==='complete'&&typeof manifest.id==='string'&&Array.isArray(manifest.databases)&&manifest.databases.length===3&&CORE_DATABASES.every(item=>manifest.databases.filter(row=>row.source===item.source).length===1)&&manifest.databases.every(row=>row.status==='missing'||(row.status==='backed_up'&&row.integrityCheck==='ok'&&typeof row.file==='string'&&path.basename(row.file)===row.file&&/^[a-f0-9]{64}$/.test(row.sha256)));
}
// Probe only snapshot durability, independently of recovery locks and process
// identity. Mac fullsync remains mandatory; fsync alone is not a substitute.
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
export function createCoreDbSnapshot({zylosDir,transactionId,fromVersion,toVersion,onProgress}) {
  if(!/^[a-zA-Z0-9_-]+$/.test(transactionId)) throw new Error('Invalid snapshot transaction ID');
  const root=path.join(zylosDir,'.backup','db');fs.mkdirSync(root,{recursive:true,mode:0o700});
  syncDir(path.dirname(root));syncDir(zylosDir);
  const staging=fs.mkdtempSync(path.join(root,'.staging-'));fs.chmodSync(staging,0o700);syncDir(root);
  let manifest;
  try {
    const result=runCoreDbWorker({action:'snapshot',zylosDir,stagingDir:staging});
    manifest={formatVersion:1,function:'core-self-upgrade-db',status:'complete',id:transactionId,from:fromVersion,to:toVersion,createdAt:new Date().toISOString(),databases:result.databases};
    if(!validComplete(manifest)) throw new Error('Incomplete snapshot group');
    durableJson(path.join(staging,'manifest.json'),manifest);
    const destination=path.join(root,transactionId);if(fs.existsSync(destination)) throw new Error(`Snapshot already exists: ${destination}`);
    fs.renameSync(staging,destination);syncDir(root);
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
      try {durableJson(path.join(staging,'failure.json'),{status:'failed',error:error.message,transactionId});}
      catch(writeError) {error.message+=`; failure record could not be persisted: ${writeError.message}`;}
    }
    error.stagingDir=staging;throw error;
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
  let installed;
  for(const item of CORE_DATABASES) {
    try {const req=createRequire(path.join(zylosDir,'.claude','skills',item.owner,'package.json'));req.resolve('better-sqlite3');installed=req;break;}catch{}
  }
  if(!installed) throw new Error('No installed core SQLite driver for independent recovery');
  copyPackage('better-sqlite3',installed);
  const workerPath=path.join(target,'core-db-backup-worker.js');fs.copyFileSync(WORKER,workerPath);
  const driverPath=path.join(packages,'better-sqlite3','lib','index.js');
  runCoreDbWorker({action:'probe',driverPath},{workerPath});
  function syncTree(dir) {
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})) {
      const file=path.join(dir,entry.name);
      if(entry.isDirectory()) syncTree(file);
      else {fs.chmodSync(file,0o600);const fd=fs.openSync(file,'r');try{maintenance.fsyncFd(fd);}finally{fs.closeSync(fd);}}
    }
    fs.chmodSync(dir,0o700);syncDir(dir);
  }
  syncTree(target);syncDir(transactionDir);
  return {workerPath,driverPath,nodePath:process.execPath,driverClosureRoot:target};
}
