import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {saveOriginalPackage} from '../upgrade-package.js';

const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-original-package-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const prefix = path.join(root, 'prefix');
  const sourceRoot = path.join(prefix, 'lib', 'node_modules', 'zylos');
  const transactionDir = path.join(root, 'transaction');
  fs.mkdirSync(path.join(sourceRoot, 'cli'), {recursive:true});
  fs.mkdirSync(path.join(sourceRoot, 'node_modules', 'dependency'), {recursive:true});
  fs.mkdirSync(path.join(prefix, 'bin'), {recursive:true});
  fs.mkdirSync(transactionDir);
  fs.writeFileSync(path.join(sourceRoot, 'package.json'), JSON.stringify({
    name:'zylos', version:'0.9.3', bin:{zylos:'cli/original.js'},
  }));
  fs.writeFileSync(path.join(sourceRoot, 'cli', 'original.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(sourceRoot, 'cli', 'original.js'), 0o755);
  fs.writeFileSync(path.join(sourceRoot, 'node_modules', 'dependency', 'index.js'), 'original dependency\n');
  fs.symlinkSync(path.relative(path.join(prefix, 'bin'), path.join(sourceRoot, 'cli', 'original.js')), path.join(prefix, 'bin', 'zylos'));
  const journal = {
    formatVersion:1, transactionId:'tx', zylosDir:root, nodePath:process.execPath,
    from:'0.9.3', installationIntent:true, installerStarted:true,
    installerStage:'install', installerExitConfirmed:true,
  };
  m.update(transactionDir, journal);
  const ctx = {maintenance:m, coreDir:sourceRoot, from:'0.9.3', transactionDir, journal};
  const originalPackage = saveOriginalPackage(ctx);
  journal.initialIdentity = {
    packageJson:path.join(sourceRoot, 'package.json'),
    packageHash:m.hash(path.join(sourceRoot, 'package.json')),
    cliRoot:path.join(sourceRoot, 'cli'),
    cliHash:m.treeHash(path.join(sourceRoot, 'cli')),
  };
  m.update(transactionDir, journal, {initialIdentity:journal.initialIdentity});
  return {root, prefix, sourceRoot, transactionDir, journal, originalPackage,
    load:() => m.read(path.join(transactionDir, 'journal.json'))};
}

function replaceInstalledPackage(f, metadata = {name:'zylos', version:'1.0.0', bin:{zylos:'cli/replacement.js'}}) {
  fs.rmSync(f.sourceRoot, {recursive:true, force:true});
  fs.mkdirSync(path.join(f.sourceRoot, 'cli'), {recursive:true});
  fs.mkdirSync(path.join(f.sourceRoot, 'node_modules', 'replacement'), {recursive:true});
  fs.writeFileSync(path.join(f.sourceRoot, 'package.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(f.sourceRoot, 'cli', 'replacement.js'), 'replacement\n');
  fs.writeFileSync(path.join(f.sourceRoot, 'node_modules', 'replacement', 'index.js'), 'replacement dependency\n');
  const link = path.join(f.prefix, 'bin', 'zylos');
  fs.rmSync(link, {force:true});
  fs.symlinkSync(path.relative(path.dirname(link), path.join(f.sourceRoot, 'cli', 'replacement.js')), link);
}

test('preservation snapshots the exact installed directory including dependencies and modes', t => {
  const f = fixture(t);
  const expected = path.join(f.transactionDir, 'code', 'original-package');
  assert.deepEqual(f.originalPackage, {
    path:expected,
    treeHash:m.treeHash(f.sourceRoot, {excludeNodeModules:false, includeModes:true}),
    sourceVersion:'0.9.3',
    sourceRoot:f.sourceRoot,
  });
  assert.equal(fs.readFileSync(path.join(expected, 'node_modules/dependency/index.js'), 'utf8'), 'original dependency\n');
  assert.equal(fs.statSync(path.join(expected, 'cli/original.js')).mode & 0o777, 0o755);
  assert.deepEqual(f.load().originalPackage, f.originalPackage);
});

test('restoration replaces the same source root and rebuilds changed package bin mappings', t => {
  const f = fixture(t);
  replaceInstalledPackage(f);
  m.restoreOriginalPackage(f.transactionDir, f.journal);
  assert.equal(m.treeHash(f.sourceRoot, {excludeNodeModules:false, includeModes:true}), f.originalPackage.treeHash);
  assert.equal(fs.readFileSync(path.join(f.sourceRoot, 'node_modules/dependency/index.js'), 'utf8'), 'original dependency\n');
  assert.equal(fs.statSync(path.join(f.sourceRoot, 'cli/original.js')).mode & 0o777, 0o755);
  assert.equal(path.resolve(path.join(f.prefix, 'bin'), fs.readlinkSync(path.join(f.prefix, 'bin', 'zylos'))), path.join(f.sourceRoot, 'cli', 'original.js'));
  assert.equal(f.load().originalPackageRestored, true);
});
