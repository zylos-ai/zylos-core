import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { runSelfUpgradeFinalize, resumeUpgradeFinalization } from '../self-upgrade.js';
import { LEGACY_CORE_DATABASES, createCoreDbSnapshot, prepareRecoveryDependencies, runCoreDbWorker } from '../core-db-backup.js';
import { prepareUpgradeRuntime, prepareUpgradeRuntimeClis } from '../upgrade-runtime-preparation.js';
import { preparePostCutoff } from '../upgrade-post-cutoff.js';
import { commitCutoff } from '../upgrade-cutoff.js';
import { resumeFinalize } from '../upgrade-resume.js';
import { migrateDatabase } from '../../../skills/comm-bridge/scripts/sqlite-schema.js';
import * as c4Schema from '../../../skills/comm-bridge/scripts/c4-schema.js';
import * as schedulerSchema from '../../../skills/scheduler/scripts/schema.js';
import * as webSchema from '../../../skills/web-console/scripts/schema.js';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '../../..');
const Database = require(path.join(packageRoot, 'skills/comm-bridge/node_modules/better-sqlite3'));

function fixture(t, { protectedUpgrade = true, temporaryBase = os.tmpdir(), firstTakeover = true, databaseMode = 'migrate' } = {}) {
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
    try {migrateDatabase(db,[c4Schema,schedulerSchema,webSchema][index],{allowNew:true,strict:false});}
    finally {db.close();}
  }
  const database = new Database(path.join(root, 'comm-bridge/c4.db'));
  database.prepare('INSERT INTO checkpoints(id, summary) VALUES (?, ?)').run(17, 'keep current data');
  database.close();
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'cli/lib/upgrade-maintenance.cjs'), path.join(stable, 'maintenance.cjs'));
  const m = require(path.join(stable, 'maintenance.cjs'));
  const calls = [];
  m.stop = () => calls.push('stop');
  m.runInstaller = () => { calls.push('npm'); return ''; };
  const tempDir = path.join(home, 'download');
  fs.mkdirSync(path.join(tempDir, 'skills/dashboard'), {recursive:true});
  const state = { schemaVersion: 1, from: '0.9.3', to: '0.9.4', tempDir, zylosDir:root, firstTakeover, dashboardOwnerManaged:false };
  let dir, journal;
  if (protectedUpgrade) {
    dir = path.join(root, '.backup/self-upgrade/tx');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const snapshot = createCoreDbSnapshot({ zylosDir: root, transactionId: 'tx', formatVersion: 2 });
    const closure = prepareRecoveryDependencies(dir, root, { dashboardRoot: path.join(home, 'uninstalled-dashboard') });
    for (const [source, target] of [['upgrade-maintenance.cjs', 'maintenance.cjs'],
      ['upgrade-recovery.cjs', 'runner.cjs'], ['upgrade-installer.cjs', 'installer.cjs']]) {
      fs.copyFileSync(path.join(packageRoot, 'cli/lib', source), path.join(dir, target));
      fs.chmodSync(path.join(dir, target), 0o600);
    }
    m.durable(path.join(dir, 'descriptor.json'), { formatVersion: 1, transactionId: 'tx', ...closure,
      runnerPath: path.join(dir, 'runner.cjs'), hashes: Object.fromEntries(
        ['maintenance.cjs', 'runner.cjs', 'installer.cjs'].map(name => [name, m.hash(path.join(dir, name))])) });
    const packageJson = path.join(home, 'old-package.json'), cliRoot = path.join(home, 'old-cli');
    fs.writeFileSync(packageJson, '{}'); fs.mkdirSync(cliRoot);
    journal = { formatVersion: 1, transactionId: 'tx', zylosDir: root, skillsDir,
      nodePath: process.execPath, phase: 'installing', installationIntent: true,
      databaseMode, firstTakeover, dashboardOwnerManaged:false, dbBackupDir: snapshot.dbBackupDir,
      snapshotManifestHash: m.hash(path.join(snapshot.dbBackupDir, 'manifest.json')),
      from: '0.9.3', to: '0.9.4', originalServices: [],
      coreManifest: LEGACY_CORE_DATABASES.map(item => ({ name: item.owner, existedBefore: true,
        backedUp: true, originalHash: m.treeHash(path.join(skillsDir, item.owner)),
        dependencies:{kind:'directory',sha256:m.treeHash(path.join(skillsDir,item.owner,'node_modules'))} })),
      initialIdentity: { nodePath: process.execPath, packageJson, packageHash: m.hash(packageJson),
        cliRoot, cliHash: m.treeHash(cliRoot), workerPath: closure.workerPath,
        workerHash: m.hash(closure.workerPath), ecosystemHash: null,
        databases: snapshot.manifest.databases.map(item => ({ source: item.source, exists: item.status !== 'missing' })) } };
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
    // The package is already deployed into this private fixture. Do not run
    // the host-oriented skill copier or invoke npm against the real host.
    syncSkills: () => ({ step: 5, name: 'sync_core_skills', status: 'done' }),
    step6: { skillsDir },
    prepareRuntimeClis: () => ({ completed: ['claude.cli', 'codex.cli'], failed: [] }),
    prepareRuntime: ctx => prepareUpgradeRuntime(ctx, { packageRoot, homeDir: home, stopFailureSupported: false }),
    ensureMemoryMigration: () => { calls.push('ensure-memory'); return {}; },
    startServices: () => { calls.push('start'); return { status: 'done' }; },
    verifyServices: () => { calls.push('verify'); return { status: 'done' }; },
    readMode: () => ({ mode: 'single', keyPresent: true }), readTransition: () => null,
    restart: () => { calls.push('restart'); return { ok: true, data: { result: 'exit_enqueued' } }; },
    audit: () => [],
  };
  const load = () => m.transaction(root, dir);
  const resume = (overrides = {}) => resumeUpgradeFinalization({ zylosDir: root, transactionDir: dir,
    transactionId: 'tx', journal: load(), maintenance: m }, { ...deps, ...overrides });
  return { root, home, dir, state, deps, calls, m, write, load, resume, pm2Calls,
    read: relative => fs.readFileSync(path.join(root, relative), 'utf8'),
    run: overrides => runSelfUpgradeFinalize(state, { ...deps, ...overrides }) };
}

