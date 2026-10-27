import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { finalizeStatus, resumeFinalize } from '../upgrade-resume.js';
import { preparePostCutoff, publishPostCutoff } from '../upgrade-post-cutoff.js';
import { formatFinalizeResult } from '../../commands/component.js';

const actual=createRequire(import.meta.url)('../upgrade-maintenance.cjs');
function fixture(t) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'resume-')));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const id='upgrade-1-fixture',dir=path.join(root,'.backup/self-upgrade',id),db=path.join(root,'.backup/db',id);
  fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(db,{recursive:true});
  const manifest={formatVersion:1,function:'core-self-upgrade-db',status:'complete',id,
    databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db'].map(source=>({source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  actual.durable(path.join(db,'manifest.json'),manifest);
  const hash=actual.hash(path.join(db,'manifest.json'));
  let journal={formatVersion:1,transactionId:id,zylosDir:root,initialIdentity:{},installationIntent:true,
    dbBackupDir:db,snapshotManifestHash:hash,phase:'compensation_closed',from:'old',to:'new',originalServices:[],
    compensationCutoff:{formatVersion:1,closed:true,transactionId:id,snapshotManifestHash:hash,writer:'finalizer',closedAt:new Date().toISOString()},
    postCutoff:preparePostCutoff({zylosDir:root,transactionDir:dir,homeDir:root,runtime:'claude',replacements:[]})};
  actual.durable(path.join(dir,'journal.json'),journal);
  const calls=[];
  const m={...actual,discover:()=>({candidates:[{dir,journal:structuredClone(journal)}],diagnostics:[]}),
    acquire:()=>{calls.push('lock');return()=>calls.push('unlock');},
    transaction:()=>structuredClone(journal),
    update:(_dir,j,changes)=>{calls.push('update');Object.assign(j,changes);journal=structuredClone(j);},
    marker:()=>calls.push('marker'),stop:()=>calls.push('stop'),finishTerminal:()=>{calls.push('cleanup');return {complete:true};}};
  return {root,dir,db,m,calls,get journal(){return journal;},set journal(value){journal=value;}};
}

test('status reads persisted facts without locking, isolation, finalizer calls, or terminal cleanup',async t=>{
  const f=fixture(t);f.journal={...f.journal,phase:'upgrade_complete'};
  const bytes=fs.readFileSync(path.join(f.dir,'journal.json'));
  const result=await resumeFinalize(f.root,{status:true},{maintenance:f.m,finalize:()=>assert.fail('finalizer called')});
  assert.equal(result.ok,true);assert.equal(result.data.next,null);assert.deepEqual(f.calls,[]);
  assert.deepEqual(fs.readFileSync(path.join(f.dir,'journal.json')),bytes);
});

test('persisted Dashboard items never substitute for current runtime verification',()=>{
  const journal={transactionId:'upgrade-status',phase:'upgrade_complete'};
  assert.equal(finalizeStatus(journal).dashboard.state,'unknown');
  journal.dashboardInstall={items:{registration:{state:'done'},route:{state:'done'}}};
  assert.equal(finalizeStatus(journal).dashboard.state,'unknown');
  journal.dashboardInstall.items={};
  assert.equal(finalizeStatus(journal).dashboard.state,'unknown');
  journal.dashboardInstall.items={route:{state:'pending'}};
  assert.equal(finalizeStatus(journal).dashboard.state,'unknown');
});

test('recorded Dashboard copy and installation failures remain degraded',()=>{
  const journal={transactionId:'upgrade-status',phase:'upgrade_complete',dashboardInstall:{
    dbCopy:{ok:false,error:{code:'COPY_FAILED',message:'copy failed'}},
    items:{registration:{state:'done'},route:{state:'failed',lastError:{code:'ROUTE_FAILED',message:'route failed'}}}
  }};
  assert.deepEqual(finalizeStatus(journal).dashboard,{state:'degraded',errors:[
    {item:'dbCopy',code:'COPY_FAILED',message:'copy failed'},
    {item:'route',code:'ROUTE_FAILED',message:'route failed'}
  ]});
});

test('successful resume reports its runtime observation but later status stays unverified',async t=>{
  const f=fixture(t),observed={state:'ready',errors:[]};
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},finalize:async ctx=>{
    f.m.update(f.dir,ctx.journal,{phase:'upgrade_complete'});
    return {success:true,dashboard:observed};
  }});
  assert.deepEqual(result.data.dashboard,observed);
  assert.equal((await resumeFinalize(f.root,{status:true},{maintenance:f.m})).data.dashboard.state,'unknown');
});

