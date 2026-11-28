// covers: cli/lib/self-upgrade.js cli/lib/upgrade-entry.js cli/lib/upgrade-protection.js cli/lib/core-db-backup.js cli/lib/upgrade-runtime-preparation.js cli/lib/upgrade-post-cutoff.js cli/lib/upgrade-cutoff.js cli/lib/upgrade-resume.js skills/comm-bridge/scripts/sqlite-schema.js skills/comm-bridge/scripts/c4-schema.js skills/scheduler/scripts/schema.js cli/lib/upgrade-maintenance.cjs cli/lib/core-db-backup-worker.js cli/lib/__tests__/fixtures/legacy-web-console-schema.js cli/lib/__tests__/helpers/legacy-web-console.js skills/comm-bridge/scripts/__tests__/fixtures/migration-history/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { runSelfUpgradeFinalize, resumeUpgradeFinalization } from '../self-upgrade.js';
import { LEGACY_CORE_DATABASES, createCoreDbSnapshot, prepareRecoveryDependencies, runCoreDbWorker } from '../core-db-backup.js';
import { installUpgradeTarget } from '../upgrade-entry.js';
import { prepareProtectedInstall } from '../upgrade-protection.js';
import { prepareUpgradeRuntime } from '../upgrade-runtime-preparation.js';
import { resumeFinalize } from '../upgrade-resume.js';
import { migrateDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import * as schedulerSchema from '../../../skills/scheduler/scripts/schema.js';
import * as webSchema from './fixtures/legacy-web-console-schema.js';
import {installLegacyWebConsoleSchema} from './helpers/legacy-web-console.js';


const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '../../..');
const Database = require(path.join(packageRoot, 'skills/comm-bridge/node_modules/better-sqlite3'));