function assertDataPreserved(f) {
  const db = new Database(path.join(f.root, 'comm-bridge/c4.db'), { readonly: true });
  try { assert.equal(db.prepare('SELECT summary FROM checkpoints WHERE id=17').get().summary, 'keep current data'); }
  finally { db.close(); }
  assert.equal(f.read('ZYLOS.md'), 'private user instructions\r\n');
  assert.equal(f.read('memory/state.md'), 'preserve working state\n');
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
  assert.equal(JSON.parse(f.read('.zylos/config.json')).new_session_threshold, 70);
  assert.equal(result.settingsChanged, true);
  assert.equal(Object.hasOwn(result, 'instructionFilesRebuilt'), false);
  assert.equal(result.completion.modeTransition, 'pending_auto');
  assert.ok(f.calls.indexOf('start') > f.calls.indexOf('ensure-memory'));
  assert.ok(f.calls.indexOf('restart') > f.calls.indexOf('verify'));
  assertDataPreserved(f);
});

test('protected finalizer reports persisted unchanged database mode and verified snapshot',async t=>{
  const f=fixture(t,{databaseMode:'unchanged'});
  const result=await f.run();
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.dbSnapshotVerified,true);
  assert.equal(result.databaseMode,'unchanged');
  assertDataPreserved(f);
});

test('forward repair reports the persisted unchanged database mode',async t=>{
  const f=fixture(t,{databaseMode:'unchanged'});
  await f.run({ensureMemoryMigration(){throw Error('prepare closed transaction');}});
  const result=await f.resume();
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.databaseMode,'unchanged');
  assert.equal(result.dbSnapshotVerified,true);
});

test('forward repair does not report a verified snapshot when the manifest no longer matches',async t=>{
  const f=fixture(t);
  await f.run({ensureMemoryMigration(){throw Error('prepare closed transaction');}});
  fs.appendFileSync(path.join(f.load().dbBackupDir,'manifest.json'),' ');
  const result=await f.resume();
  assert.equal(result.success,false,JSON.stringify(result));
  assert.match(result.error,/Snapshot manifest hash does not match/);
  assert.equal(result.dbSnapshotVerified,false);
});

test('upgrade preparation rejects malformed settings before cutoff and preserves live settings', async t => {
  const f = fixture(t);
  const malformed = '{invalid settings';
  f.write('.claude/settings.json', malformed);
  const result = await f.run();
  assert.equal(result.success, false);
  assert.equal(result.code, 'SETTINGS_UNREADABLE');
  assert.equal(f.read('.claude/settings.json'), malformed);
  assert.equal(f.load().compensationCutoff, undefined);
  assert.equal(f.calls.includes('start'), false);
  assert.equal(f.calls.includes('restart'), false);
});

