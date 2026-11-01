import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import maintenance from '../upgrade-maintenance.cjs';
import { saveOriginalPackage } from '../upgrade-package.js';

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'up-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const coreDir = path.join(root, 'p/lib/node_modules/zylos');
  const transactionDir = path.join(root, 'h/zylos/.backup/self-upgrade/tx');
  const binDir = path.join(root, 'p/bin');
  fs.mkdirSync(path.join(coreDir, 'cli'), {recursive:true});
  fs.mkdirSync(path.join(coreDir, 'node_modules/dependency'), {recursive:true});
  fs.mkdirSync(transactionDir, {recursive:true, mode:0o700});
  fs.mkdirSync(binDir, {recursive:true});
  fs.writeFileSync(path.join(coreDir, 'package.json'), JSON.stringify({name:'zylos', version:'0.9.3', bin:{zylos:'./cli/zylos.js'}}));
  fs.writeFileSync(path.join(coreDir, 'cli/zylos.js'), 'original cli\n', {mode:0o755});
  fs.writeFileSync(path.join(coreDir, 'node_modules/dependency/index.js'), 'original dependency\n', {mode:0o640});
  fs.symlinkSync('index.js', path.join(coreDir, 'node_modules/dependency/entry.js'));
  fs.symlinkSync('../lib/node_modules/zylos/cli/zylos.js', path.join(binDir, 'zylos'));
  const journal = {
    formatVersion:1, transactionId:'tx', from:'0.9.3', to:'0.9.4', phase:'prepared', installationIntent:false,
    initialIdentity:{packageJson:path.join(coreDir, 'package.json'), packageHash:maintenance.hash(path.join(coreDir, 'package.json')),
      cliRoot:path.join(coreDir, 'cli'), cliHash:maintenance.treeHash(path.join(coreDir, 'cli'))},
  };
  maintenance.update(transactionDir, journal);
  return {root, coreDir, transactionDir, binDir, journal, ctx:{coreDir, transactionDir, from:'0.9.3', journal, maintenance}};
}

function changeInstalledPackage(f) {
  fs.writeFileSync(path.join(f.coreDir, 'package.json'), JSON.stringify({name:'zylos', version:'0.9.4', bin:{zylos:'./cli/zylos.js'}}));
  fs.writeFileSync(path.join(f.coreDir, 'cli/zylos.js'), 'new cli\n');
  fs.chmodSync(path.join(f.coreDir, 'cli/zylos.js'), 0o644);
  fs.writeFileSync(path.join(f.coreDir, 'node_modules/dependency/index.js'), 'new dependency\n');
  maintenance.update(f.transactionDir, f.journal, {installationIntent:true, phase:'installing'});
}

test('original package preservation includes dependencies, modes and symlinks', t => {
  const f = fixture(t);
  const saved = saveOriginalPackage(f.ctx);
  assert.equal(saved.sourceRoot, f.coreDir);
  assert.equal(saved.sourceVersion, '0.9.3');
  assert.equal(saved.treeHash, maintenance.treeHash(f.coreDir, {excludeNodeModules:false, includeModes:true}));
  assert.equal(fs.readFileSync(path.join(saved.path, 'node_modules/dependency/index.js'), 'utf8'), 'original dependency\n');
  assert.equal(fs.statSync(path.join(saved.path, 'cli/zylos.js')).mode & 0o777, 0o755);
  assert.equal(fs.statSync(path.join(saved.path, 'node_modules/dependency/index.js')).mode & 0o777, 0o640);
  assert.equal(fs.readlinkSync(path.join(saved.path, 'node_modules/dependency/entry.js')), 'index.js');
  assert.deepEqual(maintenance.read(path.join(f.transactionDir, 'journal.json')).originalPackage, saved);
  assert.throws(() => saveOriginalPackage(f.ctx), /snapshot already exists/);
});

