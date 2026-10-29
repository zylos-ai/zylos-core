import fs from 'node:fs';
import path from 'node:path';

const STALE_TOOL_THRESHOLD_MS = 300_000;
const STALE_SUBAGENT_THRESHOLD_MS = 1_800_000;
const STALE_PERMISSION_THRESHOLD_MS = 600_000;
const POSSIBLY_STUCK_THRESHOLD_S = 300;
const STUCK_CONFIRMATION_THRESHOLD_S = 600;
const RECENT_PROGRESS_THRESHOLD_S = 60;
const COLLECTOR_FRESHNESS_MS = 30_000;
const SNAPSHOT_INTERVAL_MS = 30_000;
const AM_HEARTBEAT_INTERVAL_MS = 15_000;
const AM_HEARTBEAT_STALE_MS = 60_000;
const TOOL_TOMBSTONE_LIMIT = 64;

export function deriveAgentState(signals) {
  const evidence = [];
  const missing = [];

  if (!signals.amAvailable) {
    missing.push('am_heartbeat');
    if (signals.runningTool) {
      evidence.push(`tool_running:${signals.runningTool.tool_name}:${Math.floor(signals.runningTool.age)}s`);
    }
    if (signals.openTurn) {
      evidence.push(`open_turn:${Math.floor(signals.openTurn.age)}s`);
    }
    return {
      state: 'UNKNOWN',
      confidence: 'LOW',
      evidence,
      missing_evidence: missing,
      reason: 'AM heartbeat unavailable — session liveness unconfirmed',
      suggested_action: 'Check activity-monitor service'
    };
  }

  evidence.push(`am:${signals.amState}:health=${signals.amHealth}`);

  if (signals.amState === 'offline') {
    return {
      state: 'OFFLINE',
      confidence: 'HIGH',
      evidence,
      missing_evidence: missing,
      reason: 'Agent session is not responding',
      suggested_action: 'Check if the agent session is running'
    };
  }

  if (signals.amHealth !== 'ok') {
    evidence.push(`am_health_degraded:${signals.amHealth}`);
  }

  if (signals.runningTool) {
    const ageSec = Math.floor(signals.runningTool.age);
    evidence.push(`tool_running:${signals.runningTool.tool_name}:${ageSec}s`);

    const recentProgress = signals.lastProgressAge < RECENT_PROGRESS_THRESHOLD_S;

    if (ageSec > POSSIBLY_STUCK_THRESHOLD_S && !recentProgress) {
      if (signals.possiblyStuckSince) {
        const stuckDuration = (signals.now() - new Date(signals.possiblyStuckSince).getTime()) / 1000;
        if (stuckDuration >= STUCK_CONFIRMATION_THRESHOLD_S && signals.collectorLivenessFresh) {
          return {
            state: 'STUCK',
            confidence: 'HIGH',
            evidence,
            missing_evidence: missing,
            reason: `${signals.runningTool.tool_name} tool running for ${ageSec}s with no progress`,
            suggested_action: 'Consider interrupting the stuck operation'
          };
        }
      }

      if (!signals.collectorLivenessFresh) {
        missing.push('collector_liveness_stale');
      }

      return {
        state: 'POSSIBLY_STUCK',
        confidence: 'MEDIUM',
        evidence,
        missing_evidence: missing,
        reason: `${signals.runningTool.tool_name} tool running for ${ageSec}s`,
        suggested_action: 'Monitor — may resolve on its own'
      };
    }

    return {
      state: 'BUSY',
      confidence: 'HIGH',
      evidence,
      missing_evidence: missing,
      reason: `Executing ${signals.runningTool.tool_name} (${ageSec}s)`,
      suggested_action: null
    };
  }

  if (signals.openTurn) {
    const ageSec = Math.floor(signals.openTurn.age);
    evidence.push(`open_turn:${ageSec}s`);
    const recentTurnProgress = signals.lastProgressAge < RECENT_PROGRESS_THRESHOLD_S;

    if (ageSec > POSSIBLY_STUCK_THRESHOLD_S && !recentTurnProgress) {
      if (signals.possiblyStuckSince) {
        const stuckDuration = (signals.now() - new Date(signals.possiblyStuckSince).getTime()) / 1000;
        if (stuckDuration >= STUCK_CONFIRMATION_THRESHOLD_S && signals.collectorLivenessFresh) {
          return {
            state: 'STUCK',
            confidence: 'MEDIUM',
            evidence,
            missing_evidence: missing,
            reason: `Turn open for ${ageSec}s with no progress`,
            suggested_action: 'Consider sending a new message to the agent'
          };
        }
      }

      return {
        state: 'POSSIBLY_STUCK',
        confidence: 'MEDIUM',
        evidence,
        missing_evidence: missing,
        reason: `Turn open for ${ageSec}s without recent activity`,
        suggested_action: 'Monitor — may be thinking'
      };
    }

    return {
      state: 'BUSY',
      confidence: 'MEDIUM',
      evidence,
      missing_evidence: missing,
      reason: `Thinking (${ageSec}s)`,
      suggested_action: null
    };
  }

  if (!signals.collectorLivenessAvailable) {
    missing.push('collector_liveness');
  }

  if (signals.lastProgressAge < Infinity) {
    evidence.push(`last_progress:${Math.floor(signals.lastProgressAge)}s_ago`);
  }

  return {
    state: 'IDLE',
    confidence: 'MEDIUM',
    evidence,
    missing_evidence: missing,
    reason: 'No active task',
    suggested_action: null
  };
}

