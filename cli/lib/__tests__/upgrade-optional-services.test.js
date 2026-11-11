import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {serviceRestartFixture} from './helpers/service-restart-fixture.js';
import {step11_startCoreServices, step12_verifyServices, resumeUpgradeFinalization} from '../self-upgrade.js';
import {resumeFinalize, finalizeStatus} from '../upgrade-resume.js';
import {formatSelfUpgradeCompletion} from '../../commands/component.js';

const require = createRequire(import.meta.url);
const maintenance = require('../upgrade-maintenance.cjs');
const warning = 'Service custom-service is not online; restart it manually.';

// Integration boundary: real restart/verification, finalization and recovery
// modules, with a lifecycle-owned fake PM2 executable under private PM2_HOME.
// Run for service membership, failure policy or warnings/result changes; skip
// unrelated features. The official runner isolates before imports; each fixture
// proves HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/TMUX_TMPDIR and uses no live DB/socket.
// Synchronous fake-PM2 children have 30s command deadlines; t.after reaps roots.
function fixture(t, options) {
  const f = serviceRestartFixture(t, options); f.custom();
  f.j.originalServices.reverse(); // A failed optional restart must not skip Core.
  assert.ok(Buffer.byteLength(path.join(f.env.TMPDIR, 'tmux.sock')) < 100);
  for (const key of ['HOME', 'ZYLOS_DIR', 'PM2_HOME', 'TMPDIR', 'TMUX_TMPDIR']) assert.ok(f.env[key].startsWith(f.root + path.sep));
  for (const file of ['comm-bridge/c4.db', 'scheduler/scheduler.db']) assert.ok(path.join(f.env.ZYLOS_DIR, file).startsWith(f.root + path.sep));
  return f;
}
function context(f) { return {journal:f.j, servicesWereRunning:f.j.originalServices.map(service => service.name)}; }
const poll = f => command => command.startsWith('sleep') ? '' : JSON.stringify(f.records());

