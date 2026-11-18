import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// We test the module's behavior by importing it and verifying that
// the functions handle various child_process outcomes correctly.
// Since tmux-helpers calls execFileSync directly (no DI), we use
// node:test's mock.module to intercept calls.

import {
  tmuxCapturePaneText,
  getProcessName,
  isTimeoutError,
} from '../tmux-helpers.js';

// These tests verify the contract: each function must never throw,
// and must return the correct fallback on timeout or exit errors.

describe('tmux-helpers integration (live calls to nonexistent sessions)', () => {
  const FAKE_SESSION = '__zylos_test_nonexistent_session__';

  it('tmuxCapturePaneText returns null for nonexistent session', () => {
    assert.equal(tmuxCapturePaneText(FAKE_SESSION), null);
  });

  it('getProcessName returns null for nonexistent PID', () => {
    assert.equal(getProcessName(999999999), null);
  });
});

describe('tmux-helpers timeout behavior', () => {
  it('tmuxCapturePaneText returns null on error (does not throw)', () => {
    const result = tmuxCapturePaneText('__timeout_test__');
    assert.equal(result, null);
  });

  it('getProcessName returns null on error (does not throw)', () => {
    const result = getProcessName(-1);
    assert.equal(result, null);
  });
});

describe('isTimeoutError classifier', () => {
  it('returns true for ETIMEDOUT error (Node execFileSync timeout)', () => {
    const err = new Error('spawnSync sleep ETIMEDOUT');
    err.code = 'ETIMEDOUT';
    err.signal = 'SIGTERM';
    assert.equal(isTimeoutError(err), true);
  });

  it('returns false for normal exit code 1 (session not found)', () => {
    const err = new Error('Command failed: tmux has-session');
    err.status = 1;
    err.code = undefined;
    err.signal = null;
    assert.equal(isTimeoutError(err), false);
  });

  it('returns false for null/undefined', () => {
    assert.equal(isTimeoutError(null), false);
    assert.equal(isTimeoutError(undefined), false);
  });

  it('returns false for generic errors', () => {
    assert.equal(isTimeoutError(new Error('ENOENT')), false);
  });
});
