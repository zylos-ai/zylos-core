import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const library = path.resolve(import.meta.dirname, '..');
const source = require(path.join(library, 'upgrade-maintenance.cjs'));

// A deployment whose global package lives at <prefix>/lib/node_modules/zylos and
// whose transaction saved that package under code/original-package. Recovery
// helpers are the transaction's frozen copies, as during a real resume.
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-install-staging-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const zylosDir = path.join(root, 'zylos'), modules = path.join(root, 'prefix/lib/node_modules');
  const sourceRoot = path.join(modules, 'zylos');
  const dir = path.join(zylosDir, '.backup/self-upgrade/tx');
  fs.mkdirSync(dir, {recursive:true});
  writePackage(sourceRoot);
  const snapshot = path.join(dir, 'code/original-package');
  source.copyTreePreservingModes(sourceRoot, snapshot);
  const files = [['../../skills/comm-bridge/scripts/remove-owned-tree.js', 'remove-owned-tree.mjs'],
    ['upgrade-maintenance.cjs', 'maintenance.cjs'], ['upgrade-recovery.cjs', 'runner.cjs']];
  for (const [from, name] of files) fs.copyFileSync(path.join(library, from), path.join(dir, name));
  const m = require(path.join(dir, 'maintenance.cjs'));
  const j = {formatVersion:1, phase:'restored_data_ready', databaseMode:'unchanged', transactionId:'tx', zylosDir,
    installationIntent:true, nodePath:process.execPath, skillsDir:path.join(zylosDir, '.claude/skills'),
    recoveryHashes:{'remove-owned-tree.mjs':m.hash(path.join(dir, 'remove-owned-tree.mjs'))},
    initialIdentity:{nodePath:process.execPath, packageJson:path.join(sourceRoot, 'package.json'), packageHash:'b'.repeat(64)},
    originalPackage:{path:snapshot, sourceRoot, sourceVersion:'1.0.0',
      treeHash:m.treeHash(snapshot, {excludeNodeModules:false, includeModes:true})},
    coreManifest:[], originalServices:[]};
  m.update(dir, j);
  const staging = m.npmRetiredPath(sourceRoot);
  return {root, dir, j, m, modules, sourceRoot, snapshot, staging};
}

function writePackage(directory, {version = '1.0.0'} = {}) {
  fs.mkdirSync(path.join(directory, 'cli/lib'), {recursive:true});
  fs.mkdirSync(path.join(directory, 'node_modules/dep'), {recursive:true});
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({name:'zylos', version, bin:{zylos:'cli/zylos.js'}}));
  fs.writeFileSync(path.join(directory, 'cli/zylos.js'), '#!/usr/bin/env node\n', {mode:0o755});
  fs.writeFileSync(path.join(directory, 'cli/lib/index.js'), 'export {};\n');
  fs.writeFileSync(path.join(directory, 'node_modules/dep/index.js'), 'module.exports = 1;\n');
  fs.symlinkSync('../cli/zylos.js', path.join(directory, 'node_modules/zylos-link'));
}

// What npm leaves when it is killed after moving the installed package aside.
function leaveMovedAsideCopy(f, target = f.staging) {
  source.copyTreePreservingModes(f.snapshot, target);
  return target;
}

test('the staging name is the sibling npm moves the installed package to', () => {
  // Values produced by @npmcli/arborist lib/retire-path.js for the same paths.
  assert.equal(source.npmRetiredPath('/usr/local/lib/node_modules/zylos'), '/usr/local/lib/node_modules/.zylos-k2sH85eN');
  assert.equal(source.npmRetiredPath('/opt/node/lib/node_modules/zylos'), '/opt/node/lib/node_modules/.zylos-lqeCmPs4');
});

test('a copy of the saved original package left by an interrupted install is removed', t => {
  const f = fixture(t);
  leaveMovedAsideCopy(f);
  assert.deepEqual(f.m.removeInterruptedInstallStaging(f.dir, f.j), {removed:f.staging});
  assert.equal(fs.existsSync(f.staging), false);
  assert.equal(fs.existsSync(path.join(f.sourceRoot, 'package.json')), true, 'the installed package stays');
  assert.equal(fs.existsSync(f.snapshot), true, 'the saved original package stays');
});

test('a copy npm had partly deleted after moving it aside is removed', t => {
  const f = fixture(t);
  leaveMovedAsideCopy(f);
  fs.rmSync(path.join(f.staging, 'node_modules'), {recursive:true});
  fs.rmSync(path.join(f.staging, 'package.json'));
  assert.deepEqual(f.m.removeInterruptedInstallStaging(f.dir, f.j), {removed:f.staging});
  assert.equal(fs.existsSync(f.staging), false);
});

test('nothing happens when npm left no staging directory', t => {
  const f = fixture(t);
  assert.deepEqual(f.m.removeInterruptedInstallStaging(f.dir, f.j), {});
});

test('a similarly named directory that is not the staging name for this install target is kept', t => {
  const f = fixture(t);
  const similar = leaveMovedAsideCopy(f, path.join(f.modules, '.zylos-AAAAAAAA'));
  // The name npm would use for a package installed under a different prefix.
  const otherRoot = leaveMovedAsideCopy(f, path.join(f.modules, path.basename(f.m.npmRetiredPath(path.join(f.root, 'other/lib/node_modules/zylos')))));
  assert.deepEqual(f.m.removeInterruptedInstallStaging(f.dir, f.j), {});
  assert.equal(fs.existsSync(similar), true);
  assert.equal(fs.existsSync(otherRoot), true);
});

