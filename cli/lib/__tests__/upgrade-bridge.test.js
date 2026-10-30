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

test('unfinished transaction discovery runs before upgrade and rejects incomplete recovery', () => {
  let options;
  assert.deepEqual(resumeUnfinishedUpgrade('/fixture', {discover:(root, opts) => {
    assert.equal(root, '/fixture'); options = opts; return {active:false, blocked:false};
  }}), {success:true});
  assert.deepEqual(options, {resume:true, scanHistory:true});

  const blocked = resumeUnfinishedUpgrade('/fixture', {discover:() => ({
    active:true, recovery_required:true, error:'runner failed', automaticResume:true,
  })});
  assert.equal(blocked.failure.code, 'UPGRADE_RECOVERY_REQUIRED');
  assert.deepEqual(blocked.failure.persisted, []);

  const manual = resumeUnfinishedUpgrade('/fixture', {discover:() => ({
    active:true, recovery_required:true, error:'ownership unknown', automaticResume:false,
  })});
  assert.equal(manual.failure.code, 'MANUAL_RECOVERY_REQUIRED');
});

test('release package has no minimum-source install gate', () => {
  const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
  assert.equal(pkg.version, '0.9.3');
  assert.equal(Object.hasOwn(pkg.scripts, 'preinstall'), false);
});