export class StateEngine {
  constructor(store, collectors, config, { now = () => Date.now(), onStateChange = null } = {}) {
    this.store = store;
    this.collectors = collectors;
    this._config = config;
    this._now = now;
    this._onStateChange = onStateChange;
    this._snapshotTimer = null;
    this._amTimer = null;
    this._lastSnapshotState = null;
    this._lastSnapshotTime = 0;

    this._state = {
      runningTools: new Map(),
      openTurn: null,
      pendingPermission: null,
      possiblyStuckSince: null,
      lastProgressAt: null,
      pm2: null,
      amHeartbeat: null,
      lastSnapshotCursor: 0,
      mainSessionId: null,
      activeSubagents: new Map(),
      lastAssistantMessage: null
    };

    // tool_use_ids whose post_tool_use arrived before its pre_tool_use
    // (hook HTTP posts of fast tool calls can race and land out of order)
    this._toolTombstones = new Set();
  }

  onEvent(event) {
    if (this._isForeignRuntimeEvent(event)) {
      this._resetRuntimeForegroundState();
      this._broadcastStateChange();
      this._maybeSnapshot();
      return;
    }

    const now = new Date(this._now());

    switch (event.event_type) {
      case 'pre_tool_use':
        if (event.metadata?.tool_use_id && this._toolTombstones.has(event.metadata.tool_use_id)) {
          this._toolTombstones.delete(event.metadata.tool_use_id);
          this._state.lastProgressAt = now;
          this._clearPossiblyStuck();
          break;
        }
        if (event.metadata?.tool_use_id) {
          const agentId = this._agentIdForEvent(event);
          this._state.runningTools.set(event.metadata.tool_use_id, {
            tool_name: event.metadata.tool_name,
            tool_detail: event.metadata.tool_detail || null,
            started_at: event.timestamp,
            session_id: event.session_id,
            agent_id: agentId
          });
          if (agentId) {
            const toolActivity = event.summary ||
              (event.metadata.tool_detail
                ? `${event.metadata.tool_name || 'Tool'}: ${event.metadata.tool_detail}`
                : event.metadata.tool_name || 'Tool started');
            this._updateSubagentActivity(agentId, event.timestamp, {
              last_activity: toolActivity
            });
          }
        }
        this._state.lastProgressAt = now;
        this._clearPossiblyStuck();
        break;

      case 'post_tool_use':
        if (event.metadata?.tool_use_id) {
          const removed = this._state.runningTools.delete(event.metadata.tool_use_id);
          if (!removed) this._addToolTombstone(event.metadata.tool_use_id);
        }
        this._state.lastProgressAt = now;
        this._clearPossiblyStuck();
        if (this._state.pendingPermission &&
            this._state.pendingPermission.tool_name === event.metadata?.tool_name) {
          this._state.pendingPermission = null;
        }
        break;

      case 'session_start':
        if (this._isSubagentSession(event.session_id)) {
          this._updateSubagentActivity(event.session_id, event.timestamp, {
            last_activity: event.summary || 'Subagent session started'
          });
          this._state.lastProgressAt = now;
          this._clearPossiblyStuck();
          break;
        }
        if (this._isNewMainSessionBoundary(event.session_id)) {
          this._resetRuntimeForegroundState();
        }
        if (event.session_id) this._setMainSessionId(event.session_id);
        this._state.lastProgressAt = now;
        this._clearPossiblyStuck();
        break;

      case 'user_prompt_submit':
        if (this._isSubagentSession(event.session_id)) {
          this._updateSubagentActivity(event.session_id, event.timestamp, {
            last_activity: event.summary || 'Prompt received'
          });
          this._state.lastProgressAt = now;
          this._clearPossiblyStuck();
          break;
        }
        this._state.openTurn = { started_at: event.timestamp, session_id: event.session_id };
        if (event.session_id) this._setMainSessionId(event.session_id);
        this._state.lastProgressAt = now;
        this._state.lastAssistantMessage = null;
        this._state.lastPrompt = {
          source: event.metadata?.prompt_source || null,
          summary: event.summary || 'Prompt received',
          timestamp: event.timestamp
        };
        this._clearPossiblyStuck();
        break;

      case 'stop':
        if (this._isSubagentSession(event.session_id)) {
          for (const [id, tool] of this._state.runningTools) {
            if (tool.agent_id === event.session_id || tool.session_id === event.session_id) {
              this._state.runningTools.delete(id);
            }
          }
          this._updateSubagentActivity(event.session_id, event.timestamp, {
            status: 'completed',
            last_activity: event.summary || 'Subagent completed'
          });
          this._cleanupStaleTools();
          this._state.lastProgressAt = now;
          this._clearPossiblyStuck();
          break;
        }
        if (event.session_id) {
          for (const [id, tool] of this._state.runningTools) {
            if (tool.session_id === event.session_id && !tool.agent_id) {
              this._state.runningTools.delete(id);
            }
          }
        } else {
          for (const [id, tool] of this._state.runningTools) {
            if (!tool.agent_id) this._state.runningTools.delete(id);
          }
        }
        this._cleanupStaleTools();
        this._state.openTurn = null;
        this._state.lastProgressAt = now;
        this._clearPossiblyStuck();
        this._state.pendingPermission = null;
        if (event.metadata?.assistant_summary) {
          this._state.lastAssistantMessage = {
            text: event.metadata.assistant_summary,
            timestamp: event.timestamp
          };
        }
        break;

      case 'assistant_message':
        if (this._isSubagentSession(event.session_id)) {
          this._updateSubagentActivity(event.session_id, event.timestamp, {
            last_activity: event.summary || 'Subagent message'
          });
          this._state.lastProgressAt = now;
          break;
        }
        this._state.lastAssistantMessage = {
          text: event.summary,
          timestamp: event.timestamp
        };
        this._state.lastProgressAt = now;
        break;

      case 'permission_request':
        this._state.pendingPermission = {
          tool_name: event.metadata?.tool_name,
          requested_at: event.timestamp,
          session_id: event.session_id
        };
        this._state.lastProgressAt = now;
        break;

      case 'subagent_start':
        if (event.session_id) this._setMainSessionId(event.session_id);
        if (event.metadata?.agent_id) {
          let description = event.metadata.description || null;
          if (!description) {
            for (const [, tool] of this._state.runningTools) {
              if ((tool.tool_name === 'Agent' || tool.tool_name === 'Task')
                  && !tool.agent_id && tool.tool_detail && !tool._descriptionConsumed) {
                description = tool.tool_detail;
                tool._descriptionConsumed = true;
                break;
              }
            }
          }
          this._state.activeSubagents.set(event.metadata.agent_id, {
            agent_type: event.metadata.agent_type || 'general-purpose',
            nickname: event.metadata.nickname || null,
            status: event.metadata.status || 'running',
            description,
            started_at: event.timestamp,
            updated_at: event.timestamp,
            last_activity: event.summary || 'Subagent started',
            session_id: event.session_id,
            recent_activity: subagentActivityHistory(null, event.timestamp, event.summary || 'Subagent started', event.metadata?.status || 'running')
          });
        }
        this._state.lastProgressAt = now;
        break;

      case 'subagent_update':
        if (event.session_id) this._setMainSessionId(event.session_id);
        if (event.metadata?.agent_id) {
          const existing = this._state.activeSubagents.get(event.metadata.agent_id) || {
            agent_type: event.metadata.agent_type || 'general-purpose',
            nickname: null,
            status: 'running',
            description: null,
            started_at: event.timestamp,
            session_id: event.session_id
          };
          this._state.activeSubagents.set(event.metadata.agent_id, {
            ...existing,
            agent_type: event.metadata.agent_type || existing.agent_type,
            nickname: event.metadata.nickname || existing.nickname || null,
            status: event.metadata.status || existing.status || 'running',
            description: event.metadata.description || existing.description || null,
            updated_at: event.timestamp,
            last_activity: event.summary || event.metadata.last_activity || existing.last_activity || null,
            session_id: event.session_id || existing.session_id,
            wait_started_at: event.metadata.wait_started_at || (event.metadata.status === 'waiting' ? existing.wait_started_at : null),
            wait_timeout_ms: event.metadata.wait_timeout_ms ?? existing.wait_timeout_ms ?? null,
            wait_latency_ms: event.metadata.wait_latency_ms ?? existing.wait_latency_ms ?? null,
            wait_timed_out: event.metadata.wait_timed_out || existing.wait_timed_out || false,
            failure_reason: event.metadata.failure_reason || existing.failure_reason || null,
            recent_activity: subagentActivityHistory(
              existing.recent_activity,
              event.timestamp,
              event.summary || event.metadata.last_activity || existing.last_activity || 'Subagent updated',
              event.metadata.status || existing.status || 'running'
            )
          });
        }
        this._state.lastProgressAt = now;
        break;

      case 'subagent_stop':
        if (event.metadata?.agent_id) {
          this._state.activeSubagents.delete(event.metadata.agent_id);
          for (const [id, tool] of this._state.runningTools) {
            if (tool.agent_id === event.metadata.agent_id) {
              this._state.runningTools.delete(id);
            }
          }
        }
        this._cleanupStaleTools();
        this._state.lastProgressAt = now;
        break;
    }

    this._broadcastStateChange();
    this._maybeSnapshot();
  }

