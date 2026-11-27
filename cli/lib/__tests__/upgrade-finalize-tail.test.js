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
test('tail archives both inbox layouts before starting services and preserves user-owned state',async t=>{
  const ctx=fixture(t),calls=[];
  const memory=path.join(ctx.zylosDir,'memory');
  const write=(relative,bytes)=>{
    const file=path.join(memory,relative);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    fs.writeFileSync(file,bytes);
    return file;
  };
  const state='# Old user-owned state\n';
  write('state.md',state);
  write('sessions/current.md','legacy bytes');
  const current=write('inbox.md','single inbox');
  const groupOrigin=write('session-groups/origin/inbox.md','multi Origin inbox');
  const groupInbox=write('session-groups/telegram:team/inbox.md','team inbox');
  const segmentName='inbox.20261019T053000000Z-1.md';
  const segmentBytes=Buffer.from([0xef,0xbb,0xbf,0x61,0x0d,0x0a,0xff]);
  const segment=write(`session-groups/telegram:team/${segmentName}`,segmentBytes);
  const groupState=write('session-groups/telegram:team/state.md',state);
  const groupLog=write('session-groups/telegram:team/sessions/2026-10-19.md','old group log');
  const unrelated=write('session-groups/telegram:team/inbox.md.bak','unrelated backup');
  const existing=write('archive/inbox/origin/inbox.md','preexisting archive');
  const archivedTeam=path.join(memory,'archive/inbox/telegram:team');
  fs.mkdirSync(archivedTeam,{recursive:true});
  // An interrupted move may already have published an archive link.
  fs.linkSync(segment,path.join(archivedTeam,segmentName));
  const agents=path.join(ctx.zylosDir,'.claude/agents');
  fs.mkdirSync(agents);
  const retiredAgents=['zylos-global-sync.md','zylos-group-sync.md','zylos-origin-sync.md'];
  for(const name of retiredAgents) fs.writeFileSync(path.join(agents,name),`Previously installed ${name}\n`);
  fs.writeFileSync(path.join(agents,'local-agent.md'),'Custom agent');
  const startServices=()=>{
    calls.push('start');
    for(const source of [current,groupOrigin,groupInbox,segment]) assert.equal(fs.existsSync(source),false,source);
    assert.equal(fs.readFileSync(existing,'utf8'),'preexisting archive');
    assert.equal(fs.readFileSync(path.join(memory,'archive/inbox/origin/inbox.archive-1.md'),'utf8'),'single inbox');
    assert.equal(fs.readFileSync(path.join(memory,'archive/inbox/origin/inbox.archive-2.md'),'utf8'),'multi Origin inbox');
    assert.equal(fs.readFileSync(path.join(archivedTeam,'inbox.md'),'utf8'),'team inbox');
    assert.deepEqual(fs.readFileSync(path.join(archivedTeam,segmentName)),segmentBytes);
    assert.equal(fs.readdirSync(archivedTeam).length,2);
    assert.deepEqual(fs.readdirSync(agents),['local-agent.md']);
    for(const name of retiredAgents) {
      assert.equal(fs.readFileSync(path.join(ctx.zylosDir,'.zylos/retired-claude-agents',name),'utf8'),`Previously installed ${name}\n`);
    }
    return {status:'done'};
  };
  const result=await completeUpgradeFinalization(ctx,deps(calls,{startServices}));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.equal(result.completion.dashboard,'degraded');
  assert.equal(result.completion.sessionRestart,'accepted');
  assert.equal(result.completion.modeTransition,'unknown');
  assert.equal(result.modeStatus.error.code,'SESSION_MODE_STATUS_UNAVAILABLE');
  assert.equal(Object.hasOwn(result,'instructionFilesRebuilt'),false);
  assert.deepEqual(calls,['thresholds','ensure','rotate','start','verify','dashboard','restart']);
  assert.equal(result.steps.find(step=>step.name==='archive_legacy_inbox')?.status,'done');
  assert.equal(result.steps.find(step=>step.name==='archive_retired_runtime_files')?.status,'done');
  assert.equal(fs.readFileSync(path.join(memory,'state.md'),'utf8'),state);
  assert.equal(fs.readFileSync(groupState,'utf8'),state);
  assert.equal(fs.readFileSync(groupLog,'utf8'),'old group log');
  assert.equal(fs.readFileSync(unrelated,'utf8'),'unrelated backup');

  const resumed=await completeUpgradeFinalization({...ctx,steps:[]},deps([],{startServices}));
  assert.equal(resumed.success,true);
  assert.equal(resumed.steps.find(step=>step.name==='archive_legacy_inbox')?.status,'skipped');
  assert.equal(resumed.steps.find(step=>step.name==='archive_retired_runtime_files')?.status,'skipped');
});

