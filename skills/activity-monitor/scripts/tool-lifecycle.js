const PENDING_EVENT_TTL_MS = 30_000;
const COMPLETION_MATCH_WINDOW_MS = 5_000;
const COMPLETED_EVENT_TTL_MS = 30_000;

function cloneSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  return JSON.parse(JSON.stringify(summary));
}

function summariesEqual(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  return JSON.stringify(left) === JSON.stringify(right);
}

function ensureSession(state, sessionId, pid = 0) {
  if (!state.sessions[sessionId]) {
    state.sessions[sessionId] = {
      pid: pid || 0,
      scope: 'background',
      in_prompt: false,
      last_prompt_at: 0,
      last_event_at: 0,
      last_event: null,
      running_tools: [],
      last_completed_tool: null,
      completed_event_ids: {},
    };
  }
  const session = state.sessions[sessionId];
  if (pid) session.pid = pid;
  if (!session.completed_event_ids || typeof session.completed_event_ids !== 'object') {
    session.completed_event_ids = {};
  }
  return session;
}

function findLastRunningToolIndex(runningTools, toolName) {
  for (let i = runningTools.length - 1; i >= 0; i--) {
    if (runningTools[i].name === toolName) return i;
  }
  return -1;
}

function findRunningToolIndexByEventId(runningTools, eventId) {
  if (!eventId) return -1;
  return runningTools.findIndex((candidate) => candidate.event_id === eventId);
}

function hasCompletedEpisodeEventId(session, eventId) {
  if (!eventId) return false;
  return Boolean(session.completed_event_ids?.[eventId]);
}

function rememberCompletedEpisodeEventId(session, episode, status, endedAt) {
  if (!episode?.event_id) return;
  session.completed_event_ids[episode.event_id] = {
    status,
    ended_at: endedAt || 0,
  };
}

function findRunningToolIndexBySummary(runningTools, toolName, summary) {
  if (!toolName || !summary) return -1;
  const matches = [];
  for (let i = 0; i < runningTools.length; i++) {
    const candidate = runningTools[i];
    if (candidate.name !== toolName) continue;
    if (!summariesEqual(candidate.summary, summary)) continue;
    matches.push(i);
  }
  if (matches.length === 1) return matches[0];
  return matches.length > 1 ? matches[matches.length - 1] : -1;
}

function findRunningToolIndexForCompletion(runningTools, event) {
  const exactIdx = findRunningToolIndexByEventId(runningTools, event.event_id);
  if (exactIdx >= 0) return exactIdx;
  const summaryIdx = findRunningToolIndexBySummary(runningTools, event.tool, event.summary);
  if (summaryIdx >= 0) return summaryIdx;
  return findLastRunningToolIndex(runningTools, event.tool);
}

function completeEpisode(session, episode, status, endedAt, extra = {}) {
  session.last_completed_tool = {
    event_id: episode.event_id,
    name: episode.name,
    status,
    started_at: episode.started_at,
    ended_at: endedAt,
    summary: cloneSummary(episode.summary),
    ...extra,
  };
  rememberCompletedEpisodeEventId(session, episode, status, endedAt);
}

function applyPendingCompletionIfPresent(state, session, episode) {
  const exactIdx = episode.event_id
    ? state.pending_completions.findIndex((pending) => pending.event_id === episode.event_id)
    : -1;
  if (exactIdx >= 0) {
    const pending = state.pending_completions.splice(exactIdx, 1)[0];
    const runningIdx = session.running_tools.findIndex(
      (candidate) => candidate.event_id === episode.event_id
    );
    if (runningIdx >= 0) {
      session.running_tools.splice(runningIdx, 1);
    }
    completeEpisode(session, episode, pending.status, pending.ended_at, { clear_reason: pending.reason || undefined });
    return true;
  }

  let idx = -1;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = 0; i < state.pending_completions.length; i++) {
    const pending = state.pending_completions[i];
    if (pending.session_id !== episode.session_id || pending.tool !== episode.name) {
      continue;
    }
    if (pending.summary && !summariesEqual(pending.summary, episode.summary)) {
      continue;
    }

    const distance = Math.abs((pending.ended_at || 0) - episode.started_at);
    if (distance > COMPLETION_MATCH_WINDOW_MS) {
      continue;
    }

    if (distance < bestDistance) {
      idx = i;
      bestDistance = distance;
    }
  }

  if (idx < 0) return false;

  const pending = state.pending_completions.splice(idx, 1)[0];
  const runningIdx = session.running_tools.findIndex(
    (candidate) => candidate.event_id === episode.event_id
  );
  if (runningIdx >= 0) {
    session.running_tools.splice(runningIdx, 1);
  }
  completeEpisode(session, episode, pending.status, pending.ended_at, { clear_reason: pending.reason || undefined });
  return true;
}

