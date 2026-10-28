import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { completeUpgradeFinalization, readUpgradeModeStatus, step11_startCoreServices, step12_verifyServices, runSelfUpgradeFinalize } from '../self-upgrade.js';

const maintenance=createRequire(import.meta.url)('../upgrade-maintenance.cjs');

for(const observed of [true,false])test(`PM2 timeout is checked through jlist before reporting ${observed?'started':'failed'}`,t=>{
  const calls=[];
  const result=step11_startCoreServices({servicesWereRunning:['scheduler']},{
    fs:{existsSync:()=>false},
    execSync:(command,options)=>{
      calls.push(command);
      assert.equal(options.timeout,30000);
      if(command.startsWith('pm2 restart'))throw Object.assign(Error('timed out'),{code:'ETIMEDOUT'});
      if(command.startsWith('pm2 jlist'))return JSON.stringify(observed?[{name:'scheduler',pm2_env:{status:'online'}}]:[]);
      return '';
    }
  });
  assert.equal(result.status,observed?'done':'failed');
  assert.equal(calls.filter(command=>command.startsWith('pm2 jlist')).length,1);
  assert.equal(calls.some(command=>command.startsWith('pm2 delete')),false);
});

test('service verification uses only its local poll and PM2 limits',()=>{
  const calls=[];
  const result=step12_verifyServices({servicesWereRunning:['scheduler'],budget:{check(){throw Error('obsolete budget');},remaining:()=>0}},{
    execSync:(command,options)=>{calls.push(command);assert.ok(options.timeout>0 && options.timeout<=30000);return command.startsWith('pm2')?JSON.stringify([{name:'scheduler',pm2_env:{status:'online'}}]):'';}
  });
  assert.equal(result.status,'done');
  assert.equal(calls.length,2);
});

