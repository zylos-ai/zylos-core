import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { customInjectDir, emitCustomInject } from '../emit-custom-inject.js';

const tmpDirs = [];

function makeZylosDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-inject-test-'));
  tmpDirs.push(dir);
  return dir;
}

function writeCustomFile(zylosDir, name, content) {
  const dir = path.join(zylosDir, 'custom-hooks', 'session-start');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), content);
}

afterEach(() => {
  while (tmpDirs.length) fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('customInjectDir', () => {
  it('resolves under ZYLOS_DIR when set, else under ~/zylos', () => {
    assert.equal(customInjectDir({ ZYLOS_DIR: '/opt/zy' }), path.join('/opt/zy', 'custom-hooks', 'session-start'));
    assert.equal(customInjectDir({}), path.join(os.homedir(), 'zylos', 'custom-hooks', 'session-start'));
  });
});

describe('emitCustomInject', () => {
  it('emits nothing when the directory does not exist (fresh install)', () => {
    const zylosDir = makeZylosDir();
    assert.equal(emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), '');
  });

  it('emits nothing when the directory has no usable content', () => {
    const zylosDir = makeZylosDir();
    fs.mkdirSync(path.join(zylosDir, 'custom-hooks', 'session-start'), { recursive: true });
    assert.equal(emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), '');

    // Whitespace-only and empty files count as no content.
    writeCustomFile(zylosDir, '10-empty.md', '');
    writeCustomFile(zylosDir, '20-blank.md', '  \n\n\t\n');
    assert.equal(emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), '');
  });

  it('concatenates .md files in lexicographic order (conf.d-style prefixes)', () => {
    const zylosDir = makeZylosDir();
    // Written out of order on purpose — filename order must win.
    writeCustomFile(zylosDir, '20-platform.md', 'PLATFORM RULES');
    writeCustomFile(zylosDir, '10-rules.md', 'HOUSE RULES\n');

    assert.equal(
      emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }),
      'HOUSE RULES\n\nPLATFORM RULES'
    );
  });

  it('ignores dotfiles and non-md entries', () => {
    const zylosDir = makeZylosDir();
    writeCustomFile(zylosDir, '10-real.md', 'REAL');
    writeCustomFile(zylosDir, '.05-hidden.md', 'HIDDEN');
    writeCustomFile(zylosDir, 'notes.txt', 'TXT');
    writeCustomFile(zylosDir, 'script.js', 'console.log("nope")');
    fs.mkdirSync(path.join(zylosDir, 'custom-hooks', 'session-start', 'subdir.md'), { recursive: true });

    assert.equal(emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), 'REAL');
  });

  it('skips symlinked .md files while injecting regular .md files', () => {
    const zylosDir = makeZylosDir();
    writeCustomFile(zylosDir, '10-real.md', 'REAL');

    const outsideFile = path.join(zylosDir, 'outside.md');
    fs.writeFileSync(outsideFile, 'OUTSIDE');
    fs.symlinkSync(
      outsideFile,
      path.join(zylosDir, 'custom-hooks', 'session-start', '20-linked.md')
    );

    assert.equal(emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), 'REAL');
  });

  it('skips whitespace-only files but keeps the rest in order', () => {
    const zylosDir = makeZylosDir();
    writeCustomFile(zylosDir, '10-a.md', 'A');
    writeCustomFile(zylosDir, '20-blank.md', '   \n');
    writeCustomFile(zylosDir, '30-c.md', '\nC\n');

    assert.equal(emitCustomInject({ env: { ZYLOS_DIR: zylosDir } }), 'A\n\nC');
  });
});