test('staging directories of other packages are kept', t => {
  const f = fixture(t);
  const other = path.join(f.modules, 'other');
  fs.mkdirSync(other);
  const otherStaging = f.m.npmRetiredPath(other);
  fs.mkdirSync(otherStaging);
  fs.writeFileSync(path.join(otherStaging, 'package.json'), '{"name":"other"}');
  leaveMovedAsideCopy(f);
  assert.deepEqual(f.m.removeInterruptedInstallStaging(f.dir, f.j), {removed:f.staging});
  assert.equal(fs.existsSync(path.join(otherStaging, 'package.json')), true);
  assert.equal(fs.existsSync(other), true);
});

test('the staging name holding files that are not in the saved original package is kept with a warning', t => {
  for (const change of [
    staging => fs.writeFileSync(path.join(staging, 'cli/lib/extra.js'), 'new\n'),
    staging => fs.writeFileSync(path.join(staging, 'cli/lib/index.js'), 'export const changed = 1;\n'),
    staging => fs.writeFileSync(path.join(staging, 'package.json'), JSON.stringify({name:'zylos', version:'9.9.9'})),
    staging => { fs.rmSync(path.join(staging, 'node_modules/zylos-link')); fs.symlinkSync('../package.json', path.join(staging, 'node_modules/zylos-link')); },
    staging => { fs.rmSync(path.join(staging, 'cli/lib/index.js')); fs.mkdirSync(path.join(staging, 'cli/lib/index.js')); },
  ]) {
    const f = fixture(t);
    leaveMovedAsideCopy(f);
    change(f.staging);
    const result = f.m.removeInterruptedInstallStaging(f.dir, f.j);
    assert.equal(result.removed, undefined);
    assert.ok(result.warning.includes(f.staging), result.warning);
    assert.match(result.warning, /not identical to the saved original package/);
    assert.match(result.warning, /ENOTEMPTY/);
    assert.equal(fs.existsSync(path.join(f.staging, 'cli')), true);
  }
});

test('a staging name that is a symlink is kept without following it', t => {
  const f = fixture(t);
  const elsewhere = leaveMovedAsideCopy(f, path.join(f.root, 'elsewhere'));
  fs.symlinkSync(elsewhere, f.staging);
  const result = f.m.removeInterruptedInstallStaging(f.dir, f.j);
  assert.match(result.warning, /it is not a directory/);
  assert.equal(fs.lstatSync(f.staging).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(elsewhere, 'package.json')), true);
});

test('the staging directory is kept when the saved original package no longer matches its record', t => {
  const f = fixture(t);
  leaveMovedAsideCopy(f);
  fs.writeFileSync(path.join(f.snapshot, 'cli/lib/index.js'), 'export const changed = 1;\n');
  fs.writeFileSync(path.join(f.staging, 'cli/lib/index.js'), 'export const changed = 1;\n');
  const result = f.m.removeInterruptedInstallStaging(f.dir, f.j);
  assert.match(result.warning, /saved original package changed/);
  assert.equal(fs.existsSync(f.staging), true);
});

test('nothing is examined for a transaction that never started installing', t => {
  const f = fixture(t);
  leaveMovedAsideCopy(f);
  assert.deepEqual(f.m.removeInterruptedInstallStaging(f.dir, {...f.j, installationIntent:false}), {});
  assert.equal(fs.existsSync(f.staging), true);
});

function recoveryFixture(t) {
  const f = fixture(t);
  const recovery = require(path.join(f.dir, 'runner.cjs'));
  const events = [];
  f.m.restoreOriginalPackage = () => events.push('restore-package');
  f.m.start = () => events.push('start');
  f.m.verifyServices = () => events.push('verify');
  f.m.stop = () => events.push('stop');
  f.m.finishTerminal = () => ({complete:true});
  return {...f, recovery, events};
}

test('recovery removes the staging directory after restoring the original package and completes', t => {
  const f = recoveryFixture(t);
  leaveMovedAsideCopy(f);
  const result = f.recovery.validateReady(f.dir, f.j);
  assert.equal(result.completed, true);
  assert.equal(result.recovery_required, false);
  assert.equal(result.warnings, undefined);
  assert.equal(fs.existsSync(f.staging), false);
  assert.deepEqual(f.events, ['restore-package', 'start', 'verify']);
});

test('recovery still completes when the staging directory cannot be removed and reports why', t => {
  const f = recoveryFixture(t);
  leaveMovedAsideCopy(f);
  fs.writeFileSync(path.join(f.staging, 'cli/lib/extra.js'), 'new\n');
  f.j.serviceWarnings = ['Service example is not online; restart it manually.'];
  const result = f.recovery.validateReady(f.dir, f.j);
  assert.equal(result.completed, true);
  assert.equal(result.recovery_required, false);
  assert.equal(f.m.read(path.join(f.dir, 'journal.json')).phase, 'restored_complete');
  assert.equal(result.warnings.length, 2);
  assert.equal(result.warnings[0], f.j.serviceWarnings[0]);
  assert.ok(result.warnings[1].includes(f.staging));
  assert.match(result.warnings[1], /ENOTEMPTY/);
  assert.equal(fs.existsSync(f.staging), true);
});