  onPM2Update(pm2Data) {
    this._state.pm2 = pm2Data;
  }

  onSystemUpdate(_sysData) {
    // System data consumed via collectors; no state-level tracking needed
  }

  getState() {
    const derived = this._deriveState();
    const now = new Date(this._now()).toISOString();

    const runningTools = [];
    const subagentToolsMap = new Map();
    for (const [id, tool] of this._state.runningTools) {
      const durationS = Math.floor((this._now() - new Date(tool.started_at).getTime()) / 1000);
      const entry = {
        tool_use_id: id,
        tool_name: tool.tool_name,
        tool_detail: tool.tool_detail || null,
        started_at: tool.started_at,
        duration_s: durationS
      };
      if (tool.agent_id) {
        if (!subagentToolsMap.has(tool.agent_id)) {
          subagentToolsMap.set(tool.agent_id, []);
        }
        subagentToolsMap.get(tool.agent_id).push(entry);
      } else {
        runningTools.push(entry);
      }
    }

    const activeSubagents = [];
    for (const [id, agent] of this._state.activeSubagents) {
      activeSubagents.push({
        agent_id: id,
        agent_type: agent.agent_type,
        nickname: agent.nickname || null,
        status: agent.status || 'running',
        description: agent.description || null,
        started_at: agent.started_at,
        updated_at: agent.updated_at || agent.started_at,
        last_activity: agent.last_activity || null,
        duration_s: Math.floor((this._now() - new Date(agent.started_at).getTime()) / 1000),
        wait_duration_s: agent.wait_started_at ? Math.floor((this._now() - new Date(agent.wait_started_at).getTime()) / 1000) : null,
        wait_timeout_ms: agent.wait_timeout_ms ?? null,
        wait_latency_ms: agent.wait_latency_ms ?? null,
        wait_timed_out: agent.wait_timed_out || false,
        failure_reason: agent.failure_reason || null,
        recent_activity: agent.recent_activity || [],
        running_tools: subagentToolsMap.get(id) || []
      });
    }

    const subagentTools = [];
    for (const [, tools] of subagentToolsMap) {
      subagentTools.push(...tools);
    }

    return {
      state: derived.state,
      confidence: derived.confidence,
      evidence: derived.evidence,
      missing_evidence: derived.missing_evidence,
      reason: derived.reason,
      suggested_action: derived.suggested_action,
      updated_at: now,
      source: this._buildSourceHealth(),
      running_tools: runningTools,
      active_subagents: activeSubagents,
      subagent_tools: subagentTools,
      last_message: this._state.lastAssistantMessage,
      last_prompt: this._state.lastPrompt || null
    };
  }

