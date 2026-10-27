import path from 'node:path';
import { createRequire } from 'node:module';
import { classifyCutoff } from './upgrade-cutoff.js';
import { resumeFinalizeBudget } from './upgrade-budget.js';
import { loadSnapshotManifest } from './upgrade-snapshot-manifest.js';

const require = createRequire(import.meta.url);
const maintenance = require('./upgrade-maintenance.cjs');
const failure = (code,message) => Object.assign(Error(message),{code,persisted:[]});

export function finalizeStatus(journal) {
  const hooks=journal.postCutoff?.items?.hooks;
  const dashboard=journal.dashboardInstall;
  const errors=dashboard ? Object.entries(dashboard.items || {}).filter(([,item])=>item.state==='failed').map(([item,state])=>({item,...state.lastError})) : [];
  if(dashboard?.dbCopy?.ok===false) errors.unshift({item:'dbCopy',...dashboard.dbCopy.error});
  const failedItems=hooks?.lastError?[{id:'hooks',...hooks.lastError}]:[];
  if(journal.phase==='recovery_required' && journal.lastError && !failedItems.length) {
    failedItems.push({id:'finalize',code:'FINALIZE_INCOMPLETE',reason:journal.lastError});
  }
  return {
    transactionId:journal.transactionId,
    core:{state:failedItems.length?'failed':journal.phase==='upgrade_complete'?'done':hooks?.state==='done'?'pending':hooks?.state || 'pending',failedItems,warnings:hooks?.warnings || []},
    dashboard:{state:'degraded',errors},
    next:journal.phase==='upgrade_complete'?null:'Repair the reported failure, then run zylos upgrade --resume-finalize.'
  };
}

export function locateFinalize(root, m = maintenance, { readManifest = true } = {}) {
  let found;
  try { found=m.discover(root); }
  catch(cause) {throw failure('CUTOFF_UNTRUSTED',cause.message);}
  if(found.diagnostics.length || found.candidates.length>1) throw failure('CUTOFF_UNTRUSTED','Upgrade transaction identity is ambiguous; inspect retained materials.');
  if(!found.candidates.length) throw failure('NOT_RESUMABLE','No protected upgrade is available for forward repair.');
  const candidate=found.candidates[0],j=candidate.journal;
  let dbManifest;
  const classification=classifyCutoff(j);
  if(classification==='untrusted') throw failure('CUTOFF_UNTRUSTED','Cutoff facts are incomplete or inconsistent; preserve current data.');
  if(classification!=='closed') throw failure('NOT_RESUMABLE','This transaction has not closed compensation.');
  try {
    if(j.zylosDir!==path.resolve(root) || j.transactionId!==path.basename(candidate.dir) ||
        j.dbBackupDir!==path.join(j.zylosDir,'.backup','db',j.transactionId)) throw Error('Upgrade material identity does not match the transaction.');
    if(readManifest) dbManifest=loadSnapshotManifest(j,m);
  } catch(cause) {throw failure('CUTOFF_UNTRUSTED',cause.message);}
  return {...candidate,dbManifest};
}

function targetHashes(journal,m) {
  return new Map((journal.postCutoff?.items?.hooks?.targets || []).map(target=>{
    const root=target.root==='zylos'?journal.zylosDir:journal.postCutoff.items.hooks.codexGlobalDir;
    try {return [target.id,m.hash(path.join(root,target.path))];} catch {return [target.id,null];}
  }));
}

function persistedChanges(before,after,originalHashes,m) {
  const persisted=[];
  if(JSON.stringify(before)!==JSON.stringify(after)) persisted.push('journal');
  const previous=before.postCutoff?.items?.hooks,current=after.postCutoff?.items?.hooks;
  if(current?.attempts!==previous?.attempts) persisted.push('journal.attempts');
  for(const item of current?.targets || []) {
    const changed=originalHashes && targetHashes(after,m).get(item.id)!==originalHashes.get(item.id);
    if(changed) persisted.push(`journal.items.hooks.${item.id}`);
  }
  return persisted;
}