function applyPendingClearHintsIfPresent(state, session, episode) {
  const matched = state.pending_clear_hints.filter(
    (hint) => hint.session_id === episode.session_id
      && episode.started_at <= hint.ts + (hint.match_slack_ms || 0)
  );
  if (matched.length === 0) return false;

  const runningIdx = session.running_tools.findIndex(
    (candidate) => candidate.event_id === episode.event_id
  );
  if (runningIdx >= 0) {
    session.running_tools.splice(runningIdx, 1);
  }

  const latestHint = matched[matched.length - 1];
  completeEpisode(session, episode, 'cleared_by_session_event', latestHint.ts, {
    clear_reason: latestHint.reason
  });
  return true;
}

function applyPreTool(state, event) {
  if (!event.session_id || !event.tool || !event.event_id) return;

  const session = ensureSession(state, event.session_id, event.pid);
  if (
    findRunningToolIndexByEventId(session.running_tools, event.event_id) >= 0 ||
    hasCompletedEpisodeEventId(session, event.event_id)
  ) {
    return;
  }

  session.in_prompt = false;
  session.last_event = event.event;
  session.last_event_at = Math.max(session.last_event_at || 0, event.ts || 0);

  const episode = {
    event_id: event.event_id,
    session_id: event.session_id,
    pid: event.pid || 0,
    name: event.tool,
    rule_id: event.rule_id || null,
    started_at: event.ts || 0,
    summary: cloneSummary(event.summary),
  };

  session.running_tools.push(episode);
  if (applyPendingCompletionIfPresent(state, session, episode)) return;
  applyPendingClearHintsIfPresent(state, session, episode);
}

function applyCompletion(state, event, status) {
  if (!event.session_id || !event.tool) return;

  const session = ensureSession(state, event.session_id, event.pid);
  session.in_prompt = false;
  session.last_event = event.event;
  session.last_event_at = Math.max(session.last_event_at || 0, event.ts || 0);

  const runningIdx = findRunningToolIndexForCompletion(session.running_tools, event);
  if (runningIdx >= 0) {
    const [episode] = session.running_tools.splice(runningIdx, 1);
    completeEpisode(session, episode, status, event.ts || 0);
    return;
  }

  if (
    event.event_id &&
    session.last_completed_tool?.status === 'cleared_by_session_event' &&
    session.last_completed_tool.event_id === event.event_id
  ) {
    session.last_completed_tool = {
      ...session.last_completed_tool,
      name: session.last_completed_tool.name || event.tool,
      status,
      ended_at: event.ts || 0,
      summary: cloneSummary(session.last_completed_tool.summary || event.summary),
    };
    delete session.last_completed_tool.clear_reason;
    session.completed_event_ids[event.event_id] = {
      status,
      ended_at: event.ts || 0,
    };
    return;
  }

  if (
    event.event_id &&
    hasCompletedEpisodeEventId(session, event.event_id)
  ) {
    return;
  }

  if (
    event.event_id &&
    state.pending_completions.some((pending) =>
      pending.event_id === event.event_id
      && pending.session_id === event.session_id
      && pending.status === status)
  ) {
    return;
  }

  state.pending_completions.push({
    event_id: event.event_id || null,
    session_id: event.session_id,
    pid: event.pid || 0,
    tool: event.tool,
    status,
    ended_at: event.ts || 0,
    reason: event.reason || null,
    summary: cloneSummary(event.summary),
  });
}

function clearSessionEpisodes(state, event) {
  if (!event.session_id) return;

  const session = ensureSession(state, event.session_id, event.pid);
  session.in_prompt = false;
  session.last_event = event.event;
  session.last_event_at = Math.max(session.last_event_at || 0, event.ts || 0);

  const survivors = [];
  let clearedAny = false;

  for (const episode of session.running_tools) {
    if (episode.started_at <= event.ts + (event.match_slack_ms || 0)) {
      completeEpisode(session, episode, 'cleared_by_session_event', event.ts || 0, {
        clear_reason: event.reason || event.event
      });
      clearedAny = true;
      continue;
    }
    survivors.push(episode);
  }

  session.running_tools = survivors;
  if (!clearedAny) {
    state.pending_clear_hints.push({
      session_id: event.session_id,
      pid: event.pid || 0,
      ts: event.ts || 0,
      reason: event.reason || event.event,
      match_slack_ms: event.match_slack_ms || 2000,
    });
  }
}

function purgeExpiredPending(state, nowMs) {
  state.pending_completions = state.pending_completions.filter(
    (pending) => (nowMs - (pending.ended_at || 0)) <= PENDING_EVENT_TTL_MS
  );
  state.pending_clear_hints = state.pending_clear_hints.filter(
    (hint) => (nowMs - (hint.ts || 0)) <= PENDING_EVENT_TTL_MS
  );
  for (const session of Object.values(state.sessions)) {
    const completedEventIds = session?.completed_event_ids;
    if (!completedEventIds || typeof completedEventIds !== 'object') continue;
    for (const [eventId, completed] of Object.entries(completedEventIds)) {
      if ((nowMs - (Number(completed?.ended_at) || 0)) > COMPLETED_EVENT_TTL_MS) {
        delete completedEventIds[eventId];
      }
    }
  }
}