  getCurrentSessionId() {
    return this._state.mainSessionId || this._currentSessionId();
  }

  getRunningTools() {
    const tools = [];
    for (const [id, tool] of this._state.runningTools) {
      tools.push({
        tool_use_id: id,
        tool_name: tool.tool_name,
        tool_detail: tool.tool_detail || null,
        started_at: tool.started_at,
        duration_s: Math.floor((this._now() - new Date(tool.started_at).getTime()) / 1000)
      });
    }
    return tools;
  }

  getSourceHealth() {
    return this._buildSourceHealth();
  }

  async initialize() {
    try {
      const snapshot = this.store.latestSnapshot(
        this._config.runtime || 'claude',
        this._currentSessionId()
      );
      if (snapshot) {
        if (snapshot.running_tool) {
          const parsed = typeof snapshot.running_tool === 'string'
            ? JSON.parse(snapshot.running_tool) : snapshot.running_tool;
          if (parsed.tools) {
            this._state.runningTools = new Map(Object.entries(parsed.tools));
            this._state.mainSessionId = parsed.mainSessionId || null;
            if (parsed.activeSubagents) {
              this._state.activeSubagents = new Map(Object.entries(parsed.activeSubagents));
            }
          } else {
            this._state.runningTools = new Map(Object.entries(parsed));
          }
        }
        this._state.openTurn = snapshot.open_turn
          ? (typeof snapshot.open_turn === 'string' ? JSON.parse(snapshot.open_turn) : snapshot.open_turn)
          : null;
        this._state.pendingPermission = snapshot.pending_permission
          ? (typeof snapshot.pending_permission === 'string' ? JSON.parse(snapshot.pending_permission) : snapshot.pending_permission)
          : null;
        this._state.possiblyStuckSince = snapshot.possibly_stuck_since
          ? new Date(snapshot.possibly_stuck_since)
          : null;
        this._state.lastProgressAt = snapshot.last_progress_at
          ? new Date(snapshot.last_progress_at)
          : null;
        this._state.lastSnapshotCursor = snapshot.last_progress_cursor || 0;
        if (snapshot.last_message) {
          this._state.lastAssistantMessage = typeof snapshot.last_message === 'string'
            ? JSON.parse(snapshot.last_message) : snapshot.last_message;
        }
        if (snapshot.last_prompt) {
          this._state.lastPrompt = typeof snapshot.last_prompt === 'string'
            ? JSON.parse(snapshot.last_prompt) : snapshot.last_prompt;
        }
      }
    } catch (err) {
      process.stderr.write(`[state-engine] Snapshot restore error: ${err.message}\n`);
    }

    try {
      const events = this.store.eventsSince(this._state.lastSnapshotCursor);
      for (const event of events) {
        this.onEvent(event);
      }
    } catch (err) {
      process.stderr.write(`[state-engine] Event replay error: ${err.message}\n`);
    }

    const now = this._now();
    for (const [id, tool] of this._state.runningTools) {
      if ((now - new Date(tool.started_at).getTime()) > STALE_TOOL_THRESHOLD_MS) {
        this._state.runningTools.delete(id);
      }
    }
    for (const [id, agent] of this._state.activeSubagents) {
      if ((now - new Date(agent.started_at).getTime()) > STALE_SUBAGENT_THRESHOLD_MS) {
        this._state.activeSubagents.delete(id);
      }
    }
    if (this._state.pendingPermission) {
      const age = now - new Date(this._state.pendingPermission.requested_at).getTime();
      if (age > STALE_PERMISSION_THRESHOLD_MS) {
        this._state.pendingPermission = null;
      }
    }

    this._readAMHeartbeat();
  }

