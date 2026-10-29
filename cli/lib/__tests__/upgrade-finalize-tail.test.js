import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { completeUpgradeFinalization, readUpgradeModeStatus, step11_startCoreServices, step12_verifyServices } from '../self-upgrade.js';

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
  const result=step12_verifyServices({servicesWereRunning:['scheduler']},{
    execSync:(command,options)=>{calls.push(command);assert.ok(options.timeout>0 && options.timeout<=30000);return command.startsWith('pm2')?JSON.stringify([{name:'scheduler',pm2_env:{status:'online'}}]):'';}
  });
  assert.equal(result.status,'done');
  assert.equal(calls.length,2);
});

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'upgrade-tail-'));
  fs.mkdirSync(path.join(root,'memory'),{recursive:true});
  const ctx={zylosDir:root,from:'0.9.3',to:'new',tempDir:null,servicesWereRunning:[],steps:[],mergeConflicts:[],mergedFiles:[]};
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
    readModeStatus:()=>{throw Object.assign(Error('session-mode status is unavailable'),{code:'SESSION_MODE_STATUS_UNAVAILABLE'});},
    readMode:()=>{calls.push('mode');return {mode:null,keyPresent:false};},
    readTransition:()=>{calls.push('transition');return null;},
    restart:async options=>{calls.push('restart');assert.equal((await options.readMode()).mode,'single');return {ok:true,data:{result:'exit_enqueued'}};},
    audit:()=>{calls.push('audit');return [];},
    verifyPublicationForServices(){},protectedSuccess(){},
    ...extras,
  };
}
for(const failing of [false,true]) test(`finalization retains optional runtime warnings on ${failing?'failure':'success'}`,async t=>{
  const ctx=fixture(t),calls=[];
  ctx.runtimeWarnings=[{code:'RUNTIME_CLI_UNAVAILABLE',runtime:'codex',message:'CLI installation failed or command not on PATH'}];
  const result=await completeUpgradeFinalization(ctx,deps(calls,failing?{
    ensureMemoryMigration(){throw Object.assign(Error('memory prerequisite unavailable'),{code:'MEMORY_UNAVAILABLE'});}
  }:{}));
  assert.equal(result.success,!failing);
  assert.deepEqual(JSON.parse(JSON.stringify(result)).warnings,ctx.runtimeWarnings);
  if(failing){
    assert.equal(result.code,'MEMORY_UNAVAILABLE');
    assert.equal(result.recovery_required,true);
    assert.equal(calls.includes('start'),false);
  }
});
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
  assert.equal(result.modeStatus.error.code,'SESSION_MODE_STATUS_UNAVAILABLE');
  assert.equal(Object.hasOwn(result,'instructionFilesRebuilt'),false);
  assert.deepEqual(calls,['thresholds','ensure','rotate','start','verify','dashboard','mode','transition','restart','audit']);
  assert.equal(fs.readFileSync(path.join(ctx.zylosDir,'memory/state.md'),'utf8'),state);
});
test('session-mode status adapter invokes only the read-only command with its own timeout and root',()=>{
  const observation={ok:true,data:{sessionMode:'multi',transition:null}};
  assert.deepEqual(readUpgradeModeStatus('/isolated/root',{execute:(node,args,options)=>{
    assert.equal(node,process.execPath);
    assert.deepEqual(args.slice(1),['session-mode','status','--json']);
    assert.equal(options.env.ZYLOS_DIR,'/isolated/root');
    assert.equal(options.timeout,5000);
    return JSON.stringify(observation);
  }}),observation);
});
for(const outcome of ['unavailable','invalid-json','rejected']) test(`session-mode status adapter reports ${outcome} without guessing a mode`,()=>{
  assert.throws(()=>readUpgradeModeStatus('/isolated/root',{execute:()=>{
    if(outcome==='unavailable')throw Error('Unknown command: session-mode');
    return outcome==='invalid-json'?'invalid':JSON.stringify({ok:false});
  }}),{code:'SESSION_MODE_STATUS_UNAVAILABLE'});
});
test('mode transition reporting uses session-mode status independently of restart routing',async t=>{
  const ctx=fixture(t),calls=[];
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    readModeStatus:()=>({ok:true,data:{sessionMode:'multi',transition:null}}),
    readTransition:()=>({phase:'gating'})
  }));
  assert.equal(result.completion.modeTransition,'none');
  assert.deepEqual(result.modeStatus,{state:'observed',sessionMode:'multi',transition:null});
  assert.equal(result.completion.sessionRestart,'single_exit_enqueued');
});
test('unreadable session-mode status remains unknown despite successful restart routing',async t=>{
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
test('completed finalization starts the original service set',async t=>{
  const ctx=fixture(t),calls=[];
  const d=deps(calls);
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
for(const failing of [null,'registration','route','verify','dbCopy']) test(`Dashboard ${failing || 'success'} preserves independent outcomes`,async t=>{
  const ctx=fixture(t),calls=[];
  ctx.journal.firstTakeover=true;
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
});

test('Dashboard owns verification timeout and receives no overall deadline',async t=>{
  const ctx=fixture(t),calls=[];
  ctx.journal.firstTakeover=true;
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    dashboardOwner:{applyDashboardRegistration:()=>{calls.push('registration');return {state:'done'};},applyDashboardRoute:()=>{calls.push('route');return {state:'done'};},verifyDashboard:options=>{assert.deepEqual(options,{zylosDir:ctx.zylosDir});calls.push('dashboardVerify');return {state:'ready'};}}
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
  Object.assign(ctx,{upgradeProtected:true,transactionDir:path.join(ctx.zylosDir,'transaction'),transactionId:'tx',journal,
    maintenance:{...maintenance,transaction:()=>journal,update:(_dir,current,changes)=>Object.assign(current,changes),stop:()=>{}}});
  const stable=path.join(ctx.zylosDir,'.zylos/upgrade/maintenance.cjs');
  fs.mkdirSync(path.dirname(stable),{recursive:true});fs.writeFileSync(stable,'old stable reader');
  return {ctx,journal,stable};
}

test('closed recovery preserves the default reader and recovery phase before services',async t=>{
  const {ctx,journal,stable}=protectedReaderFixture(t),calls=[];
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    verifyPublicationForServices:undefined,
    startServices:()=>{assert.equal(fs.readFileSync(stable,'utf8'),'old stable reader');calls.push('start');return {status:'done'};},
    protectedSuccess:()=>{calls.push('success');}
  }));
  assert.equal(result.success,true);
  assert.equal(journal.phase,'recovery_required');
  assert.equal(calls.includes('start'),true);
});

test('Dashboard persists independent failure and retries it without repeating completed registration',async t=>{
  const {ctx,journal}=protectedReaderFixture(t),calls=[];
  ctx.journal.firstTakeover=true;
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
  const result=await completeUpgradeFinalization(ctx,deps(calls,{verifyPublicationForServices:undefined}));
  assert.equal(result.success,false);
  assert.equal(calls.includes('start'),false);
  assert.equal(fs.readFileSync(stable,'utf8'),'old stable reader');
});

test('untrusted recovery cutoff cannot refresh stable reader or start services',async t=>{
  const {ctx,stable}=protectedReaderFixture(t,{corrupt:true}),calls=[];calls.protectedReader=true;
  await assert.rejects(()=>completeUpgradeFinalization(ctx,deps(calls,{verifyPublicationForServices:undefined})),/publication is not ready/);
  assert.equal(calls.includes('start'),false);
  assert.equal(fs.readFileSync(stable,'utf8'),'old stable reader');
});

test('later upgrade restores Dashboard only after required services with independent timeouts',async t=>{
  const ctx=fixture(t),calls=[];
  ctx.servicesWereRunning=['c4-dispatcher','zylos-dashboard','scheduler'];
  const original=[...ctx.servicesWereRunning];
  const d=deps(calls,{
    startServices:c=>{calls.push('core-start');assert.deepEqual(c.servicesWereRunning,['c4-dispatcher','scheduler']);return {status:'done'};},
    verifyServices:c=>{calls.push('core-verify');assert.deepEqual(c.servicesWereRunning,['c4-dispatcher','scheduler']);return {status:'done'};},
    dashboardOwner:{
      restoreDashboardService:options=>{calls.push('dashboard-restore');assert.deepEqual(options,{zylosDir:ctx.zylosDir});return {state:'done'};},
      verifyDashboard:options=>{calls.push('dashboard-verify');assert.deepEqual(options,{zylosDir:ctx.zylosDir});return {state:'ready',errors:[]};},
      applyDashboardRegistration:()=>assert.fail('later upgrade must not register'),
      applyDashboardRoute:()=>assert.fail('later upgrade must not route')
    }
  });
  const result=await completeUpgradeFinalization(ctx,d);
  assert.equal(result.success,true);
  assert.equal(result.completion.dashboard,'ready');
  assert.deepEqual(ctx.servicesWereRunning,original);
  assert.deepEqual(calls.filter(x=>/^(core|dashboard)-/.test(x)),['core-start','core-verify','dashboard-restore','dashboard-verify']);
});

for(const kind of ['failed','throw']) test(`Dashboard restore ${kind} is degraded without Core isolation`,async t=>{
  const {ctx}=protectedReaderFixture(t),calls=[];
  ctx.servicesWereRunning=['c4-dispatcher','zylos-dashboard'];
  let stops=0;
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    stopServices:()=>{stops++;},protectedSuccess:()=>{},
    startServices:c=>{assert.deepEqual(c.servicesWereRunning,['c4-dispatcher']);return {status:'done'};},
    verifyServices:c=>{assert.deepEqual(c.servicesWereRunning,['c4-dispatcher']);return {status:'done'};},
    dashboardOwner:{
      restoreDashboardService:()=>{if(kind==='throw')throw Error('Dashboard start denied');return {state:'failed',error:{message:'Dashboard start denied'}};},
      verifyDashboard:()=>{calls.push('dashboard-verify');return {state:'ready',errors:[]};}
    }
  }));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.equal(result.completion.dashboard,'degraded');
  assert.equal(result.dashboard.errors[0].code,'registration_failed');
  assert.equal(stops,0);
  assert.ok(calls.includes('dashboard-verify'));
  assert.ok(calls.includes('restart'));
});