test('default finalizer reports unknown when session-mode status cannot be read', async t => {
  const f = fixture(t);
  const result = await f.run({ readModeStatus: () => {
    throw Object.assign(Error('injected session-mode status failure'), { code: 'SESSION_MODE_STATUS_UNAVAILABLE' });
  } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.completion.modeTransition, 'unknown');
  assertDataPreserved(f);
});

test('Dashboard takeover uses the persisted entry fact independently of source version and caller override', async t => {
  const f=fixture(t);
  const journal=f.load();
  f.m.update(f.dir,journal,{from:'0.9.4'});
  f.state.from='0.9.4';
  f.state.firstTakeover=false;
  // Keep real protected snapshot checks, while avoiding a missing Dashboard schema owner.
  const result=await f.run({dataReady:()=>{}});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(f.load().dashboardInstall.items.registration.state,'done');
  assert.ok(f.calls.includes('dashboard-copy'));
  assert.ok(f.calls.includes('registration'));
  assert.ok(f.calls.includes('route'));
});

test('persisted subsequent takeover skips first registration', async t => {
  const f=fixture(t,{firstTakeover:false});
  const result=await f.run();
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(f.load().dashboardInstall,null);
  for(const call of ['dashboard-copy','registration','route']) assert.equal(f.calls.includes(call),false,call);
  assert.ok(f.calls.includes('dashboard-verify'));
});

test('target without Dashboard creates no takeover work', async t => {
  const f=fixture(t);
  fs.rmdirSync(path.join(f.state.tempDir,'skills/dashboard'));
  const result=await f.run();
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(f.load().dashboardInstall,null);
  for(const call of ['dashboard-copy','registration','route']) assert.equal(f.calls.includes(call),false,call);
});

test('finalization does not recompute the persisted takeover fact from changed deployed files', async t => {
  const f=fixture(t);
  f.write('.claude/skills/dashboard/package.json','{"type":"module"}\n');
  const result=await f.run();
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(f.load().firstTakeover,true);
  assert.ok(f.calls.includes('registration'));
});

test('default finalizer loads the Dashboard owner from the CLI module without loading the service package', async t => {
  const f=fixture(t), target=path.join(f.home,'target-package');
  fs.mkdirSync(path.join(target,'cli/lib'),{recursive:true});
  fs.mkdirSync(path.join(target,'components/dashboard'),{recursive:true});
  fs.writeFileSync(path.join(target,'package.json'),'{"type":"module"}');
  fs.writeFileSync(path.join(target,'components/dashboard/package.json'),'{"type":"module","main":"index.js"}');
  fs.writeFileSync(path.join(target,'components/dashboard/index.js'),`throw Error('Dashboard service entry must not load');`);
  const calls=path.join(f.home,'ib66-calls');
  fs.writeFileSync(path.join(target,'cli/lib/dashboard-install.js'),`
    import fs from 'node:fs';
    const record=name=>fs.appendFileSync(${JSON.stringify(calls)},name+'\\n');
    export function copyDashboardDb(){record('copy');return {ok:true};}
    export function applyDashboardRegistration(){record('registration');return {state:'done'};}
    export function applyDashboardRoute(){record('route');return {state:'done'};}
    export function verifyDashboard(options){record('verify');if(Object.hasOwn(options,'deadlineAt'))throw Error('unexpected parent deadline');return {state:'ready',errors:[]};}
  `);
  const result=await f.run({dashboardOwner:null,prepareRuntime:ctx=>{
    const prepared=prepareUpgradeRuntime(ctx,{packageRoot,homeDir:f.home,stopFailureSupported:false});
    ctx.packageRoot=target;
    return prepared;
  }});
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(result.completion.dashboard,'ready');
  assert.deepEqual(fs.readFileSync(calls,'utf8').trim().split('\n'),['copy','registration','route','verify']);
});

test('default finalizer reports unchanged published settings truthfully', async t => {
  const f = fixture(t);
  const prepared = f.deps.prepareRuntime({ zylosDir: f.root, tempDir: f.state.tempDir });
  const settings = prepared.replacements.find(item => item.kind === 'claude_settings').content;
  f.write('.claude/settings.json', settings);
  const result = await f.run();
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.settingsChanged, false);
  assert.equal(f.read('.claude/settings.json'), settings);
});

