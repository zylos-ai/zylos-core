import { beginStateRequest, applyStateResponse } from './response-order.js?v=98';

export async function refreshDashboardState(state, fetchState) {
  const request = beginStateRequest(state);
  const data = await fetchState('/api/state');
  if (!data || typeof data !== 'object') return null;
  return applyStateResponse(state, request, data) ? data : null;
}