test('required service failure still enters protected Core isolation',async t=>{
  const {ctx,journal}=protectedReaderFixture(t),calls=[];
  ctx.servicesWereRunning=['c4-dispatcher','zylos-dashboard'];
  let stops=0;
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    stopServices:()=>{stops++;},
    startServices:c=>{assert.deepEqual(c.servicesWereRunning,['c4-dispatcher']);return {status:'failed',error:'required service unavailable'};},
    dashboardOwner:{restoreDashboardService:()=>assert.fail('must not restore Dashboard')}
  }));
  assert.equal(result.success,false);
  assert.equal(result.completion.install,'pending');
  assert.equal(stops,1);
  assert.equal(journal.phase,'recovery_required');
  assert.equal(calls.includes('restart'),false);
});

test('Dashboard absent from original running set is verified without starting',async t=>{
  const ctx=fixture(t),calls=[];
  ctx.servicesWereRunning=['c4-dispatcher'];
  let restoreCalls=0;
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    dashboardOwner:{restoreDashboardService:()=>{restoreCalls++;return {state:'done'};},verifyDashboard:()=>({state:'degraded',errors:[]})}
  }));
  assert.equal(restoreCalls,0);
  assert.equal(result.success,true);
});

test('installation reads the journal first-takeover decision independently of legacy context',async t=>{
  for(const firstTakeover of [true,false]){
    const ctx=fixture(t),calls=[];
    ctx.journal.firstTakeover=firstTakeover;
    ctx.firstDashboardTakeover=!firstTakeover;
    ctx.servicesWereRunning=['zylos-dashboard'];
    const result=await completeUpgradeFinalization(ctx,deps(calls,{
      dashboardOwner:{
        applyDashboardRegistration:()=>{calls.push('register');return {state:'done'};},
        applyDashboardRoute:()=>{calls.push('route');return {state:'done'};},
        restoreDashboardService:()=>{calls.push('restore');return {state:'done'};},
        verifyDashboard:()=>{calls.push('health');return {state:'ready'};}
      }
    }));
    assert.equal(result.success,true);
    assert.deepEqual(calls.filter(x=>['register','route','restore','health'].includes(x)),firstTakeover?['register','route','health']:['restore','health']);
  }
});

