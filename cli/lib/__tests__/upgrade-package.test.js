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

test('an exact installed tree is an idempotent restore skip', t => {
  const f = fixture(t);
  const copy = fs.cpSync, remove = fs.rmSync;
  fs.cpSync = () => { throw Error('exact tree must not be copied'); };
  fs.rmSync = (...args) => {
    if (args[0] === f.sourceRoot) throw Error('exact tree must not be removed');
    return remove(...args);
  };
  try { assert.doesNotThrow(() => m.restoreOriginalPackage(f.transactionDir, f.journal)); }
  finally { fs.cpSync = copy; fs.rmSync = remove; }
  assert.equal(f.load().originalPackageRestored, true);
});

test('restoration rejects corrupt snapshots and alternate source roots', t => {
  const corrupt = fixture(t);
  fs.appendFileSync(path.join(corrupt.originalPackage.path, 'package.json'), '\n');
  assert.throws(() => m.restoreOriginalPackage(corrupt.transactionDir, corrupt.journal), /snapshot changed/);

  const alternate = fixture(t);
  alternate.journal.originalPackage.sourceRoot = path.join(alternate.prefix, 'lib', 'node_modules', 'other');
  assert.throws(() => m.restoreOriginalPackage(alternate.transactionDir, alternate.journal), /preservation evidence missing/);
  assert.equal(alternate.load().originalPackageRestored, undefined);
});

test('restoration rejects a copied result whose full tree hash differs', t => {
  const f = fixture(t);
  replaceInstalledPackage(f);
  const copy = fs.cpSync;
  fs.cpSync = (source, destination, options) => {
    copy(source, destination, options);
    if (destination === f.sourceRoot) fs.appendFileSync(path.join(destination, 'package.json'), '\n');
  };
  try { assert.throws(() => m.restoreOriginalPackage(f.transactionDir, f.journal), /restore verification failed/); }
  finally { fs.cpSync = copy; }
  assert.equal(f.load().originalPackageRestored, undefined);
});

test('restoration refuses to overwrite a non-symlink global bin path', t => {
  const f = fixture(t);
  replaceInstalledPackage(f);
  const link = path.join(f.prefix, 'bin', 'zylos');
  fs.rmSync(link);
  fs.writeFileSync(link, 'unowned executable\n');
  assert.throws(() => m.restoreOriginalPackage(f.transactionDir, f.journal), /bin path is not a symlink/);
  assert.equal(fs.readFileSync(link, 'utf8'), 'unowned executable\n');
  assert.equal(f.load().originalPackageRestored, undefined);
});

test('restoration skips package evidence when installation intent is false', t => {
  const f=fixture(t);
  replaceInstalledPackage(f);
  f.journal.installationIntent=false;
  f.journal.originalPackage.treeHash='invalid';
  m.update(f.transactionDir,f.journal);
  assert.equal(m.restoreOriginalPackage(f.transactionDir,f.journal),false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.sourceRoot,'package.json'))).version,'1.0.0');
  assert.equal(f.load().originalPackageRestored,undefined);
});

test('restore retains target-only bins and repairs original bins even when the tree already matches', t => {
  const f=fixture(t),binDir=path.join(f.prefix,'bin');
  const stale=path.join(binDir,'target-only');
  fs.symlinkSync(path.relative(binDir,path.join(f.sourceRoot,'cli/target-only.js')),stale);
  fs.unlinkSync(path.join(binDir,'zylos'));
  m.restoreOriginalPackage(f.transactionDir,f.journal);
  assert.equal(fs.lstatSync(stale).isSymbolicLink(),true);
  assert.equal(path.resolve(binDir,fs.readlinkSync(path.join(binDir,'zylos'))),path.join(f.sourceRoot,'cli/original.js'));
  assert.equal(f.load().originalPackageRestored,true);
});

test('interrupted-copy reentry does not require package metadata or bin links before recopy', t => {
  const f=fixture(t);
  fs.rmSync(f.sourceRoot,{recursive:true,force:true});
  fs.rmSync(path.join(f.prefix,'bin','zylos'),{force:true});
  assert.doesNotThrow(()=>m.restoreOriginalPackage(f.transactionDir,f.journal));
  assert.equal(m.treeHash(f.sourceRoot,{excludeNodeModules:false,includeModes:true}),f.originalPackage.treeHash);
  assert.equal(path.resolve(path.join(f.prefix,'bin'),fs.readlinkSync(path.join(f.prefix,'bin','zylos'))),path.join(f.sourceRoot,'cli/original.js'));
});

test('completed restoration rejects a changed installed tree without replacing it', t => {
  const f=fixture(t);
  replaceInstalledPackage(f);
  m.restoreOriginalPackage(f.transactionDir,f.journal);
  const changed=path.join(f.sourceRoot,'operator-change');
  fs.writeFileSync(changed,'preserve for manual recovery\n');
  const copy=fs.cpSync,remove=fs.rmSync;
  fs.cpSync=()=>{throw Error('completed restore must not copy');};
  fs.rmSync=(...args)=>{
    if(args[0]===f.sourceRoot)throw Error('completed restore must not remove');
    return remove(...args);
  };
  try {assert.throws(()=>m.restoreOriginalPackage(f.transactionDir,f.load()),/completed original package restore changed; manual recovery required/);}
  finally {fs.cpSync=copy;fs.rmSync=remove;}
  assert.equal(fs.readFileSync(changed,'utf8'),'preserve for manual recovery\n');
});
