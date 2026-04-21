import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { classifyClaudeProbeFailure } from '../runtime/claude.js';

describe('Claude auth probe failure classification', () => {
  it('keeps authentication_error classified as auth failure', () => {
    const result = classifyClaudeProbeFailure({
      stdout: '',
      stderr: 'authentication_error: invalid x-api-key',
    });

    assert.deepEqual(result, {
      ok: false,
      reason: 'cli_probe_authentication_error',
    });
  });

  it('treats unknown nonzero probe failures as cli_probe_unknown and preserves output', () => {
    const result = classifyClaudeProbeFailure({
      stdout: '',
      stderr: 'upstream gateway exploded in some new way',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'cli_probe_unknown');
    assert.match(result.output, /upstream gateway exploded/);
  });

  it('keeps known transient failures non-blocking', () => {
    const result = classifyClaudeProbeFailure({
      stdout: '',
      stderr: 'api_error: temporarily unavailable',
    });

    assert.deepEqual(result, {
      ok: true,
      reason: 'cli_probe_uncertain',
    });
  });
});
