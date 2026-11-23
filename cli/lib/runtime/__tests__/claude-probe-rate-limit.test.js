import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _RATE_LIMIT_PATTERNS as PATTERNS } from '../claude/health.js';

function matchesAny(text) {
  return PATTERNS.some(p => p.test(text));
}

describe('RATE_LIMIT_PATTERNS', () => {
  it('matches "You\'ve hit your limit" (original)', () => {
    assert.ok(matchesAny("You've hit your limit"));
    assert.ok(matchesAny("you've hit your limit"));
  });

  it('does not match unrelated text', () => {
    assert.ok(!matchesAny("Hello, how are you?"));
    assert.ok(!matchesAny("The session has started"));
    assert.ok(!matchesAny("Your rate is excellent"));
    assert.ok(!matchesAny("You've hit the mark"));
  });
});
