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

for (const changed of [false, true]) test(`new template after a missing original ecosystem retains saved-record routing and provenance (${changed})`, t => {
  const f = fixture(t, {ecosystem:false});
  fs.mkdirSync(path.dirname(f.file), {recursive:true});
  fs.writeFileSync(f.file, `module.exports={apps:[{name:'scheduler',script:${JSON.stringify(f.scripts.scheduler)}}]};`);
  if (changed) f.records([f.record('scheduler'), {...f.record('custom-service'), pm2_env:{status:'stopped',pm_exec_path:'/untrusted/custom.js'}}]);
  const ctx = context(f);
  const result = step11_startCoreServices(ctx, {zylosDir:f.env.ZYLOS_DIR, ecosystemPath:f.file});
  assert.equal(result.status, changed ? 'failed' : 'done', JSON.stringify(result));
  if (changed) {
    assert.match(result.error, /original PM2 service record missing or changed/);
    assert.equal(f.calls().some(args => ['restart','start','startOrRestart'].includes(args[0])), false);
  } else {
    assert.deepEqual(f.calls().filter(args => args[0] !== 'jlist'), [['restart','custom-service','--update-env'],['restart','scheduler','--update-env'],['save']]);
    assert.equal(step12_verifyServices(ctx, {execSync:poll(f)}).status, 'done');
    assert.deepEqual(ctx.serviceWarnings, []);
  }
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
  const root=f.env.ZYLOS_DIR,id='optional-finalize',dir=path.join(root,'.backup/self-upgrade',id),db=path.join(root,'.backup/db',id);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.mkdirSync(db,{recursive:true,mode:0o700});
  const manifest={formatVersion:2,function:'core-self-upgrade-db',status:'complete',id,
    databases:['comm-bridge/c4.db','scheduler/scheduler.db','web-console/web-console.db','components/dashboard/dashboard.db'].map(source=>({source,status:'missing',file:null,bytes:0,sha256:null,userVersion:null,integrityCheck:null}))};
  maintenance.durable(path.join(db,'manifest.json'),manifest);
  const digest=maintenance.hash(path.join(db,'manifest.json'));
  const journal={...f.j,transactionId:id,phase:'recovery_required',resumePhase:'compensation_closed',installationIntent:true,from:'old',to:'new',dbBackupDir:db,snapshotManifestHash:digest,
    compensationCutoff:{formatVersion:1,closed:true,transactionId:id,snapshotManifestHash:digest,closedAt:new Date().toISOString(),writer:'finalizer'},postCutoff:{items:{hooks:{state:'done'}}}};
  maintenance.durable(path.join(dir,'journal.json'),journal);
  const read=()=>maintenance.read(path.join(dir,'journal.json'));
  const m={...maintenance,discover:()=>({candidates:[{dir,journal:read()}],diagnostics:[]}),transaction:read,acquire:()=>()=>{},marker:()=>{}};
  const result=await resumeFinalize(root,{}, {maintenance:m,quiesce:()=>{},finalize:ctx=>resumeUpgradeFinalization(ctx,{
    publish:()=>({ok:true}),updateConfig:()=>{},ensureMemoryMigration:()=>{},verifyPublicationForServices:()=>{},
    startServices:ctx=>step11_startCoreServices(ctx,{zylosDir:root,ecosystemPath:f.file}),
    verifyServices:ctx=>step12_verifyServices(ctx,{execSync:poll(f)}),
    dashboardOwner:{verifyDashboard:()=>({state:'ready',errors:[]})},readModeStatus:()=>({ok:true,data:{sessionMode:'single',transition:null}}),
    readMode:()=>({mode:'single'}),readTransition:()=>null,restart:()=>({ok:true,data:{result:'accepted'}}),audit:()=>[],
    protectedSuccess:ctx=>m.update(dir,ctx.journal,{phase:'upgrade_complete'}),
  })});
  assert.equal(result.ok,true,JSON.stringify(result));
  assert.deepEqual(result.data.serviceWarnings, fails ? [warning] : undefined);
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
  fs.copyFileSync(path.resolve('cli/lib/upgrade-maintenance.cjs'),path.join(dir,'maintenance.cjs'));
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
