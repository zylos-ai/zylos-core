export const WATCHDOG_INTERRUPT_AVAILABLE_IN_SEC = 1;

export function evaluateToolWatchdogTransition({
  nowMs,
  foregroundIdentity,
  apiActivity,
  interactiveState,
  state,
  deps
}) {
  const candidate = apiActivity?.watchdog_candidate_tool || null;
  const phase = {
    watchdog_phase: 'idle',
    watchdog_block_reason: null,
    api_activity_dirty: false,
  };

  if (!foregroundIdentity?.trusted) {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = foregroundIdentity?.blockReason || 'foreground_untrusted';
    return phase;
  }

  const withinLaunchGrace = state.runtimeLaunchAtMs > 0
    && (nowMs - state.runtimeLaunchAtMs) < (state.launchGracePeriodSec * 1000);
  if (withinLaunchGrace) {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = 'launch_grace';
    return phase;
  }

  if (state.engineHealth !== 'ok') {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = `health_${state.engineHealth}`;
    return phase;
  }

  if (!candidate) {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = 'no_watchdog_candidate';
    return phase;
  }

  const rule = deps.getRuleById(candidate.rule_id);
  if (!rule?.watchdog?.enabled) {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = 'watchdog_disabled';
    return phase;
  }

  const maxRuntimeMs = rule.watchdog.maxRuntimeSec * 1000;
  if ((nowMs - candidate.started_at) < maxRuntimeMs) {
    if (state.watchdogState?.episode_key !== candidate.event_id) {
      deps.clearWatchdogState();
    }
    phase.watchdog_phase = 'observing';
    return phase;
  }

  if (state.watchdogState && state.watchdogState.episode_key === candidate.event_id) {
    if (!apiActivity.watchdog_candidate_tool) {
      deps.clearWatchdogState();
      phase.watchdog_phase = 'recovered';
      return phase;
    }

    if (deps.canTreatPaneAsRecovered(interactiveState)) {
      deps.applySyntheticClearHint(
        foregroundIdentity.sessionId,
        foregroundIdentity.claudePid,
        'interactive_recovered',
        nowMs
      );
      deps.clearWatchdogState();
      phase.watchdog_phase = 'recovered';
      phase.api_activity_dirty = true;
      return phase;
    }

    if (state.watchdogState.interrupt_sent_at && nowMs <= state.watchdogState.grace_deadline_at) {
      phase.watchdog_phase = 'interrupt_wait';
      return phase;
    }

    if (!state.watchdogState.interrupt_sent_at
      && state.watchdogState.retry_after_at
      && nowMs < state.watchdogState.retry_after_at) {
      phase.watchdog_phase = 'interrupt_retry_wait';
      return phase;
    }

    if (state.watchdogState.escalated_at) {
      phase.watchdog_phase = 'escalated';
      return phase;
    }
  }

  if (!state.watchdogState
    || state.watchdogState.episode_key !== candidate.event_id
    || !state.watchdogState.interrupt_sent_at) {
    const retryCooldownMs = rule.watchdog.cooldownSec * 1000;
    const result = deps.enqueueInterrupt(rule.watchdog.interruptKey);

    state.watchdogState = {
      version: 1,
      episode_key: candidate.event_id,
      session_id: foregroundIdentity.sessionId,
      claude_pid: foregroundIdentity.claudePid,
      tool_name: candidate.name,
      rule_id: candidate.rule_id,
      started_at: candidate.started_at,
      first_timeout_at: state.watchdogState?.episode_key === candidate.event_id
        ? state.watchdogState.first_timeout_at
        : nowMs,
      interrupt_sent_at: result.ok ? nowMs : 0,
      interrupt_key: rule.watchdog.interruptKey,
      interrupt_count: (state.watchdogState?.episode_key === candidate.event_id
        ? state.watchdogState.interrupt_count
        : 0) + 1,
      grace_deadline_at: result.ok ? (nowMs + (rule.watchdog.interruptGraceSec * 1000)) : 0,
      interactive_recovered_at: 0,
      escalated_at: 0,
      escalation: rule.watchdog.escalation,
      retry_after_at: result.ok ? 0 : (nowMs + retryCooldownMs),
      last_action_at: nowMs,
    };
    deps.writeWatchdogState();
    deps.log(result.ok
      ? `Tool watchdog: sent ${rule.watchdog.interruptKey} for ${candidate.name} (session=${foregroundIdentity.sessionId})`
      : `Tool watchdog: failed to enqueue ${rule.watchdog.interruptKey} for ${candidate.name} (${result.output})`);
    phase.watchdog_phase = result.ok ? 'interrupt_sent' : 'interrupt_retry_wait';
    if (!result.ok) {
      phase.watchdog_block_reason = 'interrupt_enqueue_failed';
    }
    return phase;
  }

  deps.triggerRecovery(`tool_timeout_${candidate.name}`);
  state.watchdogState.escalated_at = nowMs;
  state.watchdogState.last_action_at = nowMs;
  deps.writeWatchdogState();
  deps.log(`Tool watchdog: escalated ${candidate.name} timeout to guardian recovery`);
  phase.watchdog_phase = 'escalated';
  return phase;
}
