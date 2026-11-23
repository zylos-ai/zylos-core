import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We need to set ZYLOS_DIR before importing bin.js (it reads BIN_DIR from config at import time)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-bin-test-'));
process.env.ZYLOS_DIR = tmpRoot;

const { linkBins, unlinkBins } = await import('../bin.js');
const { BIN_DIR } = await import('../config.js');

describe('linkBins', () => {
  let skillDir;

  beforeEach(() => {
    skillDir = path.join(tmpRoot, 'skills', `test-${Date.now()}`);
    fs.mkdirSync(path.join(skillDir, 'src'), { recursive: true });
    // Create a dummy CLI script
    fs.writeFileSync(path.join(skillDir, 'src', 'cli.js'), '#!/usr/bin/env node\nconsole.log("hello");\n');
  });

  afterEach(() => {
    // Clean up bin dir symlinks
    if (fs.existsSync(BIN_DIR)) {
      for (const entry of fs.readdirSync(BIN_DIR)) {
        try { fs.unlinkSync(path.join(BIN_DIR, entry)); } catch { /* ignore */ }
      }
    }
  });

  it('creates symlink for valid bin entry', () => {
    const result = linkBins(skillDir, { 'test-cmd': 'src/cli.js' });

    assert.ok(result);
    assert.ok(result['test-cmd']);
    assert.equal(result['test-cmd'], path.join(BIN_DIR, 'test-cmd'));

    // Verify symlink exists and points to correct target
    const linkTarget = fs.readlinkSync(path.join(BIN_DIR, 'test-cmd'));
    assert.equal(linkTarget, path.join(skillDir, 'src', 'cli.js'));
  });

});

describe('unlinkBins', () => {
  let binDir;

  beforeEach(() => {
    binDir = BIN_DIR;
    fs.mkdirSync(binDir, { recursive: true });
  });

  it('does not remove regular files (safety check)', () => {
    const filePath = path.join(binDir, 'regular-file');
    fs.writeFileSync(filePath, 'not a symlink');

    unlinkBins({ 'regular-file': filePath });

    // Regular file should still exist
    assert.ok(fs.existsSync(filePath));

    // Cleanup
    fs.unlinkSync(filePath);
  });

});