test('real finalizer stdout remains JSON when publication changes global Codex configuration', t => {
  const f=fixture(t);
  const config=path.join(f.home,'.codex/config.toml'),original='model = "preserve-my-model"\n';
  fs.mkdirSync(path.dirname(config),{recursive:true});fs.writeFileSync(config,original);
  const child=path.join(f.home,'finalizer-entry.mjs');
  const moduleUrl=new URL('../self-upgrade.js',import.meta.url).href;
  fs.writeFileSync(child,`
    import fs from 'node:fs';
    import {createRequire} from 'node:module';
    import * as upgrade from ${JSON.stringify(moduleUrl)};
    import {prepareUpgradeRuntime} from ${JSON.stringify(new URL('../upgrade-runtime-preparation.js',import.meta.url).href)};
    const root=${JSON.stringify(f.root)},home=${JSON.stringify(f.home)};
    const state=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    const m=createRequire(import.meta.url)(root+'/.zylos/upgrade/maintenance.cjs');
    const release=m.acquire(state.transactionDir);
    try {
      const result=await upgrade.runSelfUpgradeFinalize(state,{
        zylosDir:root,syncSkills:()=>({step:5,status:'done'}),
        installDependencies:()=>({step:6,status:'done'}),prepareRuntimeClis:()=>{},
        prepareRuntime:ctx=>prepareUpgradeRuntime(ctx,{packageRoot:${JSON.stringify(packageRoot)},homeDir:home,stopFailureSupported:false}),
        updateConfig(){},ensureMemoryMigration(){},rotateSession(){},commitBaselines:()=>({status:'done'}),
        startServices:()=>({status:'done'}),verifyServices:()=>({status:'done'}),
        dashboardOwner:{copyDashboardDb:()=>({ok:true}),applyDashboardRegistration:()=>({state:'done'}),applyDashboardRoute:()=>({state:'done'}),verifyDashboard:()=>({state:'ready',errors:[]})},
        readModeStatus:()=>({sessionMode:null,transition:null}),readMode:()=>({mode:null,keyPresent:false}),readTransition:()=>null,
        restart:()=>({ok:true,data:{result:'exit_enqueued'}}),audit:()=>[],
      });
      process.stdout.write(JSON.stringify(result)+'\\n');
      process.exitCode=result.success?0:1;
    } finally {release();}
  `);
  const stateFile=path.join(f.home,'finalize-state.json');
  fs.writeFileSync(stateFile,JSON.stringify(f.state));
  const output=spawnSync(process.execPath,[child,stateFile],{
    encoding:'utf8',timeout:15000,env:{...process.env,HOME:f.home,ZYLOS_DIR:f.root,PM2_HOME:path.join(f.home,'.pm2')}});
  assert.equal(output.status,0,output.stderr+'\n'+output.stdout);
  const result=JSON.parse(output.stdout);
  assert.equal(result.success,true,JSON.stringify(result));
  const updated=fs.readFileSync(config,'utf8');
  assert.notEqual(updated,original);
  assert.match(updated,/preserve-my-model/);
});

test('NOT_RESUMABLE after acquiring the forward-repair lock is preserved', async t => {
  const f=fixture(t);
  const interrupted=await f.run({publication:{afterStep(step){if(step==='t02')throw Error('pause publication');}}});
  assert.equal(interrupted.success,false);
  const discover=f.m.discover;let reads=0,locked=false,released=false;
  const acquire=f.m.acquire;
  f.m.acquire=dir=>{const release=acquire(dir);locked=true;return ()=>{released=true;release();};};
  f.m.discover=root=>{
    reads++;
    if(reads===3){assert.equal(locked,true);return {candidates:[],diagnostics:[]};}
    return discover(root);
  };
  const before=f.load();
  await assert.rejects(()=>resumeFinalize(f.root,{}, {maintenance:f.m,platform:'linux'}),{code:'NOT_RESUMABLE',persisted:[]});
  assert.equal(released,true);
  assert.equal(f.load().lastError,before.lastError);
  assert.equal(f.load().resumePhase,'compensation_closed');
});

test('independent Dashboard rejects protected finalization before any writes',async t=>{
  const f=fixture(t);
  f.write('.zylos/components.json',JSON.stringify({dashboard:{version:'legacy'}}));
  const before=f.read('.claude/settings.json');
  const result=await f.run();
  assert.equal(result.success,false);
  assert.equal(result.code,'DASHBOARD_STILL_INSTALLED');
  assert.match(result.error,/Uninstall standalone Dashboard/);
  assert.match(result.next,/zylos uninstall dashboard --yes/);
  assert.deepEqual(f.calls,[]);
  assert.equal(f.read('.claude/settings.json'),before);
  assert.equal(f.load().phase,'installing');
  assertDataPreserved(f);
});