  startSnapshotTimer() {
    this.stopSnapshotTimer();
    this._snapshotTimer = setInterval(() => this._periodicSnapshot(), SNAPSHOT_INTERVAL_MS);
    this._snapshotTimer.unref();
    this._amTimer = setInterval(() => this._readAMHeartbeat(), AM_HEARTBEAT_INTERVAL_MS);
    this._amTimer.unref();
  }

  stopSnapshotTimer() {
    if (this._snapshotTimer) {
      clearInterval(this._snapshotTimer);
      this._snapshotTimer = null;
    }
    if (this._amTimer) {
      clearInterval(this._amTimer);
      this._amTimer = null;
    }
  }

  _deriveState() {
    const now = this._now;
    const oldestTool = this._oldestRunningTool();

    const signals = {
      amAvailable: this._state.amHeartbeat !== null,
      amState: this._state.amHeartbeat?.state ?? null,
      amHealth: this._state.amHeartbeat?.health ?? null,
      runningTool: oldestTool ? {
        tool_name: oldestTool.tool_name,
        age: (now() - new Date(oldestTool.started_at).getTime()) / 1000
      } : null,
      openTurn: this._state.openTurn ? {
        age: (now() - new Date(this._state.openTurn.started_at).getTime()) / 1000
      } : null,
      pendingPermission: this._state.pendingPermission ? {
        tool_name: this._state.pendingPermission.tool_name,
        age: (now() - new Date(this._state.pendingPermission.requested_at).getTime()) / 1000
      } : null,
      lastProgressAge: this._state.lastProgressAt
        ? (now() - this._state.lastProgressAt.getTime()) / 1000
        : Infinity,
      lastProgressType: null,
      collectorLivenessFresh: this._isCollectorLivenessFresh(),
      collectorLivenessAvailable: this._isCollectorLivenessAvailable(),
      activeOtelSpan: false,
      possiblyStuckSince: this._state.possiblyStuckSince?.toISOString() ?? null,
      runtime: this._config.runtime || 'claude',
      now
    };

    const derived = deriveAgentState(signals);

    if ((derived.state === 'POSSIBLY_STUCK' || derived.state === 'STUCK') &&
        !this._state.possiblyStuckSince) {
      this._state.possiblyStuckSince = new Date(now());
    }

    return derived;
  }

