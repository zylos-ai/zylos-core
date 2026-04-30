import fs from 'node:fs';
import {
  applyOrderedToolEvents,
  createToolLifecycleState,
  getSessionSnapshot,
  normalizeToolLifecycleState,
  pruneToolLifecycleState,
} from './tool-lifecycle.js';
import {
  createToolEventStreamState,
  readToolEventsIncrementalFromStream,
  rotateToolEventStream,
} from './tool-event-stream.js';

export const TOOL_EVENT_REORDER_WINDOW_MS = 2000;
export const TOOL_SESSION_TTL_MS = 3600_000;
export const TOOL_EVENT_ROTATION_BYTES = 1024 * 1024;
export const TOOL_EVENT_ROTATION_DRAIN_MS = 2000;
export const STATUSLINE_LAUNCH_GUARD_MS = 5000;
export const STATUSLINE_ACTIVE_TOOL_CLEAR_GRACE_MS = 5000;

function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, filePath);
}

function safeUnlink(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best-effort.
  }
}

function getToolEventPriority(eventName) {
  switch (eventName) {
    case 'prompt':
      return 10;
    case 'pre_tool':
      return 20;
    case 'post_tool':
    case 'post_tool_failure':
      return 30;
    case 'stop':
    case 'stop_failure':
    case 'idle':
      return 40;
    case 'session_clear_hint':
      return 50;
    default:
      return 100;
  }
}

function sortToolEvents(events) {
  events.sort((left, right) => {
    if (left.ts !== right.ts) return left.ts - right.ts;
    const priorityDiff = getToolEventPriority(left.event) - getToolEventPriority(right.event);
    if (priorityDiff !== 0) return priorityDiff;
    return (left._arrival_seq || 0) - (right._arrival_seq || 0);
  });
}

export function canTreatPaneAsRecovered(interactiveState) {
  return Boolean(
    interactiveState?.captureOk &&
    interactiveState.promptVisible &&
    !interactiveState.usageOverlay &&
    !interactiveState.inProgressCapture &&
    (interactiveState.inputState === 'empty' || interactiveState.inputState === 'has_content')
  );
}

export class ToolPipeline {
  constructor({
    files,
    toolRules = [],
    runtimeLaunchAtMs = () => 0,
    isPidAlive = () => false,
    log = () => {},
  } = {}) {
    this.files = files;
    this.toolRules = toolRules;
    this.runtimeLaunchAtMs = runtimeLaunchAtMs;
    this.isPidAlive = isPidAlive;
    this.log = log;
    this.reset();
  }

  reset({ clearFiles = false } = {}) {
    this.lifecycleState = createToolLifecycleState();
    this.streamState = createToolEventStreamState(this.files.toolEvents);
    this.activeTail = '';
    this.rotatedTail = '';
    this.arrivalSeq = 0;
    this.reorderBuffer = [];
    this.lastStatuslineSyntheticClearAt = 0;
    this.apiActivity = null;
    this.foregroundIdentity = null;

    if (clearFiles) {
      try {
        fs.writeFileSync(this.files.toolEvents, '');
      } catch {
        // Best-effort.
      }
      safeUnlink(this.files.toolEventStreamState);
      safeUnlink(this.files.sessionToolState);
      safeUnlink(this.files.foregroundSession);
      safeUnlink(`${this.files.toolEvents}.old`);
      return;
    }

    const loadedStreamState = this.loadPersistedToolEventStreamState();
    if (!loadedStreamState) return;

    const loadedSessionState = this.readJsonFileSafe(this.files.sessionToolState);
    if (!loadedSessionState || loadedSessionState.version !== 1) return;

    this.streamState = loadedStreamState;
    this.lifecycleState = normalizeToolLifecycleState(loadedSessionState);
  }

  tick({ nowMs, currentTmuxClaudePid = 0, interactiveState = null } = {}) {
    this.processToolLifecycle(nowMs, currentTmuxClaudePid, interactiveState);
    this.foregroundIdentity = this.resolveTrustedForegroundIdentity(currentTmuxClaudePid);
    this.apiActivity = this.buildApiActivity(this.foregroundIdentity, currentTmuxClaudePid);
    this.writeSessionToolState(
      this.foregroundIdentity,
      this.foregroundIdentity?.trusted ? this.foregroundIdentity.sessionId : null
    );
    this.writeApiActivitySnapshot(this.apiActivity);
    this.maybeRotateToolEventStream(
      nowMs,
      this.foregroundIdentity?.trusted ? this.foregroundIdentity.sessionId : null
    );
    return {
      foregroundIdentity: this.foregroundIdentity,
      apiActivity: this.apiActivity,
    };
  }

