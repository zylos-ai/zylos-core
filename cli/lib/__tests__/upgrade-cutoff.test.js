import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import maintenance from '../upgrade-maintenance.cjs';
import { closeCompensation, prepareTargetData, protectedDataReady, protectedSuccess, saveProtectedCode } from '../upgrade-protection.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'uc-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const dir = path.join(root, '.backup/self-upgrade/tx');
  fs.mkdirSync(path.join(dir, 'code'), {recursive:true, mode:0o700});
  const j = {
    formatVersion:1, transactionId:'tx', targetOwned:true, zylosDir:root,
    from:'0.9.3', to:'0.9.4', phase:'installing', installationIntent:true, databaseMode:'unchanged',
    nodePath:process.execPath, skillsDir:path.join(root, '.claude/skills'),
    dbBackupDir:path.join(root, '.backup/db/tx'), snapshotManifestHash:'a'.repeat(64),
    coreManifest:[{name:'core', existedBefore:true, backedUp:true, originalHash:'b'.repeat(64)}],
    originalServices:[], cleanup:{complete:false},
    initialIdentity:{nodePath:process.execPath, packageJson:path.join(root, 'p/package.json'), packageHash:'c'.repeat(64),
      cliRoot:path.join(root, 'p/cli'), cliHash:'d'.repeat(64), workerPath:path.join(root, 'p/cli/lib/worker.js'),
      workerHash:'e'.repeat(64), ecosystemHash:null, databases:maintenance.DB_PATHS.map(source => ({source, exists:true}))},
  };
  maintenance.update(dir, j);
  maintenance.marker(root, dir, j);
  return {root, dir, j, ctx:{maintenance, transactionDir:dir, transactionId:'tx', journal:j},
    read:() => maintenance.read(path.join(dir, 'journal.json'))};
}

function cutoffFor(j) {
  return {formatVersion:1, closed:true, transactionId:j.transactionId, from:j.from, to:j.to, snapshotManifestHash:j.snapshotManifestHash};
}

test('closed compensation facts survive manual forward phase transitions and existing terminal cleanup', t => {
  const f = fixture(t);
  closeCompensation(f.ctx);
  const cutoff = f.read().compensationCutoff;
  assert.deepEqual(cutoff, cutoffFor(f.j));
  maintenance.update(f.dir, f.ctx.journal, {phase:'recovery_required', resumePhase:'compensation_closed'});
  assert.equal(f.read().phase, 'recovery_required');
  assert.deepEqual(f.read().compensationCutoff, cutoff);
  // Manual publication can return to ready. Phase order must not become a guard.
  maintenance.update(f.dir, f.ctx.journal, {phase:'new_data_ready'});
  assert.equal(f.read().phase, 'new_data_ready');
  assert.deepEqual(f.read().compensationCutoff, cutoff);
  protectedSuccess(f.ctx);
  const terminal = f.read();
  assert.equal(terminal.phase, 'upgrade_complete');
  assert.deepEqual(terminal.compensationCutoff, cutoff);
  assert.equal(maintenance.terminalValid(terminal), true);
  assert.equal(terminal.cleanup.complete, true);
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/upgrade/active.json')), false);
});

test('a stale controller cannot drop or alter closed compensation facts', t => {
  const f = fixture(t);
  const stale = structuredClone(f.j);
  closeCompensation(f.ctx);
  const saved = f.read();
  assert.throws(() => maintenance.update(f.dir, stale, {phase:'installing'}), /cutoff facts are immutable/);
  for (const change of [
    {compensationCutoff:undefined},
    {compensationCutoff:{...saved.compensationCutoff, closed:false}},
    {from:'0.9.2'},
    {to:'0.9.5'},
    {transactionId:'another'},
    {snapshotManifestHash:'f'.repeat(64)},
  ]) {
    assert.throws(() => maintenance.update(f.dir, structuredClone(saved), change), /cutoff facts are immutable/);
    assert.deepEqual(f.read(), saved);
  }
});

test('malformed cutoff identities are untrusted in every phase', t => {
  const f = fixture(t);
  const good = {...f.j, compensationCutoff:cutoffFor(f.j)};
  for (const phase of ['compensation_closed', 'recovery_required', 'new_data_ready', 'new_verifying', 'upgrade_complete']) {
    assert.equal(maintenance.classifyCutoff({...good, phase}), 'closed');
    for (const fields of [{closed:false}, {transactionId:'other'}, {from:'0.9.2'}, {to:'0.9.5'}, {snapshotManifestHash:'not-a-hash'}]) {
      assert.equal(maintenance.classifyCutoff({...good, phase, compensationCutoff:{...good.compensationCutoff, ...fields}}), 'untrusted');
    }
  }
  assert.equal(maintenance.classifyCutoff({...f.j, phase:'compensation_closed'}), 'untrusted');
  assert.equal(maintenance.classifyCutoff({...f.j, phase:'recovery_required', resumePhase:'compensation_closed'}), 'untrusted');
  assert.equal(maintenance.classifyCutoff(f.j), 'none');
  for (const phase of ['new_data_ready', 'new_verifying', 'upgrade_complete']) assert.equal(maintenance.classifyCutoff({...f.j,phase}), 'untrusted');
});

