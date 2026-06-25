import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _RATE_LIMIT_PATTERNS as PATTERNS, _parseResetTime } from '../heartbeat/claude-probe.js';

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

describe('_parseResetTime', () => {
  it('parses simple time "12am"', () => {
    const result = _parseResetTime('12am');
    assert.ok(result > 0);
  });

  it('parses "3am"', () => {
    const result = _parseResetTime('3am');
    assert.ok(result > 0);
  });

  it('parses "7:30pm"', () => {
    const result = _parseResetTime('7:30pm');
    assert.ok(result > 0);
  });

  it('parses time with date "3am" + "Jun 29"', () => {
    const result = _parseResetTime('3am', 'Jun 29');
    assert.ok(result > 0);
    const d = new Date(result * 1000);
    assert.equal(d.getMonth(), 5); // June
    assert.equal(d.getDate(), 29);
  });

  it('parses time with date+year "3am" + "Jun 29, 2026"', () => {
    const result = _parseResetTime('3am', 'Jun 29, 2026');
    assert.ok(result > 0);
    const d = new Date(result * 1000);
    assert.equal(d.getFullYear(), 2026);
    assert.equal(d.getMonth(), 5);
    assert.equal(d.getDate(), 29);
  });

  it('returns 0 for unparseable input', () => {
    assert.equal(_parseResetTime('invalid'), 0);
  });

  it('handles all month abbreviations', () => {
    for (const mon of ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']) {
      const result = _parseResetTime('1am', `${mon} 15`);
      assert.ok(result > 0, `Failed for ${mon}`);
    }
  });
});
