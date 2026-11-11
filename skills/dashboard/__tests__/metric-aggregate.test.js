import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveAggregateValue } from '../src/lib/metric-aggregate.js';

test('Codex session aggregate falls back to latest rollout session when current state session has no value', () => {
  const calls = [];
  const store = {
    aggregateTokens(bounds) {
      calls.push(bounds);
      if (bounds.sessionId === 'rollout-session') {
        return { input: 42000, output: 1700, cache_read: 12000, cache_rate: 12000 / 42000 };
      }
      return null;
    },
    latestCodexRolloutPath() {
      return { session_id: 'rollout-session' };
    }
  };

  const result = resolveAggregateValue(
    store,
    'tokens',
    { sessionId: 'current-state-session', until: '2026-06-02T15:00:00.000Z' },
    { runtime: 'codex', period: 'session' }
  );

  assert.equal(result.bounds.sessionId, 'rollout-session');
  assert.equal(result.value.input, 42000);
  assert.equal(result.value.output, 1700);
  assert.equal(result.value.cache_rate, 12000 / 42000);
  assert.deepEqual(calls.map(c => c.sessionId), ['current-state-session', 'rollout-session']);
});

test('Claude session aggregate does not fall back to Codex rollout session', () => {
  const store = {
    aggregateCost() {
      return null;
    },
    latestCodexRolloutPath() {
      return { session_id: 'rollout-session' };
    }
  };

  const result = resolveAggregateValue(
    store,
    'cost',
    { sessionId: 'current-state-session', until: '2026-06-02T15:00:00.000Z' },
    { runtime: 'claude', period: 'session' }
  );

  assert.equal(result.bounds.sessionId, 'current-state-session');
  assert.equal(result.value, null);
});
