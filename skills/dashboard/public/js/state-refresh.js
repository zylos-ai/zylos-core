import { beginStateRequest, applyStateResponse } from './response-order.js?v=98';
import { setInstanceZone } from './wb/instance-zone.js?v=100';

export async function refreshDashboardState(state, fetchState) {
  const request = beginStateRequest(state);
  const data = await fetchState('/api/state');
  if (!data || typeof data !== 'object') return null;
  if (!applyStateResponse(state, request, data)) return null;
  // Every date and time on the page is written in the instance time zone (.env TZ) the server reports; UTC while unknown.
  setInstanceZone(data.tz);
  return data;
}
