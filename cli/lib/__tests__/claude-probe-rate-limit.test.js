import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _RATE_LIMIT_PATTERNS as PATTERNS } from '../heartbeat/claude-probe.js';

function matchesAny(text) {
  return PATTERNS.some(p => p.test(text));
}

describe('RATE_LIMIT_PATTERNS', () => {
  it('matches "You\'ve hit your limit" (original)', () => {
    assert.ok(matchesAny("You've hit your limit"));
    assert.ok(matchesAny("you've hit your limit"));
  });

  it('matches "You\'ve hit your session limit"', () => {
    assert.ok(matchesAny("You've hit your session limit · resets 12am (Asia/Singapore)"));
  });

  it('matches "You\'ve hit your weekly limit"', () => {
    assert.ok(matchesAny("You've hit your weekly limit · resets Jun 29, 3am (Asia/Singapore)"));
  });

  it('matches with curly apostrophe', () => {
    assert.ok(matchesAny("You’ve hit your session limit"));
  });

  it('matches with straight apostrophe', () => {
    assert.ok(matchesAny("You've hit your weekly limit"));
  });

  it('matches Opus/Sonnet limit variants', () => {
    assert.ok(matchesAny("You've hit your Opus limit"));
    assert.ok(matchesAny("You've hit your Sonnet limit"));
  });

  it('matches extra/fast usage variants', () => {
    assert.ok(matchesAny("out of extra usage"));
    assert.ok(matchesAny("You're out of fast usage"));
    assert.ok(matchesAny("usage limit reached"));
  });

  it('does not match unrelated text', () => {
    assert.ok(!matchesAny("Hello, how are you?"));
    assert.ok(!matchesAny("The session has started"));
    assert.ok(!matchesAny("Your rate is excellent"));
    assert.ok(!matchesAny("You've hit the mark"));
  });
});
