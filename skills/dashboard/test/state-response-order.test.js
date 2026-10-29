import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginStateRequest,
  captureMetricTarget,
  isMetricTargetCurrent,
  isStateRequestCurrent,
} from '../public/js/response-order.js';

test('a response predating a newer SSE observation is stale', () => {
  const state = { navigationGeneration: 0, stateRevision: 0 };
  const request = beginStateRequest(state);
  state.stateRevision++;
  assert.equal(isStateRequestCurrent(state, request), false);
});

test('only the newest overlapping state request remains current', () => {
  const state = { navigationGeneration: 0 };
  const first = beginStateRequest(state);
  const second = beginStateRequest(state);
  assert.equal(isStateRequestCurrent(state, first), false);
  assert.equal(isStateRequestCurrent(state, second), true);
});

test('a state request from the previous fleet target is stale', () => {
  const state = { navigationGeneration: 0 };
  const request = beginStateRequest(state);
  state.navigationGeneration++;
  assert.equal(isStateRequestCurrent(state, request), false);
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
