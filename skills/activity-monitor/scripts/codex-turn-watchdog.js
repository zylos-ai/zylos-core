export const CODEX_PENDING_MESSAGE_INTERRUPT_AVAILABLE_IN_SEC = 1;

export function evaluateCodexTurnWatchdogTransition({
  nowMs,
  interactiveState,
  state,
  deps
}) {
  const phase = {
    watchdog_phase: 'idle',
    watchdog_block_reason: null,
  };

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

  if (!interactiveState?.captureOk) {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = 'capture_unavailable';
    return phase;
  }

  if (!interactiveState.codexQueuedUserMessages) {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = 'no_queued_user_message';
    return phase;
  }

  const workingSeconds = Number(interactiveState.codexWorkingSeconds) || 0;
  if (workingSeconds <= 0) {
    deps.clearWatchdogState();
    phase.watchdog_block_reason = 'not_working';
    return phase;
  }

  const workingStartedAt = nowMs - (workingSeconds * 1000);
  const episodeKey = `codex_pending_message:${Math.floor(workingStartedAt / 1000)}`;

  if (workingSeconds < state.codexPendingMessageInterruptSec) {
    if (state.watchdogState?.episode_key !== episodeKey) {
      deps.clearWatchdogState();
    }
    phase.watchdog_phase = 'observing';
    return phase;
  }

  if (state.watchdogState?.episode_key === episodeKey) {
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
    || state.watchdogState.episode_key !== episodeKey
    || !state.watchdogState.interrupt_sent_at) {
    const result = deps.enqueueInterrupt('Escape');
    state.watchdogState = {
      version: 1,
      type: 'codex_pending_message',
      episode_key: episodeKey,
      started_at: workingStartedAt,
      first_timeout_at: state.watchdogState?.episode_key === episodeKey
        ? state.watchdogState.first_timeout_at
        : nowMs,
      interrupt_sent_at: result.ok ? nowMs : 0,
      interrupt_key: 'Escape',
      interrupt_count: (state.watchdogState?.episode_key === episodeKey
        ? state.watchdogState.interrupt_count
        : 0) + 1,
      grace_deadline_at: result.ok ? (nowMs + (state.codexPendingMessageGraceSec * 1000)) : 0,
      escalated_at: 0,
      retry_after_at: result.ok ? 0 : (nowMs + (state.codexPendingMessageCooldownSec * 1000)),
      last_action_at: nowMs,
    };
    deps.writeWatchdogState();
    deps.log(result.ok
      ? `Codex watchdog: sent Escape for queued user message after ${workingSeconds}s working`
      : `Codex watchdog: failed to enqueue Escape for queued user message (${result.output})`);
    phase.watchdog_phase = result.ok ? 'interrupt_sent' : 'interrupt_retry_wait';
    if (!result.ok) {
      phase.watchdog_block_reason = 'interrupt_enqueue_failed';
    }
    return phase;
  }

  deps.triggerRecovery('codex_pending_message_stuck');
  state.watchdogState.escalated_at = nowMs;
  state.watchdogState.last_action_at = nowMs;
  deps.writeWatchdogState();
  deps.log('Codex watchdog: escalated queued user message stall to guardian recovery');
  phase.watchdog_phase = 'escalated';
  return phase;
}