function forwardFixture(f, {savedWarnings=[]} = {}) {
  const root=f.env.ZYLOS_DIR,id='optional-finalize',dir=path.join(root,'.backup/self-upgrade',id),db=path.join(root,'.backup/db',id);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(db,{recursive:true,mode:0o700});
  const manifest={formatVersion:2,function:'core-self-upgrade-db',status:'complete',id,
    databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db','components/dashboard/dashboard.db'].map(source=>({source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  maintenance.durable(path.join(db,'manifest.json'),manifest);
  const digest=maintenance.hash(path.join(db,'manifest.json'));
  const journal={...f.j,serviceWarnings:savedWarnings,transactionId:id,phase:'recovery_required',resumePhase:'compensation_closed',installationIntent:true,from:'old',to:'new',dbBackupDir:db,snapshotManifestHash:digest,
    compensationCutoff:{formatVersion:1,closed:true,transactionId:id,snapshotManifestHash:digest,closedAt:new Date().toISOString(),writer:'finalizer'},postCutoff:{items:{hooks:{state:'done'}}}};
  maintenance.durable(path.join(dir,'journal.json'),journal);
  const read=()=>maintenance.read(path.join(dir,'journal.json'));
  const m={...maintenance,discover:()=>({candidates:[{dir,journal:read()}],diagnostics:[]}),transaction:read,acquire:()=>()=>{},marker:()=>{}};
  return {root,dir,manifest,journal,read,m};
}

for (const fails of [false, true]) test(`service verification reports only final unavailable external services (${fails ? 'unavailable' : 'online'})`, t => {
  const f = fixture(t); if (fails) f.fail('custom-service');
  maintenance.start(f.j); maintenance.verifyServices(f.j);
  assert.equal(f.records().find(item => item.name === 'scheduler').pm2_env.status, 'online');
  const starts = f.calls().filter(args => ['restart', 'startOrRestart'].includes(args[0]));
  assert.equal(starts[0][1], 'custom-service');
  assert.ok(starts[1].includes('scheduler'), 'Core after failed external service is restarted');
  assert.deepEqual(f.j.serviceWarnings, fails ? [warning] : []);
  if (fails) {
    maintenance.verifyServices(f.j); assert.deepEqual(f.j.serviceWarnings, [warning], 'repeat verification does not duplicate warnings');
    f.clearFailure(); maintenance.start(f.j); maintenance.verifyServices(f.j);
    assert.deepEqual(f.j.serviceWarnings, [], 'a later successful restart clears the prior warning');
  }
});

for (const ecosystem of [true, false]) test(`ecosystem members and unknown ecosystem membership retain strict verification (${ecosystem})`, t => {
    const f = fixture(t, {ecosystem}); f.records([f.record('scheduler'), f.record('custom-service', 'online')]);
    let now = 0; const restore = Date.now; Date.now = () => (now += 40000);
    try { assert.throws(() => maintenance.verifyServices(f.j), /original services did not become online/); }
    finally { Date.now = restore; }
    assert.equal(f.j.originalServices.length, 2);
});

test('untrusted ecosystem bytes and PM2 provenance never become optional availability warnings', t => {
  const f = fixture(t); fs.appendFileSync(f.file, '// changed');
  assert.throws(() => maintenance.start(f.j), /identity changed/);
  assert.throws(() => maintenance.verifyServices(f.j), /identity changed/);
  assert.deepEqual(f.calls(), []);
  f.j.initialIdentity.ecosystemHash = maintenance.hash(f.file);
  f.records([f.record('scheduler')]);
  assert.throws(() => maintenance.verifyServices(f.j), /original PM2 service record missing or changed/);
});

test('PM2 discovery failures remain fatal before optional services are classified as available', t => {
  const f = fixture(t); f.listLimit(0);
  assert.throws(() => maintenance.start(f.j), /list unavailable/);
  assert.throws(() => maintenance.verifyServices(f.j), /list unavailable/);
  assert.equal(f.calls().some(args => ['restart', 'startOrRestart'].includes(args[0])), false);
});

for (const fails of [false, true]) test(`upgrade keeps Core available and returns service warning only when needed (${fails ? 'unavailable' : 'online'})`, t => {
  const f = fixture(t); if (fails) f.fail('custom-service');
  const ctx = context(f);
  const started = step11_startCoreServices(ctx, {zylosDir:f.env.ZYLOS_DIR, ecosystemPath:f.file});
  assert.equal(started.status, 'done', JSON.stringify(started));
  assert.equal(f.records().find(item => item.name === 'scheduler').pm2_env.status, 'online');
  assert.equal(step12_verifyServices(ctx, {execSync:poll(f)}).status, 'done');
  assert.deepEqual(ctx.serviceWarnings, fails ? [warning] : []);
  assert.equal(ctx.servicesWereRunning.length, 2);
});

// Run when forward verification or saved external-service admission changes;
// unrelated changes may skip. The fixture's PM2 records remain private.
test('service verification rejects an external script changed after successful startup',t=>{
  const f=fixture(t),ctx=context(f);
  const started=step11_startCoreServices(ctx,{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(started.status,'done',JSON.stringify(started));
  f.records(f.records().map(record=>record.name==='custom-service'
    ? {...record,pm2_env:{...record.pm2_env,pm_exec_path:path.join(f.skillsDir,'custom-service/changed.js')}}
    : record));
  const verified=step12_verifyServices(ctx,{execSync:poll(f)});
  assert.equal(verified.status,'failed',JSON.stringify(verified));
  assert.match(verified.error,/original PM2 service record missing or changed: custom-service/);
  assert.equal(ctx.serviceWarnings,undefined);assert.equal(ctx.journal.serviceWarnings,undefined);
});

for (const failedName of [null, 'custom-service', 'scheduler', 'changed-record', 'custom-stopped']) test(`new ecosystem after an absent original applies configuration with strict failures (${failedName || 'healthy'})`, t => {
  const f = fixture(t, {ecosystem:false});
  const tempDir=path.join(f.root,'download'),template=path.join(tempDir,'templates/pm2/ecosystem.config.cjs');
  fs.mkdirSync(path.dirname(template),{recursive:true});
  fs.writeFileSync(template, `module.exports={apps:[{name:'scheduler',script:${JSON.stringify(f.scripts.scheduler)},env:{FRESH_CORE_ENV:'new-template'}}]};`);
  const dir=path.join(f.env.ZYLOS_DIR,'.backup/self-upgrade','new-ecosystem');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});maintenance.durable(path.join(dir,'journal.json'),f.j);
  if (failedName==='changed-record') f.records([f.record('scheduler'), {...f.record('custom-service'), pm2_env:{status:'stopped',pm_exec_path:'/untrusted/custom.js'}}]);
  else if(failedName==='custom-stopped')f.stayStopped('custom-service');
  else if(failedName)f.fail(failedName);
  assert.equal(f.records().find(record=>record.name==='scheduler').pm2_env.FRESH_CORE_ENV,undefined);
  const ctx = {...context(f),tempDir,transactionDir:dir,upgradeProtected:true};
  const result = step11_startCoreServices(ctx, {zylosDir:f.env.ZYLOS_DIR, ecosystemPath:f.file});
  assert.equal(result.status, failedName && failedName!=='custom-stopped' ? 'failed' : 'done', JSON.stringify(result));
  assert.equal(ctx.serviceWarnings,undefined,'unclassified original services are never optional');
  if (failedName==='changed-record') {
    assert.match(result.error, /original PM2 service record missing or changed/);
    assert.equal(f.calls().some(args => ['restart','start','startOrRestart'].includes(args[0])), false);
  } else {
    assert.ok(f.calls().some(args=>args[0]==='restart'&&args[1]==='custom-service'));
    assert.ok(f.calls().some(args=>['start','startOrRestart'].includes(args[0])&&args[1]===f.file&&args.includes('scheduler')));
    if(failedName==='custom-stopped') {
      assert.equal(f.records().find(record=>record.name==='custom-service').pm2_env.status,'stopped','successful restart leaves the external service stopped');
      let now=0;t.mock.method(Date,'now',()=>now+=2000);
      const verified=step12_verifyServices(ctx,{execSync:poll(f)});
      assert.equal(verified.status,'failed');assert.match(verified.error,/Not online after 30s: custom-service/);
      assert.equal(ctx.serviceWarnings,undefined);assert.equal(ctx.journal.serviceWarnings,undefined);
    } else if(failedName)assert.match(result.error,new RegExp(failedName));
    else {
      assert.equal(f.records().find(record=>record.name==='scheduler').pm2_env.FRESH_CORE_ENV,'new-template');
      assert.equal(step12_verifyServices(ctx, {execSync:poll(f)}).status, 'done');
      assert.deepEqual(ctx.serviceWarnings, []);
    }
  }
  assert.equal(maintenance.read(path.join(dir,'journal.json')).ecosystemCreationIntent.originalMissing,true);
});

// Actual forward service steps cover both known and originally absent identity.
// Run for startup/verification membership changes; unrelated changes may skip.
for(const originalHash of ['known','absent'])test(`forward service steps accept two ecosystem instances with ${originalHash} original identity`,t=>{
  const f=serviceRestartFixture(t);
  fs.writeFileSync(f.file,`module.exports={apps:[{name:'scheduler',script:${JSON.stringify(f.scripts.scheduler)},instances:2,exec_mode:'cluster'}]};`);
  f.j.initialIdentity.ecosystemHash=originalHash==='known'?maintenance.hash(f.file):null;
  f.j.originalServices.push({...f.j.originalServices[0]});
  f.records([f.record('scheduler'),f.record('scheduler')]);
  const ctx=context(f);assert.deepEqual(ctx.servicesWereRunning,['scheduler','scheduler']);
  const started=step11_startCoreServices(ctx,{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(started.status,'done',JSON.stringify(started));
  const verified=step12_verifyServices(ctx,{execSync:poll(f)});
  assert.equal(verified.status,'done',JSON.stringify(verified));assert.deepEqual(ctx.serviceWarnings,[]);
  assert.equal(f.records().length,2);assert.ok(f.records().every(record=>record.pid>0&&record.pm2_env.status==='online'));
  assert.equal(f.calls().filter(args=>args[0]==='start'&&args.includes('scheduler')).length,2);
  assert.ok(f.calls().some(args=>args[0]==='save'));
});

test('a newly present invalid ecosystem remains fatal when the original file was missing', t => {
  const f = fixture(t, {ecosystem:false});
  fs.mkdirSync(path.dirname(f.file), {recursive:true});
  fs.writeFileSync(f.file, 'module.exports={};');
  assert.deepEqual(maintenance.serviceRequirements(f.j).external, [], 'recovery never loads a newly appeared unhashed config');
  const result = step11_startCoreServices(context(f), {zylosDir:f.env.ZYLOS_DIR, ecosystemPath:f.file});
  assert.equal(result.status, 'failed'); assert.match(result.error, /invalid ecosystem apps/);
  assert.equal(f.calls().length, 0);
});

test('an ecosystem restart failure still fails the upgrade after external failure', t => {
  const f = fixture(t); f.fail();
  const result = step11_startCoreServices(context(f), {zylosDir:f.env.ZYLOS_DIR, ecosystemPath:f.file});
  assert.equal(result.status, 'failed'); assert.match(result.error, /scheduler/);
  assert.ok(f.calls().some(args => args.includes('scheduler')));
});

for (const fails of [false, true]) test(`forward finalization and status retain latest service warnings (${fails ? 'unavailable' : 'online'})`, async t => {
  const f = fixture(t); if (fails) f.fail('custom-service');
  const {root,dir,read,m}=forwardFixture(f);
  let finalized;
  const result=await resumeFinalize(root,{}, {maintenance:m,quiesce:()=>{},finalize:async ctx=>(finalized=await resumeUpgradeFinalization(ctx,{
    finalizeWebConsoleRemoval:()=>({warnings:[],pm2Changed:false}),
    publish:()=>({ok:true}),updateConfig:()=>{},ensureMemoryMigration:()=>{},verifyPublicationForServices:()=>{},
    startServices:ctx=>step11_startCoreServices(ctx,{zylosDir:root,ecosystemPath:f.file}),
    verifyServices:ctx=>step12_verifyServices(ctx,{execSync:poll(f)}),
    dashboardOwner:{verifyDashboard:()=>({state:'ready',errors:[]})},readModeStatus:()=>({ok:true,data:{sessionMode:'single',transition:null}}),
    readMode:()=>({mode:'single'}),readTransition:()=>null,restart:()=>({ok:true,data:{result:'accepted'}}),audit:()=>[],
    protectedSuccess:ctx=>m.update(dir,ctx.journal,{phase:'upgrade_complete'}),
  }))});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(finalized.serviceWarnings, fails ? [warning] : undefined,'direct finalizer result receives copied Core warnings');
  assert.deepEqual(finalized.warnings,[],'service strings never enter runtime warnings');
  assert.deepEqual(result.data.serviceWarnings, fails ? [warning] : undefined);
  assert.deepEqual(result.data.warnings,[]);
  assert.deepEqual(finalizeStatus(read()).serviceWarnings, fails ? [warning] : undefined);
  assert.equal(read().phase,'upgrade_complete');
  const output = formatSelfUpgradeCompletion(result.data);
  if (fails) assert.match(output, /Service warning: Service custom-service is not online; restart it manually/);
  else assert.doesNotMatch(output, /Service warning/);
});

for (const requiredFails of [false, true]) test(`restored verification finishes only when required services recover (${requiredFails ? 'required unavailable' : 'optional unavailable'})`, t => {
  const f = fixture(t); f.fail(requiredFails ? 'fail' : 'custom-service');
  const dir=path.join(f.env.ZYLOS_DIR,'.backup/self-upgrade','optional-restore');
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  // Load unchanged product modules privately so package-restoration admission can
  // be supplied as an already-complete boundary; actual service policy, durable
  // journal, recovery state machine and maintenance marker cleanup stay real.
  fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(dir,'maintenance.cjs'));fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/remove-owned-tree.js'),path.join(path.dirname(path.join(dir,'maintenance.cjs')),'remove-owned-tree.mjs'));
  fs.copyFileSync(path.resolve('cli/lib/upgrade-recovery.cjs'),path.join(dir,'recovery.cjs'));
  const m=require(path.join(dir,'maintenance.cjs')),recovery=require(path.join(dir,'recovery.cjs'));
  const digest='a'.repeat(64),pkg=path.join(f.env.ZYLOS_DIR,'package.json');
  const j={...f.j,formatVersion:1,transactionId:'optional-restore',installationIntent:true,databaseMode:'unchanged',nodePath:process.execPath,
    phase:'restored_data_ready',dbBackupDir:path.join(f.env.ZYLOS_DIR,'.backup/db/optional-restore'),snapshotManifestHash:digest,
    coreManifest:[{name:'scheduler',existedBefore:true,backedUp:true,originalHash:digest}],
    initialIdentity:{...f.j.initialIdentity,nodePath:process.execPath,packageJson:pkg,packageHash:digest,cliRoot:path.join(f.env.ZYLOS_DIR,'cli'),cliHash:digest,
      workerPath:path.join(f.env.ZYLOS_DIR,'worker.js'),workerHash:digest,databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db','components/dashboard/dashboard.db'].map(source=>({source,exists:false}))}};
  m.update(dir,j);m.marker(f.env.ZYLOS_DIR,dir,j);
  m.restoreOriginalPackage=()=>{}; // Original code is already restored for this boundary.
  m.canRecognizeProcesses=()=>false;
  let now=0;const originalNow=Date.now;
  if(requiredFails)Date.now=()=>now+=40000;
  let result;
  try {result=recovery.resume(dir,{ownership:(_dir,fn)=>fn()});}
  finally {Date.now=originalNow;}
  assert.equal(result.completed,!requiredFails,JSON.stringify(result));
  assert.equal(result.recovery_required,requiredFails);
  const marker=path.join(f.env.ZYLOS_DIR,'.zylos/upgrade/active.json');
  assert.equal(fs.existsSync(marker),requiredFails);
  if(!requiredFails) {
    assert.equal(result.stage,'restored_complete'); assert.deepEqual(result.warnings,[warning]);
    assert.equal(f.records().find(item=>item.name==='scheduler').pm2_env.status,'online');
    const repeated=recovery.resume(dir,{ownership:(_dir,fn)=>fn()});assert.deepEqual(repeated.warnings,[warning]);
  }
});


// This changed-hash case requires the deliberate post-publication admission;
// leaving bytes identical would not distinguish the required branch.
test('published ecosystem updates require a closed cutoff and completed hooks', t => {
  const f=fixture(t),digest='a'.repeat(64),id='published-services';
  const j={...f.j,phase:'compensation_closed',transactionId:id,snapshotManifestHash:digest,
    compensationCutoff:{formatVersion:1,closed:true,transactionId:id,snapshotManifestHash:digest,closedAt:new Date().toISOString(),writer:'finalizer'},
    postCutoff:{items:{hooks:{state:'done'}}}};
  fs.appendFileSync(f.file,'\n// intentionally regenerated template\n');
  assert.notEqual(maintenance.hash(f.file),j.initialIdentity.ecosystemHash);
  const classified=maintenance.serviceRequirements(j,{ecosystemPath:f.file,allowUpdatedEcosystem:true});
  assert.deepEqual(classified.required.map(service=>service.name),['scheduler']);
  assert.deepEqual(classified.external.map(service=>service.name),['custom-service']);
  assert.throws(()=>maintenance.serviceRequirements(j,{ecosystemPath:f.file}),/identity changed/);
  assert.throws(()=>maintenance.serviceRequirements({...j,postCutoff:{items:{hooks:{state:'pending'}}}},{ecosystemPath:f.file,allowUpdatedEcosystem:true}),/identity changed/);
  assert.throws(()=>maintenance.serviceRequirements({...j,phase:'restored_verifying',compensationCutoff:undefined},{ecosystemPath:f.file,allowUpdatedEcosystem:true}),/identity changed/);
});

test('forward service startup accepts ecosystem symlinks while recovery remains strict', t => {
  const f=fixture(t),target=path.join(f.root,'deployed-ecosystem.cjs');
  fs.renameSync(f.file,target);fs.symlinkSync(target,f.file);
  const ctx=context(f),started=step11_startCoreServices(ctx,{zylosDir:f.env.ZYLOS_DIR,ecosystemPath:f.file});
  assert.equal(started.status,'done',JSON.stringify(started));
  assert.equal(f.records().find(record=>record.name==='scheduler').pm2_env.status,'online');
  assert.equal(step12_verifyServices(ctx,{execSync:poll(f)}).status,'done');
  assert.throws(()=>maintenance.start(f.j),/unsafe recovery path/,'forward startup does not weaken recovery path admission');
});

// Each real verification must replace state and durably publish it. A separate
// journal reread prevents an in-memory ctx/journal alias from hiding a lost write.
for(const finalOnline of [true,false])test(`service verification replaces prior warnings and persists the final state (${finalOnline?'online':'unavailable'})`,t=>{
  const f=fixture(t),{dir,read}=forwardFixture(f),ctx={...context(f),transactionDir:dir};
  ctx.journal=read();ctx.journal.serviceWarnings=finalOnline?[warning]:[];
  ctx.serviceWarnings=ctx.journal.serviceWarnings;
  maintenance.update(dir,ctx.journal);
  f.records([f.record('scheduler','online'),f.record('custom-service',finalOnline?'online':'stopped')]);
  assert.equal(step12_verifyServices(ctx,{execSync:poll(f)}).status,'done');
  const expected=finalOnline?[]:[warning];
  assert.deepEqual(ctx.serviceWarnings,expected,'latest observation replaces previous warning state');
  assert.deepEqual(read().serviceWarnings,expected,'fresh read observes the latest durable warning state');
});

test('resume retains durable service warnings when publication fails before service verification',async t=>{
  const f=fixture(t),{root,read,m}=forwardFixture(f,{savedWarnings:[warning]});
  let finalized;
  const result=await resumeFinalize(root,{}, {maintenance:m,quiesce:()=>{},finalize:async ctx=>{
    finalized=await resumeUpgradeFinalization(ctx,{publish:()=>{throw Error('publication unavailable before service verification');}});
    return finalized;
  }});
  assert.equal(result.ok,false);assert.equal(finalized.success,false);
  assert.deepEqual(finalized.serviceWarnings,[warning],'resume result must initialize from its durable warning field');
  assert.deepEqual(finalized.warnings,[],'saved service warnings retain their own result field');
  assert.deepEqual(result.data.serviceWarnings,[warning]);
  assert.deepEqual(read().serviceWarnings,[warning]);
});

// Original package/CLI identity and preinstall abort are real; unchanged DB mode
// avoids unrelated migration/restore machinery. The terminal reread is also real.
for(const unavailable of [false,true])test(`preinstall abort preserves service warnings and cleanup shape (${unavailable?'unavailable':'online'})`,t=>{
  const f=fixture(t),id='optional-abort',root=f.env.ZYLOS_DIR,dir=path.join(root,'.backup/self-upgrade',id);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  for(const [source,dest] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',source),path.join(dir,dest));
  const m=require(path.join(dir,'maintenance.cjs')),recovery=require(path.join(dir,'recovery.cjs'));
  const pkg=path.join(root,'package.json'),cli=path.join(root,'cli'),worker=path.join(root,'worker.js');
  fs.writeFileSync(pkg,JSON.stringify({name:'original',version:'old'}));fs.mkdirSync(cli);fs.writeFileSync(path.join(cli,'original.js'),'// original CLI');
  fs.writeFileSync(worker,'// unchanged worker');
  const j={...f.j,formatVersion:1,transactionId:id,installationIntent:false,databaseMode:'unchanged',nodePath:process.execPath,phase:'offline',
    coreManifest:[{name:'absent-core',existedBefore:false,backedUp:false,originalHash:null}],
    initialIdentity:{...f.j.initialIdentity,nodePath:process.execPath,packageJson:pkg,packageHash:m.hash(pkg),cliRoot:cli,cliHash:m.treeHash(cli),workerPath:worker,workerHash:m.hash(worker),
      databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db','components/dashboard/dashboard.db'].map(source=>({source,exists:false}))}};
  m.update(dir,j);m.marker(root,dir,j);if(unavailable)f.fail('custom-service');
  const finish=m.finishTerminal;let cleanup;
  m.finishTerminal=(...args)=>(cleanup=finish(...args));
  const result=recovery.resume(dir,{ownership:(_dir,fn)=>fn()});
  assert.equal(result.stage,'aborted_before_install',JSON.stringify(result));assert.equal(result.attempted,false);assert.equal(result.completed,false);assert.equal(result.recovery_required,false);
  if(unavailable)assert.deepEqual(result.warnings,[warning],'initial preinstall abort includes the external service warning');
  else {assert.equal(Object.hasOwn(result,'warnings'),Object.hasOwn(cleanup,'warnings'));assert.deepEqual(result.warnings,cleanup.warnings,'healthy abort retains the exact cleanup warning shape');}
  const saved=m.read(path.join(dir,'journal.json'));
  const terminal=recovery.abort(dir,saved);
  if(unavailable)assert.deepEqual(terminal.warnings,[warning],'terminal abort includes the same warning');
  else {assert.equal(Object.hasOwn(terminal,'warnings'),Object.hasOwn(cleanup,'warnings'));assert.deepEqual(terminal.warnings,cleanup.warnings);}
  const repeated=recovery.resume(dir,{ownership:(_dir,fn)=>fn()});
  if(unavailable)assert.deepEqual(repeated.warnings,[warning],'public terminal reread retains it once');
  else {assert.equal(Object.hasOwn(repeated,'warnings'),Object.hasOwn(cleanup,'warnings'));assert.deepEqual(repeated.warnings,cleanup.warnings);}
  assert.equal(m.discover(root).marker,null);
});


for(const source of ['module.exports={apps:[]};','module.exports={};'])test(`empty original service set ignores changed ecosystem (${source})`,t=>{
  const f=fixture(t);f.j.originalServices=[];f.j.serviceWarnings=['old warning'];fs.writeFileSync(f.file,source);
  assert.doesNotThrow(()=>maintenance.verifyServices(f.j));
  assert.equal(f.calls().length,0);
  assert.deepEqual(f.j.serviceWarnings,[]);
});
