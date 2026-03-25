import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];

const { copyTree } = await import('../fs-utils.js');

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

function makeTmpDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-fs-utils-test-'));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

describe('copyTree', () => {
  it('backs up a symlink root without precreating dest as a directory', () => {
    const tmpDir = makeTmpDir();
    const realSkillsDir = path.join(tmpDir, 'real-skills');
    const symlinkSkillsDir = path.join(tmpDir, 'skills');
    const backupTarget = path.join(tmpDir, 'backup', 'skills');

    fs.mkdirSync(realSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(realSkillsDir, 'manifest.json'), '{}', 'utf8');
    fs.symlinkSync(realSkillsDir, symlinkSkillsDir);

    copyTree(symlinkSkillsDir, backupTarget, { excludes: ['node_modules'] });

    const stat = fs.lstatSync(backupTarget);
    assert.equal(stat.isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(backupTarget), realSkillsDir);
  });
});
