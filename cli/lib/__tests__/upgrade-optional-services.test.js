import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {serviceFixture} from './helpers/upgrade-service-fixture.js';
const require = createRequire(import.meta.url);
const m = require('../upgrade-maintenance.cjs');
const {step11_startCoreServices} = await import('../self-upgrade.js');

// Integration boundary: real finalizer/recovery/start/verify and durable journal,
// with a private PM2 shim only. Run for service availability or warning plumbing;
// unrelated upgrades may skip. Outer test launcher must supply private HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR/TMUX_TMPDIR; cases own their socket/DB paths.
// Every child is synchronous with a deadline; fixture cleanup reclaims its root.
function mixed(t) {
  const f = serviceFixture(t, {ecosystem:true});
  const custom = {name:'custom', script:path.join(f.j.skillsDir, 'custom/service.js')};
  fs.mkdirSync(path.dirname(custom.script), {recursive:true}); fs.writeFileSync(custom.script, '// custom');
  f.j.originalServices.unshift(custom);
  f.records([{name:'custom',pid:0,pm2_env:{status:'stopped',pm_exec_path:custom.script}}, ...f.readRecords()]);
  Object.assign(f.j, {formatVersion:1, transactionId:'tx', from:'1', to:'2', installationIntent:true,
    databaseMode:'unchanged', nodePath:process.execPath, phase:'restored_data_ready',
    dbBackupDir:path.join(f.root,'.backup/db/tx'), snapshotManifestHash:'a'.repeat(64),
    coreManifest:[{name:'core',existedBefore:true,backedUp:true,originalHash:'b'.repeat(64)}]});
  Object.assign(f.j.initialIdentity, {nodePath:process.execPath,packageJson:path.join(f.root,'package.json'),packageHash:'c'.repeat(64),
    cliRoot:path.join(f.root,'cli'),cliHash:'d'.repeat(64),workerPath:path.join(f.root,'worker.js'),workerHash:'e'.repeat(64),
    databases:m.DB_PATHS.map(source=>({source,exists:false}))});
  f.dir=path.join(f.root,'.backup/self-upgrade/tx'); fs.mkdirSync(f.dir,{recursive:true,mode:0o700});
  const stable=path.join(f.root,'.zylos/upgrade');fs.mkdirSync(stable,{recursive:true,mode:0o700});
  for(const [source,target] of [['upgrade-maintenance.cjs','maintenance.cjs'],['upgrade-recovery.cjs','recovery.cjs']])fs.copyFileSync(path.resolve('cli/lib',source),path.join(stable,target));
  f.maintenance=require(path.join(stable,'maintenance.cjs')); f.runner=require(path.join(stable,'recovery.cjs'));
  f.save=()=>{f.maintenance.update(f.dir,f.j);f.maintenance.marker(f.root,f.dir,f.j);};
  f.load=()=>f.maintenance.read(path.join(f.dir,'journal.json'));
  const paths={HOME:path.join(f.root,'home'),ZYLOS_DIR:f.root,PM2_HOME:path.join(f.root,'pm2-home'),TMPDIR:path.join(f.root,'tmp'),TMUX_TMPDIR:path.join(f.root,'tmux')};
  for(const directory of Object.values(paths))fs.mkdirSync(directory,{recursive:true});
  assert.ok(Object.values(paths).every(directory=>fs.realpathSync(directory).startsWith(f.root)));
  f.env={PATH:process.env.PATH,...paths};
  console.info('optional service isolation',JSON.stringify({...paths,socket:path.join(f.root,'tmux/socket'),databases:m.DB_PATHS.map(source=>path.join(f.root,source))}));
  return f;
}
for(const targetOwned of [false,true])for(const mode of ['restart-error','stays-stopped','online'])test(`upgrade finalizer completes when external service is ${mode} (${targetOwned?'target owned':'standard'})`,t=>{
  const f=mixed(t);f.j.phase='new_data_ready';
  const packageRoot=fs.realpathSync(path.resolve('.'));
  if(targetOwned) {
    f.j.targetOwned=true;f.j.to=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version;
    f.j.compensationCutoff={formatVersion:1,closed:true,transactionId:'tx',from:f.j.from,to:f.j.to,snapshotManifestHash:f.j.snapshotManifestHash};
  }
  f.save();
  if(mode!=='online')fs.writeFileSync(path.join(f.root,mode==='restart-error'?'fail-restart':'stay-stopped'),'custom');
  const state={schemaVersion:2,preInstallProtection:true,zylosDir:f.root,ecosystemPath:f.file,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler'],from:'1',to:f.j.to,databaseMode:'unchanged',targetOwned,packageRoot};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,true,JSON.stringify(result));
  if(targetOwned)assert.equal(f.commands().filter(args=>args[0]==='save').length,3,'target-owned second service verification runs before completion');
  assert.equal(f.readRecords().find(record=>record.name==='scheduler').pm2_env.status,'online');
  const calls=f.commands(), externalRestart=calls.findIndex(args=>args[0]==='restart'&&args[1]==='custom');
  const coreRestart=calls.findIndex(args=>['start','startOrRestart'].includes(args[0])&&args.includes('scheduler'));
  assert.ok(externalRestart>=0&&coreRestart>externalRestart,'core after failing external was restarted');
  if(mode==='online')assert.equal(result.serviceWarnings,undefined);
  else {assert.equal(result.serviceWarnings.length,1);assert.match(result.serviceWarnings[0],/custom.*manually/);assert.equal(f.load().serviceWarnings.length,1);}
});
for(const mode of ['restart-error','stays-stopped'])test(`recovery completes and persists external ${mode} warning across resume`,t=>{
  const f=mixed(t);f.save();fs.writeFileSync(path.join(f.root,mode==='restart-error'?'fail-restart':'stay-stopped'),'custom');
  const result=f.runner.resume(f.dir);
  assert.equal(result.completed,true,JSON.stringify(result));assert.equal(result.recovery_required,false);assert.equal(result.stage,'restored_complete');
  assert.equal(result.warnings.length,1);assert.match(result.warnings[0],/custom.*manually/);
  assert.equal(f.readRecords().find(record=>record.name==='scheduler').pm2_env.status,'online');
  assert.deepEqual(f.runner.resume(f.dir).warnings,result.warnings,'terminal reread retains warning without duplicate');
  assert.equal(f.maintenance.discover(f.root).marker,null);
});
test('upgrade finalizer still fails when an ecosystem service cannot restart',t=>{
  const f=mixed(t);f.j.phase='new_data_ready';f.save();fs.writeFileSync(path.join(f.root,'fail-restart'),'scheduler');
  const state={schemaVersion:2,preInstallProtection:true,zylosDir:f.root,ecosystemPath:f.file,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler'],from:'1',to:'2',databaseMode:'unchanged'};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,false);assert.equal(result.failedStep,11);assert.match(result.error,/scheduler/);
  assert.notEqual(f.load().phase,'upgrade_complete');
});
for(const failedName of [null,'custom','scheduler','custom-stopped'])test(`originally missing ecosystem applies the generated core configuration with strict failures (${failedName || 'healthy'})`,t=>{
  const f=mixed(t);f.j.phase='new_data_ready';f.j.initialIdentity.ecosystemHash=null;
  const tempDir=path.join(f.root,'download'),template=path.join(tempDir,'templates/pm2/ecosystem.config.cjs');
  fs.mkdirSync(path.dirname(template),{recursive:true});
  const script=f.j.originalServices.find(service=>service.name==='scheduler').script;
  fs.writeFileSync(template,`module.exports={apps:[{name:'scheduler',script:${JSON.stringify(script)},env:{FRESH_CORE_ENV:'from-new-template'}}]};`);
  fs.unlinkSync(f.file);f.save();
  assert.equal(f.readRecords().find(record=>record.name==='scheduler').pm2_env.FRESH_CORE_ENV,undefined,'cached record lacks the new environment');
  if(failedName==='custom-stopped')fs.writeFileSync(path.join(f.root,'stay-stopped'),'custom');
  else if(failedName)fs.writeFileSync(path.join(f.root,'fail-restart'),failedName);
  const state={schemaVersion:2,preInstallProtection:true,zylosDir:f.root,ecosystemPath:f.file,tempDir,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler'],from:'1',to:'2',databaseMode:'unchanged',expireServiceWait:failedName==='custom-stopped'};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,failedName===null);assert.equal(result.serviceWarnings,undefined);
  assert.ok(f.commands().some(args=>args[0]==='restart'&&args[1]==='custom'),'outside generated ecosystem retains saved-record restart');
  assert.ok(f.commands().some(args=>['start','startOrRestart'].includes(args[0])&&args[1]===f.file&&args.includes('scheduler')),'generated ecosystem member uses fresh configuration');
  assert.equal(f.commands().some(args=>args[0]==='restart'&&args[1]==='scheduler'),false,'Core does not reuse cached ordinary-restart environment');
  assert.equal(f.load().ecosystemCreationIntent.originalMissing,true);
  if(failedName==='custom-stopped') {
    assert.equal(result.failedStep,12);assert.match(result.error,/did not become online/);
    assert.equal(f.readRecords().find(record=>record.name==='custom').pm2_env.status,'stopped');
  } else if(failedName) {assert.equal(result.failedStep,11);assert.match(result.error,new RegExp(failedName));}
  else assert.equal(f.readRecords().find(record=>record.name==='scheduler').pm2_env.FRESH_CORE_ENV,'from-new-template');
});
test('required ecosystem service remaining stopped still fails verification',t=>{
  const f=mixed(t);f.records(f.readRecords().map(record=>({...record,pid:0,pm2_env:{...record.pm2_env,status:'stopped'}})));
  let clock=0;t.mock.method(Date,'now',()=>clock+=40000);
  assert.throws(()=>m.verifyServices(f.j),/original services did not become online/);
});
test('a present but invalid ecosystem is not downgraded when the original ecosystem was missing',t=>{
  const f=mixed(t);f.j.phase='new_data_ready';f.j.initialIdentity.ecosystemHash=null;f.save();fs.writeFileSync(f.file,'module.exports={}');
  const result=step11_startCoreServices({preInstallProtection:true,transactionDir:f.dir,servicesWereRunning:['custom','scheduler']},{ecosystemPath:f.file,zylosDir:f.root});
  assert.equal(result.status,'failed');assert.match(result.error,/invalid ecosystem apps/);
  assert.equal(f.commands().length,0);
});
test('PM2 list failure is never downgraded to an optional service warning',t=>{
  const f=mixed(t);fs.writeFileSync(path.join(f.root,'fail-jlist'),'yes');
  assert.throws(()=>m.start(f.j),/exited 10/);
  assert.throws(()=>m.verifyServices(f.j),/exited 10/);
  assert.equal(f.j.serviceWarnings,undefined);
});
test('PM2 provenance remains strict for optional services',t=>{
  const f=mixed(t);f.records(f.readRecords().filter(record=>record.name!=='custom'));
  assert.throws(()=>m.start(f.j),/original PM2 service record missing or changed/);
  assert.equal(f.commands().filter(args=>args[0]==='restart'||args[0]==='startOrRestart').length,0);
});

// The fixture changes PM2 state only after the real first verification returns.
// The real finalizer's target-owned second verify must replace both result and
// durable warnings; fixed-state cases cannot prove this freshness boundary.
for(const finalStatus of ['online','stopped'])test(`target-owned completion uses the last external service status (${finalStatus})`,t=>{
  const f=mixed(t),packageRoot=fs.realpathSync(path.resolve('.'));
  f.j.phase='new_data_ready';f.j.targetOwned=true;
  f.j.to=JSON.parse(fs.readFileSync(path.join(packageRoot,'package.json'),'utf8')).version;
  f.j.compensationCutoff={formatVersion:1,closed:true,transactionId:'tx',from:f.j.from,to:f.j.to,snapshotManifestHash:f.j.snapshotManifestHash};
  f.save();
  if(finalStatus==='online')fs.writeFileSync(path.join(f.root,'stay-stopped'),'custom');
  const state={schemaVersion:2,preInstallProtection:true,targetOwned:true,packageRoot,zylosDir:f.root,ecosystemPath:f.file,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler'],from:f.j.from,to:f.j.to,
    databaseMode:'unchanged',externalAfterFirstVerify:finalStatus};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(f.commands().filter(args=>args[0]==='save').length,3,'second service verification executed');
  const expected=finalStatus==='online'?[]:['Service custom is not online; restart it manually, then run pm2 save.'];
  assert.deepEqual(result.serviceWarnings,expected.length?expected:undefined,'result reflects second verification');
  assert.deepEqual(f.load().serviceWarnings,expected,'journal reflects second verification rather than first');
  assert.equal(f.load().phase,'upgrade_complete');
});

// Preinstall abort keeps original package/CLI/core identity checks real, with
// unchanged database mode. Both first abort and terminal abort/reread retain the
// named external warning without manufacturing an installed rollback result.
test('preinstall abort returns external service warnings on first and terminal results',t=>{
  const f=mixed(t);f.j.installationIntent=false;f.j.phase='offline';
  const identity=f.j.initialIdentity;
  fs.writeFileSync(identity.packageJson,JSON.stringify({name:'original-package',version:'1'}));
  identity.packageHash=f.maintenance.hash(identity.packageJson);
  fs.mkdirSync(identity.cliRoot,{recursive:true});fs.writeFileSync(path.join(identity.cliRoot,'original.js'),'// original CLI');
  identity.cliHash=f.maintenance.treeHash(identity.cliRoot);
  f.j.coreManifest=[{name:'absent-core',existedBefore:false,backedUp:false,originalHash:null}];
  f.save();fs.writeFileSync(path.join(f.root,'stay-stopped'),'custom');
  const result=f.runner.resume(f.dir);
  assert.equal(result.attempted,false,JSON.stringify(result));assert.equal(result.completed,false);
  assert.equal(result.recovery_required,false);assert.equal(result.stage,'aborted_before_install');
  const expected=['Service custom is not online; restart it manually, then run pm2 save.'];
  assert.deepEqual(result.warnings,expected,'initial abort includes latest unavailable external service');
  assert.deepEqual(f.load().serviceWarnings,expected);
  assert.equal(f.readRecords().find(record=>record.name==='scheduler').pm2_env.status,'online');
  const terminalAbort=f.runner.abort(f.dir,f.load());
  assert.deepEqual(terminalAbort.warnings,expected,'already terminal abort preserves the warning');
  assert.deepEqual(f.runner.resume(f.dir).warnings,expected,'public terminal resume preserves it once');
  assert.equal(f.maintenance.discover(f.root).marker,null);
});

for(const ecosystemSource of ['module.exports={apps:[]};','module.exports={};'])test(`empty original service set does not inspect changed ecosystem (${ecosystemSource})`,t=>{
  const f=mixed(t);f.j.originalServices=[];f.j.serviceWarnings=['obsolete warning'];
  fs.writeFileSync(f.file,ecosystemSource);
  assert.doesNotThrow(()=>m.verifyServices(f.j));
  assert.equal(f.commands().length,0,'no PM2 query or save is required without original services');
  assert.deepEqual(f.j.serviceWarnings,[],'obsolete service warnings are cleared');
});

// Forward finalization and new-phase recovery follow the trusted deployed link;
// restored recovery still verifies the original nonsymlink path before restart.
test('protected upgrade completes with a trusted ecosystem symlink',t=>{
  const f=mixed(t);f.j.phase='new_data_ready';
  const target=path.join(f.root,'deployed-ecosystem.cjs');fs.renameSync(f.file,target);fs.symlinkSync(target,f.file);f.save();
  const state={schemaVersion:2,preInstallProtection:true,zylosDir:f.root,ecosystemPath:f.file,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler'],from:'1',to:'2',databaseMode:'unchanged'};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.serviceWarnings,undefined);
  assert.equal(f.load().phase,'upgrade_complete');
  assert.equal(f.readRecords().find(record=>record.name==='scheduler').pm2_env.status,'online');
  assert.throws(()=>m.start({...f.load(),phase:'restored_verifying'}),/unsafe recovery path/);
});

// Real service steps must retain ecosystem cluster-instance compatibility.
// Run when step11 saved-record admission changes; unrelated changes may skip.
test('protected upgrade completes with two instances of an ecosystem service',t=>{
  const f=mixed(t);f.j.phase='new_data_ready';
  const scheduler=f.j.originalServices.find(service=>service.name==='scheduler');
  f.j.originalServices.push({...scheduler});
  f.records([...f.readRecords(),{name:'scheduler',pid:0,pm2_env:{status:'stopped',pm_exec_path:scheduler.script}}]);
  fs.writeFileSync(f.file,`module.exports={apps:[{name:'scheduler',script:${JSON.stringify(scheduler.script)},instances:2,exec_mode:'cluster'}]};`);
  f.save();
  const state={schemaVersion:2,preInstallProtection:true,zylosDir:f.root,ecosystemPath:f.file,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler','scheduler'],from:'1',to:'2',databaseMode:'unchanged'};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,true,JSON.stringify(result));assert.equal(result.serviceWarnings,undefined);
  assert.equal(f.load().phase,'upgrade_complete');
  const instances=f.readRecords().filter(record=>record.name==='scheduler');
  assert.equal(instances.length,2);assert.ok(instances.every(record=>record.pid>0&&record.pm2_env.status==='online'));
  assert.equal(f.commands().filter(args=>args[0]==='start'&&args.includes('scheduler')).length,2);
  assert.ok(f.commands().some(args=>args[0]==='save'));
});

// Actual resume exercises validateReady and the terminal-services-stopped path.
// Run for forward recovery ecosystem/start changes; unrelated changes may skip.
for(const phase of ['new_data_ready','new_verifying'])test(`forward recovery completes with a trusted ecosystem symlink from ${phase}`,t=>{
  const f=mixed(t);f.j.phase=phase;
  const target=path.join(f.root,'deployed-ecosystem.cjs');fs.renameSync(f.file,target);fs.symlinkSync(target,f.file);
  const core=path.join(f.root,'core');fs.mkdirSync(core);fs.writeFileSync(path.join(core,'current.js'),'// deployed core');
  const coreHash=f.maintenance.treeHash(core);f.save();
  const result=f.runner.resume(f.dir);
  assert.equal(result.stage,'upgrade_complete',JSON.stringify(result));assert.equal(result.recovery_required,false);
  assert.equal(result.attempted,false);assert.equal(result.completed,false,'forward completion is not rollback completion');
  const durable=f.load();assert.equal(durable.phase,'upgrade_complete');assert.equal(durable.terminalEvidence.verified,true);
  assert.equal(durable.cleanup.complete,true);assert.equal(f.maintenance.discover(f.root).marker,null);
  assert.equal(f.maintenance.treeHash(core),coreHash,'forward completion preserves deployed core');
  assert.ok(f.readRecords().every(record=>record.pid>0&&record.pm2_env.status==='online'));
  const starts=f.commands().filter(args=>args[0]==='startOrRestart').length;
  durable.terminalServicesStopped=true;f.maintenance.update(f.dir,durable);f.maintenance.marker(f.root,f.dir,durable);
  f.records(f.readRecords().map(record=>({...record,pid:0,pm2_env:{...record.pm2_env,status:'stopped'}})));
  const terminal=f.runner.resume(f.dir);
  assert.equal(terminal.stage,'upgrade_complete',JSON.stringify(terminal));assert.equal(terminal.recovery_required,false);
  assert.equal(terminal.completed,false);assert.equal(f.load().terminalServicesStopped,false);
  assert.ok(f.commands().filter(args=>args[0]==='startOrRestart').length>starts,'terminal resume restarts through the symlink');
  assert.ok(f.readRecords().every(record=>record.pid>0&&record.pm2_env.status==='online'));
  assert.equal(f.maintenance.discover(f.root).marker,null);assert.equal(f.maintenance.treeHash(core),coreHash);
});
