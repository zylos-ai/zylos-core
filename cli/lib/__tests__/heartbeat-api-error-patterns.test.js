import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { detectApiErrorText } from '../heartbeat/api-error-patterns.js';

describe('heartbeat API error patterns', () => {
  it('detects many-image dimension limit errors', () => {
    const pane = `
      An image in the conversation exceeds the dimension limit for many-image requests (2000px).
      Run /compact to remove old images from context, or start a new session.
    `;

    const result = detectApiErrorText(pane);

    assert.equal(result.detected, true);
    assert.match(result.pattern, /dimension limit/i);
  });

  it('detects existing API error patterns', () => {
    const result = detectApiErrorText('APIError: 400 invalid_request_error');

    assert.equal(result.detected, true);
    assert.equal(result.pattern, 'APIError: 400');
  });

  it('does not match ordinary image discussion text', () => {
    const result = detectApiErrorText('Please resize this image to 2000px before sending it.');

    assert.equal(result.detected, false);
  });

  it('detects "API Error: 400" with the whitespace variant emitted by current Claude Code', () => {
    const pane = `
      ⎿  API Error: 400 {"error":{"code":"400","message":"Param Incorrect",
                                   "param":"Not supported model claude-opus-4-7"}}
    `;

    const result = detectApiErrorText(pane);

    assert.equal(result.detected, true);
    assert.match(result.pattern, /API\s*Error:\s*400/);
  });

  it('detects raw JSON-format Anthropic errors', () => {
    const result = detectApiErrorText('error response: {"error":{"code":"400","message":"..."}}');

    assert.equal(result.detected, true);
    assert.match(result.pattern, /"code"\s*:\s*"400"/);
  });

  it('detects stale-model-alias rejection text', () => {
    const result = detectApiErrorText('Not supported model claude-opus-4-7');

    assert.equal(result.detected, true);
    assert.match(result.pattern, /Not supported model/i);
  });
});