test('protected finalization without takeover verifies Dashboard without registration or route',async t=>{
  const f=fixture(t);
  await f.run({
    commitCutoff:(ctx,fields)=>commitCutoff(ctx,{...fields,dashboardInstall:null}),
    ensureMemoryMigration(){throw Error('prepare closed transaction');},
  });
  f.calls.length=0;
  const result=await f.resume();
  assert.equal(result.success,true,JSON.stringify(result));
  assert.equal(f.calls.includes('registration'),false);
  assert.equal(f.calls.includes('route'),false);
  assert.equal(f.calls.includes('dashboard-verify'),true);
});

test('resume entry preserves step 4 lock timeout without adding persistent fields',async t=>{
  const f=fixture(t);
  await f.run({ensureMemoryMigration(){throw Error('initial failure');}});
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},
    finalize:ctx=>resumeUpgradeFinalization(ctx,{...f.deps,
      updateConfig(){throw Object.assign(Error('configuration lock timed out'),{code:'LOCK_TIMEOUT'});}})});
  assert.equal(result.ok,false);
  const expected={id:'step4',code:'LOCK_TIMEOUT',reason:'configuration lock timed out'};
  assert.deepEqual(result.data.core.failedItems,[expected]);
  const status=await resumeFinalize(f.root,{status:true},{maintenance:f.m});
  assert.equal(status.data.core.failedItems[0].reason,expected.reason);
  assert.equal(Object.hasOwn(f.load(),'finalizeError'),false);
  assert.equal(Object.hasOwn(f.load(),'error'),false);
  assert.equal(f.load().lastError,expected.reason);
  assert.deepEqual(result.data.dashboard,{state:'degraded',errors:[]});
  assert.equal(f.load().phase,'recovery_required');
});

for(const boundary of ['publication','manifest'])test(`resume reports an unnumbered ${boundary} failure as finalize`,async t=>{
  const f=fixture(t);
  await f.run({ensureMemoryMigration(){throw Error('prepare closed transaction');}});
  f.calls.length=0;
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},
    finalize:ctx=>{
      if(boundary==='manifest') {
        delete ctx.dbManifest;
        ctx.journal.snapshotManifestHash='0'.repeat(64);
      }
      return resumeUpgradeFinalization(ctx,{...f.deps,
        publish(){throw Object.assign(Error('publication denied'),{code:'EACCES'});}});
    }});
  assert.equal(result.ok,false);
  assert.equal(result.data.core.failedItems[0].id,'finalize');
  assert.equal(result.data.core.failedItems[0].code,boundary==='publication'?'EACCES':'UPGRADE_FAILED');
  assert.deepEqual(result.data.dashboard,{state:'degraded',errors:[]});
  assert.equal(f.calls.includes('start'),false);
});

for(const code of ['EACCES','SCHEMA_TOO_NEW'])test(`resume catch preserves ${code} while retaining the failed transaction`,async t=>{
  const f=fixture(t);
  await f.run({ensureMemoryMigration(){throw Error('prepare closed transaction');}});
  f.calls.length=0;
  const result=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},
    finalize(){throw Object.assign(Error('forward repair failed'),{code});}});
  assert.equal(result.ok,false);
  assert.deepEqual(result.data.core.failedItems,[{id:'finalize',code,reason:'forward repair failed'}]);
  assert.deepEqual(result.data.dashboard,{state:'degraded',errors:[]});
  assert.equal(f.load().lastError,'forward repair failed');
  assert.equal(Object.hasOwn(f.load(),'error'),false);
  assert.equal(f.calls.includes('start'),false);
});

