import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getNextRun, isValidCron, describeCron, getDefaultTimezone } from '../cron-utils.js';

describe('getDefaultTimezone', () => {
  it('returns process.env.TZ when set', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Tokyo';
      assert.equal(getDefaultTimezone(), 'Asia/Tokyo');
    } finally {
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
    }
  });

  it('returns UTC when TZ is unset', () => {
    const originalTz = process.env.TZ;
    try {
      delete process.env.TZ;
      assert.equal(getDefaultTimezone(), 'UTC');
    } finally {
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
    }
  });
});

describe('isValidCron', () => {
  it('returns true for standard 5-field expressions', () => {
    assert.equal(isValidCron('0 9 * * *'), true);
    assert.equal(isValidCron('*/5 * * * *'), true);
    assert.equal(isValidCron('0 0 1 * *'), true);
    assert.equal(isValidCron('0 9 * * 1-5'), true);
  });

  it('returns false for invalid expressions', () => {
    assert.equal(isValidCron('not a cron'), false);
    assert.equal(isValidCron('abc def ghi jkl mno'), false);
  });
});

describe('getNextRun', () => {
  it('throws for invalid cron expression', () => {
    assert.throws(
      () => getNextRun('invalid cron', 'UTC'),
      (error) => error.message.includes('Invalid cron expression')
    );
  });

  it('returns a future timestamp', () => {
    const nowTs = Math.floor(Date.now() / 1000);
    const result = getNextRun('* * * * *', 'UTC');
    assert.ok(result > nowTs - 1, 'next run should be in the future');
  });

  it('uses getDefaultTimezone when timezone is falsy', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'UTC';
      const fromDate = new Date('2026-02-08T00:00:00Z');
      const withExplicit = getNextRun('0 9 * * *', 'UTC', fromDate);
      const withFalsy = getNextRun('0 9 * * *', null, fromDate);
      assert.equal(withExplicit, withFalsy);
    } finally {
      if (originalTz === undefined) { delete process.env.TZ; } else { process.env.TZ = originalTz; }
    }
  });
});

describe('describeCron', () => {
  it('describes known patterns', () => {
    assert.equal(describeCron('* * * * *'), 'Every minute');
    assert.equal(describeCron('0 * * * *'), 'Every hour');
    assert.equal(describeCron('0 0 * * *'), 'Every day at midnight');
    assert.equal(describeCron('0 8 * * *'), 'Every day at 8:00 AM');
    assert.equal(describeCron('0 9 * * 1-5'), 'Weekdays at 9:00 AM');
    assert.equal(describeCron('0 0 * * 1'), 'Every Monday at midnight');
  });

  it('returns the expression itself for unknown patterns', () => {
    assert.equal(describeCron('30 14 * * 2'), '30 14 * * 2');
    assert.equal(describeCron('0 6 1 1 *'), '0 6 1 1 *');
  });
});
