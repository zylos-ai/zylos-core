export function beginStateRequest(state) {
  const request = state.stateRequest = (state.stateRequest || 0) + 1;
  return {
    request,
    navigation: state.navigationGeneration,
    identity: captureMetricTarget(state),
  };
}

function freshness(value) {
  const parsed = Date.parse(value?.updated_at || '');
  return Number.isFinite(parsed) ? parsed : null;
}

export function isStateRequestCurrent(state, token, response) {
  if (token.request !== state.stateRequest || token.navigation !== state.navigationGeneration) return false;
  if (!response || typeof response !== 'object') return true;
  const currentIdentity = captureMetricTarget(state);
  const responseIdentity = JSON.stringify([
    state.navigationGeneration,
    response.runId ?? response.run_id,
    response.sessionId ?? response.session?.session_id,
  ]);
  if (currentIdentity !== token.identity && responseIdentity !== currentIdentity) return false;
  const currentTime = freshness(state.dashboardState);
  const responseTime = freshness(response);
  return currentIdentity !== responseIdentity || currentTime === null || responseTime === null || responseTime >= currentTime;
}

export function applyStateResponse(state, token, response) {
  if (!isStateRequestCurrent(state, token, response)) return false;
  state.dashboardState = response;
  return true;
}

export function captureMetricTarget(state) {
  return JSON.stringify([
    state.navigationGeneration,
    state.dashboardState?.runId ?? state.dashboardState?.run_id,
    state.dashboardState?.sessionId ?? state.dashboardState?.session?.session_id,
  ]);
}

export function isMetricTargetCurrent(state, target) {
  return target === captureMetricTarget(state);
}