test('target finalizer rejects unprotected and old parent state before any work',()=>{
  for(const state of [{},{schemaVersion:1},{schemaVersion:2,preInstallProtection:false}]) {
    const result=runSelfUpgradeFinalize(state,{maintenance:{transaction(){throw Error('must not read');}}});
    assert.equal(result.success,false);
    assert.match(result.error,/protected target-upgrade/);
  }
});

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-tail-'));
  fs.mkdirSync(path.join(root,'memory'),{recursive:true});
  const ctx={zylosDir:root,from:'old',to:'new',tempDir:null,servicesWereRunning:[],steps:[],mergeConflicts:[],mergedFiles:[]};
  ctx.journal={phase:'compensation_closed'};
  ctx.transactionDir=path.join(root,'transaction');
  ctx.maintenance={transaction:()=>ctx.journal,classifyCutoff:()=> 'closed',
    update(_dir,j,changes){Object.assign(j,changes);},stop(){},canRecognizeProcesses:()=>true};
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  return ctx;
}
function deps(calls, extras={}) {
  return {
    updateConfig:(input,options)=>{calls.push('thresholds');assert.deepEqual(input,{setIfAbsent:{new_session_threshold:70,codex_new_session_threshold:75}});assert.equal(options.waitMs,2000);},
    ensureMemoryMigration:()=>{calls.push('ensure');},
    rotateSession:()=>{calls.push('rotate');},
    startServices:()=>{calls.push('start');return {status:'done'};},
    verifyServices:()=>{calls.push('verify');return {status:'done'};},
    dashboardOwner:{verifyDashboard:()=>{calls.push('dashboard');return {state:'degraded',errors:[]};}},
    readModeStatus:()=>{throw Object.assign(Error('P10 session-mode status is unavailable'),{code:'P10_STATUS_UNAVAILABLE'});},
    readMode:()=>{calls.push('mode');return {mode:null,keyPresent:false};},
    readTransition:()=>{calls.push('transition');return null;},
    restart:async options=>{calls.push('restart');assert.equal((await options.readMode()).mode,'single');return {ok:true,data:{result:'exit_enqueued'}};},
    audit:()=>{calls.push('audit');return [];},
    commitBaselines:()=>{calls.push('baselines');return {status:'done'};},
    refreshMaintenanceReader(){},protectedSuccess(){},
    ...extras,
  };
}
test('tail preserves W1 and follows F1, W7, services, restart and audit order',async t=>{
  const ctx=fixture(t),calls=[];
  const state='# Old user-owned state\n';
  fs.writeFileSync(path.join(ctx.zylosDir,'memory/state.md'),state);
  fs.mkdirSync(path.join(ctx.zylosDir,'memory/sessions'));
  fs.writeFileSync(path.join(ctx.zylosDir,'memory/sessions/current.md'),'legacy bytes');
  const result=await completeUpgradeFinalization(ctx,deps(calls));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.equal(result.completion.dashboard,'degraded');
  assert.equal(result.completion.sessionRestart,'single_exit_enqueued');
  assert.equal(result.completion.modeTransition,'unknown');
  assert.equal(result.modeStatus.error.code,'P10_STATUS_UNAVAILABLE');
  assert.equal(Object.hasOwn(result,'instructionFilesRebuilt'),false);
  assert.deepEqual(calls,['thresholds','ensure','rotate','baselines','start','verify','dashboard','mode','transition','restart','audit']);
  assert.equal(fs.readFileSync(path.join(ctx.zylosDir,'memory/state.md'),'utf8'),state);
});
test('P10 status adapter invokes only the read-only command with its own timeout and root',()=>{
  const budget={check(){},remaining:()=>12000};
  const observation={ok:true,data:{sessionMode:'multi',transition:null}};
  assert.deepEqual(readUpgradeModeStatus('/isolated/root',{budget,execute:(node,args,options)=>{
    assert.equal(node,process.execPath);
    assert.deepEqual(args.slice(1),['session-mode','status','--json']);
    assert.equal(options.env.ZYLOS_DIR,'/isolated/root');
    assert.equal(options.timeout,5000);
    return JSON.stringify(observation);
  }}),observation);
});
for(const outcome of ['unavailable','invalid-json','rejected']) test(`P10 status adapter reports ${outcome} without guessing a mode`,()=>{
  const budget={check(){},remaining:()=>10000};
  assert.throws(()=>readUpgradeModeStatus('/isolated/root',{budget,execute:()=>{
    if(outcome==='unavailable')throw Error('Unknown command: session-mode');
    return outcome==='invalid-json'?'invalid':JSON.stringify({ok:false});
  }}),{code:'P10_STATUS_UNAVAILABLE'});
});
test('mode transition reporting uses P10 status independently of restart routing',async t=>{
  const ctx=fixture(t),calls=[];
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    readModeStatus:()=>({ok:true,data:{sessionMode:'multi',transition:null}}),
    readTransition:()=>({phase:'gating'})
  }));
  assert.equal(result.completion.modeTransition,'none');
  assert.deepEqual(result.modeStatus,{state:'observed',sessionMode:'multi',transition:null});
  assert.equal(result.completion.sessionRestart,'single_exit_enqueued');
});
test('unreadable P10 status remains unknown despite successful restart routing',async t=>{
  const ctx=fixture(t),calls=[];
  const result=await completeUpgradeFinalization(ctx,deps(calls,{readModeStatus:()=>{throw Error('DB_BUSY');}}));
  assert.equal(result.success,true);
  assert.equal(result.completion.modeTransition,'unknown');
  assert.equal(result.modeStatus.state,'unavailable');
  assert.match(result.modeStatus.error.message,/DB_BUSY/);
  assert.equal(result.completion.sessionRestart,'single_exit_enqueued');
});
for(const failing of ['thresholds','ensure','rotate'])test(`failure in ${failing} blocks all service starts`,async t=>{
  const ctx=fixture(t),calls=[];
  fs.mkdirSync(path.join(ctx.zylosDir,'memory/sessions'));
  fs.writeFileSync(path.join(ctx.zylosDir,'memory/sessions/current.md'),'legacy bytes');
  const d=deps(calls);
  const key={thresholds:'updateConfig',ensure:'ensureMemoryMigration',rotate:'rotateSession'}[failing];
  d[key]=()=>{calls.push(failing);throw Error(`${failing} failure`);};
  const result=await completeUpgradeFinalization(ctx,d);
  assert.equal(result.success,false);
  assert.match(result.error,/failure/);
  assert.equal(calls.includes('start'),false);
  assert.match(result.next,/resume-finalize/);
});
test('W1 read failure stops before services and does not rewrite state',async t=>{
  const ctx=fixture(t),calls=[];
  fs.mkdirSync(path.join(ctx.zylosDir,'memory/state.md'));
  const result=await completeUpgradeFinalization(ctx,deps(calls));
  assert.equal(result.success,false);
  assert.equal(calls.includes('start'),false);
  assert.equal(fs.statSync(path.join(ctx.zylosDir,'memory/state.md')).isDirectory(),true);
});
test('obsolete overall budget cannot prevent independent finalization steps',async t=>{
  const ctx=fixture(t),calls=[];
  let checks=0;
  const d=deps(calls,{budget:{deadlineAt:Date.now(),remaining:()=>0,check(){if(++checks===5)throw Object.assign(Error('exhausted'),{code:'deadline_exceeded'});}}});
  ctx.budget=d.budget;
  const result=await completeUpgradeFinalization(ctx,d);
  assert.equal(result.success,true);
  assert.equal(calls.includes('start'),true);
});
test('restart path read errors are reported without submitting; audit failure is incomplete',async t=>{
  const ctx=fixture(t),calls=[];
  const result=await completeUpgradeFinalization(ctx,deps(calls,{readTransition:()=>{throw Error('DB_BUSY');},audit:()=>{throw Error('DB_BUSY');}}));
  assert.equal(result.success,true);
  assert.equal(result.completion.sessionRestart,'manual_required');
  assert.equal(calls.includes('restart'),false);
  assert.equal(result.checkpointAudit.state,'incomplete');
});
test('baseline failure prevents service and restart submission and leaves install pending',async t=>{
  const ctx=fixture(t),calls=[];
  const result=await completeUpgradeFinalization(ctx,deps(calls,{commitBaselines:()=>({status:'failed',error:'baseline write denied'})}));
  assert.equal(result.success,false);
  assert.equal(result.completion.install,'pending');
  assert.equal(result.failedStep,13);
  assert.match(result.error,/baseline write denied/);
  assert.equal(calls.includes('start'),false);
  assert.equal(calls.includes('restart'),false);
});

