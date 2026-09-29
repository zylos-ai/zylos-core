import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('captures stop at capacity, preserve evidence, and restrict permissions', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-capture-'));
  const original = process.env.ZYLOS_DIR;
  process.env.ZYLOS_DIR = directory;
  try {
    const { saveEnterCapture } = await import(`../c4-diagnostic.js?test=${Date.now()}`);
    for (let i = 0; i < 100; i++) assert.equal(saveEnterCapture('x'.repeat(10000), 'after', { itemId: i }), 'saved');
    assert.equal(saveEnterCapture('must not overwrite', 'before'), 'capacity');
    const captures = path.join(directory, 'activity-monitor/enter-captures');
    assert.equal(fs.statSync(captures).mode & 0o777, 0o700);
    const files = fs.readdirSync(captures);
    assert.equal(files.length, 100);
    for (const file of files) {
      const location = path.join(captures, file);
      assert.equal(fs.statSync(location).mode & 0o777, 0o600);
      const content = JSON.parse(fs.readFileSync(location, 'utf8'));
      assert.equal(content.capture.length, 8192);
      assert.equal(content.phase, 'after');
    }
  } finally {
    if (original === undefined) delete process.env.ZYLOS_DIR;
    else process.env.ZYLOS_DIR = original;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
