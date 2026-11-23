import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completeUpgradeFinalization } from '../self-upgrade.js';


function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-tail-'));
  fs.mkdirSync(path.join(root,'memory'),{recursive:true});
  fs.mkdirSync(path.join(root,'.claude'),{recursive:true});
  fs.writeFileSync(path.join(root,'.claude/settings.json'),JSON.stringify({model:'opus'}));
  fs.mkdirSync(path.join(root,'.zylos'),{recursive:true});
  fs.writeFileSync(path.join(root,'.zylos/config.json'),JSON.stringify({new_session_threshold:70}));
  const ctx={zylosDir:root,from:'1.0.0',to:'new',tempDir:null,servicesWereRunning:[],steps:[],mergeConflicts:[],mergedFiles:[]};
  ctx.journal={phase:'compensation_closed'};
  ctx.transactionDir=path.join(root,'transaction');
  ctx.maintenance={transaction:()=>ctx.journal,classifyCutoff:()=> 'closed',
    update(_dir,j,changes){Object.assign(j,changes);},stop(){},canRecognizeProcesses:()=>true};
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return ctx;
}
function deps(calls, extras={}) {
  return {
    updateConfig:(input,options)=>{calls.push('thresholds');assert.deepEqual(input,{mergeIfAbsent:{model_rotation_thresholds:{claude:{opus:70}}}});assert.equal(options.waitMs,2000);},
    ensureMemoryMigration:()=>{calls.push('ensure');},
    rotateSession:()=>{calls.push('rotate');},
    startServices:()=>{calls.push('start');return {status:'done'};},
    verifyServices:()=>{calls.push('verify');return {status:'done'};},
    dashboardOwner:{verifyDashboard:()=>{calls.push('dashboard');return {state:'degraded',errors:[]};}},
    readModeStatus:()=>{throw Object.assign(Error('session-mode status is unavailable'),{code:'SESSION_MODE_STATUS_UNAVAILABLE'});},
    restart:async options=>{calls.push('restart');assert.deepEqual(options,{afterServiceRestart:true});return {ok:true,data:{result:'accepted'}};},
    verifyPublicationForServices(){},protectedSuccess(){},
    finalizeWebConsoleRemoval:async()=>({warnings:[]}),
    ensureLogRotation:()=>({state:'present'}),
    savePm2ProcessList:()=>true,
    ...extras,
  };
}
test('tail keeps user-owned state and runs thresholds, memory migration, session rotation, services and restart in order',async t=>{
  const ctx=fixture(t),calls=[];
  const state='# Old user-owned state\n';
  fs.writeFileSync(path.join(ctx.zylosDir,'memory/state.md'),state);
  fs.mkdirSync(path.join(ctx.zylosDir,'memory/sessions'));
  fs.writeFileSync(path.join(ctx.zylosDir,'memory/sessions/current.md'),'legacy bytes');
  const result=await completeUpgradeFinalization(ctx,deps(calls));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.equal(result.completion.dashboard,'degraded');
  assert.equal(result.completion.sessionRestart,'accepted');
  assert.equal(result.completion.modeTransition,'unknown');
  assert.equal(result.modeStatus.error.code,'SESSION_MODE_STATUS_UNAVAILABLE');
  assert.equal(Object.hasOwn(result,'instructionFilesRebuilt'),false);
  assert.deepEqual(calls,['thresholds','ensure','rotate','start','verify','dashboard','restart']);
  assert.equal(fs.readFileSync(path.join(ctx.zylosDir,'memory/state.md'),'utf8'),state);
});
test('completed finalization starts the original service set',async t=>{
  const ctx=fixture(t),calls=[];
  const d=deps(calls);
  const result=await completeUpgradeFinalization(ctx,d);
  assert.equal(result.success,true);
  assert.equal(calls.includes('start'),true);
});
for(const failing of [null,'registration','route','verify','dbCopy']) test(`Dashboard ${failing || 'success'} preserves independent outcomes`,async t=>{
  const ctx=fixture(t),calls=[];
  ctx.journal.firstTakeover=true;
  ctx.firstDashboardTakeover=true;
  if(failing==='dbCopy')ctx.journal.dashboardInstall={dbCopy:{ok:false,error:{code:'COPY_FAILED',message:'copy denied'}}};
  const action=item=>()=>{calls.push(item);if(failing===item)throw Object.assign(Error(`${item} denied`),{code:'DASHBOARD_FAILED'});return {state:item==='verify'?'ready':'done',errors:[]};};
  const result=await completeUpgradeFinalization(ctx,deps(calls,{dashboardOwner:{applyDashboardRegistration:action('registration'),applyDashboardRoute:action('route'),verifyDashboard:action('verify')}}));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.deepEqual(calls.filter(item=>['registration','route','verify'].includes(item)),['verify','registration','route','verify']);
  assert.equal(result.dashboard.state,failing?'degraded':'ready');
  assert.equal(result.completion.dashboard,result.dashboard.state);
  assert.equal(result.dashboard.errors.length,failing?1:0);
  if(failing)assert.equal(result.dashboard.errors[0].item,failing==='verify'?'dashboard':failing);
  if(failing){assert.match(result.next,/dashboard\.errors/);assert.match(result.next,/zylos init/);}
  else assert.equal(result.next,null);
});
