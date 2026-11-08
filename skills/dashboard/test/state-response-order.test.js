import test from 'node:test';
import assert from 'node:assert/strict';
import {
  beginStateRequest,
  applyStateResponse,
  captureMetricTarget,
  isStateRequestCurrent,
} from '../public/js/response-order.js';
import { refreshDashboardState } from '../public/js/state-refresh.js';
import { instanceZone, setInstanceZone } from '../public/js/wb/instance-zone.js?v=100';

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

test('an older same-run HTTP response cannot overwrite a newer SSE state', () => {
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:00Z' } };
  const request = beginStateRequest(state);
  state.dashboardState = { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:02Z', state: 'IDLE' };
  assert.equal(applyStateResponse(state, request, { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:01Z', state: 'BUSY' }), false);
  assert.equal(state.dashboardState.state, 'IDLE');
});

test('the real refresh helper routes fetched state through response ordering', async () => {
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:00Z' } };
  let resolveResponse;
  const pending = refreshDashboardState(state, () => new Promise(resolve => { resolveResponse = resolve; }));
  state.dashboardState = { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:02Z', state: 'IDLE' };
  resolveResponse({ runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:01Z', state: 'BUSY' });
  assert.equal(await pending, null);
  assert.equal(state.dashboardState.state, 'IDLE');
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

test('the state identity follows navigation and the running run and session', () => {
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1' } };
  const target = captureMetricTarget(state);
  assert.equal(captureMetricTarget(state), target);
  state.dashboardState = { runId: 'R2', sessionId: 'S1' };
  assert.notEqual(captureMetricTarget(state), target);
  state.dashboardState = { runId: 'R1', sessionId: 'S1' }; state.navigationGeneration++;
  assert.notEqual(captureMetricTarget(state), target);
});

test('the state identity recognizes raw Core SSE identity fields', () => {
  const raw = { navigationGeneration: 0, dashboardState: { run_id: 'R1', session: { session_id: 'S1' } } };
  assert.equal(captureMetricTarget(raw), captureMetricTarget({ navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1' } }));
});

test('a state refresh sets the instance time zone the server reports for every page, and UTC when it reports none', async () => {
  setInstanceZone(null);
  const state = { navigationGeneration: 0, dashboardState: { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:00Z' } };
  const reply = body => async () => body;
  await refreshDashboardState(state, reply({ runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:01Z', tz: 'Pacific/Chatham' }));
  assert.equal(instanceZone(), 'Pacific/Chatham');
  await refreshDashboardState(state, reply({ runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:02Z', tz: 'America/Los_Angeles' }));
  assert.equal(instanceZone(), 'America/Los_Angeles', 'a changed zone applies on the next refresh');
  await refreshDashboardState(state, reply({ runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:03Z', tz: null }));
  assert.equal(instanceZone(), 'UTC', 'a server that cannot read its zone reads UTC, never the browser zone');

  // A response that arrives after a newer state was applied (e.g. from the previous Fleet target) is discarded and
  // must not set its zone on the page either.
  await refreshDashboardState(state, reply({ runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:04Z', tz: 'Asia/Tokyo' }));
  assert.equal(instanceZone(), 'Asia/Tokyo');
  let resolveLate;
  const late = refreshDashboardState(state, () => new Promise(resolve => { resolveLate = resolve; }));
  state.dashboardState = { runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:06Z' };
  resolveLate({ runId: 'R1', sessionId: 'S1', updated_at: '2026-01-01T00:00:05Z', tz: 'Europe/London' });
  assert.equal(await late, null, 'the late response is discarded');
  assert.equal(instanceZone(), 'Asia/Tokyo', 'a discarded response leaves the zone unchanged');
  setInstanceZone(null);
});
