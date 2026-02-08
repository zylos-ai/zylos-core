import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseTime, parseDuration, formatTime, getRelativeTime } from '../time-utils.js';

describe('parseDuration', () => {
  it('parses natural language durations', () => {
    const result = parseDuration('30 minutes');
    assert.ok(result >= 1790 && result <= 1810, `expected ~1800, got ${result}`);
  });

  it('parses compound natural language', () => {
    const result = parseDuration('1 hour 30 minutes');
    assert.ok(result >= 5390 && result <= 5410, `expected ~5400, got ${result}`);
  });

  it('parses fractional hours', () => {
    const result = parseDuration('2.5 hours');
    assert.ok(result >= 8990 && result <= 9010, `expected ~9000, got ${result}`);
  });

  it('parses short form minutes', () => {
    const result = parseDuration('30m');
    assert.ok(result >= 1790 && result <= 1810, `expected ~1800, got ${result}`);
  });

  it('parses short form hours', () => {
    const result = parseDuration('2h');
    assert.ok(result >= 7190 && result <= 7210, `expected ~7200, got ${result}`);
  });

  it('parses short form days', () => {
    const result = parseDuration('1d');
    assert.ok(result >= 86390 && result <= 86410, `expected ~86400, got ${result}`);
  });

  it('parses pure number as seconds', () => {
    assert.equal(parseDuration('7200'), 7200);
  });

  it('returns null for unparseable input', () => {
    assert.equal(parseDuration('not a duration'), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseDuration(''), null);
  });

  it('returns null for negative number', () => {
    assert.equal(parseDuration('-100'), null);
  });
});

describe('parseTime', () => {
  it('parses natural language time', () => {
    const refDate = new Date('2026-02-08T00:00:00Z');
    const result = parseTime('tomorrow at 9am', refDate);
    assert.ok(typeof result === 'number');
    assert.ok(result > Math.floor(refDate.getTime() / 1000));
  });

  it('returns null for unparseable input', () => {
    assert.equal(parseTime('not a time at all xyz'), null);
  });

  it('parses ISO date string as fallback', () => {
    const result = parseTime('2026-06-15T14:30:00Z');
    const expected = Math.floor(new Date('2026-06-15T14:30:00Z').getTime() / 1000);
    assert.equal(result, expected);
  });

  it('parses partial ISO date', () => {
    const result = parseTime('2026-06-15');
    assert.ok(typeof result === 'number');
    assert.ok(result > 0);
  });
});

describe('formatTime', () => {
  // 1770541200 = 2026-02-08T09:00:00Z
  const ts = 1770541200;

  it('formats timestamp in UTC', () => {
    const result = formatTime(ts, 'UTC');
    assert.ok(result.includes('2026'), `expected year 2026: ${result}`);
    assert.ok(result.includes('09:00'), `expected 09:00: ${result}`);
  });

  it('formats timestamp in Asia/Shanghai (UTC+8)', () => {
    const result = formatTime(ts, 'Asia/Shanghai');
    assert.ok(result.includes('17:00'), `expected 17:00: ${result}`);
  });

  it('falls back to UTC for invalid timezone', () => {
    const result = formatTime(ts, 'Invalid/Zone');
    assert.ok(result.includes('09:00'), `expected UTC fallback 09:00: ${result}`);
  });

  it('uses process.env.TZ as default timezone', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Shanghai';
      const result = formatTime(ts);
      assert.ok(result.includes('17:00'), `expected 17:00 from env TZ: ${result}`);
    } finally {
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
    }
  });
});

describe('getRelativeTime', () => {
  it('shows seconds for near future', () => {
    const ts = Math.floor(Date.now() / 1000) + 30;
    assert.match(getRelativeTime(ts), /^in \d+s$/);
  });

  it('shows minutes for minutes away', () => {
    const ts = Math.floor(Date.now() / 1000) + 300;
    assert.match(getRelativeTime(ts), /^in \d+m$/);
  });

  it('shows hours for hours away', () => {
    const ts = Math.floor(Date.now() / 1000) + 7200;
    assert.match(getRelativeTime(ts), /^in \d+h$/);
  });

  it('shows days for days away', () => {
    const ts = Math.floor(Date.now() / 1000) + 172800;
    assert.match(getRelativeTime(ts), /^in \d+d$/);
  });

  it('shows ago suffix for past timestamps', () => {
    const ts = Math.floor(Date.now() / 1000) - 300;
    assert.match(getRelativeTime(ts), /^\d+m ago$/);
  });

  it('shows seconds ago for recent past', () => {
    const ts = Math.floor(Date.now() / 1000) - 10;
    assert.match(getRelativeTime(ts), /^\d+s ago$/);
  });

  it('shows hours ago for hours past', () => {
    const ts = Math.floor(Date.now() / 1000) - 7200;
    assert.match(getRelativeTime(ts), /^\d+h ago$/);
  });

  it('shows days ago for days past', () => {
    const ts = Math.floor(Date.now() / 1000) - 172800;
    assert.match(getRelativeTime(ts), /^\d+d ago$/);
  });
});