for (const [fault, step, code] of [
  ['threshold-lock',4,'LOCK_TIMEOUT'],
  ['threshold-write',4,'EACCES'], ['ensure',5,'ENSURE_FAILED'],
  ['rename',5,'EACCES'], ['state-read',6,'EACCES'],
]) test(`D4 protected ${fault} blocks services and permits forward repair`,async t=>{
  const f=fixture(t);
  await f.run({ensureMemoryMigration(){throw Error('prepare closed transaction');}});
  const state=f.read('memory/state.md'), settings=f.read('.claude/settings.json');
  const config=f.read('.zylos/config.json');
  const current=path.join(f.root,'memory/sessions/current.md');
  const archived=path.join(f.root,'memory/sessions/repaired.md');
  f.write('memory/sessions/current.md','legacy session bytes');
  f.calls.length=0;
  let readingFault=fault==='state-read';
  const read=fs.readFileSync;
  fs.readFileSync=function(file,...args){
    if(readingFault && String(file)===path.join(f.root,'memory/state.md')) {
      throw Object.assign(Error('injected state read failure'),{code:'EACCES'});
    }
    return read.call(this,file,...args);
  };
  t.after(()=>{fs.readFileSync=read;});
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
  readingFault=false;
  assert.equal(result.success,false,JSON.stringify(result));
  assert.equal(result.failedStep,step);
  assert.equal(result.code,code);
  assert.match(result.next,/resume-finalize/);
  assert.equal(f.calls.includes('start'),false);
  assert.equal(f.load().phase,'recovery_required');
  assert.equal(f.load().resumePhase,'compensation_closed');
  assert.equal(Object.hasOwn(f.load(),'finalizeError'),false);
  assertDataPreserved(f);
  const repaired=await resumeFinalize(f.root,{}, {maintenance:f.m,quiesce:()=>{},
    finalize:ctx=>resumeUpgradeFinalization(ctx,{...f.deps,
      rotateSession:rotate})});
  assert.equal(repaired.ok,true,JSON.stringify(repaired));
  assert.equal(f.load().phase,'upgrade_complete');
  assert.equal(f.calls.includes('start'),true);
  assert.equal(f.read('memory/state.md'),state);
  assert.equal(f.read('.claude/settings.json'),settings);
  assert.equal(f.read('.zylos/config.json'),config);
  assert.equal(fs.readFileSync(archived,'utf8'),'legacy session bytes');
  assert.equal(fs.existsSync(current),false);
  assertDataPreserved(f);
});

test('missing transaction journal rejects before migration or publication', async t => {
  const f = fixture(t, { protectedUpgrade: false });
  const result = await f.run();
  assert.equal(result.success, false, JSON.stringify(result));
  assert.match(result.error,/ENOENT/);
  assert.equal(fs.existsSync(path.join(f.root, '.backup/self-upgrade')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.backup/db')), false);
  assert.equal(f.read('CLAUDE.md'), 'old Claude output');
  assert.equal(f.calls.includes('start'), false);
  assert.equal(f.calls.includes('restart'), false);
  assertDataPreserved(f);
});

test('protected tail failure retains published bytes and stops before services with a forward repair next step', async t => {
  const f = fixture(t);
  const result = await f.run({ ensureMemoryMigration() { throw Error('memory prerequisite failed'); } });
  assert.equal(result.success, false);
  assert.match(result.error, /memory prerequisite failed/);
  assert.equal(result.recovery_required, true);
  assert.match(result.next, /resume-finalize/);
  assert.equal(f.load().phase,'recovery_required');
  assert.match(f.read('CLAUDE.md'), /private user instructions/);
  assert.equal(f.calls.includes('start'), false);
  assertDataPreserved(f);
});

test('default initial finalizer treats uncertain cutoff as zero publication or service work', async t => {
  const f = fixture(t);
  const result = await f.run({ commitCutoff(ctx, inputs) {
    commitCutoff(ctx, inputs);
    throw Object.assign(Error('cutoff acknowledgement lost'), { code: 'CUTOFF_WRITE_UNCERTAIN' });
  } });
  assert.equal(result.success, false);
  assert.equal(result.code, 'CUTOFF_WRITE_UNCERTAIN');
  assert.equal(f.read('CLAUDE.md'), 'old Claude output');
  assert.equal(f.read('AGENTS.md'), 'old Codex output');
  assert.equal(f.read('.claude/settings.json'), '{"permissions":{"allow":["Read"]},"hooks":{}}\n');
  assert.equal(f.load().postCutoff.items.hooks.attempts, 0);
  assert.equal(f.calls.includes('start'), false);
  assert.equal(f.calls.includes('restart'), false);
  assertDataPreserved(f);
});

test('default resume rejects declared corrupt material with no regeneration fallback', async t => {
  const f = fixture(t);
  const result = await f.run({ stage(inputs) {
    const staged = preparePostCutoff(inputs);
    const target = staged.items.hooks.targets.at(-1);
    fs.writeFileSync(path.join(inputs.transactionDir, target.stagedFile), 'corrupt declared material');
    return staged;
  } });
  assert.equal(result.success, false);
  assert.equal(result.code, 'material_corrupt');
  assert.equal(f.load().phase, 'recovery_required');
  assert.equal(f.read('CLAUDE.md'), 'old Claude output');
  const before = fs.readFileSync(path.join(f.root, '.claude/settings.json'));
  const repaired = await f.resume({ prepareRuntime() { throw Error('must never regenerate'); },
    migrateDatabases() { throw Error('must never migrate'); } });
  assert.equal(repaired.success, false);
  assert.equal(repaired.code, 'material_corrupt');
  assert.deepEqual(fs.readFileSync(path.join(f.root, '.claude/settings.json')), before);
  assert.equal(f.calls.includes('start'), false);
  assertDataPreserved(f);
});

test('default resume recovers interrupted publication using durable bytes without migration or rendering', async t => {
  const f = fixture(t);
  const first = await f.run({ publication: { afterStep(step) {
    if (step === 't02') throw Error('simulated finalizer interruption');
  } } });
  assert.equal(first.success, false);
  assert.equal(f.load().phase, 'recovery_required');
  assert.match(f.read('CLAUDE.md'), /private user instructions/);
  assert.equal(f.calls.includes('start'), false);
  const output = fs.readFileSync(path.join(f.root, 'CLAUDE.md'));
  const result = await f.resume({ prepareRuntime() { throw Error('must never render'); },
    dataReady() { throw Error('must never migrate'); } });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.load().phase, 'upgrade_complete');
  assert.equal(f.load().postCutoff.items.hooks.attempts, 2);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'CLAUDE.md')), output);
  assert.equal(f.calls.filter(call => call === 'start').length, 1);
  assert.equal(f.calls.filter(call => call === 'registration').length, 1);
  assertDataPreserved(f);
});

