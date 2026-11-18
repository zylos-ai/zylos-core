import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {completeUpgradeFinalization} from '../self-upgrade.js';

for(const item of ['dbCopy','registration','route','dashboard']) {
  for(const response of ['throw','return']) test(`Dashboard ${item} ${response} preserves original code and message`,async t=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-errors-'));
    t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
    const error={code:`${item}_original_code`,message:`${item} original diagnostic`};
    const ctx={zylosDir:root,firstDashboardTakeover:true,from:'old',to:'new',mergeConflicts:[],mergedFiles:[],
      journal:{firstTakeover:true,dashboardInstall:{items:{registration:{state:'pending',attempts:0},route:{state:'pending',attempts:0}}}},
      maintenance:{canRecognizeProcesses:()=>true,update(_dir,journal,changes){Object.assign(journal,changes);}}};
    const fail=()=>{
      if(response==='throw') throw Object.assign(Error(error.message),error);
      return {state:'failed',error};
    };
    const owner={applyDashboardRegistration:()=>({state:'done'}),applyDashboardRoute:()=>({state:'done'}),
      verifyDashboard:()=>({state:'ready',errors:[]})};
    if(item==='dbCopy') ctx.journal.dashboardInstall.dbCopy={ok:false,error};
    else if(item==='dashboard') owner.verifyDashboard=response==='throw'?fail:()=>({state:'degraded',errors:[{item:'dashboard',...error,location:'dashboard.db'}]});
    else owner[item==='registration'?'applyDashboardRegistration':'applyDashboardRoute']=fail;
    const result=await completeUpgradeFinalization(ctx,{
      finalizeWebConsoleRemoval:()=>({warnings:[],pm2Changed:false}),
      ensureLogRotation:()=>({state:'present'}),
      dashboardOwner:owner,updateConfig:()=>{},ensureMemoryMigration:()=>{},commitBaselines:()=>{},
      verifyPublicationForServices:()=>{},protectedSuccess:()=>{},
      startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),
      readModeStatus:()=>({sessionMode:'single',transition:null}),readMode:()=>({mode:'single'}),readTransition:()=>null,
      restart:()=>({ok:true,data:{result:'exit_enqueued'}}),
    });
    assert.equal(result.success,true);
    assert.equal(result.dashboard.state,'degraded');
    assert.match(result.next,/zylos init to reapply Dashboard configuration and routing/);
    const reported=result.dashboard.errors.find(value=>value.item===item);
    assert.equal(reported.code,error.code);
    assert.equal(reported.message,error.message);
    if(item==='registration' || item==='route') assert.deepEqual(ctx.journal.dashboardInstall.items[item].lastError,error);
  });
}

for(const state of ['stopped','running','restore-failed','unregistered']) test(`Dashboard ${state} preserves upgrade service intent`,async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'dashboard-intent-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const calls=[];
  const ctx={zylosDir:root,from:'old',to:'new',mergeConflicts:[],mergedFiles:[],
    servicesWereRunning:['stopped','unregistered'].includes(state)?[]:['zylos-dashboard'],journal:{databaseMode:'migrate',erroredServices:[],dashboardWasStopped:state==='stopped'},
    maintenance:{canRecognizeProcesses:()=>true}};
  const result=await completeUpgradeFinalization(ctx,{
    finalizeWebConsoleRemoval:()=>({warnings:[],pm2Changed:false}),ensureLogRotation:()=>({state:'present'}),
    dashboardOwner:{restoreDashboardService(){calls.push('restore');return state==='restore-failed'
      ? {state:'failed',error:{message:'port is occupied'}}:{state:'done'};},
      verifyDashboard(){calls.push('verify');return {state:'ready',errors:[]};}},
    updateConfig:()=>{},ensureMemoryMigration:()=>{},commitBaselines:()=>{},verifyPublicationForServices:()=>{},protectedSuccess:()=>{},
    startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),restartErroredServices:()=>({status:'done'}),
    readModeStatus:()=>({sessionMode:'single',transition:null}),readMode:()=>({mode:'single'}),readTransition:()=>null,
    restart:()=>({ok:true,data:{result:'exit_enqueued'}}),
  });
  assert.equal(result.success,true);
  assert.equal(result.dashboard.state,state==='stopped'?'stopped':state==='restore-failed'?'degraded':'ready');
  assert.deepEqual(calls,state==='stopped'?[]:state==='running'?['restore','verify']:state==='unregistered'?['verify']:['restore']);
  if(state==='stopped') {assert.match(result.dashboard.message,/already stopped/);assert.equal(result.next,null);}
  if(state==='restore-failed') {assert.match(result.next,/restore failed: port is occupied/);assert.doesNotMatch(result.next,/zylos init/);}
});