test('package restoration restores the full package and its owned bin link', t => {
  const f = fixture(t);
  const saved = saveOriginalPackage(f.ctx);
  changeInstalledPackage(f);
  fs.unlinkSync(path.join(f.binDir, 'zylos'));
  fs.symlinkSync('../lib/node_modules/zylos/cli/replaced.js', path.join(f.binDir, 'zylos'));
  maintenance.restoreOriginalPackage(f.transactionDir, f.journal);
  assert.equal(maintenance.treeHash(f.coreDir, {excludeNodeModules:false, includeModes:true}), saved.treeHash);
  assert.equal(fs.readlinkSync(path.join(f.binDir, 'zylos')), '../lib/node_modules/zylos/cli/zylos.js');
  assert.equal(f.journal.originalPackageRestored, true);
  assert.doesNotThrow(() => maintenance.restoreOriginalPackage(f.transactionDir, f.journal));
  fs.appendFileSync(path.join(f.coreDir, 'node_modules/dependency/index.js'), 'post-restore user change\n');
  assert.throws(() => maintenance.restoreOriginalPackage(f.transactionDir, f.journal), /completed original package restore changed/);
  assert.match(fs.readFileSync(path.join(f.coreDir, 'node_modules/dependency/index.js'), 'utf8'), /post-restore user change/);
});

test('damaged preservation material and unknown installer exit refuse package replacement', t => {
  const f = fixture(t);
  const saved = saveOriginalPackage(f.ctx);
  changeInstalledPackage(f);
  const currentHash = maintenance.treeHash(f.coreDir, {excludeNodeModules:false, includeModes:true});
  fs.appendFileSync(path.join(saved.path, 'node_modules/dependency/index.js'), 'damaged snapshot\n');
  assert.throws(() => maintenance.restoreOriginalPackage(f.transactionDir, f.journal), /snapshot changed/);
  assert.equal(maintenance.treeHash(f.coreDir, {excludeNodeModules:false, includeModes:true}), currentHash);
  maintenance.update(f.transactionDir, f.journal, {installerStarted:true, installerPid:null, installerExitConfirmed:false});
  assert.throws(() => maintenance.restoreOriginalPackage(f.transactionDir, f.journal));
  assert.equal(maintenance.treeHash(f.coreDir, {excludeNodeModules:false, includeModes:true}), currentHash);
});

test('closed compensation cannot replace an installed target package', t => {
  const f = fixture(t);
  saveOriginalPackage(f.ctx);
  changeInstalledPackage(f);
  const snapshotManifestHash = 'a'.repeat(64);
  maintenance.update(f.transactionDir, f.journal, {snapshotManifestHash, phase:'compensation_closed',
    compensationCutoff:{formatVersion:1, closed:true, transactionId:'tx', from:'0.9.3', to:'0.9.4', snapshotManifestHash}});
  const currentHash = maintenance.treeHash(f.coreDir, {excludeNodeModules:false, includeModes:true});
  assert.throws(() => maintenance.restoreOriginalPackage(f.transactionDir, f.journal), /compensation is closed or untrusted/);
  assert.equal(maintenance.treeHash(f.coreDir, {excludeNodeModules:false, includeModes:true}), currentHash);
});

test('standard layout admission rejects a bin owned by another package', t => {
  const f = fixture(t);
  fs.unlinkSync(path.join(f.binDir, 'zylos'));
  fs.symlinkSync('/another/package/cli.js', path.join(f.binDir, 'zylos'));
  assert.throws(() => saveOriginalPackage(f.ctx), {code:'UNSUPPORTED_INSTALL_LAYOUT'});
  assert.equal(fs.existsSync(path.join(f.transactionDir, 'code/original-package')), false);
  assert.equal(fs.readlinkSync(path.join(f.binDir, 'zylos')), '/another/package/cli.js');
});

test('a foreign bin acquired after installation blocks compensation before package replacement', t => {
  const f = fixture(t);
  saveOriginalPackage(f.ctx);
  changeInstalledPackage(f);
  fs.unlinkSync(path.join(f.binDir,'zylos'));
  fs.symlinkSync('/another/package/cli.js',path.join(f.binDir,'zylos'));
  const before = maintenance.treeHash(f.coreDir,{excludeNodeModules:false,includeModes:true});
  assert.throws(() => maintenance.restoreOriginalPackage(f.transactionDir,f.journal),{code:'UNSUPPORTED_INSTALL_LAYOUT'});
  assert.equal(maintenance.treeHash(f.coreDir,{excludeNodeModules:false,includeModes:true}),before);
});