function fixture(t, { protectedUpgrade = true, temporaryBase = os.tmpdir(), firstTakeover = true, databaseMode = 'migrate', from = '0.9.3', to = '0.9.4', olderDatabases = false, prepareAtEntry = false } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(temporaryBase, 'default-finalizer-')));
  const previousHome = process.env.HOME, previousPm2Home = process.env.PM2_HOME, previousPath = process.env.PATH;
  process.env.HOME = home;
  process.env.PM2_HOME = path.join(home, '.pm2');
  const bin = path.join(home, 'bin'), pm2Calls = path.join(home, 'pm2-calls');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'pm2'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(pm2Calls)}, JSON.stringify(process.argv.slice(2))+'\\n');process.stderr.write('unexpected fixture PM2 invocation');process.exit(91);\n`, {mode:0o700});
  process.env.PATH = bin + path.delimiter + previousPath;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousPm2Home === undefined) delete process.env.PM2_HOME; else process.env.PM2_HOME = previousPm2Home;
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  });
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'zylos');
  const write = (relative, bytes) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  };
  write('ZYLOS.md', 'private user instructions\r\n');
  write('CLAUDE.md', 'old Claude output');
  write('AGENTS.md', 'old Codex output');
  write('.zylos/instructions/meta.json', '{"schemaVersion":1,"activatedAt":"old"}\n');
  write('.claude/settings.json', '{"permissions":{"allow":["Read"]},"hooks":{}}\n');
  write('.zylos/config.json', '{"runtime":"claude"}\n');
  write('memory/state.md', 'preserve working state\n');
  const skillsDir = path.join(root, '.claude/skills');
  if (!firstTakeover) {
    write('.claude/skills/dashboard/package.json', '{"type":"module"}\n');
    write('.claude/skills/dashboard/src/lib/schema-owner.js', `export const dashboardSchemaOwner = {
      inspectSchema() { return {currentVersion:0,targetVersion:0,needsMigration:false}; },
      migrate() { throw Error('missing Dashboard must not be created before cutoff'); }
    };\n`);
  }
  for (const owner of LEGACY_CORE_DATABASES.map(item => item.owner)) {
    if(owner==='web-console'){installLegacyWebConsoleSchema(skillsDir);fs.mkdirSync(path.join(skillsDir,owner,'node_modules'));continue;}
    const source = path.join(packageRoot, 'skills', owner), target = path.join(skillsDir, owner);
    fs.mkdirSync(target, { recursive: true });
    fs.cpSync(path.join(source, 'scripts'), path.join(target, 'scripts'), {
      recursive: true, filter: file => !file.split(path.sep).includes('__tests__'),
    });
    fs.copyFileSync(path.join(source, 'package.json'), path.join(target, 'package.json'));
    if (fs.existsSync(path.join(source, 'init-db.sql'))) {
      fs.copyFileSync(path.join(source, 'init-db.sql'), path.join(target, 'init-db.sql'));
    }
    fs.mkdirSync(path.join(target, 'node_modules'));
    if(fs.existsSync(path.join(source,'node_modules')))for(const name of fs.readdirSync(path.join(source,'node_modules')))fs.symlinkSync(path.join(source,'node_modules',name),path.join(target,'node_modules',name));
  }
  // Exercise the real owner migration engine to create valid databases before
  // snapshotting; later assertions inspect real native SQLite state.
  for (const [index,item] of LEGACY_CORE_DATABASES.entries()) {
    const file=path.join(root,item.source);
    fs.mkdirSync(path.dirname(file),{recursive:true});
    const db=new Database(file);
    // Older C4/scheduler layouts come from the released v1 samples.
    const older=olderDatabases && ['c4-v0.9.0-v1.sql','scheduler-v0.9.0-v1.sql'][index];
    try {
      if(older)db.exec(fs.readFileSync(path.join(packageRoot,'skills/comm-bridge/scripts/__tests__/fixtures/migration-history',older),'utf8'));
      else migrateDatabase(db,[c4Schema,schedulerSchema,webSchema][index],{allowNew:true,strict:false});
    }
    finally {db.close();}
  }
  const database = new Database(path.join(root, 'comm-bridge/c4.db'));
  database.prepare('INSERT INTO checkpoints(id, summary) VALUES (?, ?)').run(17, 'keep current data');
  database.close();
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'cli/lib/upgrade-maintenance.cjs'), path.join(stable, 'maintenance.cjs'));fs.copyFileSync(path.resolve('skills/comm-bridge/scripts/remove-owned-tree.js'),path.join(path.dirname(path.join(stable, 'maintenance.cjs')),'remove-owned-tree.mjs'));
  const m = require(path.join(stable, 'maintenance.cjs'));
  const calls = [];
  m.stop = () => calls.push('stop');
  m.runInstaller = () => { calls.push('npm'); return ''; };
  const tempDir = path.join(home, 'download');
  fs.mkdirSync(path.join(tempDir, 'skills/dashboard'), {recursive:true});
  const state = { schemaVersion: 1, from, to, tempDir, zylosDir:root, firstTakeover, dashboardOwnerManaged:false };
  let dir, journal;
  if (protectedUpgrade) {
    dir = path.join(root, '.backup/self-upgrade/tx');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const snapshot = prepareAtEntry ? null : createCoreDbSnapshot({ zylosDir: root, transactionId: 'tx', formatVersion: 3 });
    const closure = prepareAtEntry ? null : prepareRecoveryDependencies(dir, root, { dashboardRoot: path.join(home, 'uninstalled-dashboard') });
    for (const [source, target] of [['../../skills/comm-bridge/scripts/remove-owned-tree.js','remove-owned-tree.mjs'],['upgrade-maintenance.cjs','maintenance.cjs'],
      ['upgrade-recovery.cjs', 'runner.cjs'], ['upgrade-installer.cjs', 'installer.cjs']]) {
      fs.copyFileSync(path.join(packageRoot, 'cli/lib', source), path.join(dir, target));
      fs.chmodSync(path.join(dir, target), 0o600);
    }
    if (closure) m.durable(path.join(dir, 'descriptor.json'), { formatVersion: 1, transactionId: 'tx', ...closure,
      runnerPath: path.join(dir, 'runner.cjs'), hashes: Object.fromEntries(
        ['maintenance.cjs', 'runner.cjs', 'installer.cjs','remove-owned-tree.mjs'].map(name => [name, m.hash(path.join(dir, name))])) });
    const packageJson = path.join(home, 'old-package.json'), cliRoot = path.join(home, 'old-cli');
    const workerPath = closure?.workerPath ?? path.join(packageRoot,'cli/lib/core-db-backup-worker.js');
    fs.writeFileSync(packageJson, '{}'); fs.mkdirSync(cliRoot);
    journal = { formatVersion: 1, transactionId: 'tx', zylosDir: root, skillsDir,
      nodePath: process.execPath, phase: prepareAtEntry ? 'code_saved' : 'installing', installationIntent: !prepareAtEntry,
      databaseMode, firstTakeover, dashboardOwnerManaged:false,
      ...(snapshot && {dbBackupDir:snapshot.dbBackupDir,snapshotManifestHash:m.hash(path.join(snapshot.dbBackupDir,'manifest.json'))}),
      from, to, originalServices: [],
      coreManifest: LEGACY_CORE_DATABASES.map(item => ({ name: item.owner, existedBefore: true,
        backedUp: true, originalHash: m.treeHash(path.join(skillsDir, item.owner)),
        dependencies:{kind:'directory',sha256:m.treeHash(path.join(skillsDir,item.owner,'node_modules'))} })),
      initialIdentity: { nodePath: process.execPath, packageJson, packageHash: m.hash(packageJson),
        cliRoot, cliHash: m.treeHash(cliRoot), workerPath,
        workerHash: m.hash(workerPath), ecosystemHash: null,
        databases: m.databasePaths(2).map(source => ({source,exists:fs.existsSync(path.join(root,source))})) } };
    m.update(dir, journal); m.marker(root, dir, journal);
    Object.assign(state, { transactionId: 'tx', transactionDir: dir });
  }
  const dashboardOwner = {
    copyDashboardDb: () => { calls.push('dashboard-copy'); return { ok: true }; },
    applyDashboardRegistration: () => { calls.push('registration'); return { state: 'done' }; },
    applyDashboardRoute: () => { calls.push('route'); return { state: 'done' }; },
    verifyDashboard: () => { calls.push('dashboard-verify'); return { state: 'ready', errors: [] }; },
  };
  const deps = {
    zylosDir: root, maintenance: m, dashboardOwner,
    finalizeWebConsoleRemoval:async()=>({warnings:[]}),savePm2ProcessList:()=>true,
    ensureLogRotation:()=>({state:'present'}),
    // The package is already deployed into this private fixture. Do not run
    // the host-oriented skill copier or invoke npm against the real host.
    syncSkills: () => ({ step: 5, name: 'sync_core_skills', status: 'done' }),
    step6: { skillsDir },
    prepareRuntimeClis: () => ({ completed: ['claude.cli', 'codex.cli'], failed: [] }),
    prepareRuntime: ctx => prepareUpgradeRuntime(ctx, { packageRoot, homeDir: home, stopFailureSupported: false }),
    ensureMemoryMigration: () => { calls.push('ensure-memory'); return {}; },
    startServices: () => { calls.push('start'); return { status: 'done' }; },
    verifyServices: () => { calls.push('verify'); return { status: 'done' }; },
    restart: () => { calls.push('restart'); return { ok: true, data: { result: 'accepted' } }; },
  };
  const load = () => m.transaction(root, dir);
  const resume = (overrides = {}) => resumeUpgradeFinalization({ zylosDir: root, transactionDir: dir,
    transactionId: 'tx', journal: load(), maintenance: m }, { ...deps, ...overrides });
  return { root, home, dir, state, deps, calls, m, write, load, resume, pm2Calls,
    read: relative => fs.readFileSync(path.join(root, relative), 'utf8'),
    run: overrides => runSelfUpgradeFinalize(state, { ...deps, ...overrides }) };
}

// Resume fault tests need a real pending migration even if the preparatory run
// already completed configuration finalization. All files belong to the fixture.
function pendingThresholdMigration(f) {
  const config = JSON.parse(f.read('.zylos/config.json'));
  config.new_session_threshold = 70;
  delete config.model_rotation_thresholds;
  const settings = JSON.parse(f.read('.claude/settings.json'));
  settings.model = 'opus[1m]';
  f.write('.claude/settings.json', JSON.stringify(settings, null, 2) + '\n');
  f.write('.zylos/config.json', JSON.stringify(config, null, 2) + '\n');
  return JSON.stringify({ ...config, model_rotation_thresholds: { claude: { 'opus[1m]': 70 } } }, null, 2) + '\n';
}

function assertDataPreserved(f, stateMigrated = true) {
  const db = new Database(path.join(f.root, 'comm-bridge/c4.db'), { readonly: true });
  try { assert.equal(db.prepare('SELECT summary FROM checkpoints WHERE id=17').get().summary, 'keep current data'); }
  finally { db.close(); }
  assert.equal(f.read('ZYLOS.md'), 'private user instructions\r\n');
  const state = 'preserve working state\n';
  if (stateMigrated) {
    assert.equal(f.read('memory/archive/state/origin/state.md'), state);
    assert.ok(f.read('memory/handoff.md').endsWith(state));
    assert.equal(fs.existsSync(path.join(f.root, 'memory/state.md')), false);
  } else {
    assert.equal(f.read('memory/state.md'), state);
  }
}

test('default finalizer fixture PM2 shim cannot launch a daemon', t => {
  const f = fixture(t);
  const out = spawnSync('pm2', ['jlist'], {encoding:'utf8'});
  assert.equal(out.status, 91);
  assert.match(out.stderr, /unexpected fixture PM2 invocation/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.pm2Calls, 'utf8').trim()), ['jlist']);
  assert.equal(fs.existsSync(path.join(f.home, '.pm2')), false);
});

test('default protected initial finalizer publishes real preparation, closes journal and runs tail', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.dbSnapshotVerified, true);
  assert.equal(result.databaseMode, 'migrate');
  assert.equal(f.load().phase, 'upgrade_complete');
  assert.equal(f.load().postCutoff.items.hooks.state, 'done');
  assert.equal(f.load().dashboardInstall.items.registration.state, 'done');
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/upgrade/active.json')), false);
  assert.match(f.read('CLAUDE.md'), /private user instructions/);
  assert.match(f.read('AGENTS.md'), /private user instructions/);
  assert.ok(JSON.parse(f.read('.claude/settings.json')).hooks.SessionStart);
  assert.equal(Object.hasOwn(JSON.parse(f.read('.zylos/config.json')), 'model_rotation_thresholds'), false, 'defaults remain implicit without a legacy user value');
  assert.equal(result.settingsChanged, true);
  assert.equal(Object.hasOwn(result, 'instructionFilesRebuilt'), false);
  assert.equal(result.completion.modeTransition, 'pending_auto');
  assert.ok(f.calls.indexOf('start') > f.calls.indexOf('ensure-memory'));
  assert.equal(f.calls.includes('restart'), true);
  assert.equal(result.completion.sessionRestart, 'accepted');
  assertDataPreserved(f);
});

// Isolated protected upgrade through preparation, installation boundary and
// finalization. Local SQLite files, fixture services/npm, no tmux or registry.
// Run for changes to step timing or snapshot retirement; skip unrelated changes.
test('protected upgrade journals database steps and retires old snapshots after service verification', async t => {
  const f = fixture(t, {prepareAtEntry:true});
  const old = createCoreDbSnapshot({zylosDir:f.root,transactionId:'old'});
  const damaged = createCoreDbSnapshot({zylosDir:f.root,transactionId:'damaged'});
  const journal = f.m.read(path.join(f.dir,'journal.json'));
  let time=0;
  const now = () => time += 10;
  const ctx = {...f.state,journal,maintenance:f.m,now};
  const c4 = 'comm-bridge/c4.db';
  const backupFile = snapshot => path.join(snapshot.dbBackupDir,snapshot.manifest.databases.find(row=>row.source===c4).file);
  prepareProtectedInstall(ctx, {
    rehearse(root,_target,{reportTimings}) {
      assert.equal(reportTimings,true);
      assert.equal(f.calls.at(-1),'stop');
      return {databaseTimings:[c4,'scheduler/scheduler.db'].map(source=>({source,bytes:fs.statSync(path.join(root,source)).size,durationMs:7}))};
    }
  });
  installUpgradeTarget(ctx, {
    runInstaller(_ctx,{stage}) {
      assert.equal(fs.existsSync(backupFile(old)),true);
      if(stage==='pack-target') return JSON.stringify([{filename:'target.tgz'}]);
    }
  });
  const result = await f.run({now,verifyServices() {
    assert.ok(f.calls.includes('start'));
    assert.equal(fs.existsSync(backupFile(old)),true);
    assert.equal(fs.existsSync(backupFile(damaged)),true);
    // Damage a same-size file only after the services have started. An earlier
    // verification would have accepted it and made it eligible for deletion.
    const file=backupFile(damaged);
    const fd=fs.openSync(file,'r+');
    try { fs.writeSync(fd,Buffer.from([0]),0,1,0); }
    finally { fs.closeSync(fd); }
    return {status:'done'};
  }});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(fs.existsSync(old.dbBackupDir),false);
  assert.equal(fs.existsSync(backupFile(damaged)),true);
  assert.ok(result.warnings.some(warning=>/Retained .*damaged.*hash mismatch/.test(warning)));
  const saved=f.load();
  assert.deepEqual(saved.runtimeWarnings,result.warnings);
  const timings = saved.stepTimings;
  const ordered = ['rehearsal','backup','verify_new_backup','original_database_check','installation','migration','post_migration_check','verify_old_backups'];
  for(const [index,name] of ordered.entries()) {
    const timing=timings[name];
    assert.equal(Date.parse(timing.startedAt),(2*index+1)*10,name);
    assert.equal(Date.parse(timing.finishedAt),(2*index+2)*10,name);
    if(name==='installation') continue;
    assert.ok(timing.databases.length>0,name);
    for(const database of timing.databases) {
      assert.equal(typeof database.source,'string',name);
      assert.ok(Number.isInteger(database.bytes) && database.bytes>=0,name);
      assert.ok(Number.isFinite(database.durationMs) && database.durationMs>=0,name);
    }
  }
  assert.deepEqual(timings.rehearsal.databases.map(({source,durationMs})=>[source,durationMs]),[[c4,7],['scheduler/scheduler.db',7]]);
  assert.equal(timings.verify_new_backup.databases.find(row=>row.source===c4).bytes,fs.statSync(backupFile(damaged)).size);
  assert.ok(timings.verify_old_backups.databases.some(row=>row.snapshotId==='damaged' && row.source===c4));
});

// Same-version upgrade: the installed package is its own target and the only
// work is migrating older databases. Real snapshot, worker migration and readback.
test('same-version protected finalizer migrates older C4 and scheduler databases from a verified snapshot', async t => {
  const f = fixture(t, { from: '1.0.0', to: '1.0.0', olderDatabases: true, firstTakeover: false });
  const userVersion = file => { const db = new Database(file, { readonly: true }); try { return db.pragma('user_version', { simple: true }); } finally { db.close(); } };
  for (const source of ['comm-bridge/c4.db', 'scheduler/scheduler.db']) assert.equal(userVersion(path.join(f.root, source)), 1);
  const result = await f.run();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.databaseMode, 'migrate');
  assert.equal(result.dbSnapshotVerified, true);
  const journal = f.load();
  assert.equal(journal.phase, 'upgrade_complete');
  assert.equal(journal.from, '1.0.0'); assert.equal(journal.to, '1.0.0');
  // The snapshot keeps the original versions; the live databases read back current.
  const manifest = JSON.parse(fs.readFileSync(path.join(journal.dbBackupDir, 'manifest.json'), 'utf8'));
  const snapshotVersion = source => manifest.databases.find(item => item.source === source).userVersion;
  assert.equal(snapshotVersion('comm-bridge/c4.db'), 1);
  assert.equal(snapshotVersion('scheduler/scheduler.db'), 1);
  for (const item of manifest.databases.filter(item => item.file)) assert.equal(userVersion(path.join(journal.dbBackupDir, item.file)), item.userVersion);
  assert.equal(userVersion(path.join(f.root, 'comm-bridge/c4.db')), c4Schema.SUPPORTED_SCHEMA_VERSION);
  assert.equal(userVersion(path.join(f.root, 'scheduler/scheduler.db')), schedulerSchema.SUPPORTED_SCHEMA_VERSION);
  assertDataPreserved(f);
  assert.ok(f.calls.includes('start'));
});

// PM2 stand-in for one fixture: keeps process state in a private file and
// answers only the commands the finalizer issues. It never starts a daemon.
function statefulPm2(f, processes, { comesOnline = true } = {}) {
  const stateFile = path.join(f.home, 'pm2-state.json');
  fs.writeFileSync(stateFile, JSON.stringify(processes));
  fs.writeFileSync(path.join(f.home, 'bin/pm2'), `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(f.pm2Calls)},JSON.stringify(args)+'\\n');