for(const failing of [null,'registration','route','verify','dbCopy']) test(`Dashboard ${failing || 'success'} preserves independent outcomes`,async t=>{
  const ctx=fixture(t),calls=[];
  ctx.firstDashboardTakeover=true;
  if(failing==='dbCopy')ctx.journal={dashboardInstall:{dbCopy:{ok:false,error:{code:'COPY_FAILED',message:'copy denied'}}}};
  const action=item=>()=>{calls.push(item);if(failing===item)throw Object.assign(Error(`${item} denied`),{code:'DASHBOARD_FAILED'});return {state:item==='verify'?'ready':'done',errors:[]};};
  const result=await completeUpgradeFinalization(ctx,deps(calls,{dashboardOwner:{applyDashboardRegistration:action('registration'),applyDashboardRoute:action('route'),verifyDashboard:action('verify')}}));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.deepEqual(calls.filter(item=>['registration','route','verify'].includes(item)),['verify','registration','route','verify']);
  assert.equal(result.dashboard.state,failing?'degraded':'ready');
  assert.equal(result.completion.dashboard,result.dashboard.state);
  assert.equal(result.dashboard.errors.length,failing?1:0);
  if(failing)assert.equal(result.dashboard.errors[0].item,failing==='verify'?'dashboard':failing);
});

test('Dashboard owns verification timeout and receives no overall deadline',async t=>{
  const ctx=fixture(t),calls=[];
  ctx.firstDashboardTakeover=true;
  let expired=false;
  ctx.budget={remaining:()=>expired?0:100000,check(){if(expired)throw Object.assign(Error('exhausted'),{code:'deadline_exceeded'});}};
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    dashboardOwner:{applyDashboardRegistration:()=>{calls.push('registration');expired=true;return {state:'done'};},applyDashboardRoute:()=>{calls.push('route');return {state:'done'};},verifyDashboard:options=>{assert.deepEqual(options,{zylosDir:ctx.zylosDir});calls.push('dashboardVerify');return {state:'ready'};}}
  }));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.equal(result.completion.dashboard,'ready');
  assert.equal(calls.includes('route'),true);
  assert.equal(calls.includes('dashboardVerify'),true);
  assert.equal(calls.includes('restart'),true);
});

