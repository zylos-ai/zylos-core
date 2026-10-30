import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import {
  resumeUnfinishedUpgrade,
  upgradeBridgeFailure,
  validateDownloadedCore,
} from '../upgrade-bridge.js';

const DRIVER = path.resolve('test/helpers/run-upgrade-bridge.mjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-bridge-')));
  const tempDir = path.join(root, 'target');
  fs.mkdirSync(path.join(tempDir, 'cli/lib'), {recursive:true});
  fs.writeFileSync(path.join(tempDir, 'package.json'), JSON.stringify({name:'zylos',version:'1.0.0',type:'module'}));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  return {
    root,
    tempDir,
    handoff: {
      tempDir,
      fromVersion: '0.9.3',
      installedRoot: path.join(root, 'installed'),
      zylosDir: path.join(root, 'zylos'),
    },
  };
}

test('pre-transaction failures use the fixed result shape', () => {
  assert.deepEqual(upgradeBridgeFailure('download failed'), {
    success:false, code:'UPGRADE_FAILED', error:'download failed', persisted:[],
  });
  assert.deepEqual(upgradeBridgeFailure('recover first', {code:'UPGRADE_RECOVERY_REQUIRED',next:'zylos recovery status'}), {
    success:false, code:'UPGRADE_RECOVERY_REQUIRED', error:'recover first', persisted:[], next:'zylos recovery status',
  });
});

test('downloaded package validation requires package.json and upgrade-entry.js files', t => {
  const f = fixture(t);
  assert.match(validateDownloadedCore(f.tempDir).error, /upgrade-entry\.js/);
  fs.mkdirSync(path.join(f.tempDir, 'cli/lib/upgrade-entry.js'));
  assert.match(validateDownloadedCore(f.tempDir).error, /not a file/);
  fs.rmSync(path.join(f.tempDir, 'cli/lib/upgrade-entry.js'), {recursive:true});
  fs.writeFileSync(path.join(f.tempDir, 'cli/lib/upgrade-entry.js'), '');
  assert.deepEqual(validateDownloadedCore(f.tempDir), {success:true});
});

test('target entry receives one JSON handoff and stdout, stderr, and exit status pass through', t => {
  const f = fixture(t), saved = path.join(f.root, 'handoff.json');
  fs.writeFileSync(path.join(f.tempDir, 'cli/lib/upgrade-entry.js'), `
    import fs from 'node:fs';
    fs.writeFileSync(${JSON.stringify(saved)}, fs.readFileSync(0, 'utf8'));
    process.stdout.write('target stdout\\n');
    process.stderr.write('target stderr\\n');
    process.exitCode = 7;
  `);
  const result = spawnSync(process.execPath, [DRIVER, JSON.stringify(f.handoff)], {encoding:'utf8'});
  assert.equal(result.status, 7);
  assert.equal(result.stdout, 'target stdout\n');
  assert.equal(result.stderr, 'target stderr\n');
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, 'utf8')), {
    schemaVersion:1,
    fromVersion:'0.9.3',
    tempDir:f.tempDir,
    installedRoot:f.handoff.installedRoot,
    zylosDir:f.handoff.zylosDir,
  });
});

test('successful target exit passes through unchanged', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.tempDir, 'cli/lib/upgrade-entry.js'), "process.stdout.write('success\\n');\n");
  const result = spawnSync(process.execPath, [DRIVER, JSON.stringify(f.handoff)], {encoding:'utf8'});
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'success\n');
  assert.equal(result.stderr, '');
});

test('target signal termination maps to exit 1 without synthetic output', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.tempDir, 'cli/lib/upgrade-entry.js'), "process.kill(process.pid, 'SIGTERM');\n");
  const result = spawnSync(process.execPath, [DRIVER, JSON.stringify(f.handoff)], {encoding:'utf8'});
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});

function recoveryFixture(t, resumeSource, statusSource) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-admission-')));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const stable = path.join(root, '.zylos/upgrade');
  const transaction = path.join(root, '.backup/self-upgrade/tx');
  fs.mkdirSync(stable, {recursive:true, mode:0o700});
  fs.mkdirSync(transaction, {recursive:true, mode:0o700});
  fs.writeFileSync(path.join(stable, 'maintenance.cjs'), "'use strict';\n", {mode:0o600});
  fs.writeFileSync(path.join(stable, 'bootstrap.cjs'), `
    const fs = require('node:fs');
    exports.bootstrap = (root, options) => {
      const transaction = ${JSON.stringify(transaction)};
      if (options?.once) { ${resumeSource} }
      ${statusSource || `return fs.existsSync(transaction)
        ? {active:true, recovery_required:true, error:'transaction remains'}
        : {active:false};`}
    };
  `, {mode:0o600});
  return {root, transaction};
}

test('unfinished recovery is re-discovered after a deployed bootstrap reports completion', t => {
  const f = recoveryFixture(t, "fs.rmSync(transaction, {recursive:true}); return {active:true, completed:true};");
  assert.deepEqual(resumeUnfinishedUpgrade(f.root), {success:true});
  assert.equal(fs.existsSync(f.transaction), false);
});

test('unfinished recovery is rejected when a deployed bootstrap leaves the transaction behind', t => {
  const f = recoveryFixture(t, "return {active:true, completed:true};");
  const blocked = resumeUnfinishedUpgrade(f.root);
  assert.equal(blocked.failure.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.deepEqual(blocked.failure.persisted, []);
  assert.match(blocked.failure.error, /transaction remains/);
});

test('unfinished recovery is rejected when rediscovery reports an active blocked transaction', t => {
  const f = recoveryFixture(
    t,
    "return {active:true, completed:true};",
    "return fs.existsSync(transaction) ? {active:true, blocked:true} : {active:false};",
  );
  const blocked = resumeUnfinishedUpgrade(f.root);
  assert.equal(blocked.failure.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.deepEqual(blocked.failure.persisted, []);
  assert.equal(fs.existsSync(f.transaction), true);
});

test('automatic recovery refusal preserves the manual recovery result code', t => {
  const f = recoveryFixture(t, "return {active:true, automaticResume:false, error:'manual recovery required'};");
  const blocked = resumeUnfinishedUpgrade(f.root);
  assert.equal(blocked.failure.code, 'MANUAL_RECOVERY_REQUIRED');
  assert.deepEqual(blocked.failure.persisted, []);
  assert.match(blocked.failure.error, /manual recovery required/);
});

test('release package has no minimum-source install gate', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg.scripts, 'preinstall'), false);
});
