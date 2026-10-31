import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import { inspectUpgradeSource, runUpgradeEntry, installUpgradeTarget } from '../upgrade-entry.js';
import {assertDashboardUninstalled} from '../core-db-backup.js';

function fixture(t, version = '0.9.3') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-target-entry-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const prefix=path.join(root,'prefix');
  const input = {schemaVersion:1, fromVersion:version, installedRoot:path.join(prefix, 'lib/node_modules/zylos'), tempDir:path.join(root, 'target'), zylosDir:path.join(root, 'deployment')};
  for (const [directory, packageVersion] of [[input.installedRoot, version], [input.tempDir, '1.0.0']]) {
    fs.mkdirSync(directory, {recursive:true});
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({type:'module', name:'zylos', version:packageVersion}));
  }
  fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
  fs.mkdirSync(input.zylosDir);
  return input;
}

test('target checks reject old sources and standalone Dashboard before touching database or transaction state', t => {
  const input = fixture(t, '0.9.2');
  const deps = {probe() {assert.fail('database inspection must not run');}};
  assert.throws(() => inspectUpgradeSource(input, deps), {code:'UPGRADE_SOURCE_TOO_OLD'});
  input.fromVersion = '0.9.3';
  fs.writeFileSync(path.join(input.installedRoot, 'package.json'), JSON.stringify({name:'zylos', version:'0.9.3'}));
  fs.mkdirSync(path.join(input.zylosDir, '.zylos'));
  fs.writeFileSync(path.join(input.zylosDir, '.zylos/components.json'), JSON.stringify({components:{dashboard:{version:'1'}}}));
  assert.throws(() => inspectUpgradeSource(input, deps), error => error.code === 'DASHBOARD_STILL_INSTALLED' && /zylos uninstall dashboard --yes/.test(error.next));
  assert.equal(fs.existsSync(path.join(input.zylosDir, '.backup')), false);
});