test('archive failures leave files for the next upgrade while other files and services continue',async t=>{
  const ctx=fixture(t),calls=[];
  const memory=path.join(ctx.zylosDir,'memory');
  const blocked=path.join(memory,'session-groups','telegram:blocked');
  const group=path.join(memory,'session-groups','telegram:team');
  const archive=path.join(memory,'archive/inbox');
  fs.mkdirSync(blocked,{recursive:true});
  fs.mkdirSync(group,{recursive:true});
  fs.mkdirSync(archive,{recursive:true});
  fs.writeFileSync(path.join(memory,'inbox.md'),'single inbox');
  fs.writeFileSync(path.join(blocked,'inbox.md'),'blocked inbox');
  fs.writeFileSync(path.join(group,'inbox.md'),'team inbox');
  const archiveConflict=path.join(archive,'telegram:blocked');
  fs.writeFileSync(archiveConflict,'existing user file in archive');
  const agents=path.join(ctx.zylosDir,'.claude/agents');
  const agentsArchive=path.join(ctx.zylosDir,'.zylos/retired-claude-agents');
  const blockedAgent=path.join(agents,'zylos-global-sync.md');
  const otherAgent=path.join(agents,'zylos-group-sync.md');
  fs.mkdirSync(agents);
  fs.writeFileSync(blockedAgent,'blocked agent');
  fs.writeFileSync(otherAgent,'other agent');
  const linkSync=fs.linkSync;
  const linkFault=t.mock.method(fs,'linkSync',(source,destination)=>{
    if(source===blockedAgent) throw Object.assign(Error('simulated hard-link failure'),{code:'EACCES'});
    return linkSync(source,destination);
  });

  const startServices=()=>{
    calls.push('start');
    assert.equal(fs.readFileSync(path.join(archive,'origin/inbox.md'),'utf8'),'single inbox');
    assert.equal(fs.readFileSync(path.join(archive,'telegram:team/inbox.md'),'utf8'),'team inbox');
    assert.equal(fs.readFileSync(path.join(agentsArchive,'zylos-group-sync.md'),'utf8'),'other agent');
    return {status:'done'};
  };
  const result=await completeUpgradeFinalization(ctx,deps(calls,{startServices}));
  assert.equal(result.success,true);
  assert.equal(result.completion.install,'done');
  assert.deepEqual(calls,['thresholds','ensure','start','verify','dashboard','restart']);
  assert.equal(result.steps.find(step=>step.name==='archive_legacy_inbox')?.status,'done');
  assert.equal(result.steps.find(step=>step.name==='archive_retired_runtime_files')?.status,'done');
  assert.equal(result.warnings.length,1);
  assert.match(result.warnings[0],/legacy inbox for telegram:blocked/);
  assert.match(result.warnings[0],/retired claude file zylos-global-sync\.md/);
  assert.equal(fs.existsSync(path.join(group,'inbox.md')),false);
  assert.equal(fs.existsSync(otherAgent),false);
  assert.equal(fs.readFileSync(path.join(blocked,'inbox.md'),'utf8'),'blocked inbox');
  assert.equal(fs.readFileSync(blockedAgent,'utf8'),'blocked agent');
  assert.equal(fs.readFileSync(archiveConflict,'utf8'),'existing user file in archive');

  fs.renameSync(archiveConflict,path.join(archive,'saved-user-file'));
  linkFault.mock.restore();
  const nextUpgrade=await completeUpgradeFinalization({...ctx,steps:[],runtimeWarnings:[]},deps(calls,{startServices}));
  assert.equal(nextUpgrade.success,true);
  assert.deepEqual(nextUpgrade.warnings,[]);
  assert.equal(fs.readFileSync(path.join(archive,'telegram:blocked/inbox.md'),'utf8'),'blocked inbox');
  assert.equal(fs.readFileSync(path.join(agentsArchive,'zylos-global-sync.md'),'utf8'),'blocked agent');
  assert.equal(fs.readFileSync(path.join(archive,'saved-user-file'),'utf8'),'existing user file in archive');
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
