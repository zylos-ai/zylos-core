import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {beginUpgrade, maintenance, recovery, saveProtectedCode} from '../upgrade-protection.js';

const require = createRequire(import.meta.url);
const library = path.resolve(import.meta.dirname, '..');

function privateRecovery(t, {closed = true} = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'utr-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const stable = path.join(root, '.zylos/upgrade');
  fs.mkdirSync(stable, {recursive:true, mode:0o700});
  for (const [source, target] of [['upgrade-maintenance.cjs','maintenance.cjs'], ['upgrade-recovery.cjs','recovery.cjs']]) {
    fs.copyFileSync(path.join(library, source), path.join(stable, target));
  }
  const m = require(path.join(stable, 'maintenance.cjs'));
  const runner = require(path.join(stable, 'recovery.cjs'));
  const dir = path.join(root, '.backup/self-upgrade/tx');
  fs.mkdirSync(dir, {recursive:true, mode:0o700});
  const j = {
    formatVersion:1, transactionId:'tx', targetOwned:closed, zylosDir:root,
    from:'0.9.3', to:'0.9.4', phase:'new_data_ready', installationIntent:true,
    databaseMode:'unchanged', nodePath:process.execPath, skillsDir:path.join(root, '.claude/skills'),
    dbBackupDir:path.join(root, '.backup/db/tx'), snapshotManifestHash:'a'.repeat(64),
    coreManifest:[{name:'core', existedBefore:true, backedUp:true, originalHash:'b'.repeat(64)}],
    originalServices:[], cleanup:{complete:false},
    initialIdentity:{nodePath:process.execPath, packageJson:path.join(root, 'package.json'), packageHash:'c'.repeat(64),
      cliRoot:path.join(root, 'cli'), cliHash:'d'.repeat(64), workerPath:path.join(root, 'cli/lib/worker.js'),
      workerHash:'e'.repeat(64), ecosystemHash:null, databases:m.DB_PATHS.map(source => ({source, exists:false}))},
  };
  if (closed) j.compensationCutoff = {formatVersion:1, closed:true, transactionId:j.transactionId,
    from:j.from, to:j.to, snapshotManifestHash:j.snapshotManifestHash};
  m.update(dir, j);
  return {root, dir, j, m, runner, load:() => m.read(path.join(dir, 'journal.json'))};
}

test('target-owned core backup and compensation restore the entire dependency tree', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'utd-')));
  let ctx;
  t.after(() => { ctx?.releaseControl?.(); fs.rmSync(root, {recursive:true, force:true}); });
  const coreDir = path.join(root, 'package');
  const tempDir = path.join(root, 'incoming');
  const zylosDir = path.join(root, 'h/zylos');
  const skillsDir = path.join(zylosDir, '.claude/skills');
  for (const base of [coreDir, tempDir]) fs.mkdirSync(path.join(base, 'skills/core'), {recursive:true});
  fs.mkdirSync(path.join(coreDir, 'cli/lib'), {recursive:true});
  fs.writeFileSync(path.join(coreDir, 'package.json'), '{"name":"zylos","version":"0.9.3"}');
  fs.writeFileSync(path.join(coreDir, 'cli/lib/core-db-backup-worker.js'), '// original worker\n');
  const skill = path.join(skillsDir, 'core');
  const dependency = path.join(skill, 'node_modules/dependency');
  fs.mkdirSync(path.join(dependency, 'nested'), {recursive:true});
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'original core\n');
  fs.writeFileSync(path.join(dependency, 'index.js'), 'original dependency\n', {mode:0o640});
  fs.writeFileSync(path.join(dependency, 'nested/original.txt'), 'original nested\n');
  fs.symlinkSync('index.js', path.join(dependency, 'entry.js'));
  const expectedHash = maintenance.treeHash(skill, {excludeNodeModules:false});
  ctx = {coreDir, tempDir, from:'0.9.3', to:'0.9.4', targetOwned:true, databaseMode:'unchanged'};
  const services = t.mock.method(maintenance, 'services', () => []);
  try { beginUpgrade(ctx, {zylosDir, skillsDir}); }
  finally { services.mock.restore(); }
  const m = ctx.maintenance || maintenance;
  const entry = ctx.journal.coreManifest.find(item => item.name === 'core');
  assert.equal(entry.originalHash, expectedHash);
  assert.notEqual(entry.originalHash, maintenance.treeHash(skill));
  saveProtectedCode(ctx);
  const saved = m.read(path.join(ctx.transactionDir, 'journal.json'));
  assert.equal(saved.coreManifest[0].backedUp, true);
  assert.equal(maintenance.treeHash(path.join(ctx.backupDir, 'skills/core'), {excludeNodeModules:false}), expectedHash);
  assert.equal(fs.readFileSync(path.join(ctx.backupDir, 'skills/core/node_modules/dependency/index.js'), 'utf8'), 'original dependency\n');
  fs.writeFileSync(path.join(dependency, 'index.js'), 'installed dependency\n');
  fs.chmodSync(path.join(dependency, 'index.js'), 0o755);
  fs.rmSync(path.join(dependency, 'nested'), {recursive:true});
  fs.writeFileSync(path.join(dependency, 'new.txt'), 'installed addition\n');
  fs.unlinkSync(path.join(dependency, 'entry.js'));
  fs.symlinkSync('new.txt', path.join(dependency, 'entry.js'));
  assert.notEqual(maintenance.treeHash(skill, {excludeNodeModules:false}), expectedHash);
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'installed core\n');
  m.update(ctx.transactionDir, saved, {phase:'installing', installationIntent:true});
  assert.notEqual(maintenance.treeHash(skill, {excludeNodeModules:false}), expectedHash);
  // Exercise the same frozen compensation operation called by resume, without
  // database/package replacement: those have separate unit/integration coverage.
  const runner = require(path.join(zylosDir, '.zylos/upgrade/recovery.cjs'));
  runner.restoreCore(ctx.transactionDir, saved);
  assert.equal(maintenance.treeHash(skill, {excludeNodeModules:false}), expectedHash);
  assert.equal(fs.readFileSync(path.join(dependency, 'index.js'), 'utf8'), 'original dependency\n');
  assert.equal(fs.statSync(path.join(dependency, 'index.js')).mode & 0o777, 0o640);
  assert.equal(fs.readFileSync(path.join(dependency, 'nested/original.txt'), 'utf8'), 'original nested\n');
  assert.equal(fs.readlinkSync(path.join(dependency, 'entry.js')), 'index.js');
  assert.equal(fs.existsSync(path.join(dependency, 'new.txt')), false);
  assert.equal(m.read(path.join(ctx.transactionDir, 'journal.json')).codeRestore.core.complete, true);
});