export async function resumeFinalize(root,{status=false,timeout,entryAt=Date.now()}={},deps={}) {
  if(status && timeout!==undefined) throw failure('INVALID_ARGS','--status does not accept --finalize-timeout.');
  const budget=status?null:resumeFinalizeBudget(timeout,entryAt);
  const m=deps.maintenance ?? maintenance;
  let candidate=locateFinalize(root,m,{readManifest:status});
  if(status) return {ok:true,data:finalizeStatus(candidate.journal)};
  if(candidate.journal.phase!=='upgrade_complete' && (deps.platform ?? process.platform)!=='linux') throw failure('MANUAL_RECOVERY_REQUIRED','Automatic forward repair is available only on Linux; preserve current databases.');
  try { budget.check(); }
  catch(error) {
    const data=finalizeStatus(candidate.journal);
    data.core.state='failed';
    data.core.failedItems=[{id:'finalize',code:error.code,reason:error.message}];
    return {ok:false,error:{code:'FINALIZE_INCOMPLETE',message:error.message,persisted:[]},data};
  }
  const release=m.acquire(candidate.dir);
  const expected={dir:candidate.dir,transactionId:candidate.journal.transactionId};
  let before;
  let originalHashes;
  let isolated=false;
  try {
    candidate=locateFinalize(root,m);
    if(candidate.dir!==expected.dir || candidate.journal.transactionId!==expected.transactionId) throw failure('CUTOFF_UNTRUSTED','The upgrade transaction changed while acquiring its lock.');
    const j=m.transaction(root,candidate.dir);
    before=structuredClone(j);
    originalHashes=targetHashes(j,m);
    if(j.phase==='upgrade_complete') return {ok:true,data:finalizeStatus(j),cleanup:m.finishTerminal(candidate.dir,j)};
    budget.check();
    (deps.quiesce ?? m.verifyFinalizerExit)(candidate.dir,j,m);
    budget.check();
    // A previous finalizer may have released the stable reader before crashing.
    // Revoke that release durably before stopping or rechecking any writers.
    if(j.phase==='compensation_closed') m.update(candidate.dir,j,{phase:'recovery_required',resumePhase:'compensation_closed'});
    m.marker(root,candidate.dir,j);
    m.stop(j);
    isolated=true;
    budget.check();
    const verified=locateFinalize(root,m);
    if(verified.dir!==expected.dir || verified.journal.transactionId!==expected.transactionId) throw failure('CUTOFF_UNTRUSTED','The upgrade transaction changed while isolating writers.');
    const current=verified.journal;
    const finalize=deps.finalize ?? (await import('./self-upgrade.js')).resumeUpgradeFinalization;
    const ctx={transactionDir:candidate.dir,transactionId:j.transactionId,zylosDir:path.resolve(root),journal:current,budget,
      dbManifest:verified.dbManifest,preInstallProtection:true,maintenance:m,originalServices:current.originalServices,from:current.from,to:current.to};
    const result=await finalize(ctx);
    const saved=m.transaction(root,candidate.dir),data=finalizeStatus(saved);
    for(const key of ['completion','sessionRestart','checkpointAudit','modeStatus','preparationWarnings']) {
      if(Object.hasOwn(result,key)) data[key]=result[key];
    }
    // Only this invocation's runtime verification can establish readiness.
    if(result.success && result.dashboard) {
      data.dashboard=result.dashboard;
    }
    if(result.success) return {ok:true,data};
    data.core.state='failed';
    if(!data.core.failedItems.length || data.core.failedItems[0].code==='FINALIZE_INCOMPLETE') data.core.failedItems=[{id:result.failedStep ? `step${result.failedStep}`:'finalize',code:result.code || 'FINALIZE_INCOMPLETE',reason:result.error}];
    return {ok:false,error:{code:'FINALIZE_INCOMPLETE',message:result.error || 'Upgrade finalization did not complete.',persisted:persistedChanges(before,saved,originalHashes,m)},data};
  } catch(error) {
    if(error.code==='CUTOFF_UNTRUSTED' || !before) throw error;
    const saved=m.transaction(root,expected.dir);
    if(isolated && saved.phase!=='upgrade_complete') m.update(expected.dir,saved,{phase:'recovery_required',resumePhase:'compensation_closed',lastError:error.message});
    const data=finalizeStatus(saved);
    data.core.state='failed';
    if(!data.core.failedItems.length || data.core.failedItems[0].code==='FINALIZE_INCOMPLETE') data.core.failedItems=[{id:error.step ? `step${error.step}`:'finalize',code:error.code || 'FINALIZE_INCOMPLETE',reason:error.message}];
    return {ok:false,error:{code:'FINALIZE_INCOMPLETE',message:error.message,persisted:persistedChanges(before,saved,originalHashes,m)},data};
  } finally {release();}
}
