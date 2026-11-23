import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectApiErrorText } from '../shared/api-error-patterns.js';

describe('heartbeat API error patterns', () => {

  it('detects existing API error patterns', () => {
    const result = detectApiErrorText('APIError: 400 invalid_request_error');

    assert.equal(result.detected, true);
    assert.equal(result.pattern, 'APIError: 400');
  });

  it('does not match ordinary image discussion text', () => {
    const result = detectApiErrorText('Please resize this image to 2000px before sending it.');

    assert.equal(result.detected, false);
  });
});
