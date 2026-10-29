import assert from 'node:assert/strict';
import test from 'node:test';
import { rateLimitWindowExpired } from '../src/lib/metric-resolver.js';

const NOW = 1781182800 * 1000; // fixed reference instant

test('window with resets_at in the past is expired (#224)', () => {
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: 1781182799 }, 'rate_limit', NOW), true);
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: 1781182800 }, 'rate_limit', NOW), true);
});

test('window with resets_at in the future is live', () => {
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: 1781182801 }, 'rate_limit', NOW), false);
});

test('per-window key wins, bare resets_at is the fallback', () => {
  assert.equal(rateLimitWindowExpired({ rate_limit_7d_resets_at: 1781182799 }, 'rate_limit_7d', NOW), true);
  assert.equal(rateLimitWindowExpired({ resets_at: 1781182799 }, 'rate_limit', NOW), true);
  // The other window's key must not bleed into this metric's verdict.
  assert.equal(rateLimitWindowExpired({ rate_limit_7d_resets_at: 1781182799 }, 'rate_limit', NOW), false);
});

test('millisecond timestamps are tolerated, mirroring fmtResetTime', () => {
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: NOW - 1 }, 'rate_limit', NOW), true);
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: NOW + 1000 }, 'rate_limit', NOW), false);
});

test('missing or malformed resets_at never expires the reading', () => {
  assert.equal(rateLimitWindowExpired(null, 'rate_limit', NOW), false);
  assert.equal(rateLimitWindowExpired({}, 'rate_limit', NOW), false);
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: 'soon' }, 'rate_limit', NOW), false);
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: 0 }, 'rate_limit', NOW), false);
  assert.equal(rateLimitWindowExpired({ rate_limit_resets_at: -5 }, 'rate_limit', NOW), false);
});
