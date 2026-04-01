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
const origDisableMain = process.env.C4_DISPATCHER_DISABLE_MAIN;
process.env.ZYLOS_DIR = tmpDir;
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';

const cacheBuster = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const mod = await import(new URL(`../c4-dispatcher.js?${cacheBuster}`, import.meta.url));

const {
  sanitizeMessage,
  getDeliveryDelay,
  getInputBoxText,
  checkInputBox,
  isUsageOverlayCapture,
  isBypassState,
  isKeystrokeControl,
  parseKeystrokeKey,
  getHeartbeatPhase,
  shouldAutoAckHeartbeat,
  readJsonFileWithRetry
} = mod;

after(() => {
  if (origZylosDir === undefined) {
    delete process.env.ZYLOS_DIR;
  } else {
    process.env.ZYLOS_DIR = origZylosDir;
  }
  if (origDisableMain === undefined) {
    delete process.env.C4_DISPATCHER_DISABLE_MAIN;
  } else {
    process.env.C4_DISPATCHER_DISABLE_MAIN = origDisableMain;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── helpers ──────────────────────────────────────────────────────────

/** Build a fake tmux capture with two separator lines surrounding `content`. */
function makeCapture(content) {
  const sep = '\u2500'.repeat(40);
  return `${sep}\n${content}\n${sep}`;
}

/** Build a capture with buddy art appended to separator lines. */
function makeBuddyCapture(content) {
  const sep = '\u2500'.repeat(40);
  return `${sep}  /^\\  /^\\\n${content}  <  \u25C9  \u25C9  >\n${sep}   \`-vvvv-\u00B4`;
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

  it('detects separators with buddy art appended (/buddy pet)', () => {
    const capture = makeBuddyCapture('❯ hello');
    assert.equal(getInputBoxText(capture), '❯ hello  <  \u25C9  \u25C9  >');
  });

  it('detects empty input box with buddy art', () => {
    const sep = '\u2500'.repeat(40);
    const capture = `${sep}  /^\\  /^\\\n❯   <  \u25C9  \u25C9  >\n${sep}   \`-vvvv-\u00B4`;
    const text = getInputBoxText(capture);
    assert.notEqual(text, null); // separator detected even with buddy art
  });

  it('falls back to Codex prompt/footer layout when separators are absent', () => {
    const capture = [
      '',
      '› [Lark DM] hello',
      '  wrapped line',
      '',
      '  tab to queue message                                        72% context left'
    ].join('\n');
    assert.equal(getInputBoxText(capture), '[Lark DM] hello\n  wrapped line');
  });

  it('returns empty string for a bare Codex prompt before the footer', () => {
    const capture = [
      '',
      '›',
      '',
      '  tab to queue message                                        72% context left'
    ].join('\n');
    assert.equal(getInputBoxText(capture), '');
  });

  it('falls back to Codex status-line layout when queue footer is absent', () => {
    const capture = [
      '',
      '› hello from lark',
      '  wrapped line',
      '',
      'gpt-5.4 default · 75% left · ~/zylos',
      '────────────────────────────────────────'
    ].join('\n');
    assert.equal(getInputBoxText(capture), 'hello from lark\n  wrapped line');
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

  it('returns "empty" when box contains only the prompt char ›', () => {
    const capture = makeCapture('›');
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

  it('returns "empty" for Codex separator layout with only › prompt', () => {
    const capture = makeCapture('›');
    assert.equal(checkInputBox(capture), 'empty');
  });

  it('returns "has_content" for Codex prompt/footer captures', () => {
    const capture = [
      '',
      '› [Lark DM] hello',
      '  wrapped line',
      '',
      '  tab to queue message                                        72% context left'
    ].join('\n');
    assert.equal(checkInputBox(capture), 'has_content');
  });

  it('returns "empty" for a bare Codex prompt/footer capture', () => {
    const capture = [
      '',
      '›',
      '',
      '  tab to queue message                                        72% context left'
    ].join('\n');
    assert.equal(checkInputBox(capture), 'empty');
  });

  it('returns "has_content" for Codex status-line captures', () => {
    const capture = [
      '',
      '› hello from lark',
      '  wrapped line',
      '',
      'gpt-5.4 default · 75% left · ~/zylos',
      '────────────────────────────────────────'
    ].join('\n');
    assert.equal(checkInputBox(capture), 'has_content');
  });
});

// ── isUsageOverlayCapture ───────────────────────────────────────────

describe('isUsageOverlayCapture', () => {
  it('detects /usage settings overlay capture', () => {
    const capture = [
      'Settings:  Status   Config   Usage  (←/→ or tab to cycle)',
      '',
      '/usage is only available for subscription plans.',
      '',
      'Esc to cancel'
    ].join('\n');
    assert.equal(isUsageOverlayCapture(capture), true);
  });

  it('returns false for normal chat capture', () => {
    const capture = makeCapture('hello world');
    assert.equal(isUsageOverlayCapture(capture), false);
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

// ── getHeartbeatPhase ───────────────────────────────────────────────

describe('getHeartbeatPhase', () => {
  it('extracts the encoded heartbeat phase from control content', () => {
    assert.equal(getHeartbeatPhase('Heartbeat check. [phase=primary]'), 'primary');
  });

  it('returns unknown when no phase marker is present', () => {
    assert.equal(getHeartbeatPhase('Heartbeat check.'), 'unknown');
  });
});

// ── shouldAutoAckHeartbeat ──────────────────────────────────────────

describe('shouldAutoAckHeartbeat', () => {
  const heartbeatItem = { content: 'Heartbeat check. [phase=primary]' };
  const aliveProc = { alive: true, frozen: false, lastDelta: 1 };

  it('keeps the existing busy-path auto-ack when activity hooks confirm work is running', () => {
    assert.equal(shouldAutoAckHeartbeat({
      item: { content: 'Heartbeat check. [phase=recovery]' },
      agentState: { state: 'busy', health: 'recovering', idleSeconds: 0, healthy: true },
      procState: aliveProc,
      confirmedActive: true
    }), true);
  });

  it('auto-acks on the idle path when the session is healthy and stably idle', () => {
    assert.equal(shouldAutoAckHeartbeat({
      item: heartbeatItem,
      agentState: { state: 'idle', health: 'ok', idleSeconds: 3, healthy: true },
      procState: aliveProc,
      confirmedActive: false
    }), true);
  });

  it('does not auto-ack non-primary idle heartbeats', () => {
    assert.equal(shouldAutoAckHeartbeat({
      item: { content: 'Heartbeat check. [phase=stuck]' },
      agentState: { state: 'idle', health: 'ok', idleSeconds: 10, healthy: true },
      procState: aliveProc,
      confirmedActive: false
    }), false);
  });

  it('does not auto-ack idle heartbeats before the sustained-idle threshold', () => {
    assert.equal(shouldAutoAckHeartbeat({
      item: heartbeatItem,
      agentState: { state: 'idle', health: 'ok', idleSeconds: 2, healthy: true },
      procState: aliveProc,
      confirmedActive: false
    }), false);
  });

  it('does not auto-ack idle heartbeats while health is not ok', () => {
    assert.equal(shouldAutoAckHeartbeat({
      item: heartbeatItem,
      agentState: { state: 'idle', health: 'recovering', idleSeconds: 10, healthy: true },
      procState: aliveProc,
      confirmedActive: false
    }), false);
  });

  it('does not auto-ack when agent status is not fresh', () => {
    assert.equal(shouldAutoAckHeartbeat({
      item: heartbeatItem,
      agentState: { state: 'idle', health: 'ok', idleSeconds: 10, healthy: false },
      procState: aliveProc,
      confirmedActive: false
    }), false);
  });

  it('does not auto-ack idle heartbeats when proc-state says the agent is frozen', () => {
    assert.equal(shouldAutoAckHeartbeat({
      item: heartbeatItem,
      agentState: { state: 'idle', health: 'ok', idleSeconds: 10, healthy: true },
      procState: { alive: true, frozen: true, lastDelta: 0 },
      confirmedActive: false
    }), false);
  });
});

describe('readJsonFileWithRetry', () => {
  it('parses valid JSON from disk', () => {
    const file = path.join(tmpDir, 'status.json');
    fs.writeFileSync(file, '{"health":"ok"}');
    assert.deepStrictEqual(readJsonFileWithRetry(file), { health: 'ok' });
  });

  it('throws after exhausting retries on invalid JSON', () => {
    const file = path.join(tmpDir, 'broken.json');
    fs.writeFileSync(file, '{"health":');
    assert.throws(() => readJsonFileWithRetry(file, 2), /Unexpected end of JSON input|JSON/);
  });
});

// ── isKeystrokeControl ──────────────────────────────────────────────

describe('isKeystrokeControl', () => {
  it('returns true for control items with [KEYSTROKE] prefix', () => {
    assert.equal(isKeystrokeControl({ type: 'control', content: '[KEYSTROKE]Enter' }), true);
  });

  it('returns true for keystroke with other keys', () => {
    assert.equal(isKeystrokeControl({ type: 'control', content: '[KEYSTROKE]Tab' }), true);
  });

  it('returns false for conversation items with [KEYSTROKE] prefix', () => {
    assert.equal(isKeystrokeControl({ type: 'conversation', content: '[KEYSTROKE]Enter' }), false);
  });

  it('returns false for control items without [KEYSTROKE] prefix', () => {
    assert.equal(isKeystrokeControl({ type: 'control', content: 'Heartbeat check' }), false);
  });

  it('returns false for empty content', () => {
    assert.equal(isKeystrokeControl({ type: 'control', content: '' }), false);
  });

  it('returns false for null/undefined content', () => {
    assert.equal(isKeystrokeControl({ type: 'control' }), false);
    assert.equal(isKeystrokeControl({ type: 'control', content: null }), false);
  });
});

// ── parseKeystrokeKey ───────────────────────────────────────────────

describe('parseKeystrokeKey', () => {
  it('extracts Enter key from [KEYSTROKE]Enter', () => {
    assert.equal(parseKeystrokeKey('[KEYSTROKE]Enter'), 'Enter');
  });

  it('trims whitespace from key name', () => {
    assert.equal(parseKeystrokeKey('[KEYSTROKE]  Enter  '), 'Enter');
  });

  it('extracts other key names', () => {
    assert.equal(parseKeystrokeKey('[KEYSTROKE]Tab'), 'Tab');
    assert.equal(parseKeystrokeKey('[KEYSTROKE]Escape'), 'Escape');
  });

  it('returns empty string for bare prefix', () => {
    assert.equal(parseKeystrokeKey('[KEYSTROKE]'), '');
  });

  it('handles null/undefined content', () => {
    assert.equal(parseKeystrokeKey(null), '');
    assert.equal(parseKeystrokeKey(undefined), '');
  });
});
