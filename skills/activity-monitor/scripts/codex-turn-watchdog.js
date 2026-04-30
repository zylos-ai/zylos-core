export const CODEX_PENDING_MESSAGE_INTERRUPT_AVAILABLE_IN_SEC = 1;

function clearWithReason(deps, phase, reason) {
  deps.clearWatchdogState();
  phase.watchdog_block_reason = reason;
  return phase;
}

function evaluatePendingMessageWatchdog({ nowMs, interactiveState, state, deps, phase }) {
  if (!interactiveState.codexQueuedUserMessages) return null;

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

function evaluateActiveCallWatchdog({ nowMs, rolloutActivity, state, deps, phase }) {
  const activeCall = rolloutActivity?.activeCall || null;
  if (!activeCall) return clearWithReason(deps, phase, 'no_queued_user_message');

  const activeCallSeconds = Number(activeCall.ageSeconds) || 0;
  const callId = String(activeCall.callId || 'unknown');
  const callName = String(activeCall.name || 'unknown');
  const startedAtMs = Number(activeCall.startedAtMs) || (nowMs - (activeCallSeconds * 1000));
  const episodeKey = `codex_active_call:${callId}:${Math.floor(startedAtMs / 1000)}`;

  if (activeCallSeconds < state.codexActiveCallInterruptSec) {
    if (state.watchdogState?.episode_key !== episodeKey) {
      deps.clearWatchdogState();
    }
    phase.watchdog_phase = 'observing';
    phase.watchdog_block_reason = 'no_queued_user_message';
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
      type: 'codex_active_call',
      episode_key: episodeKey,
      call_id: callId,
      tool_name: callName,
      started_at: startedAtMs,
      first_timeout_at: state.watchdogState?.episode_key === episodeKey
        ? state.watchdogState.first_timeout_at
        : nowMs,
      interrupt_sent_at: result.ok ? nowMs : 0,
      interrupt_key: 'Escape',
      interrupt_count: (state.watchdogState?.episode_key === episodeKey
        ? state.watchdogState.interrupt_count
        : 0) + 1,
      grace_deadline_at: result.ok ? (nowMs + (state.codexActiveCallGraceSec * 1000)) : 0,
      escalated_at: 0,
      retry_after_at: result.ok ? 0 : (nowMs + (state.codexActiveCallCooldownSec * 1000)),
      last_action_at: nowMs,
    };
    deps.writeWatchdogState();
    deps.log(result.ok
      ? `Codex watchdog: sent Escape for active ${callName} call after ${activeCallSeconds}s`
      : `Codex watchdog: failed to enqueue Escape for active ${callName} call (${result.output})`);
    phase.watchdog_phase = result.ok ? 'interrupt_sent' : 'interrupt_retry_wait';
    if (!result.ok) {
      phase.watchdog_block_reason = 'interrupt_enqueue_failed';
    }
    return phase;
  }

  deps.triggerRecovery('codex_active_call_stuck');
  state.watchdogState.escalated_at = nowMs;
  state.watchdogState.last_action_at = nowMs;
  deps.writeWatchdogState();
  deps.log(`Codex watchdog: escalated active ${callName} call stall to guardian recovery`);
  phase.watchdog_phase = 'escalated';
  return phase;
}

export function evaluateCodexTurnWatchdogTransition({
  nowMs,
  interactiveState,
  rolloutActivity,
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
    return clearWithReason(deps, phase, 'launch_grace');
  }

  if (state.engineHealth !== 'ok') {
    return clearWithReason(deps, phase, `health_${state.engineHealth}`);
  }

  if (!interactiveState?.captureOk) {
    return clearWithReason(deps, phase, 'capture_unavailable');
  }

  return evaluatePendingMessageWatchdog({ nowMs, interactiveState, state, deps, phase })
    || evaluateActiveCallWatchdog({ nowMs, rolloutActivity, state, deps, phase });
}
