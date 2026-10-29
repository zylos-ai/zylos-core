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
      journal:{dashboardInstall:{items:{registration:{state:'pending',attempts:0},route:{state:'pending',attempts:0}}}},
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
      dashboardOwner:owner,updateConfig:()=>{},ensureMemoryMigration:()=>{},commitBaselines:()=>{},
      verifyPublicationForServices:()=>{},protectedSuccess:()=>{},
      startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),
      readModeStatus:()=>({sessionMode:'single',transition:null}),readMode:()=>({mode:'single'}),readTransition:()=>null,
      restart:()=>({ok:true,data:{result:'exit_enqueued'}}),audit:()=>[],
    });
    assert.equal(result.success,true);
    assert.equal(result.dashboard.state,'degraded');
    const reported=result.dashboard.errors.find(value=>value.item===item);
    assert.equal(reported.code,error.code);
    assert.equal(reported.message,error.message);
    if(item==='registration' || item==='route') assert.deepEqual(ctx.journal.dashboardInstall.items[item].lastError,error);
  });
}
