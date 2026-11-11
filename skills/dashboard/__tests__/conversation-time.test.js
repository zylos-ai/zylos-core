import test from 'node:test';
import assert from 'node:assert/strict';
import { asDate } from '../public/js/wb/conversation-time.js';

// Pure conversion only: no databases, requests, timers or runtime resources.
test('SQL UTC timestamps retain their instant and display correctly in the viewer timezone', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Asia/Shanghai';
  try {
    const date = asDate('2026-11-08 03:02:01.123');
    assert.equal(date.toISOString(), '2026-11-08T03:02:01.123Z');
    assert.equal(date.toLocaleTimeString('en-GB', {
      hour12: false
    }), '11:02:01');
    assert.equal(asDate('2026-11-08T03:02:01.123Z').getTime(), date.getTime());
    assert.equal(asDate(date.getTime()).getTime(), date.getTime());
  } finally {
    if (previous === undefined) delete process.env.TZ;else process.env.TZ = previous;
  }
});
test('missing or invalid timestamps have no display date', () => {
  for (const value of [null, undefined, '', 'invalid date']) assert.equal(asDate(value), null);
});
