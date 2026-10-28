import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {saveOriginalPackage} from '../upgrade-package.js';
const m = createRequire(import.meta.url)('../upgrade-maintenance.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-original-package-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const source = path.join(root, 'installed'), dir = path.join(root, 'transaction');
  fs.mkdirSync(path.join(source, 'cli'), {recursive:true}); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(source, 'package.json'), JSON.stringify({name:'fixture-core', version:'0.9.3', bundledDependencies:['unsafe']}));
  fs.writeFileSync(path.join(source, 'cli', 'entry.js'), 'original CLI');
  fs.mkdirSync(path.join(source, 'node_modules', 'unsafe'), {recursive:true});
  fs.writeFileSync(path.join(source, 'node_modules', 'unsafe', 'secret'), 'must not be packed');
  const npmCli = path.join(root, 'npm-cli.js'); fs.writeFileSync(npmCli, '');
  const journal = {nodePath:process.execPath, from:'0.9.3', installationIntent:false};
  m.update(dir, journal);
  return {root, source, dir, ctx:{maintenance:m, coreDir:source, from:'0.9.3', transactionDir:dir, journal, protectedNpmCli:npmCli}};
}

test('package preservation records a durable archive from an installation copy without dependencies', t => {
  const f = fixture(t);
  const original = saveOriginalPackage(f.ctx, {runInstaller(context, options) {
    assert.equal(context, f.ctx); assert.equal(options.stage, 'save-original-package');
    assert.ok(options.args.includes('--ignore-scripts'));
    assert.equal(fs.existsSync(path.join(options.cwd, 'node_modules')), false);
    assert.equal(fs.readFileSync(path.join(options.cwd, 'cli/entry.js'), 'utf8'), 'original CLI');
    fs.writeFileSync(path.join(f.dir, 'fixture-core-0.9.3.tgz'), 'archive');
    return JSON.stringify([{filename:'fixture-core-0.9.3.tgz'}]);
  }});
  assert.equal(original.sourceVersion, '0.9.3'); assert.equal(original.sha256, m.hash(original.path));
  assert.deepEqual(m.read(path.join(f.dir, 'journal.json')).originalPackage, original);
});

test('preservation rejects changed installed version and unsafe archive names before publishing evidence', t => {
  const f = fixture(t); f.ctx.from = '0.9.4';
  assert.throws(() => saveOriginalPackage(f.ctx), /version changed/);
  f.ctx.from = '0.9.3';
  assert.throws(() => saveOriginalPackage(f.ctx, {runInstaller:() => JSON.stringify([{filename:'../escape.tgz'}])}), /archive name/);
  assert.equal(m.read(path.join(f.dir, 'journal.json')).originalPackage, undefined);
});

test('restoration runs a tracked installer before checking restored installed identity and rejects corrupt archives', t => {
  const f = fixture(t), j = f.ctx.journal;
  const packageJson = path.join(f.source, 'package.json'), cliRoot = path.join(f.source, 'cli');
  j.initialIdentity = {packageJson, packageHash:m.hash(packageJson), cliRoot, cliHash:m.treeHash(cliRoot)};
  const bytes = fs.readFileSync(packageJson, 'utf8');
  fs.writeFileSync(f.ctx.protectedNpmCli, `const fs=require('node:fs');if(process.env.ZYLOS_SKIP_POSTINSTALL!=='1'||process.env.ZYLOS_UPGRADE_FROM_VERSION!=='0.9.3')process.exit(3);fs.writeFileSync(${JSON.stringify(packageJson)},${JSON.stringify(bytes)});`);
  for (const [source, name] of [['upgrade-finalizer.cjs','finalizer.cjs'], ['upgrade-maintenance.cjs','maintenance.cjs'], ['upgrade-recovery.cjs','runner.cjs']]) fs.copyFileSync(path.resolve('cli/lib',source), path.join(f.dir,name));
  j.recoveryHashes = Object.fromEntries(['runner.cjs','maintenance.cjs','finalizer.cjs'].map(name => [name,m.hash(path.join(f.dir,name))]));
  const archive = path.join(f.dir, 'original.tgz'); fs.writeFileSync(archive, 'original');
  j.originalPackage = {path:archive, sha256:m.hash(archive), sourceVersion:'0.9.3', npmCli:f.ctx.protectedNpmCli};
  fs.writeFileSync(packageJson, 'new installed package');
  m.restoreOriginalPackage(f.dir, j);
  assert.equal(j.originalPackageRestored, true); assert.equal(j.installerStage, 'restore-original-package');
  assert.equal(j.installerExitConfirmed, true); assert.equal(m.hash(packageJson), j.initialIdentity.packageHash);
  fs.writeFileSync(archive, 'corrupted');
  assert.throws(() => m.restoreOriginalPackage(f.dir, j), /archive changed/);
});

function restorationFixture(t, installer) {
  const f = fixture(t), j = f.ctx.journal;
  const packageJson = path.join(f.source, 'package.json'), cliRoot = path.join(f.source, 'cli');
  j.initialIdentity = {packageJson, packageHash:m.hash(packageJson), cliRoot, cliHash:m.treeHash(cliRoot)};
  fs.writeFileSync(f.ctx.protectedNpmCli, installer);
  for (const [source, name] of [['upgrade-finalizer.cjs','finalizer.cjs'], ['upgrade-maintenance.cjs','maintenance.cjs'], ['upgrade-recovery.cjs','runner.cjs']]) {
    fs.copyFileSync(path.resolve('cli/lib',source), path.join(f.dir,name));
  }
  j.recoveryHashes = Object.fromEntries(['runner.cjs','maintenance.cjs','finalizer.cjs'].map(name => [name,m.hash(path.join(f.dir,name))]));
  const archive = path.join(f.dir, 'original.tgz'); fs.writeFileSync(archive, 'original');
  j.originalPackage = {path:archive, sha256:m.hash(archive), sourceVersion:'0.9.3', npmCli:f.ctx.protectedNpmCli};
  m.update(f.dir, j);
  return {...f, j, packageJson, cliRoot};
}

for (const mismatch of ['package', 'cli']) test(`B07 successful installer cannot hide a restored ${mismatch} identity mismatch`, t => {
  const f = restorationFixture(t, 'process.exit(0);');
  fs.writeFileSync(mismatch === 'package' ? f.packageJson : path.join(f.cliRoot, 'entry.js'), 'wrong restored contents');
  assert.throws(() => m.restoreOriginalPackage(f.dir, f.j), /restored installed package identity mismatch/);
  assert.equal(f.j.installerExitConfirmed, true);
});

test('B10 failed original-package installation never publishes the restored flag', t => {
  const f = restorationFixture(t, 'process.exit(12);');
  assert.throws(() => m.restoreOriginalPackage(f.dir, f.j));
  assert.equal(f.j.originalPackageRestored, undefined);
  assert.equal(m.read(path.join(f.dir, 'journal.json')).originalPackageRestored, undefined);
  assert.equal(f.j.installerStage, 'restore-original-package');
});
