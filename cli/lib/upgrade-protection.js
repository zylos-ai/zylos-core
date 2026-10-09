import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createCoreDbSnapshot, prepareRecoveryDependencies, runCoreDbWorker } from './core-db-backup.js';
import { verifyUpgradeBootCapability } from './upgrade-boot-capability.js';
const require=createRequire(import.meta.url);
export const maintenance=require('./upgrade-maintenance.cjs');
const library=import.meta.dirname;
export function deployUpgradeBootstrap(root) {
  const prior=maintenance.discover(root);if(prior.candidates.length||prior.diagnostics.length||prior.marker)throw Error('cannot replace stable bootstrap during an unresolved upgrade');
  root=fs.realpathSync(root);
  const meta=path.join(root,'.zylos');
  if(!fs.existsSync(meta))fs.mkdirSync(meta,{mode:0o700});
  maintenance.privatePath(meta,{directory:true});
  const dest=path.join(meta,'upgrade');fs.mkdirSync(dest,{recursive:true,mode:0o700});maintenance.privatePath(dest,{directory:true});
  for(const [src,name] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs'],['upgrade-bootstrap.cjs','bootstrap.cjs'],['upgrade-finalizer.cjs','finalizer.cjs'],['upgrade-runtime-args.cjs','runtime-args.cjs']]) {
    const target=path.join(dest,name),staging=target+'.'+crypto.randomBytes(8).toString('hex')+'.staging';fs.copyFileSync(path.join(library,src),staging,fs.constants.COPYFILE_EXCL);fs.chmodSync(staging,0o600);const fd=fs.openSync(staging,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(staging,target);maintenance.fsyncDir(dest);
  }
  return path.join(dest,'bootstrap.cjs');
}
function declared(dir) {const root=path.join(dir,'skills');if(!fs.existsSync(root))throw Error('package core declaration missing');return fs.readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()).map(e=>e.name);}
export function beginUpgrade(ctx,{zylosDir,skillsDir}) {
  const found=maintenance.discover(zylosDir);if(found.candidates.length||found.diagnostics.length||found.marker)throw Error('unresolved prior upgrade transaction');
  const id='upgrade-'+Date.now()+'-'+crypto.randomBytes(6).toString('hex'),dir=path.join(zylosDir,'.backup','self-upgrade',id);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.chmodSync(path.dirname(dir),0o700);
  const manifest=[...new Set([...declared(ctx.coreDir),...declared(ctx.tempDir)])].sort().map(name=>{
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(name))throw Error('invalid core declaration');const p=path.join(fs.realpathSync(skillsDir),name);
    let existing;try{existing=fs.lstatSync(p);}catch(error){if(error.code!=='ENOENT')throw error;}
    if(existing&&(!existing.isDirectory()||existing.isSymbolicLink()))throw Error('core skill target must be an individual real directory: '+name);
    return {name,existedBefore:fs.existsSync(p),backedUp:false,originalHash:fs.existsSync(p)?maintenance.treeHash(p):null};
  });
  const packageJson=path.join(ctx.coreDir,'package.json'),ecosystem=path.join(zylosDir,'pm2','ecosystem.config.cjs');
  const j={formatVersion:1,transactionId:id,zylosDir:path.resolve(zylosDir),skillsDir:path.resolve(skillsDir),nodePath:process.execPath,from:ctx.from,to:ctx.to,phase:'preparing',installationIntent:false,coreManifest:manifest,originalServices:maintenance.services({skillsDir}).filter(s=>s.status==='online'),knownProcesses:[],initialIdentity:{cliRoot:path.join(ctx.coreDir,'cli'),cliHash:maintenance.treeHash(path.join(ctx.coreDir,'cli')),packageJson,packageHash:maintenance.hash(packageJson),nodePath:process.execPath,workerPath:path.join(ctx.coreDir,'cli','lib','core-db-backup-worker.js'),workerHash:maintenance.hash(path.join(ctx.coreDir,'cli','lib','core-db-backup-worker.js')),ecosystemHash:fs.existsSync(ecosystem)?maintenance.hash(ecosystem):null,databases:maintenance.DB_PATHS.map(source=>({source,exists:fs.existsSync(path.join(zylosDir,source))}))},cleanup:{complete:false}};
  maintenance.update(dir,j);ctx.releaseControl=maintenance.acquire(dir);ctx.transactionDir=dir;ctx.transactionId=id;ctx.journal=j;ctx.coreManifest=manifest;ctx.backupDir=path.join(dir,'code');ctx.servicesWereRunning=j.originalServices.map(s=>s.name);ctx.preInstallProtection=true;
  return j;
}
export function saveProtectedCode(ctx) {
  const j=ctx.journal,dir=ctx.transactionDir;fs.mkdirSync(ctx.backupDir,{recursive:true,mode:0o700});
  for(const e of j.coreManifest){if(!e.existedBefore)continue;const p=maintenance.target(j,e.name),dest=path.join(ctx.backupDir,'skills',e.name);fs.cpSync(p,dest,{recursive:true,verbatimSymlinks:true,filter:s=>path.relative(p,s).split(path.sep)[0]!=='node_modules'});if(maintenance.treeHash(dest)!==e.originalHash)throw Error('core backup changed during copy');maintenance.fsyncTree(dest);maintenance.fsyncDir(path.dirname(dest));e.backedUp=true;maintenance.update(dir,j);}
  const ecosystem=path.join(j.zylosDir,'pm2','ecosystem.config.cjs');if(j.initialIdentity.ecosystemHash){const dest=path.join(ctx.backupDir,'pm2','ecosystem.config.cjs');fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(ecosystem,dest);}
  maintenance.fsyncTree(ctx.backupDir);maintenance.fsyncDir(dir);
  maintenance.update(dir,j,{phase:'code_saved'});
}
export function prepareProtectedInstall(ctx,{verifyBoot=verifyUpgradeBootCapability}={}) {
  const j=ctx.journal,dir=ctx.transactionDir;
  maintenance.marker(j.zylosDir,dir,j);maintenance.update(dir,j,{phase:'stopping'});maintenance.stop(j);maintenance.update(dir,j,{phase:'offline'});
  const snapshot=createCoreDbSnapshot({zylosDir:j.zylosDir,transactionId:j.transactionId,fromVersion:j.from,toVersion:j.to});ctx.dbBackupDir=snapshot.dbBackupDir;ctx.dbManifest=snapshot.manifest;ctx.backupWarnings=snapshot.warnings;
  maintenance.update(dir,j,{phase:'snapshot_saved',dbBackupDir:snapshot.dbBackupDir,snapshotManifestHash:maintenance.hash(path.join(snapshot.dbBackupDir,'manifest.json'))});
  const deps=prepareRecoveryDependencies(dir,j.zylosDir);
  for(const [src,name] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','runner.cjs'],['upgrade-finalizer.cjs','finalizer.cjs']]){const file=path.join(dir,name);fs.copyFileSync(path.join(library,src),file);fs.chmodSync(file,0o600);const fd=fs.openSync(file,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}maintenance.fsyncDir(dir);
  const descriptor={formatVersion:1,transactionId:j.transactionId,nodePath:deps.nodePath,workerPath:deps.workerPath,driverPath:deps.driverPath,runnerPath:path.join(dir,'runner.cjs'),driverClosureRoot:deps.driverClosureRoot,driverClosureHashes:deps.driverClosureHashes,hashes:{'finalizer.cjs':maintenance.hash(path.join(dir,'finalizer.cjs')),'maintenance.cjs':maintenance.hash(path.join(dir,'maintenance.cjs')),'runner.cjs':maintenance.hash(path.join(dir,'runner.cjs'))}};
  maintenance.durable(path.join(dir,'descriptor.json'),descriptor);maintenance.update(dir,j,{phase:'runner_saved'});
  maintenance.validateDescriptor(dir,j,descriptor);const checked=maintenance.preflight(dir,j,snapshot.manifest);j.stableDataEvidence=checked.databases?.map(d=>d.logicalHash);maintenance.update(dir,j);if(checked.success===false)throw Error(checked.error||'saved readonly worker self-check failed');
  ctx.bootCapability=verifyBoot({zylosDir:j.zylosDir,nodePath:process.execPath,bootstrapPath:path.join(j.zylosDir,'.zylos','upgrade','bootstrap.cjs')});
  maintenance.update(dir,j,{phase:'prepared',bootCapability:ctx.bootCapability});
}
export function markInstallationIntent(ctx) {maintenance.update(ctx.transactionDir,ctx.journal,{phase:'installing',installationIntent:true});}
export function recovery(ctx) {
  const release=()=>{try{ctx.releaseControl?.();}finally{ctx.releaseControl=null;}};
  let saved=ctx.journal;
  try {
    const root=path.resolve(ctx.journal.zylosDir),id=ctx.transactionId||ctx.journal.transactionId;
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/.test(id))throw Error('invalid recovery transaction identity');
    const active=path.join(root,'.backup','self-upgrade',id),archived=path.join(root,'.backup','self-upgrade-archive',id);
    const hasActive=fs.existsSync(active),hasArchived=fs.existsSync(archived);
    if(hasActive&&hasArchived)throw Error('ambiguous active and archived recovery material');
    if(!hasActive&&!hasArchived)throw Error('recovery transaction material is missing');
    const dir=hasActive?active:archived;
    if(hasActive)saved=maintenance.transaction(root,dir);
    else{maintenance.privatePath(dir,{directory:true});saved=maintenance.read(path.join(dir,'journal.json'));if(saved.formatVersion!==1||saved.transactionId!==id||saved.zylosDir!==root||!maintenance.terminalValid(saved))throw Error('unverified archived recovery transaction');}
    ctx.journal=saved;ctx.transactionDir=dir;
    // This entry is the parent's explicit failed-upgrade path, whereas direct
    // bootstrap resume is interruption continuation. A failed new finalizer
    // after data_ready must compensate, even if a later startup retry could
    // pass. Verified terminals and restored-data validation never compensate.
    const failedNewReady=!maintenance.terminalValid(saved)&&maintenance.READY.has(saved.phase)&&saved.phase.startsWith('new');
    if(ctx.finalizerExitUnconfirmed){
      // The child may have persisted ready/terminal state and new identities.
      // Never overwrite those with the old parent's in-memory journal.
      const terminal=maintenance.terminalValid(saved);
      maintenance.marker(root,active,saved);
      maintenance.update(dir,saved,{...(terminal?{archiveRecoveryRequired:true,archiveServicesStopped:true}:{resumePhase:failedNewReady?'restoring':saved.phase==='recovery_required'?saved.resumePhase:saved.phase,phase:'recovery_required'}),error:'finalizer exit unconfirmed',finalizerExitUnconfirmed:true});
      let error='finalizer exit unconfirmed; do not replace databases';
      try{maintenance.stop(saved);}catch(stopError){error+='; isolation: '+stopError.message;maintenance.update(dir,saved,{error});}
      release();return {attempted:false,completed:false,stage:'finalizer_exit',error,recovery_required:true};
    }
    if(failedNewReady){
      maintenance.marker(root,active,saved);
      maintenance.update(dir,saved,{phase:'recovery_required',resumePhase:'restoring',error:'new finalizer failed after data-ready publication'});
      maintenance.stop(saved);
    }
    release();
    // A lost finalizer response cannot authorize compensation of an already
    // verified terminal. Resume its saved runner for cleanup/exit verification.
    let runner=path.join(root,'.zylos','upgrade','recovery.cjs');
    if(saved.installationIntent&&!maintenance.terminalValid(saved)){
      const descriptor=maintenance.read(path.join(dir,'descriptor.json'));maintenance.validateDescriptor(dir,saved,descriptor);runner=descriptor.runnerPath;
    }
    const child=spawnSync(process.execPath,[runner,'resume','--transaction-dir',dir,'--json'],{encoding:'utf8',timeout:300000});
    if(child.error)return {attempted:!!saved.installationIntent&&!maintenance.terminalValid(saved),completed:false,stage:saved.phase,error:child.error.message,recovery_required:true};
    try{return JSON.parse(child.stdout);}catch{return {attempted:!!saved.installationIntent&&!maintenance.terminalValid(saved),completed:false,stage:saved.phase,error:child.stderr||'invalid recovery output',recovery_required:true};}
  }catch(error){try{release();}catch{}return {attempted:false,completed:false,stage:saved?.phase,error:error.message,recovery_required:true};}
}
export function protectedDataReady(ctx) {
  const dir=ctx.transactionDir,j=maintenance.read(path.join(dir,'journal.json'));
  const checked=maintenance.preflight(dir,j,null);if(checked.success===false)throw Error(checked.error||'new code offline preflight failed');maintenance.update(dir,j,{phase:'new_data_ready'});maintenance.unmark(j.zylosDir,j);
}
export function protectedSuccess(ctx) {
  const dir=ctx.transactionDir,j=maintenance.read(path.join(dir,'journal.json'));
  maintenance.update(dir,j,{phase:'upgrade_complete',terminalEvidence:{verified:true,kind:'code_data_services'},cleanup:{complete:true,markerRemoved:true,servicesRestored:true},cleanupPending:true});
  // The parent owns finalizer exit verification. Keep cleanup discoverable
  // until it confirms the entire process group is gone, then archives it.
  maintenance.durable(path.join(j.zylosDir,'.zylos','upgrade','cleanup.json'),{formatVersion:1,transactionId:j.transactionId});
  return {complete:false,warnings:[]};
}