  _oldestRunningTool() {
    let oldest = null;
    for (const [, tool] of this._state.runningTools) {
      if (tool.agent_id) continue;
      if (!oldest || new Date(tool.started_at) < new Date(oldest.started_at)) {
        oldest = tool;
      }
    }
    return oldest;
  }

  _clearPossiblyStuck() {
    this._state.possiblyStuckSince = null;
  }

  _agentIdForEvent(event) {
    if (event.metadata?.agent_id) return event.metadata.agent_id;
    return this._isSubagentSession(event.session_id) ? event.session_id : null;
  }

  _isSubagentSession(sessionId) {
    return !!sessionId && this._state.activeSubagents.has(sessionId);
  }

  _updateSubagentActivity(agentId, timestamp, patch = {}) {
    const existing = this._state.activeSubagents.get(agentId);
    if (!existing) return;
    const activity = patch.last_activity || existing.last_activity || null;
    this._state.activeSubagents.set(agentId, {
      ...existing,
      status: patch.status || existing.status || 'running',
      updated_at: timestamp || existing.updated_at || existing.started_at,
      last_activity: activity,
      recent_activity: activity
        ? subagentActivityHistory(existing.recent_activity, timestamp, activity, patch.status || existing.status || 'running')
        : existing.recent_activity || []
    });
  }

  _isForeignRuntimeEvent(event) {
    const currentRuntime = this._config.runtime || 'claude';
    return Boolean(event?.runtime && event.runtime !== currentRuntime);
  }

  _isNewMainSessionBoundary(sessionId) {
    if (!sessionId) return false;
    if (this._state.mainSessionId) return sessionId !== this._state.mainSessionId;

    const foregroundSessionIds = new Set();
    if (this._state.openTurn?.session_id) foregroundSessionIds.add(this._state.openTurn.session_id);
    if (this._state.pendingPermission?.session_id) foregroundSessionIds.add(this._state.pendingPermission.session_id);
    for (const [, tool] of this._state.runningTools) {
      if (!tool.agent_id && tool.session_id) foregroundSessionIds.add(tool.session_id);
    }
    for (const [, agent] of this._state.activeSubagents) {
      if (agent.session_id) foregroundSessionIds.add(agent.session_id);
    }

    return foregroundSessionIds.size > 0 && !foregroundSessionIds.has(sessionId);
  }

  _addToolTombstone(toolUseId) {
    this._toolTombstones.add(toolUseId);
    while (this._toolTombstones.size > TOOL_TOMBSTONE_LIMIT) {
      this._toolTombstones.delete(this._toolTombstones.values().next().value);
    }
  }

  _setMainSessionId(sessionId) {
    if (sessionId === this._state.mainSessionId) return;
    this._state.mainSessionId = sessionId;
    // A foreground tool owned by a superseded session cannot still be
    // running — its session is gone and no post_tool_use will ever come.
    for (const [id, tool] of this._state.runningTools) {
      if (!tool.agent_id && tool.session_id && tool.session_id !== sessionId) {
        this._state.runningTools.delete(id);
      }
    }
  }

  _resetRuntimeForegroundState() {
    this._state.runningTools.clear();
    this._state.openTurn = null;
    this._state.pendingPermission = null;
    this._state.possiblyStuckSince = null;
    this._state.mainSessionId = null;
    this._state.activeSubagents.clear();
    this._state.lastPrompt = null;
  }

  _isCollectorLivenessFresh() {
    try {
      const health = this.store.getCollectorLiveness();
      const sources = ['pm2_reader', 'system_sampler', 'hook_handler', 'am_heartbeat'];
      const now = this._now();
      return sources.every(name => {
        const h = health.find(s => s.name === name);
        if (!h) return false;
        if (h.status === 'stale' || h.status === 'error') return false;
        const extra = h.extra;
        const lastSuccess = extra?.last_success;
        if (!lastSuccess) return false;
        return (now - new Date(lastSuccess).getTime()) < COLLECTOR_FRESHNESS_MS;
      });
    } catch {
      return false;
    }
  }