for (const invalid of ['linked-root','ordinary-bin','outside-bin']) test(`unsupported global layout rejects ${invalid} before probes or transaction writes`, t => {
  const input=fixture(t),prefix=path.dirname(path.dirname(path.dirname(input.installedRoot)));
  const metadata={type:'module',name:'zylos',version:'0.9.3',bin:{zylos:'cli/zylos.js'}};
  fs.mkdirSync(path.join(input.installedRoot,'cli'),{recursive:true});
  fs.writeFileSync(path.join(input.installedRoot,'cli/zylos.js'),'#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(input.installedRoot,'package.json'),JSON.stringify(metadata));
  const bin=path.join(prefix,'bin/zylos');
  if(invalid==='linked-root') {
    const checkout=path.join(path.dirname(prefix),'checkout');
    fs.renameSync(input.installedRoot,checkout);
    fs.symlinkSync(checkout,input.installedRoot,'dir');
  } else if(invalid==='ordinary-bin') fs.writeFileSync(bin,'shim\n');
  else fs.symlinkSync(path.join(input.zylosDir,'outside.js'),bin);
  assert.throws(()=>inspectUpgradeSource(input,{probe(){assert.fail('probe must not run');}}),{code:'UNSUPPORTED_INSTALL_LAYOUT'});
  assert.equal(fs.existsSync(path.join(input.zylosDir,'.backup')),false);
});

test('all upgrade entrypoints share flat and nested standalone Dashboard rejection',async t=>{
  const input=fixture(t),file=path.join(input.zylosDir,'.zylos/components.json');
  const {assertDashboardUninstalled:finalizerCheck}=await import('../self-upgrade.js');
  fs.mkdirSync(path.dirname(file));
  for(const registry of [{dashboard:{}},{components:{dashboard:{}}}]) {
    fs.writeFileSync(file,JSON.stringify(registry));
    for(const check of [assertDashboardUninstalled,finalizerCheck])assert.throws(()=>check(input.zylosDir),{code:'DASHBOARD_STILL_INSTALLED'});
  }
  for(const registry of [{},{components:{}}]) {
    fs.writeFileSync(file,JSON.stringify(registry));
    for(const check of [assertDashboardUninstalled,finalizerCheck])assert.doesNotThrow(()=>check(input.zylosDir));
  }
});

test('0.9.4 prechecks freeze package and database decisions before transaction creation', t => {
  const input = fixture(t,'0.9.4');
  const calls = [];
  const ctx = inspectUpgradeSource(input, {
    probe(root, target, options) {
      calls.push('probe');
      assert.equal(options.dashboardOwnerManaged,false);
      fs.mkdirSync(path.join(input.installedRoot,'skills/dashboard'),{recursive:true});
      return {databases:[{},{},{}],needsMigration:true};
    },
    preflight() {calls.push('preflight');},
    rehearse(root, target, options) {calls.push('rehearse'); assert.equal(options.driverRoot, path.join(input.zylosDir, '.claude/skills'));}
  });
  assert.deepEqual(calls, ['probe', 'preflight', 'rehearse']);
  assert.equal(ctx.snapshotFormatVersion, 2);
  assert.equal(ctx.firstTakeover,true);
  assert.equal(ctx.dashboardOwnerManaged,false);
  assert.equal(fs.existsSync(path.join(input.zylosDir, '.backup')), false);
  input.fromVersion = '1.0.0';
  assert.throws(() => inspectUpgradeSource(input), {code:'INVALID_UPGRADE_HANDOFF'});
});

for(const bundled of [false,true]) for(const version of [13,20]) test(`independent takeover: bundled=${bundled}, schema=${version}`,t=>{
  const input=fixture(t,'0.9.4'),installed=path.resolve('skills/comm-bridge');
  const Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');
  const driver=path.join(input.zylosDir,'.claude/skills/comm-bridge');
  fs.mkdirSync(driver,{recursive:true});fs.writeFileSync(path.join(driver,'package.json'),'{}');
  fs.symlinkSync(path.join(installed,'node_modules'),path.join(driver,'node_modules'));
  const database=path.join(input.zylosDir,'components/dashboard/dashboard.db');
  fs.mkdirSync(path.dirname(database),{recursive:true});
  const db=new Database(database);db.exec('CREATE TABLE schema_migrations(version INTEGER); PRAGMA user_version=99');
  db.prepare('INSERT INTO schema_migrations VALUES (?)').run(version);db.close();
  if(bundled)fs.mkdirSync(path.join(input.installedRoot,'skills/dashboard'),{recursive:true});
  const marker=path.join(input.zylosDir,'.claude/skills/dashboard/.zylos/core-managed.json');
  fs.mkdirSync(path.dirname(marker),{recursive:true});fs.writeFileSync(marker,'ignored old marker');
  const before=fs.readFileSync(database),seen=[];
  const check=options=>{assert.equal(options.dashboardOwnerManaged,version>=20);};
  const ctx=inspectUpgradeSource(input,{
    probe(root,target,options){check(options);seen.push('probe');return {databases:Array.from({length:version>=20?4:3},()=>({})),needsMigration:true};},
    preflight(root,options){check(options);seen.push('preflight');},
    rehearse(root,target,options){check(options);seen.push('rehearse');}
  });
  assert.deepEqual(seen,['probe','preflight','rehearse']);
  assert.equal(ctx.firstTakeover,!bundled);assert.equal(ctx.dashboardOwnerManaged,version>=20);
  assert.deepEqual(fs.readFileSync(database),before);
  assert.equal(fs.existsSync(path.join(input.zylosDir,'.backup')),false);
});

test('invalid installed Dashboard directory rejects independently of old marker',t=>{
  const input=fixture(t),directory=path.join(input.installedRoot,'skills/dashboard');
  fs.mkdirSync(path.dirname(directory));fs.symlinkSync('missing',directory);
  assert.throws(()=>inspectUpgradeSource(input),{code:'DASHBOARD_TAKEOVER_INVALID'});
});

for(const kind of ['file','symlink','dangling'])test(`target entry rejects ${kind} skill dependencies before probes or transaction writes`,t=>{
  const input=fixture(t),declared=path.join(input.tempDir,'skills/comm-bridge'),modules=path.join(input.zylosDir,'.claude/skills/comm-bridge/node_modules');
  fs.mkdirSync(declared,{recursive:true});fs.mkdirSync(path.dirname(modules),{recursive:true});
  if(kind==='file')fs.writeFileSync(modules,'invalid');
  else {const target=path.join(input.zylosDir,'dependency-target');if(kind==='symlink')fs.mkdirSync(target);fs.symlinkSync(target,modules);}
  assert.throws(()=>inspectUpgradeSource(input,{probe(){assert.fail('probe must not run');}}),{code:'INVALID_CORE_DEPENDENCIES'});
  assert.equal(fs.existsSync(path.join(input.zylosDir,'.backup')),false);
  assert.equal(fs.existsSync(path.join(input.zylosDir,'.zylos')),false);
});

function pipeline(input, failAt) {
  const calls = [];
  const ctx = {coreDir:input.installedRoot, tempDir:input.tempDir, zylosDir:input.zylosDir, skillsDir:path.join(input.zylosDir, '.claude/skills')};
  const step = name => () => {calls.push(name); if (name === failAt) throw Error(name);};
  const deps = {maintenance:{discover:() => ({candidates:[], diagnostics:[], marker:null})},
    inspect:() => ctx, resolveNpm:() => '/fixture/npm-cli.js',
    begin(context) {calls.push('begin'); context.transactionDir = '/fixture/transaction'; context.upgradeProtected = true;},
    savePackage:step('savePackage'), saveCode:step('saveCode'), prepare:step('prepare'), install:step('install'),
    finalize:() => {calls.push('finalize'); return {success:true};},
    recover:() => {calls.push('recover'); return {attempted:true, completed:true};}};
  ctx.releaseControl = step('release');
  return {calls, deps};
}

test('protected entry saves original package before code, stops, snapshot and installation', async t => {
  const input = fixture(t), f = pipeline(input);
  const result = await runUpgradeEntry(input, f.deps);
  assert.equal(result.success, true);
  assert.deepEqual(f.calls, ['begin', 'savePackage', 'saveCode', 'prepare', 'install', 'finalize', 'release']);
});

test('rejected prechecks never create a transaction or request compensation', async t => {
  const input = fixture(t), f = pipeline(input);
  f.deps.inspect = () => { throw Object.assign(Error('precheck rejected'), {code:'PRECHECK_REJECTED'}); };
  const result = await runUpgradeEntry(input, f.deps);
  assert.equal(result.success, false);
  assert.deepEqual(f.calls, []);
});

for (const failure of ['savePackage', 'saveCode', 'prepare', 'install']) test(`entry compensates ${failure} failure and never finalizes`, async t => {
  const input = fixture(t), f = pipeline(input, failure);
  const result = await runUpgradeEntry(input, f.deps);
  assert.equal(result.success, false);
  assert.equal(result.rollback.completed, true);
  assert.equal(f.calls.includes('finalize'), false);
  assert.equal(f.calls.at(-1), 'recover');
});

test('entry refuses ambiguous prior transactions without inspecting, installing, or recovering them', async t => {
  const input = fixture(t), f = pipeline(input);
  f.deps.maintenance.discover = () => ({candidates:[], diagnostics:['untrusted'], marker:null});
  f.deps.inspect = () => assert.fail('prechecks must not run');
  const result = await runUpgradeEntry(input, f.deps);
  assert.equal(result.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.match(result.next,/zylos recovery status.*zylos recovery resume/);
  assert.equal(result.recovery_required,true);
  assert.deepEqual(result.persisted,[]);
  assert.deepEqual(f.calls, []);
});

test('entry directs a closed transaction to forward finalization without changing other recovery handling', async t => {
  const input=fixture(t),f=pipeline(input);
  f.deps.maintenance.discover=()=>({candidates:[{journal:{phase:'recovery_required'}}],diagnostics:[],marker:null});
  f.deps.maintenance.classifyCutoff=()=> 'closed';
  f.deps.inspect=()=>assert.fail('closed transaction must block prechecks');
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,'UPGRADE_RECOVERY_REQUIRED');
  assert.match(result.next,/zylos upgrade --resume-finalize/);
  assert.doesNotMatch(result.next,/zylos recovery resume/);
  assert.equal(result.recovery_required,true);
  assert.deepEqual(f.calls,[]);
});

test('entry keeps manual recovery guidance when process identity cannot be verified', async t => {
  const input=fixture(t),f=pipeline(input);
  f.deps.maintenance.discover=()=>({candidates:[{journal:{phase:'recovery_required'}}],diagnostics:[],marker:null});
  f.deps.maintenance.classifyCutoff=()=> 'closed';
  f.deps.maintenance.canRecognizeProcesses=()=> false;
  f.deps.inspect=()=>assert.fail('closed transaction must block prechecks');
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,'UPGRADE_RECOVERY_REQUIRED');
  assert.match(result.next,/zylos recovery status.*zylos recovery resume/);
  assert.doesNotMatch(result.next,/zylos upgrade --resume-finalize/);
  assert.deepEqual(f.calls,[]);
});

