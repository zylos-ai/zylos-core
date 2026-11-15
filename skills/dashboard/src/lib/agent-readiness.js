/** Core session and Origin lifecycle observations come from CoreState's existing refresh. */
export function agentReadiness({ observation, view, runtimeHealth } = {}, { sessionMode = 'single' } = {}) {
  const report = (ready, reason, stage) => ({ ready, observable: stage === 'ready' || stage === 'session_ready', stage, reason });
  if (runtimeHealth?.health === 'auth_failed') return report(false, 'health_auth_failed', 'runtime_down');
  if (view?.state === 'auth_wait') return report(false, 'auth_wait', 'runtime_down');
  if (view?.state === 'need_unreadable') return report(false, 'origin_need_unreadable', 'runtime_down');
  if (['sleeping', 'waking'].includes(view?.state)) return report(true, view.state, 'ready');
  if (view?.state === 'wake_overdue') return report(false, 'wake_overdue', 'runtime_up');
  if (view?.state === 'rate_wait') return report(false, 'rate_wait', 'session_ready');
  const identity = observation?.identity;
  const status = observation?.status;
  if (!identity || !status) return report(false, 'status_missing', 'runtime_down');
  if (status.reason === 'identity_changed') return report(false, 'session_predates_launch', 'runtime_up');
  if (status.reason === 'not_running' || status.reason === 'starting') return report(false, 'no_session', 'runtime_up');
  if (!status.valid) return report(false, status.reason || 'status_missing', 'runtime_down');
  if (!identity.present || identity.ready !== true) return report(false, 'no_session', 'runtime_up');
  if (sessionMode !== 'multi' && status.value?.state !== 'idle') return report(false, 'busy', 'session_ready');
  return report(true, 'ready', 'ready');
}
