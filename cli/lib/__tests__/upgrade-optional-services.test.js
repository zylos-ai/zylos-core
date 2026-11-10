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
// unrelated upgrades may skip. Outer official runner must supply private HOME,
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
for(const mode of ['restart-error','stays-stopped','online'])test(`upgrade finalizer completes when external service is ${mode}`,t=>{
  const f=mixed(t);f.j.phase='new_data_ready';f.save();
  if(mode!=='online')fs.writeFileSync(path.join(f.root,mode==='restart-error'?'fail-restart':'stay-stopped'),'custom');
  const state={schemaVersion:2,preInstallProtection:true,zylosDir:f.root,ecosystemPath:f.file,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler'],from:'1',to:'2',databaseMode:'unchanged'};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,true,JSON.stringify(result));
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
for(const fails of [false,true])test(`originally missing ecosystem retains strict saved-record startup (${fails?'failure':'healthy'})`,t=>{
  const f=mixed(t);f.j.phase='new_data_ready';f.j.initialIdentity.ecosystemHash=null;f.save();
  if(fails)fs.writeFileSync(path.join(f.root,'fail-restart'),'custom');
  const state={schemaVersion:2,preInstallProtection:true,zylosDir:f.root,ecosystemPath:f.file,
    transactionId:'tx',transactionDir:f.dir,servicesWereRunning:['custom','scheduler'],from:'1',to:'2',databaseMode:'unchanged'};
  const statePath=path.join(f.root,'state.json');fs.writeFileSync(statePath,JSON.stringify(state));
  const child=spawnSync(process.execPath,['cli/lib/__tests__/helpers/optional-service-finalizer.js',statePath],{env:f.env,encoding:'utf8',timeout:20000});
  assert.equal(child.status,0,child.stderr);const result=JSON.parse(child.stdout);
  assert.equal(result.success,!fails);assert.equal(result.serviceWarnings,undefined);
  assert.ok(f.commands().some(args=>args[0]==='restart'&&args[1]==='scheduler'));
  assert.equal(f.commands().filter(args=>['start','startOrRestart'].includes(args[0])).length,0);
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
