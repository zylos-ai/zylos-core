import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Set up an isolated temp ZYLOS_DIR BEFORE importing c4-utils.js so that
// c4-config.js (evaluated once at first import) picks up our temp path.
const ORIG_ZYLOS_DIR = process.env.ZYLOS_DIR;
const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-utils-spill-test-'));
process.env.ZYLOS_DIR = TMP_DIR;

// Dynamic import so the env var is set before c4-config.js evaluates.
const { truncateForDelivery } = await import(new URL('../c4-utils.js', import.meta.url));
const { FILE_SIZE_THRESHOLD } = await import(new URL('../c4-config.js', import.meta.url));

// Restore env after module load.
if (ORIG_ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = ORIG_ZYLOS_DIR;

// Cleanup temp dir when process exits
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Extract the spill file path from a truncated delivery string. */
function spillPathOf(delivered) {
  const m = delivered.match(/\[C4\] Full message \([\d.]+KB\) at: (\S+)/);
  assert.ok(m, `expected truncated delivery with spill path, got: ${delivered.slice(0, 120)}`);
  return m[1];
}

describe('truncateForDelivery spill path collision', () => {
  it('same-millisecond spills in one process get distinct paths and both contents survive', () => {
    const contentA = 'A'.repeat(FILE_SIZE_THRESHOLD + 100);
    const contentB = 'B'.repeat(FILE_SIZE_THRESHOLD + 100);

    // Tight loop: both calls land in the same Date.now() millisecond with
    // near-certainty; even if the clock ticks between them the assertions
    // below must still hold.
    const deliveredA = truncateForDelivery(contentA);
    const deliveredB = truncateForDelivery(contentB);

    const pathA = spillPathOf(deliveredA);
    const pathB = spillPathOf(deliveredB);

    assert.notEqual(pathA, pathB, 'two spills must never share a path');
    assert.equal(fs.readFileSync(pathA, 'utf8'), contentA, 'first spill content intact');
    assert.equal(fs.readFileSync(pathB, 'utf8'), contentB, 'second spill content intact');
  });

  it('a burst of spills yields unique paths for every message', () => {
    const N = 20;
    const paths = new Set();
    for (let i = 0; i < N; i++) {
      const content = `msg-${i}-` + 'x'.repeat(FILE_SIZE_THRESHOLD + 50);
      const delivered = truncateForDelivery(content);
      const p = spillPathOf(delivered);
      paths.add(p);
      assert.equal(fs.readFileSync(p, 'utf8'), content, `spill ${i} content intact`);
    }
    assert.equal(paths.size, N, 'every spill in the burst has its own path');
  });

  it('short messages are returned inline, no spill file created', () => {
    const content = 'short message';
    const delivered = truncateForDelivery(content);
    assert.equal(delivered, content);
    assert.ok(!delivered.includes('[C4] Full message'));
  });
});