  _isCollectorLivenessAvailable() {
    try {
      const health = this.store.getCollectorLiveness();
      const sources = ['pm2_reader', 'system_sampler', 'hook_handler', 'am_heartbeat'];
      return sources.some(name => health.find(s => s.name === name));
    } catch {
      return false;
    }
  }

  _isAMProcessOnline() {
    const pm2 = this._state.pm2;
    if (!pm2) return null;
    const procs = Array.isArray(pm2) ? pm2 : (pm2.processes || pm2.services || []);
    const am = procs.find(p => p.name === 'activity-monitor' || p.name === 'zylos-activity-monitor');
    if (!am) return null;
    const status = String(am.pm2_env?.status || am.status || '').toLowerCase();
    return ['online', 'running'].includes(status);
  }

  _readAMHeartbeat() {
    const amOnline = this._isAMProcessOnline();
    if (amOnline === false) {
      this._state.amHeartbeat = null;
      this.store.upsertSourceHealth('am_heartbeat', 'collector_liveness', 'stale', {
        reason: 'AM process not online in PM2'
      });
      return;
    }

    try {
      const amStatusPath = path.join(
        this._config.zylosDir,
        'activity-monitor', 'agent-status.json'
      );
      const raw = fs.readFileSync(amStatusPath, 'utf8');
      const data = JSON.parse(raw);
      this._state.amHeartbeat = {
        state: data.state,
        health: data.health,
        lastCheck: data.last_check,
        lastActivity: data.last_activity
      };
      this.store.upsertSourceHealth('am_heartbeat', 'collector_liveness', 'healthy', {
        last_success: new Date(this._now()).toISOString(),
        agent_state: data.state,
        agent_health: data.health
      });
    } catch {
      this._state.amHeartbeat = null;
    }
  }

  _broadcastStateChange() {
    if (this._onStateChange) {
      try {
        this._onStateChange(this.getState());
      } catch {
        // broadcast failure is non-fatal
      }
    }
  }

  _maybeSnapshot() {
    try {
      const currentState = this._deriveState().state;
      const now = this._now();
      if (currentState !== this._lastSnapshotState || now - this._lastSnapshotTime > SNAPSHOT_INTERVAL_MS) {
        this._saveSnapshot();
        this._lastSnapshotState = currentState;
        this._lastSnapshotTime = now;
      }
    } catch {
      // snapshot failure is non-fatal
    }
  }

  _periodicSnapshot() {
    try {
      this._readAMHeartbeat();
      this._saveSnapshot();
      this._lastSnapshotTime = this._now();
    } catch (err) {
      process.stderr.write(`[state-engine] Snapshot error: ${err.message}\n`);
    }
  }

  _cleanupStaleTools() {
    const now = this._now();
    for (const [id, tool] of this._state.runningTools) {
      if ((now - new Date(tool.started_at).getTime()) > STALE_TOOL_THRESHOLD_MS) {
        this._state.runningTools.delete(id);
      }
    }
    for (const [id, agent] of this._state.activeSubagents) {
      if ((now - new Date(agent.started_at).getTime()) > STALE_SUBAGENT_THRESHOLD_MS) {
        this._state.activeSubagents.delete(id);
      }
    }
  }

  _saveSnapshot() {
    this.store.saveSnapshot({
      runtime: this._config.runtime || 'claude',
      session_id: this._currentSessionId(),
      running_tool: JSON.stringify({
        tools: Object.fromEntries(this._state.runningTools),
        mainSessionId: this._state.mainSessionId,
        activeSubagents: Object.fromEntries(this._state.activeSubagents)
      }),
      open_turn: JSON.stringify(this._state.openTurn),
      pending_permission: JSON.stringify(this._state.pendingPermission),
      possibly_stuck_since: this._state.possiblyStuckSince?.toISOString() || null,
      last_progress_cursor: this._getMaxEventSeq(),
      last_message: JSON.stringify(this._state.lastAssistantMessage),
      last_prompt: JSON.stringify(this._state.lastPrompt || null),
      last_progress_at: this._state.lastProgressAt?.toISOString() || null
    });
  }

  _getMaxEventSeq() {
    try {
      const row = this.store.db.prepare('SELECT COALESCE(MAX(event_seq), 0) AS seq FROM runtime_events').get();
      return row.seq;
    } catch {
      return this._state.lastSnapshotCursor;
    }
  }

  _currentSessionId() {
    return process.env.CLAUDE_SESSION_ID || process.env.CODEX_SESSION_ID || null;
  }

