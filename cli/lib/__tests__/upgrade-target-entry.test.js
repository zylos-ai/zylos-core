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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-target-entry-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const input = {schemaVersion:1, fromVersion:version, installedRoot:path.join(root, 'installed'), tempDir:path.join(root, 'target'), zylosDir:path.join(root, 'deployment')};
  for (const [directory, packageVersion] of [[input.installedRoot, version], [input.tempDir, '1.0.0']]) {
    fs.mkdirSync(directory, {recursive:true});
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({type:'module', name:'zylos', version:packageVersion}));
  }
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

for(const kind of ['file','symlink','dangling'])test(`T09 rejects ${kind} skill dependencies before probes or transaction writes`,t=>{
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
  assert.deepEqual(f.calls, []);
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