  getApiActivity() {
    return this.apiActivity;
  }

  getForegroundIdentity() {
    return this.foregroundIdentity;
  }

  getRuleById(ruleId) {
    if (!ruleId) return null;
    return this.toolRules.find((rule) => rule.id === ruleId) || null;
  }

  writeApiActivitySnapshot(apiActivity) {
    try {
      atomicWriteJson(this.files.apiActivity, apiActivity);
    } catch {
      // Best-effort.
    }
  }

  writeSessionToolState(foregroundIdentity, foregroundSessionId) {
    try {
      const sessions = {};
      for (const sessionId of Object.keys(this.lifecycleState.sessions).sort()) {
        const snapshot = getSessionSnapshot(this.lifecycleState, sessionId, foregroundSessionId);
        if (!snapshot) continue;
        sessions[sessionId] = {
          ...snapshot,
          watchdog_candidate: snapshot.running_tools.find((tool) => {
            const rule = this.getRuleById(tool.rule_id);
            return Boolean(rule?.watchdog?.enabled);
          }) || null
        };
      }

      atomicWriteJson(this.files.sessionToolState, {
        version: 1,
        foreground_source: foregroundIdentity?.source || null,
        foreground_session_id: foregroundSessionId || null,
        sessions,
        pending_completions: this.lifecycleState.pending_completions,
        pending_clear_hints: this.lifecycleState.pending_clear_hints,
      });
    } catch {
      // Best-effort.
    }
  }

  applySyntheticClearHint(sessionId, pid, reason, nowMs) {
    applyOrderedToolEvents(this.lifecycleState, [{
      ts: nowMs,
      pid: pid || 0,
      session_id: sessionId,
      event: 'session_clear_hint',
      reason,
      match_slack_ms: TOOL_EVENT_REORDER_WINDOW_MS,
    }], { nowMs });
  }

