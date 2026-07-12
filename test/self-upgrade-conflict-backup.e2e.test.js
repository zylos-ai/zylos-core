import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateManifest, saveMergeBaseline } from '../cli/lib/manifest.js';

const DRIVER = path.join(import.meta.dirname, 'helpers', 'run-self-upgrade-driver.mjs');

let tmpRoot;
let zylosDir;
let skillsDir;
let packageDir;

function writeFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function readFile(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function prepareThreeWayConflictFixture() {
  const baseline = path.join(tmpRoot, 'baseline');
  const installed = path.join(skillsDir, 'demo-skill');
  const incoming = path.join(packageDir, 'skills', 'demo-skill');

  writeFile(baseline, 'SKILL.md', '# Demo\nvalue=baseline\n');
  writeFile(baseline, 'nested/settings.txt', 'mode=baseline\n');
  writeFile(installed, 'SKILL.md', '# Demo\nvalue=local\n');
  writeFile(installed, 'nested/settings.txt', 'mode=local\n');
  saveMergeBaseline(installed, baseline, generateManifest(baseline));
  writeFile(incoming, 'SKILL.md', '# Demo\nvalue=upstream\n');
  writeFile(incoming, 'nested/settings.txt', 'mode=upstream\n');
}

function runScenario(scenario) {
  const child = spawnSync(process.execPath, [DRIVER, packageDir, scenario], {
    encoding: 'utf8',
    env: { ...process.env, ZYLOS_DIR: zylosDir, NO_COLOR: '1' },
    timeout: 60000,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return JSON.parse(child.stdout);
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-self-upgrade-717-'));
  zylosDir = path.join(tmpRoot, 'zylos');
  skillsDir = path.join(zylosDir, '.claude', 'skills');
  packageDir = path.join(tmpRoot, 'new-package');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.mkdirSync(packageDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('self-upgrade durable conflict backups (#717)', () => {
  test('old launcher prints every nested conflict path and success cleanup preserves durable backups', () => {
    prepareThreeWayConflictFixture();

    const { result, launcherOutput, npmCommands, stoppedServices, transactionBackupDir } = runScenario('success');

    expect(result.success).toBe(true);
    expect(result.mergeConflicts).toHaveLength(2);
    expect(stoppedServices).toEqual(['fixture-service']);
    expect(npmCommands).toHaveLength(2);
    expect(npmCommands[0]).toMatch(/^npm pack/);
    expect(npmCommands[1]).toMatch(/^npm install -g/);
    expect(fs.existsSync(transactionBackupDir)).toBe(false);

    for (const conflict of result.mergeConflicts) {
      expect(conflict.backupPath.startsWith(path.join(zylosDir, '.backup') + path.sep)).toBe(true);
      expect(fs.existsSync(conflict.backupPath)).toBe(true);
      expect(launcherOutput.join('\n')).toContain(`${conflict.skill}/${conflict.file}`);
      expect(launcherOutput.join('\n')).toContain(conflict.backupPath);
    }
    expect(result.mergeConflicts.some(({ file }) => file === 'nested/settings.txt')).toBe(true);
    expect(readFile(result.mergeConflicts.find(({ file }) => file === 'SKILL.md').backupPath)).toContain('value=local');
  });

  test('JSON result exposes durable backup paths without running success cleanup', () => {
    prepareThreeWayConflictFixture();

    const { result, launcherOutput, transactionBackupDir } = runScenario('json');

    expect(result.success).toBe(true);
    expect(launcherOutput).toEqual([]);
    expect(fs.existsSync(transactionBackupDir)).toBe(true);
    expect(result.mergeConflicts).toHaveLength(2);
    for (const conflict of result.mergeConflicts) {
      expect(fs.existsSync(conflict.backupPath)).toBe(true);
    }
  });

  test('later finalizer failure performs no rollback and retains both backup lifecycles', () => {
    prepareThreeWayConflictFixture();

    const { result, transactionBackupDir } = runScenario('later-failure');

    expect(result.success).toBe(false);
    expect(result.failedStep).toBe(6);
    expect(result.rollback).toEqual({ performed: false, steps: [] });
    expect(fs.existsSync(transactionBackupDir)).toBe(true);

    const durableRoot = path.join(zylosDir, '.backup');
    const durableFiles = fs.readdirSync(durableRoot, { recursive: true })
      .filter((entry) => !fs.statSync(path.join(durableRoot, entry)).isDirectory());
    expect(durableFiles).toHaveLength(2);
    expect(readFile(path.join(durableRoot, durableFiles.find((entry) => entry.endsWith('SKILL.md'))))).toContain('value=local');
  });

  test('no conflict does not create an empty durable backup directory', () => {
    writeFile(packageDir, 'skills/new-skill/SKILL.md', '# New\n');

    const { result } = runScenario('no-conflict');

    expect(result.success).toBe(true);
    expect(result.mergeConflicts).toBeNull();
    expect(fs.existsSync(path.join(zylosDir, '.backup'))).toBe(false);
  });
});
