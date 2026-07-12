/**
 * Real-pipeline coverage for the contracted #715 ownership boundary.
 * smartSync applies business files in step 3, while runUpgrade commits the
 * authoritative baseline only after every rollback-triggering step succeeds.
 */
import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
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
    },
    timeout: 60000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-baseline-commit-e2e-'));
  zylosDir = path.join(tmpRoot, 'zylos-home');
  skillsDir = path.join(zylosDir, '.claude', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });

  shimDir = path.join(tmpRoot, 'shim-bin');
  fs.mkdirSync(shimDir, { recursive: true });
  failFlag = path.join(shimDir, 'npm-fail');
  fs.writeFileSync(path.join(shimDir, 'npm'), [
    '#!/bin/sh',
    `if [ -e "${failFlag}" ]; then exit 1; fi`,
    'exit 0',
    '',
  ].join('\n'), { mode: 0o755 });
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('runUpgrade owns the final baseline commit (#715)', () => {
  test('component upgrade does not report an identical file missing from the saved manifest as conflict', () => {
    const name = 'identical-untracked-collision';
    const dest = installV1(name);
    const sourceV2 = makeV2(name);
    writeFile(dest, 'same.js', 'byte-identical');
    writeFile(sourceV2, 'same.js', 'byte-identical');
    fs.rmSync(failFlag, { force: true });

    const result = runUpgradeE2E(name, sourceV2);

    expect(result.success).toBe(true);
    expect(result.mergeConflicts).toBeNull();
    expect(readFile(dest, 'same.js')).toBe('byte-identical');
  });

  test('later npm failure rolls back files while the old baseline remains untouched; retry truly upgrades', () => {
    const name = 'commit-boundary-retry';
    const dest = installV1(name);
    const sourceV2 = makeV2(name);
    const manifestV1 = readFile(dest, '.zylos/manifest.json');

    fs.writeFileSync(failFlag, '');
    const failed = runUpgradeE2E(name, sourceV2);

    expect(failed.success).toBe(false);
    expect(failed.failedStep).toBe(4);
    expect(readFile(dest, 'a.js')).toBe('v1');
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v1');
    expect(failed.rollback.steps.some(step => step.action === 'restore_baseline')).toBe(false);

    fs.rmSync(failFlag, { force: true });
    const retry = runUpgradeE2E(name, sourceV2);

    expect(retry.success).toBe(true);
    expect(retry.steps.find(step => step.name === 'commit_baseline')?.status).toBe('done');
    expect(retry.steps.find(step => step.name === 'smart_merge')?.message).toMatch(/overwritten/);
    expect(readFile(dest, 'a.js')).toBe('v2');
    expect(loadManifest(dest).files['a.js']).toBe(hashFile(path.join(sourceV2, 'a.js')));
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v2');
  });

  test('successful pipeline exposes the baseline commit as its final step', () => {
    const name = 'commit-boundary-success';
    const dest = installV1(name);
    const sourceV2 = makeV2(name);
    fs.rmSync(failFlag, { force: true });

    const result = runUpgradeE2E(name, sourceV2);

    expect(result.success).toBe(true);
    expect(result.steps.at(-1).name).toBe('commit_baseline');
    expect(result.steps.at(-1).step).toBe(9);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v2');
  });

  test('final baseline commit failure rolls business files back against the untouched old baseline', () => {
    const name = 'commit-boundary-failure';
    const dest = installV1(name);
    const sourceV2 = makeV2(name);
    const manifestV1 = readFile(dest, '.zylos/manifest.json');
    fs.rmSync(failFlag, { force: true });

    const result = runUpgradeE2E(name, sourceV2, { failBaselineCommit: true });

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe(9);
    expect(result.steps.at(-1).name).toBe('commit_baseline');
    expect(result.rollback.performed).toBe(true);
    expect(readFile(dest, 'a.js')).toBe('v1');
    expect(readFile(dest, '.zylos/manifest.json')).toBe(manifestV1);
    expect(readFile(dest, '.zylos/originals/a.js')).toBe('v1');
    expect(fs.existsSync(path.join(dest, '.zylos', 'manifest.json.tmp'))).toBe(false);
    expect(fs.existsSync(path.join(dest, '.zylos', 'originals.new'))).toBe(false);
  });
});
