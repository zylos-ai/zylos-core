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
    assert.ok(!delivered.includes('[C4] ⚠️ TRUNCATED'));
  });
});

describe('truncation notice wording (#748)', () => {
  it('states incompleteness, gives an imperative, and reports preview/full sizes', () => {
    const content = 'F'.repeat(FILE_SIZE_THRESHOLD + 500);
    const delivered = truncateForDelivery(content, '', 3001);

    assert.ok(delivered.includes('only a preview'), 'must state the text above is incomplete');
    assert.ok(
      delivered.includes('you MUST read the complete message file:'),
      'must carry an imperative naming the concrete action',
    );
    assert.match(delivered, /\([\d.]+KB of [\d.]+KB\)/, 'must report preview and full sizes');
  });

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

  it('delivers inline at 750 and exactly at the threshold', () => {
    for (const total of [750, PASTE_CHAR_THRESHOLD]) {
      const out = truncateForDelivery(body(total), SUFFIX, 7000 + total);
      assert.equal(out.length, total);
      assert.ok(!out.includes('[C4] ⚠️ TRUNCATED'));
    }
  });

  it('spills one char over the threshold and at 850, with a notice that stays under it', () => {
    for (const total of [PASTE_CHAR_THRESHOLD + 1, 850]) {
      const content = body(total);
      const out = truncateForDelivery(content, SUFFIX, 8000 + total);
      assert.equal(fs.readFileSync(spillPathOf(out), 'utf8'), content + SUFFIX);
      assert.ok(out.length <= PASTE_CHAR_THRESHOLD, `notice too long: ${out.length}`);
      assert.ok(out.endsWith(SUFFIX));
    }
  });

  it('keeps the notice under the threshold even with a long thread reply-via', () => {
    const longSuffix = ` ---- reply via: node /home/user/zylos/.claude/skills/comm-bridge/scripts/c4-send.js "lark" "oc_${'0'.repeat(32)}|type:p2p|root:om_${'1'.repeat(32)}|parent:om_${'1'.repeat(32)}|msg:om_${'2'.repeat(32)}"`;
    const out = truncateForDelivery('汉'.repeat(3000), longSuffix, 8500);
    assert.ok(out.length <= PASTE_CHAR_THRESHOLD, `notice too long: ${out.length}`);
  });

  it('counts UTF-16 code units like Claude Code, not bytes', () => {
    const emoji = '😀'.repeat(401); // 802 units, 1604 bytes
    assert.ok(truncateForDelivery(emoji, '', 9001).includes('[C4] ⚠️ TRUNCATED'));
    const cjk = '汉'.repeat(600); // 600 units, 1800 bytes
    assert.equal(truncateForDelivery(cjk, '', 9002), cjk);
  });

  it('measures the sanitized text that is actually pasted', () => {
    // 790 visible chars + 20 CRs: 810 raw, but 790 after the dispatcher strips \r.
    const content = 'a\r\n'.repeat(20) + 'b'.repeat(750);
    assert.equal(content.length, 810);
    assert.equal(truncateForDelivery(content, '', 9003), content);
  });
});