test('declared damaged snapshot never falls back to ordinary finalization', async t => {
  const f = fixture(t);
  fs.appendFileSync(path.join(f.load().dbBackupDir, 'manifest.json'), '\n');
  const result = await f.run();
  assert.equal(result.success, false);
  assert.match(result.error, /Snapshot manifest hash does not match cutoff facts/);
  assert.equal(f.load().phase, 'installing');
  assert.deepEqual(f.calls, []);
  assert.equal(f.read('CLAUDE.md'), 'old Claude output');
  assert.equal(fs.existsSync(path.join(f.dir, 'runtime-preparation')), false);
  assertDataPreserved(f);
});

test('finalizer loads the hashed manifest without repeating full snapshot verification', async t => {
  const f = fixture(t);
  const result = await f.run({verifySnapshot() { assert.fail('snapshot contents were already verified before installation'); }});
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.load().phase, 'upgrade_complete');
  assertDataPreserved(f);
});

test('optional runtime CLI warning survives successful finalization alongside preparation warnings', async t => {
  const f = fixture(t);
  f.m.update(f.dir, f.load(), { firstTakeover: true });
  const result = await f.run({
    prepareRuntimeClis: ctx => prepareUpgradeRuntimeClis(ctx, {
      exists: runtime => runtime === 'claude',
      install: { codex: () => false, claude: () => { throw Error('active CLI must be preserved'); } },
    }),
    prepareRuntime: ctx => {
      const prepared = f.deps.prepareRuntime(ctx);
      return { ...prepared, warnings: [...prepared.warnings, 'Existing preparation warning'] };
    },
  });
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(f.load().phase, 'upgrade_complete');
  assert.deepEqual(result.preparationWarnings, [
    'Existing preparation warning',
  ]);
  assert.deepEqual(result.warnings,[{code:'RUNTIME_CLI_UNAVAILABLE',runtime:'codex',message:'CLI installation failed or command not on PATH'}]);
  assert.equal(f.calls.filter(call => call === 'restart').length, 1);
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
  assertDataPreserved(f);
});

test('runtime warning survives a fresh process status and forward repair', async t => {
  const f = fixture(t);
  const warning = {code:'RUNTIME_CLI_UNAVAILABLE',runtime:'codex',message:'CLI installation failed or command not on PATH'};
  const initial = await f.run({
    prepareRuntimeClis: () => ({warnings:[warning]}),
    ensureMemoryMigration: () => { throw Error('memory preparation interrupted'); },
  });
  assert.equal(initial.success,false);
  assert.deepEqual(f.load().runtimeWarnings,[warning]);
  const resumeModule = new URL('../upgrade-resume.js',import.meta.url).href;
  const child = spawnSync(process.execPath,['--input-type=module','-e',`
    import {resumeFinalize} from ${JSON.stringify(resumeModule)};
    const result=await resumeFinalize(process.argv[1],{status:true});
    process.stdout.write(JSON.stringify(result));
  `,f.root],{encoding:'utf8'});
  assert.equal(child.status,0,child.stderr);
  const status=JSON.parse(child.stdout);
  assert.deepEqual(status.data.warnings,[warning]);
  assert.equal(status.data.dashboard.state,'degraded');
  const repaired=await f.resume();
  assert.equal(repaired.success,true,JSON.stringify(repaired));
  assert.deepEqual(repaired.warnings,[warning]);
});