test('invalid new cutoff facts are refused before durable publication', t => {
  const f = fixture(t);
  const saved = f.read();
  assert.throws(() => maintenance.update(f.dir, f.j, {phase:'compensation_closed', compensationCutoff:{...cutoffFor(f.j), from:'0.9.2'}}), /invalid compensation cutoff facts/);
  assert.deepEqual(f.read(), saved);
});

test('cutoff synchronization failure keeps the earlier transaction authoritative', t => {
  const f = fixture(t);
  const saved = f.read();
  const sync = fs.fsyncSync;
  t.mock.method(fs, 'fsyncSync', () => { throw Error('snapshot storage synchronization failed'); });
  assert.throws(() => closeCompensation(f.ctx), /synchronization failed/);
  t.mock.restoreAll();
  assert.equal(fs.fsyncSync, sync);
  assert.deepEqual(f.read(), saved);
  assert.equal(maintenance.classifyCutoff(f.read()), 'none');
  assert.equal(fs.existsSync(path.join(f.root, '.zylos/upgrade/active.json')), true);
});

test('target data preparation checks unchanged schemas without running a migration', t => {
  const f = fixture(t);
  const calls = [];
  const databases = maintenance.DB_PATHS.map(source => ({source, compatible:true}));
  prepareTargetData(f.ctx, {
    migrate:() => assert.fail('unchanged schemas must not migrate'),
    verify:payload => {
      calls.push(payload);
      return {success:true, databases};
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'offline-preflight');
  assert.equal(calls[0].requireCurrent, true);
  assert.equal(calls[0].schemaRoot, f.j.skillsDir);
  assert.deepEqual(f.ctx.databases, databases);
  assert.equal(maintenance.classifyCutoff(f.read()), 'none');
});

test('target data migration completes before cutoff and ready publication does not repeat it', t => {
  const f = fixture(t);
  maintenance.update(f.dir, f.j, {databaseMode:'migrate'});
  const calls = [];
  prepareTargetData(f.ctx, {
    migrate:payload => calls.push(payload.action),
    verify:payload => { calls.push(payload.action); return {success:true, databases:[]}; },
  });
  assert.deepEqual(calls, ['upgrade-migrate', 'offline-preflight']);
  closeCompensation(f.ctx);
  const cutoff = f.read().compensationCutoff;
  protectedDataReady(f.ctx, {
    migrate:() => assert.fail('migration repeated after cutoff'),
    verify:() => assert.fail('legacy data-ready verification repeated'),
  });
  assert.equal(f.read().phase, 'new_data_ready');
  assert.deepEqual(f.read().compensationCutoff, cutoff);
  assert.deepEqual(calls, ['upgrade-migrate', 'offline-preflight']);
});

test('failed target verification cannot publish the compensation cutoff or ready state', t => {
  const f = fixture(t);
  assert.throws(() => prepareTargetData(f.ctx, {verify:() => ({success:false, error:'Database migrations remain before data-ready'})}), /migrations remain/);
  assert.equal(f.read().phase, 'installing');
  assert.equal(maintenance.classifyCutoff(f.read()), 'none');
  assert.throws(() => protectedDataReady(f.ctx), /closed compensation cutoff/);
  assert.equal(f.read().phase, 'installing');
});


test('saving multiple core members durably records every verified dependency backup', t => {
  const f = fixture(t);
  const skills = path.join(f.root, '.claude/skills');
  const coreManifest = ['first','second'].map(name => {
    const dir = path.join(skills,name);
    fs.mkdirSync(path.join(dir,'node_modules/dependency'),{recursive:true});
    fs.writeFileSync(path.join(dir,'node_modules/dependency/value'),name);
    return {name,existedBefore:true,backedUp:false,originalHash:maintenance.treeHash(dir,{excludeNodeModules:false})};
  });
  maintenance.update(f.dir,f.j,{coreManifest});
  saveProtectedCode({...f.ctx,backupDir:path.join(f.dir,'code')});
  const saved = f.read();
  assert.deepEqual(saved.coreManifest.map(item => item.backedUp),[true,true]);
  for (const item of saved.coreManifest) assert.equal(maintenance.treeHash(path.join(f.dir,'code/skills',item.name),{excludeNodeModules:false}),item.originalHash);
});
