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

/**
 * Freeze Date.now() to a constant while fn runs, so every spill in fn
 * resolves to the same millisecond deterministically — the collision is
 * forced, not left to timing luck. Restores the real clock afterwards.
 */
function withFrozenClock(fn) {
  const realNow = Date.now;
  Date.now = () => 1700000000000;
  try {
    return fn();
  } finally {
    Date.now = realNow;
  }
}

describe('truncateForDelivery conv-id spill naming', () => {
  it('spills with a conversation id land in a conv-<id> directory', () => {
    const content = 'C'.repeat(FILE_SIZE_THRESHOLD + 100);
    const p = spillPathOf(truncateForDelivery(content, '', 651));
    assert.ok(p.includes(`${path.sep}conv-651${path.sep}`), `path should contain conv-651 dir, got: ${p}`);
    assert.equal(fs.readFileSync(p, 'utf8'), content);
  });

  it('different conversation ids never share a path, even in the same millisecond', () => {
    const contentA = 'A'.repeat(FILE_SIZE_THRESHOLD + 100);
    const contentB = 'B'.repeat(FILE_SIZE_THRESHOLD + 100);
    const [pathA, pathB] = withFrozenClock(() => [
      spillPathOf(truncateForDelivery(contentA, '', 1001)),
      spillPathOf(truncateForDelivery(contentB, '', 1002))
    ]);
    assert.notEqual(pathA, pathB);
    assert.equal(fs.readFileSync(pathA, 'utf8'), contentA);
    assert.equal(fs.readFileSync(pathB, 'utf8'), contentB);
  });

  it('re-spilling the same conversation id overwrites its own directory idempotently', () => {
    const content = 'D'.repeat(FILE_SIZE_THRESHOLD + 100);
    const p1 = spillPathOf(truncateForDelivery(content, '', 2001));
    const p2 = spillPathOf(truncateForDelivery(content, '', 2001));
    assert.equal(p1, p2, 'same conv id must reuse the same path');
    assert.equal(fs.readFileSync(p2, 'utf8'), content, 'content intact after re-spill');
  });

  it('conv id 0 is treated as a valid id, not as missing', () => {
    const content = 'E'.repeat(FILE_SIZE_THRESHOLD + 100);
    const p = spillPathOf(truncateForDelivery(content, '', 0));
    assert.ok(p.includes(`${path.sep}conv-0${path.sep}`), `expected conv-0 dir, got: ${p}`);
  });
});

describe('truncateForDelivery fallback (no conv id) spill path collision', () => {
  it('same-millisecond spills in one process get distinct paths and both contents survive', () => {
    const contentA = 'A'.repeat(FILE_SIZE_THRESHOLD + 100);
    const contentB = 'B'.repeat(FILE_SIZE_THRESHOLD + 100);

    const [deliveredA, deliveredB] = withFrozenClock(() => [
      truncateForDelivery(contentA),
      truncateForDelivery(contentB)
    ]);

    const pathA = spillPathOf(deliveredA);
    const pathB = spillPathOf(deliveredB);

    assert.notEqual(pathA, pathB, 'two spills must never share a path');
    assert.equal(fs.readFileSync(pathA, 'utf8'), contentA, 'first spill content intact');
    assert.equal(fs.readFileSync(pathB, 'utf8'), contentB, 'second spill content intact');
  });

  it('a burst of same-millisecond spills yields unique paths for every message', () => {
    const N = 20;
    const paths = new Set();
    withFrozenClock(() => {
      for (let i = 0; i < N; i++) {
        const content = `msg-${i}-` + 'x'.repeat(FILE_SIZE_THRESHOLD + 50);
        const delivered = truncateForDelivery(content);
        const p = spillPathOf(delivered);
        paths.add(p);
        assert.equal(fs.readFileSync(p, 'utf8'), content, `spill ${i} content intact`);
      }
    });
    assert.equal(paths.size, N, 'every spill in the burst has its own path');
  });

  it('short messages are returned inline, no spill file created', () => {
    const content = 'short message';
    const delivered = truncateForDelivery(content);
    assert.equal(delivered, content);
    assert.ok(!delivered.includes('[C4] Full message'));
  });
});
