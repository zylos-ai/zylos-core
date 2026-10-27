import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { runSelfUpgradeFinalize, resumeUpgradeFinalization } from '../self-upgrade.js';
import { LEGACY_CORE_DATABASES, createCoreDbSnapshot, prepareRecoveryDependencies, runCoreDbWorker } from '../core-db-backup.js';
import { prepareUpgradeRuntime } from '../upgrade-runtime-preparation.js';
import { preparePostCutoff } from '../upgrade-post-cutoff.js';
import { commitCutoff } from '../upgrade-cutoff.js';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(import.meta.dirname, '../../..');
const Database = require(path.join(packageRoot, 'skills/comm-bridge/node_modules/better-sqlite3'));

function fixture(t, { protectedUpgrade = true, temporaryBase = os.tmpdir() } = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(temporaryBase, 'default-finalizer-')));
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
    fs.symlinkSync(path.join(source, 'node_modules'), path.join(target, 'node_modules'));
  }
  // Exercise the real owner migration engine to create valid databases before
  // snapshotting; later assertions inspect real native SQLite state.
  runCoreDbWorker({ action: 'ordinary-migrate', zylosDir: root, schemaRoot: skillsDir, formatVersion: 1 });
  const database = new Database(path.join(root, 'comm-bridge/c4.db'));
  database.prepare('INSERT INTO checkpoints(id, summary) VALUES (?, ?)').run(17, 'keep current data');
  database.close();
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, { recursive: true });
  fs.copyFileSync(path.join(packageRoot, 'cli/lib/upgrade-maintenance.cjs'), path.join(stable, 'maintenance.cjs'));
  const m = require(path.join(stable, 'maintenance.cjs'));
  const calls = [];
  m.stop = () => calls.push('stop');
  const budget = { check() {}, remaining: () => 100000, deadlineAt: Date.now() + 100000 };
  const tempDir = path.join(home, 'download');
  fs.mkdirSync(tempDir);
  const state = { schemaVersion: 1, from: '0.9.0', to: '0.9.2', tempDir };
  let dir, journal;
  if (protectedUpgrade) {
    dir = path.join(root, '.backup/self-upgrade/tx');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const snapshot = createCoreDbSnapshot({ zylosDir: root, transactionId: 'tx', formatVersion: 1 });
    const closure = prepareRecoveryDependencies(dir, root, { dashboardRoot: path.join(home, 'uninstalled-dashboard') });
    for (const [source, target] of [['upgrade-maintenance.cjs', 'maintenance.cjs'],
      ['upgrade-recovery.cjs', 'runner.cjs'], ['upgrade-finalizer.cjs', 'finalizer.cjs']]) {
      fs.copyFileSync(path.join(packageRoot, 'cli/lib', source), path.join(dir, target));
      fs.chmodSync(path.join(dir, target), 0o600);
    }
    m.durable(path.join(dir, 'descriptor.json'), { formatVersion: 1, transactionId: 'tx', ...closure,
      runnerPath: path.join(dir, 'runner.cjs'), hashes: Object.fromEntries(
        ['maintenance.cjs', 'runner.cjs', 'finalizer.cjs'].map(name => [name, m.hash(path.join(dir, name))])) });
    const packageJson = path.join(home, 'old-package.json'), cliRoot = path.join(home, 'old-cli');
    fs.writeFileSync(packageJson, '{}'); fs.mkdirSync(cliRoot);
    journal = { formatVersion: 1, transactionId: 'tx', zylosDir: root, skillsDir,
      nodePath: process.execPath, phase: 'installing', installationIntent: true,
      databaseMode: 'migrate', dbBackupDir: snapshot.dbBackupDir,
      snapshotManifestHash: m.hash(path.join(snapshot.dbBackupDir, 'manifest.json')),
      from: '0.9.0', to: '0.9.2', originalServices: [],
      coreManifest: LEGACY_CORE_DATABASES.map(item => ({ name: item.owner, existedBefore: true,
        backedUp: true, originalHash: m.treeHash(path.join(skillsDir, item.owner)) })),
      initialIdentity: { nodePath: process.execPath, packageJson, packageHash: m.hash(packageJson),
        cliRoot, cliHash: m.treeHash(cliRoot), workerPath: closure.workerPath,
        workerHash: m.hash(closure.workerPath), ecosystemHash: null,
        databases: snapshot.manifest.databases.map(item => ({ source: item.source, exists: item.status !== 'missing' })) } };
    m.update(dir, journal); m.marker(root, dir, journal);
    Object.assign(state, { schemaVersion: 2, preInstallProtection: true, transactionId: 'tx', transactionDir: dir });
  }
  const dashboardOwner = {
    copyDashboardDb: () => { calls.push('dashboard-copy'); return { ok: true }; },
    applyDashboardRegistration: () => { calls.push('registration'); return { state: 'done' }; },
    applyDashboardRoute: () => { calls.push('route'); return { state: 'done' }; },
    verifyDashboard: () => { calls.push('dashboard-verify'); return { state: 'ready', errors: [] }; },
  };
  const deps = {
    zylosDir: root, maintenance: m, budget, dashboardOwner,
    // The package is already deployed into this private fixture. Do not run
    // the host-oriented skill copier or invoke npm against the real host.
    syncSkills: () => ({ step: 5, name: 'sync_core_skills', status: 'done' }),
    step6: { skillsDir, execSync: () => { calls.push('npm'); return ''; } },
    prepareRuntimeClis: () => ({ completed: ['claude.cli', 'codex.cli'], failed: [] }),
    prepareRuntime: ctx => prepareUpgradeRuntime(ctx, { budget, packageRoot, homeDir: home, stopFailureSupported: false }),
    ensureMemoryMigration: () => { calls.push('ensure-memory'); return {}; },
    startServices: () => { calls.push('start'); return { status: 'done' }; },
    verifyServices: () => { calls.push('verify'); return { status: 'done' }; },
    readMode: () => ({ mode: 'single', keyPresent: true }), readTransition: () => null,
    restart: () => { calls.push('restart'); return { ok: true, data: { result: 'exit_enqueued' } }; },
    audit: () => [],
  };
  const load = () => m.transaction(root, dir);
  const resume = (overrides = {}) => resumeUpgradeFinalization({ zylosDir: root, transactionDir: dir,
    transactionId: 'tx', journal: load(), maintenance: m, budget }, { ...deps, ...overrides });
  return { root, home, dir, state, deps, calls, m, write, load, resume,
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

test('default protected initial finalizer publishes real preparation, closes journal and runs tail', async t => {
  const f = fixture(t);
  const result = await f.run();
  assert.equal(result.success, true, JSON.stringify(result));
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
  assert.equal(result.completion.modeTransition, 'unknown');
  assert.ok(f.calls.indexOf('start') > f.calls.indexOf('ensure-memory'));
  assert.ok(f.calls.indexOf('restart') > f.calls.indexOf('verify'));
  assertDataPreserved(f);
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

for (const failure of [false, true]) test(`default ordinary finalizer ${failure ? 'rejects invalid settings before publication' : 'migrates and publishes without a journal'}`, async t => {
  const f = fixture(t, { protectedUpgrade: false });
  if (failure) f.write('.claude/settings.json', 'broken');
  const result = await f.run();
  assert.equal(result.success, !failure, JSON.stringify(result));
  assert.equal(fs.existsSync(path.join(f.root, '.backup/self-upgrade')), false);
  assert.equal(fs.existsSync(path.join(f.root, '.backup/db')), false);
  if (failure) {
    assert.equal(f.read('CLAUDE.md'), 'old Claude output');
    assert.equal(f.read('.claude/settings.json'), 'broken');
    assert.equal(f.calls.includes('start'), false);
    assert.equal(f.calls.includes('restart'), false);
  } else {
    assert.match(f.read('CLAUDE.md'), /private user instructions/);
    assert.equal(result.settingsChanged, true);
    assert.equal(f.calls.includes('start'), true);
  }
  assertDataPreserved(f);
});

test('ordinary tail failure retains published bytes and stops before services with a manual next step', async t => {
  const f = fixture(t, { protectedUpgrade: false });
  const result = await f.run({ ensureMemoryMigration() { throw Error('memory prerequisite failed'); } });
  assert.equal(result.success, false);
  assert.match(result.error, /memory prerequisite failed/);
  assert.equal(result.recovery_required, undefined);
  assert.doesNotMatch(result.next, /resume-finalize/);
  assert.equal(fs.existsSync(path.join(f.root, '.backup/self-upgrade')), false);
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
  assert.match(result.error, /snapshot manifest hash mismatch/);
  assert.equal(f.load().phase, 'installing');
  assert.deepEqual(f.calls, []);
  assert.equal(f.read('CLAUDE.md'), 'old Claude output');
  assert.equal(fs.existsSync(path.join(f.dir, 'runtime-preparation')), false);
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
  const failed = await f.run({ dashboardOwner: null, publication: { afterStep(step) {
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
    const budget = { check() {}, remaining: () => 100000, deadlineAt: Date.now()+100000 };
    await runSelfUpgradeFinalize(state, {
      zylosDir: root, budget,
      syncSkills: () => ({step:5, status:'done'}),
      step6: {skillsDir: root+'/.claude/skills', execSync: () => ''},
      prepareRuntimeClis: () => ({completed:['claude.cli','codex.cli'],failed:[]}),
      prepareRuntime: ctx => prepareUpgradeRuntime(ctx, {budget, packageRoot, homeDir:home, stopFailureSupported:false}),
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

test('real frozen parents time out after 180 seconds and recover according to the actual cutoff', {
  skip: process.env.P11_REAL_FROZEN_TIMEOUT !== '1' || process.platform !== 'linux',
  timeout: 250000,
}, async t => {
  const temporaryBase = process.env.P11_REAL_TIMEOUT_ROOT || os.tmpdir();
  fs.mkdirSync(temporaryBase, { recursive: true, mode: 0o700 });
  const cases = [];
  for (const version of ['0.9.0', '0.9.1']) for (const closed of [true, false]) {
    const f = fixture(t, { temporaryBase });
    const frozen = path.join(import.meta.dirname, 'fixtures', `upgrade-${version}`);
    // Preserve exact old controller/worker bytes while retaining the real
    // independently copied SQLite runtime prepared by the fixture.
    for (const [source, target] of [['upgrade-maintenance.cjs', 'maintenance.cjs'],
      ['upgrade-recovery.cjs', 'runner.cjs'], ['core-db-backup-worker.js', 'sqlite-runtime/core-db-backup-worker.js']]) {
      fs.copyFileSync(path.join(frozen, source), path.join(f.dir, target));
      fs.chmodSync(path.join(f.dir, target), 0o600);
    }
    const journal = f.load();
    journal.initialIdentity.workerHash = f.m.hash(journal.initialIdentity.workerPath);
    for (const owner of journal.coreManifest) {
      fs.cpSync(path.join(journal.skillsDir, owner.name), path.join(f.dir, 'code/skills', owner.name), {
        recursive: true, filter: file => !file.split(path.sep).includes('node_modules'),
      });
    }
    fs.chmodSync(path.join(f.dir, 'code'), 0o700);
    const descriptor = f.m.read(path.join(f.dir, 'descriptor.json'));
    for (const name of ['maintenance.cjs', 'runner.cjs']) descriptor.hashes[name] = f.m.hash(path.join(f.dir, name));
    f.m.durable(path.join(f.dir, 'descriptor.json'), descriptor);
    f.m.durable(path.join(f.dir, 'journal.json'), journal);
    const db = new Database(path.join(f.root, 'comm-bridge/c4.db'));
    db.prepare('INSERT INTO checkpoints(id, summary) VALUES (?, ?)').run(99, 'post-snapshot sentinel');
    db.close();
    const initialShared = Object.fromEntries(['CLAUDE.md', 'AGENTS.md', '.claude/settings.json'].map(name => [name, f.m.hash(path.join(f.root, name))]));
    const statePath = path.join(f.home, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify(f.state));
    const childPath = path.join(f.home, 'target-finalizer.mjs');
    fs.writeFileSync(childPath, `
      import fs from 'node:fs';
      import path from 'node:path';
      import { createRequire } from 'node:module';
      import { runSelfUpgradeFinalize } from ${JSON.stringify(new URL('../self-upgrade.js', import.meta.url).href)};
      import { prepareUpgradeRuntime } from ${JSON.stringify(new URL('../upgrade-runtime-preparation.js', import.meta.url).href)};
      const state = JSON.parse(fs.readFileSync(process.argv[2]));
      const root = ${JSON.stringify(f.root)}, home = ${JSON.stringify(f.home)};
      const m = createRequire(import.meta.url)(${JSON.stringify(path.join(f.root, '.zylos/upgrade/maintenance.cjs'))});
      const budget = {check(){}, remaining:()=>360000, deadlineAt:Date.now()+360000};
      const block = () => {
        const j = m.read(path.join(state.transactionDir, 'journal.json'));
        fs.writeFileSync(path.join(home, 'child-ready.json'), JSON.stringify({pid:process.pid,phase:j.phase,
          liveHash:m.hash(path.join(root,'comm-bridge/c4.db')),
          shared:Object.fromEntries(['CLAUDE.md','AGENTS.md','.claude/settings.json'].map(name=>[name,m.hash(path.join(root,name))]))}));
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,360000);
        throw Error('parent failed to enforce its real timeout');
      };
      const result = await runSelfUpgradeFinalize(state, {
        zylosDir:root,budget,syncSkills:()=>({step:5,status:'done'}),
        step6:{skillsDir:root+'/.claude/skills',execSync:()=>''},
        prepareRuntimeClis:()=>({completed:['claude.cli','codex.cli'],failed:[]}),
        prepareRuntime:ctx=>${closed ? 'prepareUpgradeRuntime(ctx,{budget,packageRoot:' + JSON.stringify(packageRoot) + ',homeDir:home,stopFailureSupported:false})' : 'block()'},
        dashboardOwner:{copyDashboardDb:()=>({ok:true})},
        publication:{afterStep:step=>{if(step==='t02')block();}},
        startServices(){throw Error('service start forbidden before timeout');}
      });
      throw Error('target returned before timeout: '+JSON.stringify(result));
    `);
    const driverPath = path.join(f.home, 'frozen-parent.mjs');
    fs.writeFileSync(driverPath, `
      import assert from 'node:assert/strict';
      import fs from 'node:fs';
      import path from 'node:path';
      import {createRequire} from 'node:module';
      import {spawnSync} from 'node:child_process';
      import {compileFunction} from 'node:vm';
      const require=createRequire(import.meta.url),dir=${JSON.stringify(f.dir)},root=${JSON.stringify(f.root)};
      const m=require(path.join(dir,'maintenance.cjs')),recovery=require(path.join(dir,'runner.cjs'));
      const services=[];m.stop=()=>services.push('stop');m.start=()=>services.push('start');m.verifyServices=()=>services.push('verify');
      const source=fs.readFileSync(${JSON.stringify(path.join(frozen, 'self-upgrade.js'))},'utf8');
      const start=source.indexOf('function runInstalledFinalizer(ctx) {'),end=source.indexOf('\\nexport function runSelfUpgradeFinalize',start);
      assert.ok(start>=0&&end>start);
      const run=compileFunction(source.slice(start,end)+'\\nreturn runInstalledFinalizer(ctx);',
        ['ctx','maintenanceFor','resolveInstalledPackageScript','writeFinalizeState','spawnSync','process','path','requireFinalizerExit']);
      const began=performance.now();let timeout;
      try {run({preInstallProtection:true,transactionDir:dir},()=>m,()=>${JSON.stringify(childPath)},()=>${JSON.stringify(statePath)},
        spawnSync,process,path,(target,j,terminate)=>require(path.join(target,'finalizer.cjs')).quiesce(target,j,{terminate}));}
      catch(error){timeout=error;}
      const elapsedMs=performance.now()-began;
      assert.equal(timeout?.code,'ETIMEDOUT',timeout?.stack);
      assert.ok(elapsedMs>=179000&&elapsedMs<220000,'actual elapsed '+elapsedMs);
      const ready=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(f.home, 'child-ready.json'))}));
      const j=m.read(path.join(dir,'journal.json'));
      assert.equal(j.finalizerExitConfirmed,true);assert.equal(j.finalizerExitUnconfirmed,false);
      assert.deepEqual(require(path.join(dir,'finalizer.cjs')).members(ready.pid),[]);
      assert.equal(ready.phase,${JSON.stringify(closed ? 'compensation_closed' : 'installing')});
      ${closed ? '' : 'assert.deepEqual(ready.shared,' + JSON.stringify(initialShared) + ');'}
      const result=recovery.resume(dir),saved=m.read(path.join(dir,'journal.json'));
      const hash=m.hash(path.join(root,'comm-bridge/c4.db'));
      if(${closed}) {
        assert.equal(result.recovery_required,true,JSON.stringify(result));
        assert.equal(saved.phase,'recovery_required');assert.equal(saved.resumePhase,'compensation_closed');
        assert.equal(hash,ready.liveHash);assert.equal(fs.existsSync(path.join(dir,'rescue')),false);
        assert.equal(saved.dbRestore,undefined);assert.equal(saved.codeRestore,undefined);
        assert.equal(services.includes('start'),false);
      } else {
        assert.equal(result.stage,'restored_complete',JSON.stringify(result));assert.equal(result.recovery_required,false);
        const manifest=m.read(path.join(saved.dbBackupDir,'manifest.json'));
        const row=manifest.databases.find(item=>item.source==='comm-bridge/c4.db');
        assert.equal(hash,row.sha256);assert.notEqual(hash,ready.liveHash);
        assert.deepEqual(services,['stop','start','verify']);
        const shared=Object.fromEntries(Object.keys(ready.shared).map(name=>[name,m.hash(path.join(root,name))]));
        assert.deepEqual(shared,ready.shared);
      }
      process.stdout.write(JSON.stringify({version:${JSON.stringify(version)},closed:${closed},elapsedMs,
        exitConfirmed:j.finalizerExitConfirmed,childPid:ready.pid,phase:saved.phase,resumePhase:saved.resumePhase,
        services,liveHash:hash,preRecoveryHash:ready.liveHash,result}));
    `);
    cases.push({ f, version, closed, driverPath });
  }
  const results = await Promise.allSettled(cases.map(({ f, version, closed, driverPath }) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driverPath], { encoding: 'utf8', detached: true,
      env: { ...process.env, HOME: f.home, ZYLOS_DIR: f.root, PM2_HOME: path.join(f.home, '.pm2') } });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    const watchdog = setTimeout(() => {
      // Only identities written by this isolated target can be signalled.
      const readyPath = path.join(f.home, 'child-ready.json');
      if (fs.existsSync(readyPath)) {
        const { pid } = JSON.parse(fs.readFileSync(readyPath));
        if (Number.isSafeInteger(pid) && pid > 1) try { process.kill(-pid, 'SIGKILL'); } catch {}
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      reject(Error(`frozen ${version} closed=${closed} exceeded outer watchdog`));
    }, 230000);
    child.once('error', error => { clearTimeout(watchdog); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(watchdog);
      if (code !== 0) reject(Error(`frozen ${version} closed=${closed}: exit=${code} signal=${signal}\n${stderr}\n${stdout}`));
      else {
        try { const evidence = JSON.parse(stdout); t.diagnostic(JSON.stringify(evidence)); resolve(evidence); }
        catch (error) { reject(error); }
      }
    });
  })));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  assert.equal(results.length, 4);
});
