import assert from 'node:assert/strict';
import { describe, it, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DELIVERY_DELAY_BASE,
  DELIVERY_DELAY_PER_KB,
  DELIVERY_DELAY_MAX
} from '../c4-config.js';

// Set ZYLOS_DIR to a temp dir BEFORE importing the dispatcher so the DB
// initialises in an isolated location and the background main() loop is harmless.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4-disp-test-'));
const origZylosDir = process.env.ZYLOS_DIR;
process.env.ZYLOS_DIR = tmpDir;

const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const mod = await import(new URL(`../c4-dispatcher.js?${cacheBuster}`, import.meta.url));

const { sanitizeMessage, getDeliveryDelay, getInputBoxText, checkInputBox, isBypassState } = mod;

after(() => {
  if (origZylosDir === undefined) {
    delete process.env.ZYLOS_DIR;
  } else {
    process.env.ZYLOS_DIR = origZylosDir;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

/** Build a fake tmux capture with two separator lines surrounding `content`. */
function makeCapture(content) {
  const sep = '\u2500'.repeat(40);
  return `${sep}\n${content}\n${sep}`;
}

// ── sanitizeMessage ─────────────────────────────────────────────────

describe('sanitizeMessage', () => {
  it('strips NUL, SOH, BS and other low control chars', () => {
    assert.equal(sanitizeMessage('a\x00b\x01c\x08d'), 'abcd');
  });

  it('preserves tab (\\x09) and LF (\\x0A) but strips CR (\\x0D)', () => {
    assert.equal(sanitizeMessage('a\tb\nc\rd'), 'a\tb\ncd');
  });

  it('passes normal text through unchanged', () => {
    const text = 'Hello, World! 123 @#$%';
    assert.equal(sanitizeMessage(text), text);
  });

  it('strips vertical tab (\\x0B) and unit separator (\\x1F)', () => {
    assert.equal(sanitizeMessage('a\x0Bb\x1Fc'), 'abc');
  });

  it('returns empty string for empty input', () => {
    assert.equal(sanitizeMessage(''), '');
  });
});

// ── getDeliveryDelay ────────────────────────────────────────────────

describe('getDeliveryDelay', () => {
  it('returns DELIVERY_DELAY_BASE for 0 bytes', () => {
    assert.equal(getDeliveryDelay(0), DELIVERY_DELAY_BASE);
  });

  it('returns BASE + PER_KB for exactly 1024 bytes', () => {
    assert.equal(getDeliveryDelay(1024), DELIVERY_DELAY_BASE + DELIVERY_DELAY_PER_KB);
  });

  it('floors partial KB (500 bytes rounds down to 0 KB extra)', () => {
    assert.equal(getDeliveryDelay(500), DELIVERY_DELAY_BASE);
  });

  it('caps at DELIVERY_DELAY_MAX for very large input', () => {
    const hugeBytes = 1024 * 1024; // 1 MB
    assert.equal(getDeliveryDelay(hugeBytes), DELIVERY_DELAY_MAX);
  });

  it('computes correctly for multi-KB input below max', () => {
    // 3072 bytes = 3 KB → BASE + 3 * PER_KB = 200 + 300 = 500
    const expected = Math.min(DELIVERY_DELAY_BASE + 3 * DELIVERY_DELAY_PER_KB, DELIVERY_DELAY_MAX);
    assert.equal(getDeliveryDelay(3072), expected);
  });
});

// ── getInputBoxText ─────────────────────────────────────────────────

describe('getInputBoxText', () => {
  it('returns text between the last two separator lines', () => {
    const capture = makeCapture('hello world');
    assert.equal(getInputBoxText(capture), 'hello world');
  });

  it('returns null when fewer than 2 separators are present', () => {
    const oneSep = '\u2500'.repeat(40) + '\nsome text';
    assert.equal(getInputBoxText(oneSep), null);
  });

  it('returns null for plain text with no separators', () => {
    assert.equal(getInputBoxText('just some text'), null);
  });

  it('returns empty string when box is empty (two adjacent separators)', () => {
    const sep = '\u2500'.repeat(40);
    assert.equal(getInputBoxText(`${sep}\n${sep}`), '');
  });

  it('uses the last two separators when more than two exist', () => {
    const sep = '\u2500'.repeat(40);
    const capture = `${sep}\nfirst\n${sep}\nsecond\n${sep}`;
    assert.equal(getInputBoxText(capture), 'second');
  });

  it('ignores short lines of ─ chars (length <= 10)', () => {
    const shortSep = '\u2500'.repeat(5);
    const longSep = '\u2500'.repeat(40);
    // Only one valid separator (the long one), so returns null
    assert.equal(getInputBoxText(`${shortSep}\ntext\n${longSep}`), null);
  });

  it('handles multi-line content in the input box', () => {
    const capture = makeCapture('line1\nline2\nline3');
    assert.equal(getInputBoxText(capture), 'line1\nline2\nline3');
  });
});

// ── checkInputBox ───────────────────────────────────────────────────

describe('checkInputBox', () => {
  it('returns "empty" when box contains only whitespace', () => {
    const capture = makeCapture('   \n  ');
    assert.equal(checkInputBox(capture), 'empty');
  });

  it('returns "empty" when box contains only the prompt char ❯', () => {
    const capture = makeCapture('\u276F');
    assert.equal(checkInputBox(capture), 'empty');
  });

  it('returns "has_content" when box contains actual text', () => {
    const capture = makeCapture('some user input');
    assert.equal(checkInputBox(capture), 'has_content');
  });

  it('returns "indeterminate" when no separators are found', () => {
    assert.equal(checkInputBox('no separators here'), 'indeterminate');
  });

  it('returns "empty" for box with only ❯ and whitespace', () => {
    const capture = makeCapture('  \u276F  ');
    assert.equal(checkInputBox(capture), 'empty');
  });
});

// ── isBypassState ───────────────────────────────────────────────────

describe('isBypassState', () => {
  it('returns true for control items with bypass_state=1', () => {
    assert.equal(isBypassState({ type: 'control', bypass_state: 1 }), true);
  });

  it('returns false for conversation items even with bypass_state=1', () => {
    assert.equal(isBypassState({ type: 'conversation', bypass_state: 1 }), false);
  });

  it('returns false for control items with bypass_state=0', () => {
    assert.equal(isBypassState({ type: 'control', bypass_state: 0 }), false);
  });

  it('returns false when bypass_state is undefined', () => {
    assert.equal(isBypassState({ type: 'control' }), false);
  });

  it('returns false for empty object', () => {
    assert.equal(isBypassState({}), false);
  });
});