function protectedReaderFixture(t,{phase='recovery_required',hooks='done',corrupt=false}={}) {
  const ctx=fixture(t),digest='a'.repeat(64);
  const journal={phase,resumePhase:'compensation_closed',transactionId:'tx',snapshotManifestHash:digest,
    compensationCutoff:{formatVersion:1,closed:true,transactionId:corrupt?'other':'tx',snapshotManifestHash:digest,closedAt:'2026-10-27T00:00:00.000Z',writer:'finalizer'},
    postCutoff:{items:{hooks:{state:hooks}}}};
  Object.assign(ctx,{preInstallProtection:true,transactionDir:path.join(ctx.zylosDir,'transaction'),transactionId:'tx',journal,
    maintenance:{...maintenance,transaction:()=>journal,update:(_dir,current,changes)=>Object.assign(current,changes),stop:()=>{}}});
  const stable=path.join(ctx.zylosDir,'.zylos/upgrade/maintenance.cjs');
  fs.mkdirSync(path.dirname(stable),{recursive:true});fs.writeFileSync(stable,'old stable reader');
  return {ctx,journal,stable};
}

test('closed recovery preserves the default reader and recovery phase before services',async t=>{
  const {ctx,journal,stable}=protectedReaderFixture(t),calls=[];
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    refreshMaintenanceReader:undefined,
    startServices:()=>{assert.equal(fs.readFileSync(stable,'utf8'),'old stable reader');calls.push('start');return {status:'done'};},
    protectedSuccess:()=>{calls.push('success');}
  }));
  assert.equal(result.success,true);
  assert.equal(journal.phase,'recovery_required');
  assert.equal(calls.includes('start'),true);
});

test('Dashboard persists independent failure and retries it without repeating completed registration',async t=>{
  const {ctx,journal}=protectedReaderFixture(t),calls=[];
  ctx.firstDashboardTakeover=true;
  journal.dashboardInstall={dbCopy:{ok:true,error:null},items:Object.fromEntries(['registration','route'].map(item=>[item,{state:'pending',attempts:0,lastError:null}]))};
  let registrationFails=true;
  const d=deps(calls,{protectedSuccess:()=>{},dashboardOwner:{
    applyDashboardRegistration:()=>{calls.push('registration');if(registrationFails)throw Object.assign(Error('registration denied'),{code:'REGISTRATION_FAILED'});return {state:'done'};},
    applyDashboardRoute:()=>{calls.push('route');return {state:'done'};},
    verifyDashboard:()=>({state:'ready',errors:[]})
  }});
  const first=await completeUpgradeFinalization(ctx,d);
  assert.equal(first.completion.dashboard,'degraded');
  assert.deepEqual(journal.dashboardInstall.items.registration,{state:'failed',attempts:1,lastError:{code:'REGISTRATION_FAILED',message:'registration denied'}});
  assert.deepEqual(journal.dashboardInstall.items.route,{state:'done',attempts:1,lastError:null});
  registrationFails=false;
  const second=await completeUpgradeFinalization(ctx,d);
  assert.equal(second.completion.dashboard,'ready');
  assert.deepEqual(journal.dashboardInstall.items.registration,{state:'done',attempts:2,lastError:null});
  const third=await completeUpgradeFinalization(ctx,d);
  assert.equal(third.completion.dashboard,'ready');
  assert.equal(calls.filter(item=>item==='registration').length,2);
  assert.equal(calls.filter(item=>item==='route').length,3);
});

test('unfinished publication blocks actual maintenance reader refresh and service start',async t=>{
  const {ctx,stable}=protectedReaderFixture(t,{hooks:'failed'}),calls=[];calls.protectedReader=true;
  const result=await completeUpgradeFinalization(ctx,deps(calls,{refreshMaintenanceReader:undefined}));
  assert.equal(result.success,false);
  assert.equal(calls.includes('start'),false);
  assert.equal(fs.readFileSync(stable,'utf8'),'old stable reader');
});

test('untrusted recovery cutoff cannot refresh stable reader or start services',async t=>{
  const {ctx,stable}=protectedReaderFixture(t,{corrupt:true}),calls=[];calls.protectedReader=true;
  await assert.rejects(()=>completeUpgradeFinalization(ctx,deps(calls,{refreshMaintenanceReader:undefined})),/publication is not ready/);
  assert.equal(calls.includes('start'),false);
  assert.equal(fs.readFileSync(stable,'utf8'),'old stable reader');
});
