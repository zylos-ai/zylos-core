import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizeMessage } from '../c4-utils.js';
import { findPromptY } from '../../../../cli/lib/runtime/shared/prompt-input.js';
import { checkClaudeFallbackInputBox } from '../../../../cli/lib/runtime/claude/input.js';

// ── sanitizeMessage ─────────────────────────────────────────────────

describe('sanitizeMessage', () => {
  it('strips NUL, SOH, BS and other low control chars', () => {
    assert.equal(sanitizeMessage('a\x00b\x01c\x08d'), 'abcd');
  });

  it('preserves tab (\\x09) and LF (\\x0A) but strips CR (\\x0D)', () => {
    assert.equal(sanitizeMessage('a\tb\nc\rd'), 'a\tb\ncd');
  });

});

// ── getDeliveryDelay ────────────────────────────────────────────────

// ── findPromptY ─────────────────────────────────────────────────────

describe('findPromptY', () => {
  it('finds › prompt line in a Codex-style capture', () => {
    const capture = [
      '',                                                  // Y=0
      '• Some output text',                                // Y=1
      '',                                                  // Y=2
      '› hello world',                                     // Y=3
      '',                                                  // Y=4
      '  gpt-5.4 medium · 82% left · ~/zylos'             // Y=5
    ].join('\n');
    assert.equal(findPromptY(capture), 3);
  });

});

// ── getClaudeInputBoxText / checkClaudeFallbackInputBox ────────────

describe('checkClaudeFallbackInputBox', () => {
  it('returns empty for Claude empty prompt', () => {
    const sep = '\u2500'.repeat(20);
    const capture = [
      'output',
      sep,
      '❯ ',
      sep
    ].join('\n');
    assert.equal(checkClaudeFallbackInputBox(capture), 'empty');
  });

  it('returns has_content for Claude non-empty prompt', () => {
    const sep = '\u2500'.repeat(20);
    const capture = [
      'output',
      sep,
      '❯ run tests',
      sep
    ].join('\n');
    assert.equal(checkClaudeFallbackInputBox(capture), 'has_content');
  });

});

// ── isUsageOverlayCapture ───────────────────────────────────────────

// ── isBypassState ───────────────────────────────────────────────────

// ── getHeartbeatPhase ───────────────────────────────────────────────

// ── shouldAutoAckHeartbeat ──────────────────────────────────────────

// ── isKeystrokeControl ──────────────────────────────────────────────

// ── parseKeystrokeKey ───────────────────────────────────────────────

// ── isExitLifecycleControl ──────────────────────────────────────────