  _buildSourceHealth() {
    try {
      const allHealth = this.store.getSourceHealth();
      const now = this._now();

      const currentRuntime = this._config.runtime || 'claude';
      const formatEntry = (name, { runtimeScoped = false, expectedRuntime = currentRuntime, signalType = null, capability = 'supported' } = {}) => {
        if (capability === 'unsupported') {
          return {
            fresh: false,
            age_s: null,
            status: 'unsupported',
            capability: 'unsupported',
            reason: 'unsupported',
            detail: 'Not supported for this runtime'
          };
        }

        const h = allHealth.find(s => s.name === name && (!signalType || s.signal_type === signalType));
        if (!h) {
          return {
            fresh: false,
            age_s: null,
            status: 'unknown',
            capability,
            reason: 'no_signal',
            detail: 'No source signal has been recorded yet'
          };
        }
        if (runtimeScoped && h.extra?.runtime && h.extra.runtime !== expectedRuntime) {
          return {
            fresh: false,
            age_s: null,
            status: 'unknown',
            capability,
            reason: 'runtime_mismatch',
            detail: `Last signal belongs to ${h.extra.runtime}, not ${expectedRuntime}`
          };
        }
        const lastSuccess = h.extra?.last_success;
        const ageS = lastSuccess ? Math.floor((now - new Date(lastSuccess).getTime()) / 1000) : null;
        const fresh = ageS !== null && ageS < 30;
        const reason = h.extra?.reason
          || (h.status === 'unavailable' ? 'unavailable'
            : h.status === 'stale' ? 'stale'
              : fresh ? 'fresh' : 'stale_or_not_successful');
        return {
          fresh,
          age_s: ageS,
          status: h.status,
          capability,
          reason,
          detail: sourceHealthDetail(h, reason, fresh),
          updated_at: h.updated_at || null
        };
      };

      return {
        runtime_progress: {
          hook_events: formatEntry('hook_events', { runtimeScoped: true, signalType: 'runtime_progress' }),
          jsonl_usage: currentRuntime === 'codex'
            ? formatEntry('codex_rollout', { signalType: 'collector_liveness' })
            : formatEntry('jsonl_usage', { signalType: 'collector_liveness' }),
          statusline: currentRuntime === 'claude'
            ? formatEntry('statusline', { runtimeScoped: true, expectedRuntime: 'claude', signalType: 'runtime_progress' })
            : formatEntry('statusline', { capability: 'unsupported' })
        },
        collector_liveness: {
          pm2_reader: formatEntry('pm2_reader', { signalType: 'collector_liveness' }),
          system_sampler: formatEntry('system_sampler', { signalType: 'collector_liveness' }),
          hook_handler: formatEntry('hook_handler', { signalType: 'collector_liveness' }),
          conversation_reader: formatEntry('conversation_reader', { signalType: 'collector_liveness' }),
          am_heartbeat: formatEntry('am_heartbeat', { signalType: 'collector_liveness' })
        },
        platform: {
          statusline: formatEntry('statusline', { signalType: 'collector_liveness' }),
          c4: formatEntry('c4', { signalType: 'collector_liveness' })
        }
      };
    } catch {
      return {
        runtime_progress: {},
        collector_liveness: {},
        platform: {}
      };
    }
  }
}

function sourceHealthDetail(row, reason, fresh) {
  const extra = row.extra || {};
  if (reason === 'no_hook_transcript_path') return 'Waiting for a Codex hook to provide a rollout transcript path';
  if (reason === 'rollout_unreadable') return extra.error ? `Rollout transcript is unreadable: ${extra.error}` : 'Rollout transcript is unreadable';
  if (reason === 'partial_line') return 'Rollout transcript ended with an incomplete line';
  if (reason === 'missing_model_price') return `Missing price table entry for ${extra.model || 'model'}`;
  if (reason === 'unavailable') return 'Source is unavailable';
  if (reason === 'stale') return 'No new source data since the last check';
  if (fresh) return 'Fresh source signal';
  return 'Source signal is stale or has not reported a successful sample';
}

function subagentActivityHistory(existing, timestamp, summary, status) {
  const items = Array.isArray(existing) ? existing : [];
  const text = typeof summary === 'string' ? summary.trim() : '';
  if (!text) return items.slice(-4);
  const entry = {
    timestamp,
    status: status || 'running',
    summary: text
  };
  const last = items[items.length - 1];
  if (last?.summary === entry.summary && last?.status === entry.status) {
    return [...items.slice(0, -1), entry].slice(-4);
  }
  return [...items, entry].slice(-4);
}