for(const unknown of [false,true]) test(`resume retains ${unknown?'unknown':'accepted'} restart and incomplete audit observations in text and JSON`,async t=>{
  const f=fixture(t);
  const observations={completion:{install:'done',dashboard:'ready',sessionRestart:unknown?'manual_required':'accepted',modeTransition:'unknown'},
    sessionRestart:unknown?{ok:false,requestId:'repair-request',error:{code:'restart_result_unknown',message:'reply lost'}}:{ok:true,data:{result:'accepted',requestId:'repair-request'}},
    checkpointAudit:{state:'incomplete',error:'DB_BUSY'},modeStatus:{state:'unavailable',error:{message:'P10 unavailable'}}};
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},finalize:async ctx=>{
    f.m.update(f.dir,ctx.journal,{phase:'upgrade_complete'});
    return {success:true,dashboard:{state:'ready',errors:[]},...observations};
  }});
  assert.equal(result.ok,true);
  const json=JSON.parse(JSON.stringify(result));
  for(const [key,value] of Object.entries(observations))assert.deepEqual(json.data[key],value);
  const text=formatFinalizeResult(json);
  assert.match(text,/Restart request: repair-request/);
  assert.match(text,/Checkpoint audit: incomplete: DB_BUSY/);
  assert.match(text,/Mode status: unavailable: P10 unavailable/);
  assert.match(text,unknown?/Do not resubmit automatically/:/Session restart: accepted/);
  const status=await resumeFinalize(f.root,{status:true},{maintenance:f.m});
  assert.equal(Object.hasOwn(status.data,'sessionRestart'),false);
});

test('a ready runtime observation cannot hide a retained Dashboard copy failure',async t=>{
  const f=fixture(t);
  f.journal={...f.journal,dashboardInstall:{dbCopy:{ok:false,error:{code:'COPY_FAILED'}},items:{}}};
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},finalize:async ctx=>{
    f.m.update(f.dir,ctx.journal,{phase:'upgrade_complete'});
    return {success:true,dashboard:{state:'ready',errors:[]}};
  }});
  assert.equal(result.data.dashboard.state,'degraded');
  assert.deepEqual(result.data.dashboard.errors,[{item:'dbCopy',code:'COPY_FAILED'}]);
});

test('snapshot hash drift is rejected before any modifications even when closed facts agree',async t=>{
  const f=fixture(t);fs.appendFileSync(path.join(f.db,'manifest.json'),' ');
  await assert.rejects(resumeFinalize(f.root,{}, {maintenance:f.m}),{code:'CUTOFF_UNTRUSTED'});
  assert.deepEqual(f.calls,[]);
});

test('macOS forward repair requires manual recovery and status remains available',async t=>{
  const f=fixture(t);
  await assert.rejects(resumeFinalize(f.root,{}, {maintenance:f.m,platform:'darwin'}),{code:'MANUAL_RECOVERY_REQUIRED'});
  assert.equal((await resumeFinalize(f.root,{status:true},{maintenance:f.m,platform:'darwin'})).ok,true);
  assert.deepEqual(f.calls,[]);
});

test('transaction replacement while obtaining the lock never repairs the replacement',async t=>{
  const f=fixture(t),original=f.m.acquire;
  f.m.acquire=()=>{const release=original();f.m.discover=()=>({candidates:[{dir:f.dir+'-other',journal:{...f.journal,transactionId:'other'}}],diagnostics:[]});return release;};
  await assert.rejects(resumeFinalize(f.root,{}, {maintenance:f.m}),{code:'CUTOFF_UNTRUSTED'});
  assert.deepEqual(f.calls,['lock','unlock']);
});

test('unconfirmed finalizer exit blocks isolation and publication and preserves the journal',async t=>{
  const f=fixture(t),before=structuredClone(f.journal);
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{f.calls.push('quiesce');throw Error('finalizer still active');},finalize:()=>assert.fail('published')});
  assert.equal(result.ok,false);assert.equal(result.error.code,'FINALIZE_INCOMPLETE');
  assert.match(result.error.message,/still active/);assert.equal(result.data.core.state,'failed');
  assert.deepEqual(f.journal,before);assert.deepEqual(f.calls,['lock','quiesce','unlock']);
});

test('resume confirms process exit, isolates writers, and passes persistent context and original budget to shared finalizer',async t=>{
  const f=fixture(t);
  const result=await resumeFinalize(f.root,{timeout:'60'}, {maintenance:f.m,quiesce:()=>f.calls.push('quiesce'),finalize:async(ctx,{budget})=>{
    f.calls.push('finalize');assert.equal(ctx.preInstallProtection,true);assert.equal(ctx.maintenance,f.m);
    assert.equal(ctx.transactionId,f.journal.transactionId);assert.equal(ctx.budget,budget);
    assert.deepEqual(ctx.originalServices,[]);assert.ok(budget.remaining()<=59000);
    f.m.update(f.dir,ctx.journal,{phase:'upgrade_complete'});
    return {success:true};
  }});
  assert.equal(result.ok,true);assert.equal(result.data.next,null);
  assert.deepEqual(f.calls,['lock','quiesce','update','marker','stop','finalize','update','unlock']);
});