test('late finalization failure preserves the current Dashboard readiness observation', async t => {
  const f=fixture(t);
  const failed=await f.run({protectedSuccess:()=>{throw Error('terminal journal write interrupted');}});
  assert.equal(failed.success,false);
  assert.equal(failed.dashboard.state,'ready');
  assert.deepEqual(failed.dashboard.errors,[]);
  assert.equal(f.calls.includes('dashboard-verify'),true);
  const resumed=await resumeFinalize(f.root,{}, {
    maintenance:f.m,quiesce:()=>{},
    finalize:ctx=>resumeUpgradeFinalization(ctx,{...f.deps,protectedSuccess:()=>{throw Error('terminal journal write interrupted');}}),
  });
  assert.equal(resumed.ok,false);
  assert.equal(resumed.data.dashboard.state,'ready');
  assert.deepEqual(resumed.data.dashboard.errors,[]);
});

test('finalizer returns the original failure when its journal becomes unreadable', async t => {
  const f = fixture(t);
  const journalPath = path.join(f.dir, 'journal.json');
  const damagedJournal = '{"interrupted journal write":';
  let ordinaryCalls = 0;
  const result = await f.run({
    migrateDatabases() { ordinaryCalls++; throw Error('must never fall back'); },
    syncSkills() {
      fs.writeFileSync(journalPath, damagedJournal);
      throw Object.assign(Error('original sync failure'), { code: 'SYNC_FAILED' });
    },
  });
  assert.equal(result.action, 'self_upgrade');
  assert.equal(result.success, false);
  assert.equal(result.error, 'original sync failure');
  assert.equal(result.code, 'SYNC_FAILED');
  assert.equal(typeof result.recoveryError, 'string');
  assert.ok(result.recoveryError.length > 0);
  assert.equal(result.recovery_required, true);
  assert.deepEqual(result.rollback, { performed: false, steps: [] });
  assert.equal(ordinaryCalls, 0);
  assert.deepEqual(f.calls, []);
  assert.equal(fs.readFileSync(journalPath, 'utf8'), damagedJournal);
  assert.equal(f.read('CLAUDE.md'), 'old Claude output');
  assertDataPreserved(f);
});

test('finalizer returns the original failure when recording closed-cutoff recovery fails', async t => {
  const f = fixture(t);
  const originalUpdate = f.m.update;
  const result = await f.run({ publish() {
    f.m.update = () => { throw Error('journal update unavailable'); };
    throw Object.assign(Error('publication interrupted'), { code: 'PUBLICATION_INTERRUPTED' });
  } });
  f.m.update = originalUpdate;
  assert.equal(result.success, false);
  assert.match(result.error, /publication interrupted/);
  assert.equal(result.recoveryError, 'journal update unavailable');
  assert.equal(result.recovery_required, true);
  assert.deepEqual(result.rollback, { performed: false, steps: [] });
  assert.equal(f.calls.includes('start'), false);
  assert.equal(f.load().phase, 'compensation_closed');
  assertDataPreserved(f);
});

test('default resume retries registration and retains degraded copy evidence when the initial Dashboard owner was unavailable', async t => {
  const f = fixture(t);
  const failed = await f.run({ dashboardOwner: { copyDashboardDb() {
    throw Object.assign(Error('initial Dashboard copy owner unavailable'), {code:'DASHBOARD_UNAVAILABLE'});
  } }, publication: { afterStep(step) {
    if (step === 't02') throw Error('interrupted before Dashboard registration');
  } } });
  assert.equal(failed.success, false);
  assert.equal(f.load().dashboardInstall.dbCopy.ok, false);
  assert.equal(f.load().dashboardInstall.dbCopy.error.code, 'DASHBOARD_UNAVAILABLE');
  assert.equal(f.calls.includes('dashboard-copy'), false);
  const resumed = await f.resume();
  assert.equal(resumed.success, true, JSON.stringify(resumed));
  assert.equal(resumed.completion.dashboard, 'degraded');
  assert.equal(f.calls.filter(call => call === 'registration').length, 1);
  assert.equal(f.calls.filter(call => call === 'route').length, 1);
  assertDataPreserved(f);
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
