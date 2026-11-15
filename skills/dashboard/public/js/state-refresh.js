import { beginStateRequest, applyStateResponse } from './response-order.js?v=98';
import { setInstanceZone } from './wb/instance-zone.js?v=100';

export async function refreshDashboardState(state, fetchState) {
  const target = state.remoteAgent;
  const request = beginStateRequest(state);
  const data = await fetchState('/api/instance');
  if (!data || typeof data !== 'object') return null;
  // Instance metadata survives a newer same-target SSE snapshot. Keep the
  // target guard so another instance's late reply cannot change it.
  if (target === state.remoteAgent) setInstanceZone(data.tz);
  if (!applyStateResponse(state, request, data)) return null;
  return data;
}