export function createToolLifecycleState() {
  return {
    version: 1,
    sessions: {},
    pending_completions: [],
    pending_clear_hints: [],
  };
}

export function normalizeToolLifecycleState(raw = {}) {
  const state = createToolLifecycleState();
  if (!raw || typeof raw !== 'object') return state;

  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [sessionId, session] of Object.entries(raw.sessions)) {
      const normalized = ensureSession(state, sessionId, Number(session?.pid) || 0);
      normalized.scope = session?.scope || 'background';
      normalized.in_prompt = Boolean(session?.in_prompt);
      normalized.last_prompt_at = Number(session?.last_prompt_at) || 0;
      normalized.last_event_at = Number(session?.last_event_at) || 0;
      normalized.last_event = session?.last_event || null;
      normalized.running_tools = Array.isArray(session?.running_tools)
        ? session.running_tools.map((tool) => ({
            event_id: tool.event_id,
            session_id: sessionId,
            pid: Number(tool.pid) || Number(session?.pid) || 0,
            name: tool.name,
            rule_id: tool.rule_id || null,
            started_at: Number(tool.started_at) || 0,
            summary: cloneSummary(tool.summary),
          }))
        : [];
      normalized.last_completed_tool = session?.last_completed_tool || null;
      normalized.completed_event_ids = session?.completed_event_ids && typeof session.completed_event_ids === 'object'
        ? Object.fromEntries(
            Object.entries(session.completed_event_ids).map(([eventId, completed]) => [
              eventId,
              {
                status: completed?.status || null,
                ended_at: Number(completed?.ended_at) || 0,
              }
            ])
          )
        : {};
    }
  }

  if (Array.isArray(raw.pending_completions)) {
    state.pending_completions = raw.pending_completions.slice();
  }
  if (Array.isArray(raw.pending_clear_hints)) {
    state.pending_clear_hints = raw.pending_clear_hints.slice();
  }

  return state;
}

export function applyOrderedToolEvents(state, events, { nowMs = Date.now() } = {}) {
  const nextState = state || createToolLifecycleState();
  for (const event of events) {
    switch (event.event) {
      case 'prompt': {
        if (!event.session_id) break;
        const session = ensureSession(nextState, event.session_id, event.pid);
        session.in_prompt = true;
        session.last_prompt_at = event.ts || 0;
        session.last_event = event.event;
        session.last_event_at = Math.max(session.last_event_at || 0, event.ts || 0);
        break;
      }
      case 'pre_tool':
        applyPreTool(nextState, event);
        break;
      case 'post_tool':
        applyCompletion(nextState, event, 'success');
        break;
      case 'post_tool_failure':
        applyCompletion(nextState, event, 'failure');
        break;
      case 'stop':
      case 'stop_failure':
      case 'idle':
      case 'session_clear_hint':
        clearSessionEpisodes(nextState, event);
        break;
      default:
        break;
    }
  }

  purgeExpiredPending(nextState, nowMs);
  return nextState;
}

export function pruneToolLifecycleState(state, { nowMs = Date.now(), livePids = new Set(), sessionTtlMs = 3_600_000 } = {}) {
  const nextState = state || createToolLifecycleState();
  for (const [sessionId, session] of Object.entries(nextState.sessions)) {
    const lastEventAt = Number(session?.last_event_at) || 0;
    const hasRunningTools = Array.isArray(session?.running_tools) && session.running_tools.length > 0;
    const pid = Number(session?.pid) || 0;
    const pidAlive = pid > 0 ? livePids.has(pid) : false;
    if (!hasRunningTools && (nowMs - lastEventAt) > sessionTtlMs && !pidAlive) {
      delete nextState.sessions[sessionId];
    }
  }
  purgeExpiredPending(nextState, nowMs);
  return nextState;
}

export function getSessionSnapshot(state, sessionId, foregroundSessionId = null) {
  const session = state?.sessions?.[sessionId];
  if (!session) return null;

  const runningTools = Array.isArray(session.running_tools) ? [...session.running_tools] : [];
  runningTools.sort((a, b) => a.started_at - b.started_at);

  return {
    pid: session.pid || 0,
    scope: sessionId === foregroundSessionId ? 'foreground' : 'background',
    in_prompt: Boolean(session.in_prompt),
    last_prompt_at: session.last_prompt_at || 0,
    last_event_at: session.last_event_at || 0,
    last_event: session.last_event || null,
    running_tools: runningTools,
    last_completed_tool: session.last_completed_tool || null,
  };
}