test('target rejects missing deployment before recovery discovery', async t => {
  const input=fixture(t);
  input.zylosDir=path.join(input.zylosDir,'missing');
  const result=await runUpgradeEntry(input,{maintenance:{discover(){assert.fail('missing deployment was discovered');}}});
  assert.equal(result.code,'ZYLOS_NOT_INITIALIZED');
  assert.match(result.error,/Initialize this deployment/);
  assert.deepEqual(result.persisted,[]);
  assert.equal(result.recovery_required,false);
  assert.equal(result.rollback.attempted,false);
});

test('downloaded executable keeps malformed JSON classified as invalid handoff', () => {
  const child=spawnSync(process.execPath,[path.resolve('cli/lib/upgrade-entry.js')],{input:'{',encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.code,'INVALID_UPGRADE_HANDOFF');
  assert.deepEqual(result.persisted,[]);
});

test('downloaded executable redacts paths from its main-block failure', t => {
  const privatePath=path.join(fixture(t).zylosDir,'private-handoff.json');
  const child=spawnSync(process.execPath,[path.resolve('cli/lib/upgrade-entry.js')],{input:privatePath,encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.code,'INVALID_UPGRADE_HANDOFF');
  assert.deepEqual(result.persisted,[]);
  assert.doesNotMatch(result.error,new RegExp(privatePath.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(result.error,/<path>/);
  assert.doesNotMatch(result.error,/\n| at /);
});

test('downloaded executable reports a missing target package without its path', t => {
  const input=fixture(t);
  input.tempDir=path.join(path.dirname(input.tempDir),'missing-target');
  const child=spawnSync(process.execPath,[path.resolve('cli/lib/upgrade-entry.js')],{input:JSON.stringify(input),encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.code,'UPGRADE_FAILED');
  assert.deepEqual(result.persisted,[]);
  assert.match(result.error,/Downloaded target package is unavailable/);
  assert.doesNotMatch(result.error,new RegExp(input.tempDir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(result.error,/\n| at /);
});

const registeredProtocolCodes = [
  'ZYLOS_NOT_INITIALIZED', 'INVALID_ARGS', 'UPGRADE_RECOVERY_REQUIRED',
  'DASHBOARD_STILL_INSTALLED', 'INVALID_CORE_DEPENDENCIES', 'UNSUPPORTED_INSTALL_LAYOUT', 'DASHBOARD_TAKEOVER_INVALID',
  'RUNTIME_PREPARATION_INCOMPLETE', 'UPGRADE_FAILED', 'SCHEMA_TOO_NEW', 'SCHEMA_MIGRATION_FAILED',
  'SETTINGS_UNREADABLE', 'UPGRADE_SOURCE_TOO_OLD', 'INVALID_UPGRADE_HANDOFF', 'MANUAL_RECOVERY_REQUIRED',
  'SNAPSHOT_FAILED', 'NOT_RESUMABLE', 'CUTOFF_UNTRUSTED', 'CUTOFF_WRITE_UNCERTAIN', 'FINALIZE_INCOMPLETE',
  'CONFIG_LOCK_TIMEOUT', 'CONFIG_UNREADABLE', 'CONFIG_WRITE_FAILED', 'CONFIG_KEY_RESERVED',
  'LOCK_TIMEOUT', 'DB_BUSY',
  'material_corrupt', 'runtime_config_conflict', 'codex_config_unparseable', 'codex_config_reconcile_failed',
];

for(const code of registeredProtocolCodes) test(`entry preserves registered protocol code: ${code}`,async t=>{
  const input=fixture(t),f=pipeline(input);
  f.deps.inspect=()=>{throw Object.assign(Error('precheck failed'),{code});};
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,code);
  assert.deepEqual(result.persisted,[]);
  assert.deepEqual(f.calls,[]);
});

for(const code of [undefined,'',7]) test(`entry normalizes missing failure code: ${code}`,async t=>{
  const input=fixture(t),f=pipeline(input);
  f.deps.inspect=()=>{throw Object.assign(Error('precheck failed'),{code});};
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,'UPGRADE_FAILED');
  assert.deepEqual(result.persisted,[]);
  assert.deepEqual(f.calls,[]);
});

for(const code of ['',7]) test(`returned finalizer failure normalizes non-string code: ${JSON.stringify(code)}`,async t=>{
  const input=fixture(t),f=pipeline(input);
  f.deps.finalize=()=>({success:false,code,error:'forward repair failed',failedStep:4,steps:[]});
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,'UPGRADE_FAILED');
  assert.equal(result.failedStep,4);
  assert.equal(result.rollback.completed,true);
});

test('target entry catch redacts absolute failure paths',async t=>{
  const input=fixture(t),f=pipeline(input);
  f.deps.inspect=()=>{throw Object.assign(Error(`Cannot read '${path.join(input.tempDir,'private.json')}'\nRequire stack: ${path.join(input.installedRoot,'source.js')}`),{code:'EACCES'});};
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,'EACCES');
  assert.deepEqual(result.persisted,[]);
  assert.doesNotMatch(result.error,new RegExp(path.dirname(input.tempDir).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(result.error,/Require stack/);
});

for (const code of ['EACCES','MODULE_NOT_FOUND','ERR_INVALID_ARG_TYPE','SQLITE_BUSY','SCHEMA_TOO_NEW']) test(`returned finalizer failure preserves non-empty code: ${code}`, async t => {
  const input=fixture(t), f=pipeline(input);
  f.deps.finalize=()=>({success:false,code,error:"Finalizer cannot read '/fixture/private/components.json'\nRequire stack: /fixture/source.js",failedStep:4,steps:[]});
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,code);
  assert.equal(result.failedStep,4);
  assert.equal(result.rollback.completed,true);
  assert.equal(result.error,"Finalizer cannot read '<path>'");
  assert.deepEqual(f.calls,['begin','savePackage','saveCode','prepare','install','recover']);
});

for (const error of ['', undefined]) test(`returned finalizer failure uses a readable default for ${error === '' ? 'empty' : 'missing'} error text`, async t => {
  const input=fixture(t), f=pipeline(input);
  f.deps.finalize=()=>({success:false,code:'EACCES',error,failedStep:4,steps:[]});
  const result=await runUpgradeEntry(input,f.deps);
  assert.equal(result.code,'EACCES');
  assert.equal(result.error,'Upgrade finalization failed.');
  assert.equal(result.rollback.completed,true);
  assert.equal(result.rollback.performed,true);
  assert.deepEqual(f.calls,['begin','savePackage','saveCode','prepare','install','recover']);
});

test('target packing precedes installation intent and rejects unsafe npm archive filenames', t => {
  const input = fixture(t);
  const ctx = {...input, maintenance:{}, protectedNpmCli:'/fixture/npm-cli.js'};
  const calls = [];
  const deps = {runInstaller(context, options) {calls.push(options.stage); return JSON.stringify([{filename:'target.tgz'}]);}, markInstallationIntent() {calls.push('intent');}};
  installUpgradeTarget(ctx, deps);
  assert.deepEqual(calls, ['pack-target', 'intent', 'install']);
  calls.length = 0;
  deps.runInstaller = () => JSON.stringify([{filename:'../escape.tgz'}]);
  assert.throws(() => installUpgradeTarget(ctx, deps), /Invalid target npm pack/);
  assert.deepEqual(calls, []);
});

test('downloaded executable rejects unsupported source without target node_modules', t => {
  const input = fixture(t, '0.9.2');
  const source = path.resolve('.');
  for (const relative of ['cli/lib', 'skills/comm-bridge/scripts']) {
    fs.cpSync(path.join(source, relative), path.join(input.tempDir, relative), {recursive:true,
      filter:file => !file.split(path.sep).includes('__tests__') && !file.split(path.sep).includes('node_modules')});
  }
  assert.equal(fs.existsSync(path.join(input.tempDir, 'node_modules')), false);
  const child = spawnSync(process.execPath, [path.join(input.tempDir, 'cli/lib/upgrade-entry.js')], {input:JSON.stringify(input), encoding:'utf8', timeout:10000});
  assert.equal(child.status, 1, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.code, 'UPGRADE_SOURCE_TOO_OLD');
  assert.equal(fs.existsSync(path.join(input.zylosDir, '.backup')), false);
});

test('downloaded precheck uses real installed SQLite without target dependencies', async t => {
  const input=fixture(t);
  const installed=process.env.CORE_DB_TEST_SKILL || path.resolve('skills/comm-bridge');
  const Database=createRequire(path.join(installed,'package.json'))('better-sqlite3');
  const source=path.resolve('.');
  const filter=file=>!file.split(path.sep).includes('__tests__') && !file.split(path.sep).includes('node_modules');
  fs.cpSync(path.join(source,'cli/lib'),path.join(input.tempDir,'cli/lib'),{recursive:true,filter});
  for (const name of ['comm-bridge','scheduler','web-console']) {
    const origin=path.join(source,'skills',name);
    fs.cpSync(origin,path.join(input.tempDir,'skills',name),{recursive:true,filter});
    fs.cpSync(origin,path.join(input.zylosDir,'.claude/skills',name),{recursive:true,filter});
  }
  const modules=path.join(input.zylosDir,'.claude/skills/comm-bridge/node_modules');
  fs.mkdirSync(modules);
  for(const name of fs.readdirSync(path.join(installed,'node_modules')))fs.symlinkSync(path.join(installed,'node_modules',name),path.join(modules,name));
  const file=path.join(input.zylosDir,'comm-bridge/c4.db');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const db=new Database(file);
  const {migrateDatabase}=await import('../../../skills/comm-bridge/scripts/sqlite-schema.js');
  const owner=await import('../../../skills/comm-bridge/scripts/c4-schema.js');
  migrateDatabase(db,owner,{allowNew:true,strict:false});
  db.exec('CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES (\'source\')');
  db.close();
  const before=fs.readFileSync(file);
  const script='const {inspectUpgradeSource}=await import(process.argv[1]);const ctx=inspectUpgradeSource(JSON.parse(process.argv[2]));console.log(JSON.stringify({from:ctx.from,needsMigration:ctx.databaseVersions.needsMigration,firstTakeover:ctx.firstTakeover}));';
  const child=spawnSync(process.execPath,['--input-type=module','-e',script,pathToFileURL(path.join(input.tempDir,'cli/lib/upgrade-entry.js')).href,JSON.stringify(input)],{encoding:'utf8',timeout:30000});
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{from:'0.9.3',needsMigration:true,firstTakeover:true});
  assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(fs.existsSync(path.join(input.tempDir,'node_modules')),false);
  assert.equal(fs.existsSync(path.join(input.tempDir,'skills/comm-bridge/node_modules')),false);
  assert.equal(fs.existsSync(path.join(input.zylosDir,'.backup')),false);
});
