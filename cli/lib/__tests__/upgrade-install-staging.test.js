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
