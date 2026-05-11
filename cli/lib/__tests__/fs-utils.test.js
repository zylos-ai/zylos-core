import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const tmpDirs = [];
const origHome = process.env.HOME;
const origTmpdir = process.env.TMPDIR;

const { copyTree, syncTree } = await import('../fs-utils.js');

afterEach(() => {
  if (origHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = origHome;
  }
  if (origTmpdir === undefined) {
    delete process.env.TMPDIR;
  } else {
    process.env.TMPDIR = origTmpdir;
  }
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
  it('backs up the directory behind a symlink root', () => {
    const tmpDir = makeTmpDir();
    const realSkillsDir = path.join(tmpDir, 'real-skills');
    const symlinkSkillsDir = path.join(tmpDir, 'skills');
    const backupTarget = path.join(tmpDir, 'backup', 'skills');

    fs.mkdirSync(realSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(realSkillsDir, 'manifest.json'), '{}', 'utf8');
    fs.symlinkSync(realSkillsDir, symlinkSkillsDir);

    copyTree(symlinkSkillsDir, backupTarget, { excludes: ['node_modules'] });

    const stat = fs.lstatSync(backupTarget);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(backupTarget, 'manifest.json'), 'utf8'), '{}');
  });

  it('falls back to ~/tmp when TMPDIR is not writable during self-copy backup', () => {
    const tmpDir = makeTmpDir();
    const srcDir = path.join(tmpDir, 'skill');
    const nestedBackup = path.join(srcDir, '.backup', 'run-1');

    process.env.HOME = tmpDir;
    process.env.TMPDIR = '/nonexistent';

    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), '# test\n', 'utf8');

    copyTree(srcDir, nestedBackup, { excludes: ['node_modules', '.backup'] });

    assert.equal(fs.existsSync(path.join(nestedBackup, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(tmpDir, 'tmp')), true);
  });
});

describe('syncTree', () => {
  it('refuses to sync a symlink backup path that resolves to the destination', () => {
    const tmpDir = makeTmpDir();
    const skillsDir = path.join(tmpDir, 'skills');
    const backupDir = path.join(tmpDir, 'backup');
    const backupSkills = path.join(backupDir, 'skills');

    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(skillsDir, 'component.txt'), 'keep me', 'utf8');
    fs.symlinkSync(skillsDir, backupSkills);

    assert.throws(
      () => syncTree(backupSkills, skillsDir, { excludes: ['node_modules'] }),
      /Refusing to sync identical paths/
    );
    assert.equal(fs.readFileSync(path.join(skillsDir, 'component.txt'), 'utf8'), 'keep me');
  });

  it('restores from a nested backup while preserving excluded directories', () => {
    const tmpDir = makeTmpDir();
    const destDir = path.join(tmpDir, 'skills', 'demo');
    const srcDir = path.join(destDir, '.backup', 'run-1');

    fs.mkdirSync(srcDir, { recursive: true });
    fs.mkdirSync(path.join(destDir, '.backup'), { recursive: true });
    fs.mkdirSync(path.join(destDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(destDir, '.zylos'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'SKILL.md'), 'old', 'utf8');
    fs.writeFileSync(path.join(destDir, 'SKILL.md'), 'broken', 'utf8');
    fs.writeFileSync(path.join(destDir, 'new-file.txt'), 'remove me', 'utf8');
    fs.writeFileSync(path.join(destDir, 'node_modules', 'keep.txt'), 'deps', 'utf8');
    fs.writeFileSync(path.join(destDir, '.zylos', 'manifest.json'), '{}', 'utf8');

    syncTree(srcDir, destDir, { excludes: ['node_modules', '.backup', '.zylos'] });

    assert.equal(fs.readFileSync(path.join(destDir, 'SKILL.md'), 'utf8'), 'old');
    assert.equal(fs.existsSync(path.join(destDir, 'new-file.txt')), false);
    assert.equal(fs.existsSync(path.join(destDir, '.backup', 'run-1', 'SKILL.md')), true);
    assert.equal(fs.readFileSync(path.join(destDir, 'node_modules', 'keep.txt'), 'utf8'), 'deps');
    assert.equal(fs.readFileSync(path.join(destDir, '.zylos', 'manifest.json'), 'utf8'), '{}');
  });
});
