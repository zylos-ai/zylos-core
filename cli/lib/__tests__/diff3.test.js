import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';

const origHome = process.env.HOME;
const origTmpdir = process.env.TMPDIR;
const tmpDirs = [];

const { merge3, isDiff3Available } = await import('../diff3.js');

function makeTmpDir() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-diff3-test-'));
  tmpDirs.push(tmpDir);
  return tmpDir;
}

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

describe('merge3', () => {
  it('falls back to ~/tmp when TMPDIR is not writable', () => {
    if (!isDiff3Available()) {
      return;
    }

    const tmpDir = makeTmpDir();
    process.env.HOME = tmpDir;
    process.env.TMPDIR = '/nonexistent';

    const result = merge3(
      'line1\nline2\nline3\nline4\nline5\n',
      'line1\nlocal\nline3\nline4\nline5\n',
      'line1\nline2\nline3\nline4\nremote\n'
    );

    assert.equal(result.clean, true);
    assert.match(result.content, /local/);
    assert.match(result.content, /remote/);
  });
});
