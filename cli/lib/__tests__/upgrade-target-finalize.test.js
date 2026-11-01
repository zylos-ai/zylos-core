import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';

// Import configuration only after isolating every deployment-derived path.
const suiteRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'utf-')));
const savedEnvironment = {...process.env};
for (const [key, value] of Object.entries({
  HOME:path.join(suiteRoot, 'h'), ZYLOS_DIR:path.join(suiteRoot, 'h/zylos'),
  PM2_HOME:path.join(suiteRoot, 'pm2'), TMPDIR:path.join(suiteRoot, 't'),
})) {
  fs.mkdirSync(value, {recursive:true});
  process.env[key] = value;
}
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in savedEnvironment)) delete process.env[key];
  Object.assign(process.env, savedEnvironment);
  fs.rmSync(suiteRoot, {recursive:true, force:true});
});
const {runSelfUpgradeFinalize, step7_syncInstructions} = await import('../self-upgrade.js');
const {maintenance, recovery} = await import('../upgrade-protection.js');
const packageRoot = fs.realpathSync(path.join(import.meta.dirname, '../../..'));
const targetVersion = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version;

function fixture(t) {
  const root = process.env.ZYLOS_DIR;
  fs.mkdirSync(root, {recursive:true});
  const transactionDir = path.join(root, '.backup/self-upgrade/tx');
  const tempDir = path.join(root, 'download');
  fs.mkdirSync(transactionDir, {recursive:true});
  fs.mkdirSync(tempDir);
  const journal = {
    formatVersion:1, transactionId:'tx', targetOwned:true, zylosDir:root,
    from:'0.9.3', to:targetVersion, phase:'installing', installationIntent:true,
    databaseMode:'unchanged', nodePath:process.execPath,
    skillsDir:path.join(root, '.claude/skills'),
    dbBackupDir:path.join(root, '.backup/db/tx'), snapshotManifestHash:'a'.repeat(64),
    coreManifest:[{name:'core', existedBefore:true, backedUp:true, originalHash:'b'.repeat(64)}],
    originalServices:[], cleanup:{complete:false},
    initialIdentity:{nodePath:process.execPath, packageJson:path.join(root, 'original/package.json'),
      packageHash:'c'.repeat(64), cliRoot:path.join(root, 'original/cli'), cliHash:'d'.repeat(64),
      workerPath:path.join(root, 'original/cli/lib/worker.js'), workerHash:'e'.repeat(64),
      ecosystemHash:null, databases:maintenance.DB_PATHS.map(source => ({source, exists:true}))},
  };
  maintenance.update(transactionDir, journal);
  maintenance.marker(root, transactionDir, journal);
  const state = {
    schemaVersion:2, preInstallProtection:true, targetOwned:true, packageRoot,
    transactionDir, transactionId:'tx', tempDir, from:journal.from, to:journal.to,
    newVersion:journal.to, databaseMode:'unchanged', servicesWereRunning:[],
  };
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return {root, transactionDir, journal, state,
    read:() => maintenance.read(path.join(transactionDir, 'journal.json'))};
}

for (const failedStep of [8, 9, 10]) {
  test(`target finalization closes compensation before publication failure at step ${failedStep}`, t => {
    const f = fixture(t);
    const workerCalls = [];
    t.mock.method(childProcess, 'spawnSync', (executable, args) => {
      assert.equal(executable, process.execPath);
      assert.equal(args[0], path.join(packageRoot, 'cli/lib/core-db-backup-worker.js'));
      const payload = JSON.parse(args[1]);
      assert.deepEqual(payload, {action:'offline-preflight', zylosDir:f.root,
        schemaRoot:f.journal.skillsDir, requireCurrent:true});
      workerCalls.push(payload);
      return {status:0, stdout:JSON.stringify({success:true, databases:[]}), stderr:''};
    });
    syncBuiltinESMExports();
    t.after(() => {t.mock.restoreAll(); syncBuiltinESMExports();});
    const noRestore = t.mock.method(maintenance, 'restoreOriginalPackage', () => assert.fail('restoration after shared publication'));
    const stop = t.mock.method(maintenance, 'stop', journal => {
      assert.equal(journal.transactionId, f.journal.transactionId);
      assert.equal(maintenance.classifyCutoff(journal), 'closed');
    });
    const result = runSelfUpgradeFinalize(f.state, {steps:[
      step7_syncInstructions,
      () => ({step:failedStep, name:'publication_failure', status:'failed', error:'publication unavailable'}),
      () => assert.fail('finalization continued after failure'),
    ]});
    assert.equal(result.success, false);
    assert.equal(result.failedStep, failedStep);
    assert.equal(result.steps[0].step, 7);
    assert.equal(result.steps[0].status, 'skipped');
    assert.equal(workerCalls.length, 1);
    assert.equal(result.compensationClosed, true);
    assert.equal(result.automaticCompensation, false);
    assert.deepEqual(result.rollback, {performed:false, steps:[]});
    const beforeRecovery = f.read();
    assert.equal(beforeRecovery.phase, 'compensation_closed');
    assert.equal(maintenance.classifyCutoff(beforeRecovery), 'closed');
    assert.deepEqual(beforeRecovery.compensationCutoff, {
      formatVersion:1, closed:true, transactionId:'tx', from:f.journal.from,
      to:f.journal.to, snapshotManifestHash:f.journal.snapshotManifestHash,
    });
    const recovered = recovery({journal:f.journal, transactionId:'tx', transactionDir:f.transactionDir});
    assert.equal(recovered.recovery_required, true);
    assert.equal(recovered.attempted, false);
    assert.equal(recovered.completed, false);
    const saved = f.read();
    assert.equal(saved.phase, 'recovery_required');
    assert.equal(saved.resumePhase, 'compensation_closed');
    assert.deepEqual(saved.compensationCutoff, beforeRecovery.compensationCutoff);
    assert.equal(noRestore.mock.callCount(), 0);
    assert.equal(stop.mock.callCount(), 1);
    assert.equal(workerCalls.length, 1, 'recovery must not spawn a restore worker');
    assert.equal(maintenance.read(path.join(f.root, '.zylos/upgrade/active.json')).transactionDir, f.transactionDir);
  });
}

test('target finalization rejects a different package root even at the same version', t => {
  const f = fixture(t);
  const otherRoot = path.join(f.root, 'same-version-package');
  fs.mkdirSync(otherRoot);
  fs.writeFileSync(path.join(otherRoot, 'package.json'), JSON.stringify({name:'zylos', version:targetVersion}));
  const before = f.read();
  const result = runSelfUpgradeFinalize({...f.state, packageRoot:otherRoot}, {
    steps:[() => assert.fail('steps ran from the wrong target package')],
  });
  assert.equal(result.success, false);
  assert.equal(result.recovery_required, true);
  assert.match(result.error, /installed target finalizer identity mismatch/);
  assert.deepEqual(result.rollback, {attempted:false, completed:false, performed:false});
  assert.deepEqual(f.read(), before);
});

test('target finalization rejects a journal without target ownership', t => {
  const f = fixture(t);
  delete f.journal.targetOwned;
  maintenance.update(f.transactionDir, f.journal);
  const before = f.read();
  const result = runSelfUpgradeFinalize(f.state, {
    steps:[() => assert.fail('steps ran without target-owned admission')],
  });
  assert.equal(result.success, false);
  assert.equal(result.recovery_required, true);
  assert.match(result.error, /installed target finalizer identity mismatch/);
  assert.deepEqual(result.rollback, {attempted:false, completed:false, performed:false});
  assert.deepEqual(f.read(), before);
});