test('long preceding steps do not suppress Dashboard restore or verification',async t=>{
  const ctx=fixture(t),calls=[];
  ctx.servicesWereRunning=['zylos-dashboard'];
  let now=1000;t.mock.method(Date,'now',()=>now);
  const result=await completeUpgradeFinalization(ctx,deps(calls,{
    verifyServices:()=>{now+=120000;return {status:'done'};},
    dashboardOwner:{
      restoreDashboardService:options=>{assert.deepEqual(options,{zylosDir:ctx.zylosDir});calls.push('restore');return {state:'done'};},
      verifyDashboard:options=>{assert.deepEqual(options,{zylosDir:ctx.zylosDir});calls.push('health');return {state:'ready'};}
    }
  }));
  assert.equal(result.success,true);assert.equal(result.completion.dashboard,'ready');
  assert.deepEqual(calls.filter(x=>['restore','health'].includes(x)),['restore','health']);
});

test('empty Core running set still publishes the protected ecosystem before Dashboard registration',t=>{
 const ctx=fixture(t),root=ctx.zylosDir;
 const packageRoot=path.join(root,'package'),template=path.join(packageRoot,'templates/pm2/ecosystem.config.cjs');
 fs.mkdirSync(path.dirname(template),{recursive:true});fs.writeFileSync(path.join(packageRoot,'package.json'),JSON.stringify({version:'new'}));
 const bytes='module.exports={apps:[{name:"zylos-dashboard"}]};\n';fs.writeFileSync(template,bytes);
 const target=path.join(root,'pm2/ecosystem.config.cjs');
 ctx.packageRoot=packageRoot;
 ctx.maintenance=maintenance;
 ctx.journal.initialIdentity={ecosystemHash:null};
 fs.mkdirSync(ctx.transactionDir);fs.writeFileSync(path.join(ctx.transactionDir,'journal.json'),JSON.stringify(ctx.journal));
 const options={zylosDir:root,ecosystemPath:target,execSync:()=>assert.fail('no Core processes should start')};
 {const result=step11_startCoreServices(ctx,options);assert.equal(result.status,'skipped',JSON.stringify(result));}
 assert.equal(fs.readFileSync(target,'utf8'),bytes);
 const journal=JSON.parse(fs.readFileSync(path.join(ctx.transactionDir,'journal.json')));
 assert.equal(journal.ecosystemCreationIntent.originalMissing,true);
 assert.equal(journal.ecosystemCreationIntent.target,target);
 {const result=step11_startCoreServices(ctx,options);assert.equal(result.status,'skipped',JSON.stringify(result));}
 assert.equal(fs.readFileSync(target,'utf8'),bytes);
});
