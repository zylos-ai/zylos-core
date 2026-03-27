import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseCodexUsageFromRolloutLines } from '../usage-codex-rollout-reader.js';

describe('usage-codex-rollout-reader', () => {
  it('parses primary and secondary rate limits from token_count events', () => {
    const lines = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 36, window_minutes: 300, resets_at: 1774530477 },
            secondary: { used_percent: 49, window_minutes: 10080, resets_at: 1775026972 }
          }
        }
      })
    ];

    const result = parseCodexUsageFromRolloutLines(lines);
    assert.equal(result.sessionPercent, 36);
    assert.equal(result.fiveHourPercent, 36);
    assert.equal(result.weeklyAllPercent, 49);
    assert.equal(result.statusShape, 'rollout');
    assert.match(result.fiveHourResets, /^\d{2}:\d{2}( on (?:\d{1,2} \w{3}|\w{3} \d{1,2}))?$/);
    assert.match(result.weeklyAllResets, /^\d{2}:\d{2}( on (?:\d{1,2} \w{3}|\w{3} \d{1,2}))?$/);
  });

  it('prefers the latest token_count event in the rollout tail', () => {
    const lines = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 12, resets_at: 1774530000 },
            secondary: { used_percent: 20, resets_at: 1775026000 }
          }
        }
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 36, resets_at: 1774530477 },
            secondary: { used_percent: 49, resets_at: 1775026972 }
          }
        }
      })
    ];

    const result = parseCodexUsageFromRolloutLines(lines);
    assert.equal(result.sessionPercent, 36);
    assert.equal(result.weeklyAllPercent, 49);
  });

  it('returns null when no usable rate limits are present', () => {
    const lines = [
      JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { foo: 'bar' } } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'message' } })
    ];

    assert.equal(parseCodexUsageFromRolloutLines(lines), null);
  });
});
