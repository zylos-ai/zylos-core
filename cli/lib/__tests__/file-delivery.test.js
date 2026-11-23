import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

// Sandbox ZYLOS_DIR before importing so the offline registry lookup reads a
// hermetic ~/.zylos/registry.json instead of the developer's real one.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zylos-file-delivery-test-'));
process.env.ZYLOS_DIR = sandbox;
fs.mkdirSync(path.join(sandbox, '.zylos'), { recursive: true });
fs.writeFileSync(
  path.join(sandbox, '.zylos', 'registry.json'),
  JSON.stringify({
    components: {
      'file-fixture': { repo: 'zylos-ai/zylos-file-fixture', type: 'service' },
    },
  }),
  'utf8'
);

const { isValidSha256Hex } = await import('../checksum.js');

const tmpDirs = [sandbox];

after(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});



describe('checksum utilities', () => {

  it('validates sha256 hex digests strictly', () => {
    assert.equal(isValidSha256Hex('a'.repeat(64)), true);
    assert.equal(isValidSha256Hex('A0'.repeat(32)), true);
    assert.equal(isValidSha256Hex('a'.repeat(63)), false);
    assert.equal(isValidSha256Hex('a'.repeat(65)), false);
    assert.equal(isValidSha256Hex('g'.repeat(64)), false);
    assert.equal(isValidSha256Hex(null), false);
    assert.equal(isValidSha256Hex(42), false);
  });
});
