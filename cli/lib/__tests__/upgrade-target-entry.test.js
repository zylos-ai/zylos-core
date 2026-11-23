import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { runUpgradeEntry, installUpgradeTarget } from '../upgrade-entry.js';

function fixture(t, version = '0.9.3') {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-target-entry-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const prefix=path.join(root,'prefix');
  const input = {schemaVersion:1, fromVersion:version, installedRoot:path.join(prefix, 'lib/node_modules/zylos'), tempDir:path.join(root, 'target'), zylosDir:path.join(root, 'deployment')};
  for (const [directory, packageVersion] of [[input.installedRoot, version], [input.tempDir, '1.0.0']]) {
    fs.mkdirSync(directory, {recursive:true});
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({type:'module', name:'zylos', version:packageVersion}));
  }
  fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});
  fs.mkdirSync(input.zylosDir);
  return input;
}

function pipeline(input, failAt) {
  const calls = [];
  const npmCli = path.join(input.tempDir, 'npm-cli.js');
  fs.writeFileSync(npmCli, `process.stdout.write(${JSON.stringify(path.dirname(input.installedRoot))});`);
  const ctx = {coreDir:input.installedRoot, tempDir:input.tempDir, zylosDir:input.zylosDir, skillsDir:path.join(input.zylosDir, '.claude/skills')};
  const step = name => () => {calls.push(name); if (name === failAt) throw Error(name);};
  const deps = {maintenance:{discover:() => ({candidates:[], diagnostics:[], marker:null})},
    inspect:() => ctx, resolveNpm:() => npmCli,
    begin(context) {calls.push('begin'); context.transactionDir = '/fixture/transaction'; context.upgradeProtected = true;},
    savePackage:step('savePackage'), saveCode:step('saveCode'), prepare:step('prepare'), install:step('install'),
    finalize:() => {calls.push('finalize'); return {success:true};},
    recover:() => {calls.push('recover'); return {attempted:true, completed:true};}};
  ctx.releaseControl = step('release');
  return {calls, deps};
}

test('protected entry saves original package before code, stops, snapshot and installation', async t => {
  const input = fixture(t), f = pipeline(input);
  const result = await runUpgradeEntry(input, f.deps);
  assert.equal(result.success, true);
  assert.deepEqual(f.calls, ['begin', 'savePackage', 'saveCode', 'prepare', 'install', 'finalize', 'release']);
});

for (const failure of ['savePackage', 'saveCode', 'prepare', 'install']) test(`entry compensates ${failure} failure and never finalizes`, async t => {
  const input = fixture(t), f = pipeline(input, failure);
  const result = await runUpgradeEntry(input, f.deps);
  assert.equal(result.success, false);
  assert.equal(result.rollback.completed, true);
  assert.equal(f.calls.includes('finalize'), false);
  assert.equal(f.calls.at(-1), 'recover');
});

test('entry refuses ambiguous prior transactions without inspecting, installing, or recovering them', async t => {
  const input = fixture(t), f = pipeline(input);
  f.deps.maintenance.discover = () => ({candidates:[], diagnostics:['untrusted'], marker:null});
  f.deps.inspect = () => assert.fail('prechecks must not run');
  const result = await runUpgradeEntry(input, f.deps);
  assert.equal(result.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.match(result.next,/zylos recovery status.*zylos recovery resume/);
  assert.equal(result.recovery_required,true);
  assert.deepEqual(result.persisted,[]);
  assert.deepEqual(f.calls, []);
});

test('downloaded executable redacts paths from its main-block failure', t => {
  const privatePath=path.join(fixture(t).zylosDir,'private-handoff.json');
  const child=spawnSync(process.execPath,[path.resolve('cli/lib/upgrade-entry.js')],{input:privatePath,encoding:'utf8'});
  assert.equal(child.status,1,child.stderr);
  const result=JSON.parse(child.stdout);
  assert.equal(result.code,'INVALID_UPGRADE_HANDOFF');
  assert.deepEqual(result.persisted,[]);
  assert.doesNotMatch(result.error,new RegExp(privatePath.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.match(result.error,/<path>/);
  assert.doesNotMatch(result.error,/\n| at /);
});


test('target packing precedes installation intent and rejects unsafe npm archive filenames', t => {
  const input = fixture(t);
  const ctx = {...input, journal:{}, maintenance:{update(_dir,journal,changes){Object.assign(journal,changes);}},
    protectedNpmCli:'/fixture/npm-cli.js'};
  const calls = [];
  const deps = {runInstaller(context, options) {calls.push(options.stage); return JSON.stringify([{filename:'target.tgz'}]);}, markInstallationIntent() {calls.push('intent');}};
  installUpgradeTarget(ctx, deps);
  assert.deepEqual(calls, ['pack-target', 'intent', 'install']);
  calls.length = 0;
  deps.runInstaller = () => JSON.stringify([{filename:'../escape.tgz'}]);
  assert.throws(() => installUpgradeTarget(ctx, deps), /Invalid target npm pack/);
  assert.deepEqual(calls, []);
});

test('downloaded executable rejects unsupported source without target node_modules', t => {
  const input = fixture(t, '0.9.2');
  const source = path.resolve('.');
  for (const relative of ['cli/lib', 'skills/comm-bridge/scripts']) {
    fs.cpSync(path.join(source, relative), path.join(input.tempDir, relative), {recursive:true,
      filter:file => !file.split(path.sep).includes('__tests__') && !file.split(path.sep).includes('node_modules')});
  }
  assert.equal(fs.existsSync(path.join(input.tempDir, 'node_modules')), false);
  const child = spawnSync(process.execPath, [path.join(input.tempDir, 'cli/lib/upgrade-entry.js')], {input:JSON.stringify(input), encoding:'utf8', timeout:10000});
  assert.equal(child.status, 1, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.code, 'UPGRADE_SOURCE_TOO_OLD');
  assert.equal(fs.existsSync(path.join(input.zylosDir, '.backup')), false);
});
