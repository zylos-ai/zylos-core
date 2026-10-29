export function beginStateRequest(state) {
  const request = state.stateRequest = (state.stateRequest || 0) + 1;
  return {
    request,
    revision: state.stateRevision || 0,
    navigation: state.navigationGeneration,
  };
}

export function isStateRequestCurrent(state, token) {
  return token.request === state.stateRequest
    && token.revision === (state.stateRevision || 0)
    && token.navigation === state.navigationGeneration;
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
