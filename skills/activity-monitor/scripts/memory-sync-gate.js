const DEFAULT_IN_FLIGHT_TTL_SECONDS = 3600;

export function createMemorySyncControlPrompt({ pct, thresholdPct }) {
  return `Context usage at ${pct}% (approaching ${thresholdPct}% session-switch threshold). Run Memory Sync now as a background maintenance task so it completes before the session switch.

Launch exactly one background subagent for memory sync following ~/zylos/.claude/skills/zylos-memory/SKILL.md. The subagent is maintenance-only: it must not reply through C4, process user-facing tasks, modify business/project repositories, install or upgrade components, restart services, or apply runtime changes outside the memory sync flow.

Do NOT wait for completion - continue normal work.`;
}

export function shouldTriggerMemorySync({
  state,
  now,
  unsummarizedCount,
  checkpointThreshold,
  cooldownSeconds,
  inFlightTtlSeconds = DEFAULT_IN_FLIGHT_TTL_SECONDS,
}) {
  if (unsummarizedCount <= checkpointThreshold) {
    return {
      shouldEnqueue: false,
      reason: 'below_checkpoint_threshold',
      nextState: clearMemorySyncRequest(state),
    };
  }

  const memorySync = state?.memory_sync ?? {};
  const requestedAt = Number(memorySync.requested_at ?? state?.last_memory_sync_trigger_at ?? 0);
  const expiresAt = Number(memorySync.expires_at ?? 0);

  if (requestedAt > 0 && now - requestedAt < cooldownSeconds) {
    return {
      shouldEnqueue: false,
      reason: 'cooldown',
      nextState: state ?? {},
    };
  }

  if (
    memorySync.status === 'requested' &&
    requestedAt > 0 &&
    (expiresAt > now || now - requestedAt < inFlightTtlSeconds)
  ) {
    return {
      shouldEnqueue: false,
      reason: 'sync_request_in_flight',
      nextState: state ?? {},
    };
  }

  return {
    shouldEnqueue: true,
    reason: 'eligible',
    nextState: state ?? {},
  };
}

export function markMemorySyncRequested({
  state,
  now,
  unsummarizedCount,
  pct,
  thresholdPct,
  inFlightTtlSeconds = DEFAULT_IN_FLIGHT_TTL_SECONDS,
}) {
  return {
    ...(state ?? {}),
    memory_sync: {
      status: 'requested',
      requested_at: now,
      expires_at: now + inFlightTtlSeconds,
      unsummarized_count: unsummarizedCount,
      context_pct: pct,
      session_switch_threshold_pct: thresholdPct,
    },
    // Legacy field kept for older readers of context-monitor-state.json.
    last_memory_sync_trigger_at: now,
  };
}

export function clearMemorySyncRequest(state) {
  if (!state?.memory_sync && !state?.last_memory_sync_trigger_at) {
    return state ?? {};
  }

  const nextState = { ...state };
  delete nextState.memory_sync;
  delete nextState.last_memory_sync_trigger_at;
  return nextState;
}
