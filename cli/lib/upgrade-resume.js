import path from 'node:path';
import { createRequire } from 'node:module';
import { classifyCutoff } from './upgrade-cutoff.js';
import { loadSnapshotManifest } from './upgrade-snapshot-manifest.js';
import { upgradeFailureCode } from './upgrade-admission.js';

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
    warnings:journal.runtimeWarnings || [],
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

function recordChanges(before,after,changes) {
  const walk = (previous, current, key) => {
    if (key === 'journal.updatedAt') return;
    if (JSON.stringify(previous) === JSON.stringify(current)) return;
    const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
    if ((object(previous) || previous === undefined) && (object(current) || current === undefined)) {
      const names=new Set([...Object.keys(previous || {}), ...Object.keys(current || {})]);
      if(!names.size) changes.add(key);
      for (const name of names) walk(previous?.[name], current?.[name], `${key}.${name}`);
    } else changes.add(key);
  };
  walk(before,after,'journal');
}

export async function resumeFinalize(root,{status=false}={},deps={}) {
  const base=deps.maintenance ?? maintenance;
  const persisted=new Set();
  const m=Object.create(base);
  m.update=(dir,journal,changes)=>{
    const previous=base.transaction(root,dir);
    let result;
    try { result=base.update(dir,journal,changes); }
    catch(error) {
      // A rename may have committed bytes before a later fsync failed.
      try { recordChanges(previous,base.transaction(root,dir),persisted); } catch {}
      throw error;
    }
    recordChanges(previous,base.transaction(root,dir),persisted);
    return result;
  };
  let candidate=locateFinalize(root,m,{readManifest:status});
  if(status) return {ok:true,data:finalizeStatus(candidate.journal)};
  if(candidate.journal.phase!=='upgrade_complete' && !m.canRecognizeProcesses(deps.platform ?? process.platform)) throw failure('MANUAL_RECOVERY_REQUIRED','Process identity cannot be verified; preserve current databases and recover manually.');
  const release=m.acquire(candidate.dir);
  const expected={dir:candidate.dir,transactionId:candidate.journal.transactionId};
  let before;
  let isolated=false;
  try {
    candidate=locateFinalize(root,m);
    if(candidate.dir!==expected.dir || candidate.journal.transactionId!==expected.transactionId) throw failure('CUTOFF_UNTRUSTED','The upgrade transaction changed while acquiring its lock.');
    const j=m.transaction(root,candidate.dir);
    before=structuredClone(j);
    if(j.phase==='upgrade_complete') return {ok:true,data:finalizeStatus(j),cleanup:m.finishTerminal(candidate.dir,j)};
    (deps.quiesce ?? m.verifyFinalizerExit)(candidate.dir,j,m);
    m.marker(root,candidate.dir,j);
    m.stop(j);
    isolated=true;
    const verified=locateFinalize(root,m);
    if(verified.dir!==expected.dir || verified.journal.transactionId!==expected.transactionId) throw failure('CUTOFF_UNTRUSTED','The upgrade transaction changed while isolating writers.');
    const current=verified.journal;
    const finalize=deps.finalize ?? (await import('./self-upgrade.js')).resumeUpgradeFinalization;
    const ctx={transactionDir:candidate.dir,transactionId:j.transactionId,zylosDir:path.resolve(root),journal:current,persisted,recordPersisted:field=>persisted.add(field),
      dbManifest:verified.dbManifest,maintenance:m,originalServices:current.originalServices,from:current.from,to:current.to};
    const result=await finalize(ctx);
    const saved=m.transaction(root,candidate.dir),data=finalizeStatus(saved);
    for(const key of ['completion','sessionRestart','checkpointAudit','modeStatus','preparationWarnings','warnings']) {
      if(Object.hasOwn(result,key)) data[key]=result[key];
    }
    // Only this invocation's runtime verification can establish readiness.
    if(result.dashboard) {
      data.dashboard=result.dashboard;
    }
    if(result.success && Object.hasOwn(result,'next')) data.next=result.next;
    if(result.success) return {ok:true,data};
    data.core.state='failed';
    if(!data.core.failedItems.length || data.core.failedItems[0].code==='FINALIZE_INCOMPLETE') data.core.failedItems=[{id:result.failedStep ? `step${result.failedStep}`:'finalize',code:upgradeFailureCode(result),reason:result.error}];
    return {ok:false,error:{code:'FINALIZE_INCOMPLETE',message:result.error || 'Upgrade finalization did not complete.',persisted:[...persisted]},data};
  } catch(error) {
    if(error.code==='CUTOFF_UNTRUSTED' || error.code==='NOT_RESUMABLE' || !before) throw error;
    const saved=m.transaction(root,expected.dir);
    if(isolated && saved.phase!=='upgrade_complete') m.update(expected.dir,saved,{phase:'recovery_required',resumePhase:'compensation_closed',lastError:error.message});
    const data=finalizeStatus(saved);
    data.core.state='failed';
    if(!data.core.failedItems.length || data.core.failedItems[0].code==='FINALIZE_INCOMPLETE') data.core.failedItems=[{id:error.step ? `step${error.step}`:'finalize',code:upgradeFailureCode(error),reason:error.message}];
    return {ok:false,error:{code:'FINALIZE_INCOMPLETE',message:error.message,persisted:[...persisted]},data};
  } finally {release();}
}
