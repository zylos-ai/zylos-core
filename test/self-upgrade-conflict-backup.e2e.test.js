import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
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
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0);
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

// Run for self-upgrade conflict storage, reporting or rollback changes. Skip
// for unrelated changes. The child uses a temporary instance and package tree,
// injected service operations and the runner's isolated environment.
describe('self-upgrade durable conflict backups', () => {
  test('protected merge prints every nested conflict path and success cleanup preserves durable backups', () => {
    prepareThreeWayConflictFixture();

    const { result, launcherOutput, operations, transactionBackupDir } = runScenario('success');

    assert.equal(result.success, true);
    assert.equal(result.mergeConflicts.length, 2);
    assert.deepEqual(operations, ['save-package', 'save-code', 'snapshot-and-stop', 'install', 'release']);
    assert.equal(fs.existsSync(transactionBackupDir), false);

    for (const conflict of result.mergeConflicts) {
      assert.equal(conflict.backupPath.startsWith(path.join(zylosDir, '.backup') + path.sep), true);
      assert.equal(fs.existsSync(conflict.backupPath), true);
      assert.ok(launcherOutput.join('\n').includes(`${conflict.skill}/${conflict.file}`));
      assert.ok(launcherOutput.join('\n').includes(conflict.backupPath));
    }
    assert.equal(result.mergeConflicts.some(({ file }) => file === 'nested/settings.txt'), true);
    assert.ok(readFile(result.mergeConflicts.find(({ file }) => file === 'SKILL.md').backupPath).includes('value=local'));
  });

  test('JSON success cleanup removes transaction backup and retains durable conflict paths', () => {
    prepareThreeWayConflictFixture();

    const { result, launcherOutput, transactionBackupDir } = runScenario('json');

    assert.equal(result.success, true);
    assert.deepEqual(launcherOutput, []);
    assert.equal(fs.existsSync(transactionBackupDir), false);
    assert.equal(result.mergeConflicts.length, 2);
    for (const conflict of result.mergeConflicts) {
      assert.equal(fs.existsSync(conflict.backupPath), true);
    }
  });

  test('failure before cutoff compensates installed files and preserves durable conflicts', () => {
    prepareThreeWayConflictFixture();

    const { result, operations, transactionBackupDir } = runScenario('later-failure');

    assert.equal(result.success, false);
    assert.equal(result.failedStep, 6);
    assert.deepEqual(result.rollback, {attempted:true, completed:true, recovery_required:false, performed:true});
    assert.equal(operations.at(-1), 'compensate');
    assert.equal(fs.existsSync(transactionBackupDir), true);
    assert.ok(readFile(path.join(skillsDir, 'demo-skill/SKILL.md')).includes('value=local'));
    assert.equal(readFile(path.join(skillsDir, 'demo-skill/nested/settings.txt')), 'mode=local\n');

    const durableRoot = path.join(zylosDir, '.backup');
    const durableFiles = fs.readdirSync(durableRoot, { recursive: true })
      .filter((entry) => entry.includes(`${path.sep}conflicts${path.sep}`) && !fs.statSync(path.join(durableRoot, entry)).isDirectory());
    assert.equal(durableFiles.length, 2);
    assert.ok(readFile(path.join(durableRoot, durableFiles.find((entry) => entry.endsWith('SKILL.md')))).includes('value=local'));
  });

  test('no conflict does not create an empty durable backup directory', () => {
    writeFile(packageDir, 'skills/new-skill/SKILL.md', '# New\n');

    const { result } = runScenario('no-conflict');

    assert.equal(result.success, true);
    assert.equal(result.mergeConflicts, null);
    const conflictFiles = fs.readdirSync(path.join(zylosDir, '.backup'), {recursive:true})
      .filter(entry => entry.includes('conflicts'));
    assert.deepEqual(conflictFiles, []);
  });
});
