import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginStateRequest,
  applyStateResponse,
  captureMetricTarget,
  isMetricTargetCurrent,
  isStateRequestCurrent,
} from '../public/js/response-order.js';

test('an unrelated same-run SSE observation does not discard a newer full response', () => {
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:00Z' } };
  const request = beginStateRequest(state);
  state.dashboardState = { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:01Z' };
  const response = { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:02Z', system_metrics: { cpu_pct: 1 } };
  assert.equal(applyStateResponse(state, request, response), true);
  assert.deepEqual(state.dashboardState.system_metrics, { cpu_pct: 1 });
});

test('a response for the previous running identity is stale after SSE replacement', () => {
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:00Z' } };
  const request = beginStateRequest(state);
  state.dashboardState = { runId: 'R2', sessionId: 'S2', updated_at: '2026-01-01T00:00:02Z' };
  assert.equal(applyStateResponse(state, request, { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:01Z' }), false);
  assert.equal(state.dashboardState.runId, 'R2');
});

test('only the newest overlapping state request remains current', () => {
  const state = { navigationGeneration: 0 };
  const first = beginStateRequest(state);
  const second = beginStateRequest(state);
  assert.equal(isStateRequestCurrent(state, first, {}), false);
  assert.equal(isStateRequestCurrent(state, second, {}), true);
});

test('a state request from the previous fleet target is stale', () => {
  const state = { navigationGeneration: 0 };
  const request = beginStateRequest(state);
  state.navigationGeneration++;
  assert.equal(isStateRequestCurrent(state, request, {}), false);
});

test('metric responses are bound to navigation and running identity', () => {
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1' } };
  const target = captureMetricTarget(state);
  assert.equal(isMetricTargetCurrent(state, target), true);
  state.dashboardState = { runId: 'R2', sessionId: 'S2' };
  assert.equal(isMetricTargetCurrent(state, target), false);
});

test('metric target recognizes raw Core SSE identity fields', () => {
  const state = { navigationGeneration: 0, dashboardState: { run_id: 'R1', session: { session_id: 'S1' } } };
  const target = captureMetricTarget(state);
  state.dashboardState = { run_id: 'R2', session: { session_id: 'S2' } };
  assert.equal(isMetricTargetCurrent(state, target), false);
});