const state=JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)},'utf8'));
if(args[0]==='jlist'){process.stdout.write(JSON.stringify(state.map(p=>({name:p.name,pid:p.pid,pm2_env:{status:p.status,pm_exec_path:p.script}}))));process.exit(0);}
if(args[0]==='save')process.exit(0);
if(args[0]==='start'&&args[2]==='--only'){const p=state.find(item=>item.name===args[3]);if(!p)process.exit(1);
 Object.assign(p,${comesOnline}?{status:'online',pid:4242}:{status:'errored',pid:0});fs.writeFileSync(${JSON.stringify(stateFile)},JSON.stringify(state));process.exit(0);}
process.exit(91);
`, { mode: 0o700 });
  f.write('pm2/ecosystem.config.cjs', `module.exports={apps:[{name:'c4-dispatcher'},{name:'scheduler'},{name:'zylos-dashboard'}]};\n`);
  return () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
}

// A service that refused the older database exits and PM2 marks it errored.
// It was not running, so only the recorded set is restarted after migration;
// Dashboard goes through its owner's restore, and component services are left alone.
test('same-version finalizer restarts Core services that exited on the older databases', async t => {
  const f = fixture(t, { from: '1.0.0', to: '1.0.0', olderDatabases: true, firstTakeover: false });
  const skill = name => path.join(f.root, '.claude/skills', name, 'index.js');
  const state = statefulPm2(f, [
    { name: 'c4-dispatcher', status: 'errored', pid: 0, script: skill('comm-bridge') },
    { name: 'zylos-dashboard', status: 'errored', pid: 0, script: skill('dashboard') },
    { name: 'zylos-lark', status: 'errored', pid: 0, script: skill('lark') },
  ]);
  f.m.update(f.dir, f.load(), { erroredServices: ['c4-dispatcher', 'zylos-dashboard', 'zylos-lark'] });
  const restores = [];
  const dashboardOwner = { ...f.deps.dashboardOwner, restoreDashboardService: () => { restores.push('dashboard'); return { state: 'done' }; } };
  const result = await f.run({ dashboardOwner });
  assert.equal(result.success, true, JSON.stringify(result));
  const after = Object.fromEntries(state().map(p => [p.name, p.status]));
  assert.equal(after['c4-dispatcher'], 'online');
  assert.equal(after['zylos-lark'], 'errored');
  assert.deepEqual(restores, ['dashboard']);
  assert.equal(result.dashboard.state, 'ready');
  assert.equal(Object.hasOwn(result, 'serviceWarnings'), false);
  const step = result.steps.find(item => item.name === 'restart_errored_services');
  assert.equal(step.message, 'c4-dispatcher');
  const calls = fs.readFileSync(f.pm2Calls, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls.filter(args => args[0] === 'start').map(args => args[3]), ['c4-dispatcher']);
});

for (const [fault, step, code] of [
  ['threshold-lock',4,'LOCK_TIMEOUT'],
  ['threshold-write',4,'EACCES'], ['ensure',5,'ENSURE_FAILED'],
  ['rename',5,'EACCES'],
]) test(`protected finalization ${fault} blocks services and permits forward repair`,async t=>{
  const f=fixture(t);
  await f.run({ensureMemoryMigration(){throw Error('prepare closed transaction');}});
  const config=pendingThresholdMigration(f);
  const settings=f.read('.claude/settings.json');
  const current=path.join(f.root,'memory/sessions/current.md');
  const archived=path.join(f.root,'memory/sessions/repaired.md');
  f.write('memory/sessions/current.md','legacy session bytes');
  f.calls.length=0;
  const fail=()=>{throw Object.assign(Error(`injected ${fault}`),{code});};
  const rotate=()=>{if(fs.existsSync(current))fs.renameSync(current,archived);};
  const result=await f.resume({
    publish:()=>({ok:true}),
    ...(fault==='threshold-lock'||fault==='threshold-write'?{updateConfig:fail}:{}),
    ensureMemoryMigration(){
      if(fault==='ensure')fail();
    },
    rotateSession(){
      if(fault==='rename')fail();
      rotate();
    },
  });
  assert.equal(result.success,false,JSON.stringify(result));
  assert.equal(result.failedStep,step);
  assert.equal(result.code,code);
  assert.match(result.next,/resume-finalize/);
  assert.equal(f.calls.includes('start'),false);
  assert.equal(f.load().phase,'recovery_required');
  assert.equal(f.load().resumePhase,'compensation_closed');
  assert.equal(Object.hasOwn(f.load(),'finalizeError'),false);
  assertDataPreserved(f, fault === 'rename');
  const repaired=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},
    finalize:ctx=>resumeUpgradeFinalization(ctx,{...f.deps,
      rotateSession:rotate})});
  assert.equal(repaired.ok,true,JSON.stringify(repaired));
  assert.equal(f.load().phase,'upgrade_complete');
  assert.equal(f.calls.includes('start'),true);
  assert.equal(f.read('.claude/settings.json'),settings);
  assert.equal(f.read('.zylos/config.json'),config);
  assert.equal(fs.readFileSync(archived,'utf8'),'legacy session bytes');
  assert.equal(fs.existsSync(current),false);
  assertDataPreserved(f);
});

test('runtime CLI preparation failure stops before migration, cutoff and live publication', async t => {
  const f = fixture(t);
  let migrated = false;
  const result = await f.run({
    prepareRuntimeClis() { throw Object.assign(Error('codex.cli: install unavailable'), {code:'RUNTIME_PREPARATION_INCOMPLETE'}); },
    dataReady() { migrated = true; },
  });
  assert.equal(result.success, false);
  assert.equal(result.code, 'RUNTIME_PREPARATION_INCOMPLETE');
  assert.equal(migrated, false);
  assert.equal(f.load().phase, 'installing');
  assert.equal(f.read('CLAUDE.md'), 'old Claude output');
  assert.equal(f.calls.includes('start'), false);
  assertDataPreserved(f, false);
});

test('SIGKILL during the default initial finalizer resumes from durable publication inputs', async t => {
  const f = fixture(t);
  const script = `
    import { runSelfUpgradeFinalize } from ${JSON.stringify(new URL('../self-upgrade.js', import.meta.url).href)};
    import { prepareUpgradeRuntime } from ${JSON.stringify(new URL('../upgrade-runtime-preparation.js', import.meta.url).href)};
    const state = JSON.parse(process.argv[2]);
    const root = process.argv[3], home = process.argv[4], packageRoot = process.argv[5];
    await runSelfUpgradeFinalize(state, {
      zylosDir: root,
      syncSkills: () => ({step:5, status:'done'}),
      installDependencies: () => ({step:6,status:'done'}),
      prepareRuntimeClis: () => ({completed:['claude.cli','codex.cli'],failed:[]}),
      prepareRuntime: ctx => prepareUpgradeRuntime(ctx, {packageRoot, homeDir:home, stopFailureSupported:false}),
      dashboardOwner: {copyDashboardDb: () => ({ok:true})},
      publication: {afterStep: step => {if(step==='t02') process.kill(process.pid, 'SIGKILL');}},
      startServices() {throw Error('must not reach services before crash');}
    });
    process.exitCode = 19;
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script, packageRoot,
    JSON.stringify(f.state), f.root, f.home, packageRoot], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.signal, 'SIGKILL', child.stderr);
  assert.equal(f.load().phase, 'compensation_closed');
  assert.equal(f.load().postCutoff.items.hooks.state, 'pending');
  const published = fs.readFileSync(path.join(f.root, 'CLAUDE.md'));
  assert.match(published.toString(), /private user instructions/);
  assert.throws(() => f.m.assertCoreDatabaseAvailable(f.root), { code: 'ZYLOS_MAINTENANCE' });
  const resumed = await f.resume({ prepareRuntime() { throw Error('must not render'); },
    dataReady() { throw Error('must not migrate'); } });
  assert.equal(resumed.success, true, JSON.stringify(resumed));
  assert.equal(f.load().postCutoff.items.hooks.attempts, 2);
  assert.equal(f.load().phase, 'upgrade_complete');
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'CLAUDE.md')), published);
  assert.equal(f.calls.filter(call => call === 'start').length, 1);
  assertDataPreserved(f);
});
