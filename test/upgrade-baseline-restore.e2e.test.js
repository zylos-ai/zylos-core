/**
 * Run for baseline commit, component upgrade or rollback changes. Skip for
 * unrelated changes. The child uses a private instance tree, a stub npm and
 * the runner's isolated home, PM2 home and temporary directory.
 * smartSync applies business files in step 3, while runUpgrade commits the
 * authoritative baseline only after every rollback-triggering step succeeds.
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  generateManifest,
  hashFile,
  loadManifest,
  saveMergeBaseline,
} from '../cli/lib/manifest.js';

const DRIVER = path.join(import.meta.dirname, 'helpers', 'run-upgrade-driver.mjs');

let tmpRoot;
let zylosDir;
let skillsDir;
let shimDir;
let failFlag;
let npmLog;

function mkTmp() {
  return fs.mkdtempSync(path.join(tmpRoot, 'test-'));
}

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readFile(dir, relPath) {
  return fs.readFileSync(path.join(dir, relPath), 'utf8');
}

function installV1(name) {
  const dest = path.join(skillsDir, name);
  const source = mkTmp();
  writeFile(source, 'a.js', 'v1');
  writeFile(source, 'package.json', JSON.stringify({ name, version: '1.0.0' }));
  writeFile(dest, 'a.js', 'v1');
  writeFile(dest, 'package.json', JSON.stringify({ name, version: '1.0.0' }));
  saveMergeBaseline(dest, source, generateManifest(source));
  return dest;
}

function makeV2(name) {
  const source = mkTmp();
  writeFile(source, 'a.js', 'v2');
  writeFile(source, 'package.json', JSON.stringify({ name, version: '2.0.0' }));
  return source;
}

function runUpgradeE2E(name, tempDir, { failBaselineCommit = false } = {}) {
  const child = spawnSync(process.execPath, [DRIVER, name, tempDir, '2.0.0'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ZYLOS_DIR: zylosDir,
      PATH: shimDir + path.delimiter + process.env.PATH,
      ZYLOS_TEST_BASELINE_COMMIT_FAIL: failBaselineCommit ? '1' : '0',
      npm_config_registry: 'https://registry.example.test/',
      npm_config_better_sqlite3_binary_host_mirror: 'https://binary.example.test/better-sqlite3',
      ZYLOS_TEST_NPM_LOG: npmLog,
    },
    timeout: 60000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
  return JSON.parse(child.stdout);
}

before(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-baseline-commit-e2e-'));
  zylosDir = path.join(tmpRoot, 'zylos-home');
  skillsDir = path.join(zylosDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  shimDir = path.join(tmpRoot, 'shim-bin');
  fs.mkdirSync(shimDir, { recursive: true });
  failFlag = path.join(shimDir, 'npm-fail');
  npmLog = path.join(tmpRoot, 'npm-env.log');
  fs.writeFileSync(path.join(shimDir, 'npm'), [
    '#!/bin/sh',
    'printf "%s|%s|%s|%s\\n" "$PWD" "$*" "$npm_config_registry" "$npm_config_better_sqlite3_binary_host_mirror" >> "$ZYLOS_TEST_NPM_LOG"',
    `if [ -e "${failFlag}" ]; then exit 1; fi`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runUpgrade owns the final baseline commit', () => {

  test('later npm failure rolls back files while the old baseline remains untouched; retry truly upgrades', () => {
    const name = 'commit-boundary-retry';
    const dest = installV1(name);
    const sourceV2 = makeV2(name);
    const manifestV1 = readFile(dest, '.zylos/manifest.json');

    fs.writeFileSync(failFlag, '');
    const failed = runUpgradeE2E(name, sourceV2);

    assert.equal(failed.success, false);
    assert.equal(failed.failedStep, 4);
    assert.equal(readFile(dest, 'a.js'), 'v1');
    assert.equal(readFile(dest, '.zylos/manifest.json'), manifestV1);
    assert.equal(readFile(dest, '.zylos/originals/a.js'), 'v1');
    assert.equal(failed.rollback.steps.some(step => step.action === 'restore_baseline'), false);

    fs.rmSync(failFlag, { force: true });
    const retry = runUpgradeE2E(name, sourceV2);

    assert.equal(retry.success, true);
    assert.equal(retry.steps.find(step => step.name === 'commit_baseline')?.status, 'done');
    assert.match(retry.steps.find(step => step.name === 'smart_merge')?.message, /overwritten/);
    assert.equal(readFile(dest, 'a.js'), 'v2');
    assert.equal(loadManifest(dest).files['a.js'], hashFile(path.join(sourceV2, 'a.js')));
    assert.equal(readFile(dest, '.zylos/originals/a.js'), 'v2');
  });

  test('final baseline commit failure rolls business files back against the untouched old baseline', () => {
    const name = 'commit-boundary-failure';
    const dest = installV1(name);
    const sourceV2 = makeV2(name);
    const manifestV1 = readFile(dest, '.zylos/manifest.json');
    fs.rmSync(failFlag, { force: true });

    const result = runUpgradeE2E(name, sourceV2, { failBaselineCommit: true });

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 9);
    assert.equal(result.steps.at(-1).name, 'commit_baseline');
    assert.equal(result.rollback.performed, true);
    assert.equal(readFile(dest, 'a.js'), 'v1');
    assert.equal(readFile(dest, '.zylos/manifest.json'), manifestV1);
    assert.equal(readFile(dest, '.zylos/originals/a.js'), 'v1');
    assert.equal(fs.existsSync(path.join(dest, '.zylos', 'manifest.json.tmp')), false);
    assert.equal(fs.existsSync(path.join(dest, '.zylos', 'originals.new')), false);
  });
});
