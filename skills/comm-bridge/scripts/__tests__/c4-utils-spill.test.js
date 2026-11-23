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
const { FILE_SIZE_THRESHOLD, PASTE_CHAR_THRESHOLD } = await import(new URL('../c4-config.js', import.meta.url));

// Restore env after module load.
if (ORIG_ZYLOS_DIR === undefined) delete process.env.ZYLOS_DIR;
else process.env.ZYLOS_DIR = ORIG_ZYLOS_DIR;

// Cleanup temp dir when process exits
process.on('exit', () => {
  try { fs.rmSync(TMP_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
});

/** Extract the spill file path from a truncated delivery string. */
function spillPathOf(delivered) {
  const m = delivered.match(/\[C4\] ⚠️ TRUNCATED — .* you MUST read the complete message file: (\S+)/);
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

});

describe('truncation notice wording (#748)', () => {

  it('keeps the reply-via suffix after the notice so routing survives truncation', () => {
    const content = 'G'.repeat(FILE_SIZE_THRESHOLD + 500);
    const suffix = ' ---- reply via: node /x/c4-send.js "telegram" "42"';
    const delivered = truncateForDelivery(content, suffix, 3002);

    assert.ok(delivered.endsWith(suffix), 'reply-via suffix must terminate the delivery');
    const noticeIdx = delivered.indexOf('[C4] ⚠️ TRUNCATED');
    assert.ok(noticeIdx !== -1 && noticeIdx < delivered.indexOf(suffix), 'notice precedes reply-via');
  });
});

describe('truncateForDelivery paste-wrap char threshold', () => {
  const SUFFIX = ' ---- reply via: node c4-send.js "lark" "oc_x|type:p2p"';
  const body = (total) => 'a'.repeat(total - SUFFIX.length);

  it('spills one char over the threshold and at 850, with a notice that stays under it', () => {
    for (const total of [PASTE_CHAR_THRESHOLD + 1, 850]) {
      const content = body(total);
      const out = truncateForDelivery(content, SUFFIX, 8000 + total);
      assert.equal(fs.readFileSync(spillPathOf(out), 'utf8'), content + SUFFIX);
      assert.ok(out.length <= PASTE_CHAR_THRESHOLD, `notice too long: ${out.length}`);
      assert.ok(out.endsWith(SUFFIX));
    }
  });

});