test('terminal validation rejects closed compensation on an otherwise valid restored terminal', t => {
  const f = privateRecovery(t);
  const terminal = {...structuredClone(f.j), phase:'restored_complete',
    cleanup:{complete:true, servicesRestored:true}, terminalEvidence:{verified:true, kind:'code_data_services'}};
  const legacy = structuredClone(terminal);
  delete legacy.compensationCutoff;
  legacy.targetOwned = false;
  assert.equal(f.m.terminalValid(legacy), true);
  assert.equal(f.m.terminalValid({...terminal, phase:'upgrade_complete'}), true);
  assert.equal(f.m.terminalValid(terminal), false);
});

test('parent failure stops at the closed cutoff without changing the resume phase to restoration', t => {
  const f = privateRecovery(t);
  const calls = [];
  t.mock.method(f.m, 'stop', j => { calls.push(['stop', j.transactionId]); });
  const release = () => calls.push(['release']);
  const result = recovery({maintenance:f.m, journal:structuredClone(f.j), transactionId:f.j.transactionId,
    transactionDir:f.dir, releaseControl:release});
  assert.equal(result.recovery_required, true);
  assert.equal(result.attempted, false);
  assert.equal(result.completed, false);
  assert.match(result.error, /^compensation is closed;/);
  const saved = f.load();
  assert.equal(saved.phase, 'recovery_required');
  assert.equal(saved.resumePhase, 'new_data_ready');
  assert.deepEqual(saved.compensationCutoff, f.j.compensationCutoff);
  assert.deepEqual(f.m.read(path.join(f.root, '.zylos/upgrade/active.json')).transactionDir, f.dir);
  assert.deepEqual(calls, [['stop','tx'], ['release']]);
  assert.equal(saved.codeRestore, undefined);
  assert.equal(saved.dbRestore, undefined);
});

test('frozen recovery refuses the closed cutoff before starting services or entering restoration', t => {
  const f = privateRecovery(t);
  const calls = [];
  const read = f.m.read;
  t.mock.method(f.m, 'read', file => { if (path.basename(file) === 'descriptor.json') calls.push('descriptor'); return read(file); });
  t.mock.method(f.m, 'stop', () => calls.push('stop'));
  t.mock.method(f.m, 'start', () => calls.push('start'));
  t.mock.method(f.m, 'verifyServices', () => calls.push('verifyServices'));
  t.mock.method(f.m, 'preflight', () => { calls.push('preflight'); return {success:true}; });
  t.mock.method(f.m, 'sync', () => calls.push('restoreCore'));
  t.mock.method(f.m, 'restoreOriginalPackage', () => calls.push('restorePackage'));
  let owner;
  if (process.platform === 'darwin') owner = f.m.acquire(f.dir);
  let result;
  try { result = f.runner.resume(f.dir, owner ? {ownership:owner.withOwnership} : {}); }
  finally { owner?.(); }
  assert.equal(result.attempted, false);
  assert.equal(result.completed, false);
  assert.equal(result.recovery_required, true);
  assert.match(result.error, /^compensation is closed;/);
  assert.equal(result.stage, 'recovery_required');
  assert.deepEqual(calls, ['stop']);
  const saved = f.load();
  assert.equal(saved.phase, 'recovery_required');
  assert.equal(saved.resumePhase, 'new_data_ready');
  assert.equal(saved.codeRestore, undefined);
  assert.equal(saved.dbRestore, undefined);
  assert.deepEqual(saved.compensationCutoff, f.j.compensationCutoff);
  assert.equal(f.m.read(path.join(f.root, '.zylos/upgrade/active.json')).transactionDir, f.dir);
});

// A matching legacy ready journal proves the private fixture reaches the ready
// path when no target-owned cutoff forbids it.
test('frozen recovery can finish an unchanged legacy ready journal in the same private fixture', t => {
  const f = privateRecovery(t, {closed:false});
  const calls = [];
  t.mock.method(f.m, 'start', () => calls.push('start'));
  t.mock.method(f.m, 'verifyServices', () => calls.push('verifyServices'));
  let owner;
  if (process.platform === 'darwin') owner = f.m.acquire(f.dir);
  let result;
  try { result = f.runner.resume(f.dir, owner ? {ownership:owner.withOwnership} : {}); }
  finally { owner?.(); }
  assert.equal(result.recovery_required, false, JSON.stringify(result));
  assert.equal(result.stage, 'upgrade_complete');
  assert.deepEqual(calls, ['start', 'verifyServices']);
  assert.equal(f.load().cleanup.complete, true);
});