  readJsonFileSafe(filePath) {
    try {
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  loadPersistedToolEventStreamState() {
    const persisted = this.readJsonFileSafe(this.files.toolEventStreamState);
    if (!persisted || persisted.version !== 1) return null;
    try {
      if (!fs.existsSync(this.files.toolEvents)) return null;
      const stat = fs.statSync(this.files.toolEvents);
      const inode = Number(stat.ino) || 0;
      if (persisted.inode && persisted.inode !== inode) return null;
      if (stat.size < (Number(persisted.offset) || 0)) return null;

      const loaded = {
        ...createToolEventStreamState(this.files.toolEvents),
        inode,
        offset: Number(persisted.offset) || 0,
        last_processed_at: Number(persisted.last_processed_at) || 0,
        last_rotation_at: Number(persisted.last_rotation_at) || 0,
      };

      const rotatedDrain = persisted.rotated_drain;
      if (rotatedDrain?.path && fs.existsSync(rotatedDrain.path)) {
        const rotatedStat = fs.statSync(rotatedDrain.path);
        const rotatedInode = Number(rotatedStat.ino) || 0;
        const rotatedOffset = Number(rotatedDrain.offset) || 0;
        if ((!rotatedDrain.inode || rotatedDrain.inode === rotatedInode) && rotatedStat.size >= rotatedOffset) {
          loaded.rotated_drain = {
            path: rotatedDrain.path,
            inode: rotatedInode,
            offset: rotatedOffset,
            last_size: Math.max(Number(rotatedDrain.last_size) || 0, rotatedOffset),
            quiet_since: Number(rotatedDrain.quiet_since) || loaded.last_rotation_at || 0,
          };
        }
      }

      if (!loaded.offset && !loaded.rotated_drain) return null;
      return loaded;
    } catch {
      return null;
    }
  }

  readForegroundSessionRecord() {
    const data = this.readJsonFileSafe(this.files.foregroundSession);
    if (!data || !data.session_id) return null;
    return {
      sessionId: String(data.session_id),
      claudePid: Number(data.claude_pid) || 0,
      source: data.source || 'session_start',
      observedAt: Number(data.observed_at) || 0,
    };
  }

  readStatuslineRecord() {
    try {
      if (!fs.existsSync(this.files.statusline)) return null;
      const stat = fs.statSync(this.files.statusline);
      const data = JSON.parse(fs.readFileSync(this.files.statusline, 'utf8'));
      if (!data?.session_id) return null;
      return {
        sessionId: String(data.session_id),
        observedAt: Math.floor(stat.mtimeMs),
      };
    } catch {
      return null;
    }
  }

  resolveTrustedForegroundIdentity(currentTmuxClaudePid) {
    const early = this.readForegroundSessionRecord();
    const statusline = this.readStatuslineRecord();
    const launchGuardFloor = Math.max(0, this.runtimeLaunchAtMs() - STATUSLINE_LAUNCH_GUARD_MS);

    const earlyTrusted = Boolean(
      early &&
      early.observedAt >= launchGuardFloor &&
      this.isPidAlive(early.claudePid) &&
      (!currentTmuxClaudePid || early.claudePid === currentTmuxClaudePid)
    );

    const statuslineFresh = Boolean(
      statusline &&
      statusline.observedAt >= launchGuardFloor
    );

    if (statuslineFresh && currentTmuxClaudePid > 0) {
      return {
        trusted: true,
        sessionId: statusline.sessionId,
        claudePid: currentTmuxClaudePid,
        source: earlyTrusted && early.sessionId === statusline.sessionId
          ? 'session_start+statusline'
          : 'statusline',
        observedAt: statusline.observedAt,
        blockReason: null,
      };
    }

    if (earlyTrusted) {
      return {
        trusted: true,
        sessionId: early.sessionId,
        claudePid: early.claudePid,
        source: early.source || 'session_start',
        observedAt: early.observedAt,
        blockReason: null,
      };
    }

    if (statusline && !statuslineFresh) {
      return {
        trusted: false,
        sessionId: statusline.sessionId,
        claudePid: 0,
        source: 'statusline',
        observedAt: statusline.observedAt,
        blockReason: 'stale_statusline',
      };
    }

    if (statusline && currentTmuxClaudePid <= 0) {
      return {
        trusted: false,
        sessionId: statusline.sessionId,
        claudePid: 0,
        source: 'statusline',
        observedAt: statusline.observedAt,
        blockReason: 'missing_tmux_claude_pid',
      };
    }

    return {
      trusted: false,
      sessionId: null,
      claudePid: 0,
      source: null,
      observedAt: 0,
      blockReason: 'missing_foreground_identity',
    };
  }

  readToolEventsIncremental(nowMs) {
    const result = readToolEventsIncrementalFromStream({
      filePath: this.files.toolEvents,
      streamState: this.streamState,
      activeTail: this.activeTail,
      rotatedTail: this.rotatedTail,
      arrivalSeq: this.arrivalSeq,
      nowMs,
      drainQuietMs: TOOL_EVENT_ROTATION_DRAIN_MS,
      log: this.log,
    });
    this.streamState = result.streamState;
    this.activeTail = result.activeTail;
    this.rotatedTail = result.rotatedTail;
    this.arrivalSeq = result.arrivalSeq;
    return result.events;
  }

  maybeBuildStatuslineClearHint(currentTmuxClaudePid, interactiveState) {
    const statusline = this.readStatuslineRecord();
    if (!statusline?.sessionId) return null;
    if (statusline.observedAt < Math.max(0, this.runtimeLaunchAtMs() - STATUSLINE_LAUNCH_GUARD_MS)) return null;
    if (statusline.observedAt <= this.lastStatuslineSyntheticClearAt) return null;
    if (!canTreatPaneAsRecovered(interactiveState)) return null;
    const session = getSessionSnapshot(this.lifecycleState, statusline.sessionId, statusline.sessionId);
    const runningTools = session?.running_tools || [];
    if (runningTools.length === 0) return null;
    const newestStartedAt = Number(runningTools[runningTools.length - 1]?.started_at) || 0;
    if (newestStartedAt > 0 && statusline.observedAt < (newestStartedAt + STATUSLINE_ACTIVE_TOOL_CLEAR_GRACE_MS)) {
      return null;
    }
    this.lastStatuslineSyntheticClearAt = statusline.observedAt;
    return {
      ts: statusline.observedAt,
      pid: currentTmuxClaudePid || 0,
      session_id: statusline.sessionId,
      event: 'session_clear_hint',
      reason: 'statusline_turn_complete',
      match_slack_ms: TOOL_EVENT_REORDER_WINDOW_MS,
      _arrival_seq: ++this.arrivalSeq,
    };
  }

  collectLiveSessionPids() {
    const livePids = new Set();
    for (const session of Object.values(this.lifecycleState.sessions)) {
      const pid = Number(session?.pid) || 0;
      if (this.isPidAlive(pid)) livePids.add(pid);
    }
    return livePids;
  }

  processToolLifecycle(nowMs, currentTmuxClaudePid, interactiveState) {
    const newEvents = this.readToolEventsIncremental(nowMs);
    const syntheticClear = this.maybeBuildStatuslineClearHint(currentTmuxClaudePid, interactiveState);
    if (syntheticClear) newEvents.push(syntheticClear);
    if (newEvents.length > 0) {
      this.reorderBuffer.push(...newEvents);
      sortToolEvents(this.reorderBuffer);
    }

    const flushBefore = nowMs - TOOL_EVENT_REORDER_WINDOW_MS;
    const flushable = [];
    const deferred = [];
    for (const event of this.reorderBuffer) {
      if ((event.ts || 0) <= flushBefore) {
        flushable.push(event);
      } else {
        deferred.push(event);
      }
    }
    this.reorderBuffer = deferred;

    if (flushable.length > 0) {
      applyOrderedToolEvents(this.lifecycleState, flushable, { nowMs });
    }

    pruneToolLifecycleState(this.lifecycleState, {
      nowMs,
      livePids: this.collectLiveSessionPids(),
      sessionTtlMs: TOOL_SESSION_TTL_MS
    });

    this.writeToolEventStreamState();
  }

  writeToolEventStreamState() {
    try {
      atomicWriteJson(this.files.toolEventStreamState, this.streamState);
    } catch {
      // Best-effort.
    }
  }

  maybeRotateToolEventStream(nowMs, foregroundSessionId) {
    try {
      if (!fs.existsSync(this.files.toolEvents)) return;
      const stat = fs.statSync(this.files.toolEvents);
      if (stat.size < TOOL_EVENT_ROTATION_BYTES) return;

      const hasAnyActiveTools = Object.keys(this.lifecycleState.sessions).some((sessionId) => {
        const snapshot = getSessionSnapshot(this.lifecycleState, sessionId, foregroundSessionId);
        return Boolean(snapshot?.running_tools?.length);
      });
      const hasPendingBuffers = this.lifecycleState.pending_completions.length > 0 || this.lifecycleState.pending_clear_hints.length > 0;
      if (
        hasAnyActiveTools ||
        hasPendingBuffers ||
        this.reorderBuffer.length > 0 ||
        this.activeTail ||
        this.rotatedTail ||
        this.streamState.rotated_drain
      ) {
        return;
      }

      this.streamState = rotateToolEventStream({
        filePath: this.files.toolEvents,
        nowMs,
      });
      this.activeTail = '';
      this.rotatedTail = '';
      this.writeToolEventStreamState();
      this.log('Tool event stream: rotated event log');
    } catch (err) {
      this.log(`Tool event stream rotation failed: ${err.message}`);
    }
  }

  buildApiActivity(foregroundIdentity, currentTmuxClaudePid) {
    const sessionId = foregroundIdentity?.trusted ? foregroundIdentity.sessionId : null;
    const session = sessionId ? getSessionSnapshot(this.lifecycleState, sessionId, sessionId) : null;
    const runningTools = session?.running_tools || [];
    const oldestActiveTool = runningTools[0] || null;
    const watchdogCandidate = runningTools.find((tool) => {
      const rule = this.getRuleById(tool.rule_id);
      return Boolean(rule?.watchdog?.enabled);
    }) || null;
    const pid = foregroundIdentity?.claudePid || session?.pid || currentTmuxClaudePid || 0;

    return {
      version: 3,
      pid,
      sessionId: sessionId || null,
      scope: sessionId ? 'foreground' : null,
      foreground_identity: {
        session_id: foregroundIdentity?.sessionId || null,
        source: foregroundIdentity?.source || null,
        trusted: Boolean(foregroundIdentity?.trusted),
        observed_at: foregroundIdentity?.observedAt || 0,
      },
      event: session?.last_event || null,
      tool: watchdogCandidate?.name || oldestActiveTool?.name || session?.last_completed_tool?.name || null,
      active: Boolean(runningTools.length > 0 || session?.in_prompt),
      active_tools: runningTools.length,
      in_prompt: Boolean(session?.in_prompt),
      updated_at: session?.last_event_at || 0,
      oldest_active_tool: oldestActiveTool ? {
        event_id: oldestActiveTool.event_id,
        name: oldestActiveTool.name,
        rule_id: oldestActiveTool.rule_id,
        started_at: oldestActiveTool.started_at,
        summary: oldestActiveTool.summary,
      } : null,
      watchdog_candidate_tool: watchdogCandidate ? {
        event_id: watchdogCandidate.event_id,
        name: watchdogCandidate.name,
        rule_id: watchdogCandidate.rule_id,
        started_at: watchdogCandidate.started_at,
        summary: watchdogCandidate.summary,
      } : null,
      last_completed_tool: session?.last_completed_tool || null,
    };
  }
}