test('terminal execution only finishes cleanup and does not quiesce or resume services',async t=>{
  const f=fixture(t);f.journal={...f.journal,phase:'upgrade_complete'};
  assert.equal((await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>assert.fail('quiesce'),finalize:()=>assert.fail('finalize')})).ok,true);
  assert.deepEqual(f.calls,['lock','cleanup','unlock']);
});

for(const corrupt of [false,true]) test(`resume revokes a previously published stable reader ${corrupt?'even when publication materials are corrupt':'before stopping writers'}`,async t=>{
  const f=fixture(t),stable=path.join(f.root,'.zylos/upgrade/maintenance.cjs');
  fs.mkdirSync(path.dirname(stable),{recursive:true});
  fs.writeFileSync(stable,fs.readFileSync(new URL('../upgrade-maintenance.cjs',import.meta.url),'utf8')+
    '\nmodule.exports.assertCoreDatabaseAvailable = root => assertCoreDatabaseAvailable(root, {postCutoffReady:true});\n');
  const preparation=preparePostCutoff({transactionDir:f.dir,zylosDir:f.root,homeDir:f.root,runtime:'claude',
    replacements:[{path:'CLAUDE.md',content:'published'}]});
  f.journal={...f.journal,postCutoff:{...preparation,items:{hooks:{...preparation.items.hooks,state:'done'}}}};
  fs.writeFileSync(path.join(f.root,'CLAUDE.md'),'published');
  if(corrupt)fs.writeFileSync(path.join(f.dir,preparation.items.hooks.targets[0].stagedFile),'corrupt');
  const save=()=>actual.durable(path.join(f.dir,'journal.json'),f.journal);
  save();actual.marker(f.root,f.dir,f.journal);
  const reader=createRequire(import.meta.url)(stable);
  assert.doesNotThrow(()=>reader.assertCoreDatabaseAvailable(f.root));
  const update=f.m.update;
  f.m.update=(...args)=>{update(...args);save();};
  let stopped=0;
  f.m.stop=()=>{stopped++;assert.throws(()=>reader.assertCoreDatabaseAvailable(f.root),{code:'ZYLOS_MAINTENANCE'});};
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},finalize:()=>{
    assert.equal(corrupt,false,'corrupt material reached finalization');
    assert.equal(f.journal.phase,'recovery_required');
    assert.throws(()=>reader.assertCoreDatabaseAvailable(f.root),{code:'ZYLOS_MAINTENANCE'});
    return {success:false,error:'controlled prerequisite failure'};
  }});
  assert.equal(result.ok,false);
  assert.equal(stopped,1,'existing writers must stop even when publication materials are corrupt');
  assert.throws(()=>reader.assertCoreDatabaseAvailable(f.root),{code:'ZYLOS_MAINTENANCE'});
});

test('fresh Dashboard observation deduplicates durable copy errors and retains distinct runtime errors',async t=>{
  const f=fixture(t);
  f.journal={...f.journal,dashboardInstall:{dbCopy:{ok:false,error:{code:'COPY_FAILED',message:'copy denied'}},items:{}}};
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},finalize:async ctx=>{
    f.m.update(f.dir,ctx.journal,{phase:'upgrade_complete'});
    return {success:true,dashboard:{state:'degraded',errors:[
      {item:'dbCopy',code:'COPY_FAILED',location:'copy denied'},
      {item:'verify',code:'UNAVAILABLE',location:'route missing'}]}};
  }});
  assert.equal(result.ok,true);
  assert.equal(result.data.dashboard.errors.length,2);
  assert.equal(result.data.dashboard.errors[0].item,'dbCopy');
  assert.equal(result.data.dashboard.errors[1].item,'verify');
});

test('real partial publication reports retained replace bytes when a later target conflicts',async t=>{
  const f=fixture(t);
  fs.writeFileSync(path.join(f.root,'CLAUDE.md'),'old');
  fs.writeFileSync(path.join(f.root,'AGENTS.md'),'old');
  f.journal={...f.journal,postCutoff:preparePostCutoff({zylosDir:f.root,transactionDir:f.dir,homeDir:f.root,runtime:'claude',
    replacements:[{id:'t01',path:'CLAUDE.md',content:'new'},{id:'t02',path:'AGENTS.md',content:'new'}]})};
  fs.writeFileSync(path.join(f.root,'AGENTS.md'),'conflict');
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},finalize:async ctx=>{
    const publication=await publishPostCutoff(ctx,{persist:(j,changes)=>f.m.update(f.dir,j,changes)});
    return {success:publication.ok,error:publication.lastError?.code};
  }});
  assert.equal(result.ok,false);
  assert.equal(result.data.core.failedItems[0].targetId,'t02');
  assert.ok(result.error.persisted.includes('journal.attempts'));
  assert.ok(result.error.persisted.includes('journal.items.hooks.t01'));
  assert.equal(fs.readFileSync(path.join(f.root,'CLAUDE.md'),'utf8'),'new');
  assert.equal(fs.readFileSync(path.join(f.root,'AGENTS.md'),'utf8'),'conflict');
});
