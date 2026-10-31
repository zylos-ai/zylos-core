import fs from 'node:fs';
import crypto from 'node:crypto';
import { DEFAULT_CODEX_MODEL_PRICES, DEFAULT_CODEX_PRIORITY_MODEL_PRICES, modelPricesForRuntime, normalizeServiceTier } from '../config.js';
import { Sanitizer } from '../sanitizer.js';

const PER_MTOK = 1_000_000;
const ASSISTANT_MESSAGE_SUMMARY_LIMIT = 500;
const DEFAULT_MAX_OVERSIZED_LINE_SKIP_BYTES = 8 * 1024 * 1024;
const BUILTIN_CODEX_MODEL_IDS = new Set([
  ...Object.keys(DEFAULT_CODEX_MODEL_PRICES),
  ...Object.keys(DEFAULT_CODEX_PRIORITY_MODEL_PRICES)
]);

export class CodexRolloutCollector {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this._timer = null;
    this._metadataByPath = new Map();
    this._toolSummaryByCallId = new Map();
    this._toolNameByCallId = new Map();
    this._subagentSpawnByCallId = new Map();
    this._subagentStartedAt = new Map();
    this._subagentWaitByCallId = new Map();
    this._onEvent = null;
    this._onMetric = null;
    this._onRuntimeInfo = null;
    this._runtimeInfo = null;
    this._runtimeTranscriptPath = null;
    this._sanitizer = config.sanitizer || new Sanitizer(config.zylosDir || process.cwd());
  }

  collect() {
    const mapping = this.store.latestCodexRolloutPath?.('codex');
    const now = new Date().toISOString();
    this._runtimeTranscriptPath = mapping?.transcript_path || null;

    if (!mapping?.transcript_path) {
      this._clearRuntimeInfo();
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'unavailable', {
        reason: 'no_hook_transcript_path',
        last_checked: now
      });
      return 0;
    }

    let stat;
    try {
      stat = fs.statSync(mapping.transcript_path);
    } catch (err) {
      this._clearRuntimeInfo(mapping.session_id);
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'unavailable', {
        reason: 'rollout_unreadable',
        error: err.code || err.message,
        transcript_path: mapping.transcript_path,
        session_id: mapping.session_id,
        last_checked: now
      });
      return 0;
    }

    const cursor = this.store.getCodexRolloutCursor?.(mapping.transcript_path);
    let offset = cursor?.byte_offset || 0;
    if (stat.size < offset) offset = 0;

    const sessionMeta = { ...this._getTranscriptMetadata(mapping.transcript_path) };
    this._updateRuntimeInfo({
      sessionId: mapping.session_id,
      model: sessionMeta.model,
      serviceTier: sessionMeta.serviceTier,
      effort: sessionMeta.effort,
      cliVersion: sessionMeta.cliVersion,
      timestamp: sessionMeta.modelTimestamp || sessionMeta.cliVersionTimestamp || now,
      replace: true
    });

    if (stat.size === offset) {
      const backfilled = offset > 0 ? this._backfillRateLimits(mapping, sessionMeta) : 0;
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'stale', {
        transcript_path: mapping.transcript_path,
        session_id: mapping.session_id,
        byte_offset: offset,
        metrics_written: backfilled,
        last_checked: now
      });
      this.store.upsertSourceHealth('jsonl_usage', 'runtime_progress', 'healthy', {
        transcript_path: mapping.transcript_path,
        session_id: mapping.session_id,
        byte_offset: offset,
        metrics_written: backfilled,
        last_success: now
      });
      return backfilled;
    }

    const maxBytes = Math.max(4096, Number(this.config.codexRolloutMaxBytesPerCollect) || 256 * 1024);
    const maxLines = Math.max(1, Number(this.config.codexRolloutMaxLinesPerCollect) || 200);
    const length = Math.min(stat.size - offset, maxBytes);
    const buf = Buffer.alloc(length);
    const fd = fs.openSync(mapping.transcript_path, 'r');
    try {
      fs.readSync(fd, buf, 0, length, offset);
    } finally {
      fs.closeSync(fd);
    }

    const chunk = buf.toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) {
      if (length === maxBytes) {
        const skippedTo = this._skipOversizedLine(mapping.transcript_path, offset, stat.size, maxBytes);
        const skippedBytes = skippedTo - offset;
        this.store.upsertCodexRolloutCursor?.({
          transcriptPath: mapping.transcript_path,
          byteOffset: skippedTo,
          sessionId: mapping.session_id
        });
        this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'healthy', {
          reason: 'oversized_line_skipped',
          transcript_path: mapping.transcript_path,
          session_id: mapping.session_id,
          byte_offset: skippedTo,
          skipped_bytes: skippedBytes,
          last_success: now
        });
        this.store.upsertSourceHealth('jsonl_usage', 'runtime_progress', 'healthy', {
          reason: 'oversized_line_skipped',
          transcript_path: mapping.transcript_path,
          session_id: mapping.session_id,
          byte_offset: skippedTo,
          skipped_bytes: skippedBytes,
          metrics_written: 0,
          last_success: now
        });
        return 0;
      }
      this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'stale', {
        reason: 'partial_line',
        transcript_path: mapping.transcript_path,
        session_id: mapping.session_id,
        byte_offset: offset,
        last_checked: now
      });
      return 0;
    }

    const complete = chunk.slice(0, lastNewline + 1);

    let written = 0;
    let currentOffset = offset;
    let lineIndex = 0;
    let processedLines = 0;
    const rawLines = complete.split('\n');
    for (const rawLine of rawLines.slice(0, -1)) {
      const line = rawLine.trim();
      const lineOffset = currentOffset;
      currentOffset += Buffer.byteLength(`${rawLine}\n`, 'utf8');
      lineIndex++;
      if (!line) continue;
      if (processedLines >= maxLines) {
        currentOffset = lineOffset;
        break;
      }
      processedLines++;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      written += this._ingestEvent(event, mapping, sessionMeta, {
        byteOffset: lineOffset,
        lineIndex,
        publishRuntimeInfo: false
      });
    }

    this.store.upsertCodexRolloutCursor?.({
      transcriptPath: mapping.transcript_path,
      byteOffset: currentOffset,
      sessionId: mapping.session_id
    });

    this.store.upsertSourceHealth('codex_rollout', 'collector_liveness', 'healthy', {
      transcript_path: mapping.transcript_path,
      session_id: mapping.session_id,
      byte_offset: currentOffset,
      metrics_written: written,
      last_success: now
    });
    this.store.upsertSourceHealth('jsonl_usage', 'runtime_progress', 'healthy', {
      transcript_path: mapping.transcript_path,
      session_id: mapping.session_id,
      byte_offset: currentOffset,
      metrics_written: written,
      last_success: now
    });

    return written;
  }

  _skipOversizedLine(transcriptPath, offset, statSize, maxBytes) {
    const configuredMaxSkip = Number(this.config.codexRolloutMaxOversizedLineSkipBytes);
    const maxSkipBytes = Math.max(
      maxBytes,
      Number.isFinite(configuredMaxSkip) && configuredMaxSkip > 0
        ? configuredMaxSkip
        : DEFAULT_MAX_OVERSIZED_LINE_SKIP_BYTES
    );
    const target = Math.min(statSize, offset + maxSkipBytes);
    const scanSize = Math.min(maxBytes, 256 * 1024);
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      let position = offset;
      const buf = Buffer.alloc(scanSize);
      while (position < target) {
        const bytesToRead = Math.min(scanSize, target - position);
        const bytesRead = fs.readSync(fd, buf, 0, bytesToRead, position);
        if (bytesRead <= 0) break;
        const newlineIndex = buf.subarray(0, bytesRead).indexOf(0x0a);
        if (newlineIndex >= 0 && newlineIndex < bytesRead) {
          return position + newlineIndex + 1;
        }
        position += bytesRead;
      }
      return position;
    } finally {
      fs.closeSync(fd);
    }
  }

  start(intervalMs = 5_000) {
    this.stop();
    this._timer = setInterval(() => this.collect(), intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  getRuntimeInfo() {
    const mapping = this.store.latestCodexRolloutPath?.('codex');
    if (!mapping?.transcript_path || mapping.session_id !== this._runtimeInfo?.session_id ||
        mapping.transcript_path !== this._runtimeTranscriptPath) {
      this._clearRuntimeInfo(mapping?.transcript_path ? mapping.session_id : null);
    }
    return this._runtimeInfo;
  }

  _ingestEvent(event, mapping, sessionMeta = {}, position = {}) {
    const payload = event.payload || {};
    if (event.type === 'session_meta' && payload.cli_version) {
      sessionMeta.cliVersion = payload.cli_version;
      if (position.publishRuntimeInfo !== false) this._updateRuntimeInfo({
        sessionId: mapping.session_id,
        cliVersion: payload.cli_version,
        timestamp: event.timestamp || new Date().toISOString()
      });
      return 0;
    }
    if (event.type === 'turn_context') {
      sessionMeta.model = payload.model || undefined;
      sessionMeta.serviceTier = runtimeServiceTier(payload.service_tier ?? payload.serviceTier);
      sessionMeta.effort = runtimeEffort(payload);
      if (position.publishRuntimeInfo !== false) this._updateRuntimeInfo({
        sessionId: mapping.session_id,
        model: sessionMeta.model,
        serviceTier: sessionMeta.serviceTier,
        effort: sessionMeta.effort,
        cliVersion: sessionMeta.cliVersion,
        replace: true,
        timestamp: event.timestamp || new Date().toISOString()
      });
      return 0;
    }
    if (event.type === 'response_item') {
      return this._ingestResponseItem(payload, timestampForEvent(event), mapping, position);
    }
    if (event.type !== 'event_msg' || !payload.type) return 0;

    const timestamp = event.timestamp || payload.timestamp || new Date().toISOString();
    if (payload.type === 'token_count') {
      return this._ingestTokenCount(payload.info || {}, timestamp, mapping, {
        rateLimits: payload.rate_limits || payload.info?.rate_limits,
        model: sessionMeta.model,
        serviceTier: normalizeServiceTier(payload.service_tier ?? payload.serviceTier ?? payload.info?.service_tier ?? payload.info?.serviceTier ?? sessionMeta.serviceTier),
        position
      });
    }
    if (payload.type === 'task_complete') {
      return this._ingestTaskComplete(payload, timestamp, mapping, position);
    }
    if (payload.type === 'response_item') {
      return this._ingestResponseItem(payload, timestamp, mapping, position);
    }
    return 0;
  }

  _ingestTokenCount(info, timestamp, mapping, context = {}) {
    const lastUsage = info.last_token_usage || {};
    const totalUsage = info.total_token_usage || {};
    const usage = Object.keys(lastUsage).length > 0 ? lastUsage : totalUsage;
    const model = info.model || info.model_slug || context.model || null;
    const serviceTier = normalizeServiceTier(info.service_tier ?? info.serviceTier ?? context.serviceTier);
    const position = context.position || {};
    const eventId = info.id || rolloutPositionId('token_count', mapping, position);

    const contextInput = numberOrNull(lastUsage.input_tokens);
    const contextWindow = numberOrNull(info.model_context_window);
    const tokenDims = normalizeUsage(usage);
    const totalInput = tokenDims.input;
    tokenDims.total_input = totalInput;
    tokenDims.uncached_input = Math.max(totalInput - tokenDims.cache_read - tokenDims.cache_creation, 0);
    tokenDims.runtime_semantics = 'openai_input_includes_cached';
    tokenDims.model = model;
    tokenDims.service_tier = serviceTier;
    tokenDims.event_id = eventId;
    tokenDims.rollout_offset = position.byteOffset ?? null;
    tokenDims.rollout_line = position.lineIndex ?? null;

    if (contextInput != null) tokenDims.context_input_tokens = contextInput;
    if (contextWindow && contextWindow > 0) {
      tokenDims.model_context_window = contextWindow;
      if (contextInput != null) tokenDims.context_pct = (contextInput / contextWindow) * 100;
    }

    applyRateLimitDimensions(tokenDims, context.rateLimits);

    if (totalInput > 0) {
      tokenDims.cache_hit_rate = tokenDims.cache_read / totalInput;
      const price = this._resolveModelPrice(model, serviceTier);
      // Cumulative usage cannot establish an individual request's context tier.
      const hasRequestUsage = Object.keys(lastUsage).length > 0;
      const cost = this._calculateCost(tokenDims, price, hasRequestUsage);
      if (price?.longContext && !hasRequestUsage) {
        tokenDims.cost_estimation_note = 'cannot_determine_request_context';
      }
      if (cost != null) {
        tokenDims.cost = cost;
        tokenDims.cost_confidence = 'estimated';
      } else {
        this.store.upsertSourceHealth('codex_cost', 'collector_liveness', 'unavailable', {
          reason: 'missing_model_price',
          model,
          last_checked: timestamp
        });
      }
    }

    const hasUsage = totalInput > 0 || tokenDims.output > 0 || tokenDims.reasoning > 0;
    const hasCapacity = tokenDims.context_pct != null || tokenDims.rate_limit != null || tokenDims.rate_limit_7d != null;
    if (!hasUsage && !hasCapacity) return 0;

    return this._insertUsageEventOnce({
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      metric_name: 'usage_event',
      metric_value: totalInput,
      dimensions: tokenDims,
      source: 'jsonl_usage',
      confidence: 'actual'
    });
  }

  _ingestRateLimit(limit, metricName, timestamp, mapping, position = {}) {
    if (!limit || typeof limit !== 'object') return 0;
    const value = numberOrNull(limit.percent_used ?? limit.usage_pct ?? limit.used_percent);
    if (value == null) return 0;
    const eventId = rolloutPositionId(metricName, mapping, position);
    return this._insertMetricOnce({
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      metric_name: metricName,
      metric_value: value,
      dimensions: {
        event_id: eventId,
        window_minutes: limit.window_minutes ?? null,
        resets_at: limit.resets_at ?? null,
        rollout_offset: position.byteOffset ?? null,
        rollout_line: position.lineIndex ?? null
      },
      source: 'rollout',
      confidence: 'actual'
    });
  }

  _ingestTaskComplete(payload, timestamp, mapping, position = {}) {
    let written = 0;
    const duration = numberOrNull(payload.duration_ms);
    const ttft = numberOrNull(payload.time_to_first_token_ms);
    if (duration != null) {
      written += this._insertMetricOnce({
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        metric_name: 'turn_duration',
        metric_value: duration,
        dimensions: {
          event_id: rolloutPositionId('turn_duration', mapping, position),
          rollout_offset: position.byteOffset ?? null,
          rollout_line: position.lineIndex ?? null
        },
        source: 'rollout',
        confidence: 'actual'
      });
    }
    if (ttft != null) {
      written += this._insertMetricOnce({
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        metric_name: 'ttft',
        metric_value: ttft,
        dimensions: {
          event_id: rolloutPositionId('ttft', mapping, position),
          rollout_offset: position.byteOffset ?? null,
          rollout_line: position.lineIndex ?? null
        },
        source: 'rollout',
        confidence: 'actual'
      });
    }
    if (duration != null || ttft != null) {
      const ingestId = `codex-turn-complete-${rolloutPositionId('task_complete', mapping, position)}`;
      const result = this._insertEvent({
        id: stableEventId(ingestId),
        ingest_id: ingestId,
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        event_type: 'turn_complete',
        category: 'turn',
        summary: 'Turn completed',
        duration_ms: duration,
        metadata: {
          ttft_ms: ttft,
          source_event: 'task_complete',
          rollout_offset: position.byteOffset ?? null,
          rollout_line: position.lineIndex ?? null
        },
        source: 'rollout',
        confidence: 'actual'
      });
      written += result?.inserted ? 1 : 0;
    }
    return written;
  }

  _insertMetricOnce(point) {
    const eventId = point.dimensions?.event_id || null;
    if (eventId && this.store.hasMetricEventId?.({
      metricName: point.metric_name,
      sessionId: point.session_id,
      source: point.source,
      eventId
    })) {
      return 0;
    }
    this.store.insertMetric(point);
    if (this._onMetric) {
      this._onMetric(point);
    }
    return 1;
  }

  _insertUsageEventOnce(point) {
    const result = this.store.insertMetricOnce?.(point) || this.store.insertMetric?.(point);
    if (!result?.inserted) return 0;
    if (this._onMetric) {
      this._onMetric(point);
    }
    return 1;
  }

  _ingestResponseItem(payload, timestamp, mapping, position = {}) {
    const item = payload.item || payload.response_item || payload || {};
    if (item.type === 'message' && item.role === 'assistant') {
      return this._ingestMessage(item, payload, timestamp, mapping, position);
    }
    if (!['function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output'].includes(item.type)) return 0;
    const name = item.name || payload.name || null;
    const callId = item.call_id || payload.call_id || null;
    if (!name && !callId) return 0;
    const normalizedName = normalizeToolName(name || this._toolNameByCallId.get(callId));
    const isOutput = item.type === 'function_call_output' || item.type === 'custom_tool_call_output';
    const toolArgs = parseToolArgs(item.arguments || item.input || payload.arguments || payload.input);

    if (callId && !isOutput && name) this._toolNameByCallId.set(callId, name);

    if (!isOutput && normalizedName === 'spawn_agent' && callId) {
      this._subagentSpawnByCallId.set(callId, {
        agent_type: toolArgs.agent_type || 'default',
        description: this._sanitizer.safeSummary(toolArgs.message, 200)
      });
    }

    const positionId = rolloutPositionId('response_item', mapping, position);
    const eventKey = callId || positionId;
    const summary = isOutput
      ? this._toolSummaryByCallId.get(callId) || 'Tool completed'
      : this._summarizeToolCall(name, item.arguments || item.input || payload.arguments || payload.input);
    if (callId && !isOutput) this._toolSummaryByCallId.set(callId, summary);

    const ingestId = `codex-rollout-${mapping.session_id || 'unknown'}-${eventKey}-${item.type}`;
    let written = 0;
    const toolEvent = {
      id: stableEventId(ingestId),
      ingest_id: ingestId,
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      event_type: isOutput ? 'tool_result' : 'tool_call',
      category: 'tool',
      summary,
      duration_ms: null,
      metadata: {
        tool_name: name,
        call_id: callId,
        source_event: 'response_item',
        raw_type: item.type,
        rollout_offset: position.byteOffset ?? null,
        rollout_line: position.lineIndex ?? null
      },
      source: 'rollout',
      confidence: 'actual'
    };

    const targetAgentId = subagentTargetFromArgs(normalizedName, toolArgs);
    if (targetAgentId) toolEvent.metadata.agent_id = targetAgentId;

    const toolResult = this._insertEvent(toolEvent);
    written += toolResult?.inserted ? 1 : 0;

    if (isOutput) {
      written += this._ingestSubagentLifecycleOutput(normalizedName, callId, item.output ?? payload.output, timestamp, mapping, position);
    } else {
      written += this._ingestSubagentLifecycleCall(normalizedName, toolArgs, timestamp, mapping, position, callId);
    }

    return written;
  }

  _ingestSubagentLifecycleOutput(toolName, callId, output, timestamp, mapping, position = {}) {
    if (toolName === 'spawn_agent') {
      const parsed = parseToolArgs(output);
      const agentId = agentIdFromObject(parsed);
      if (!agentId) return 0;
      const spawn = this._subagentSpawnByCallId.get(callId) || {};
      const ingestId = `codex-subagent-start-${mapping.session_id || 'unknown'}-${agentId}`;
      this._subagentStartedAt.set(agentId, timestamp);
      const result = this._insertEvent({
        id: stableEventId(ingestId),
        ingest_id: ingestId,
        timestamp,
        runtime: 'codex',
        session_id: mapping.session_id,
        event_type: 'subagent_start',
        category: 'subagent',
        summary: 'Subagent started',
        duration_ms: null,
        metadata: {
          agent_id: agentId,
          nickname: parsed.nickname || parsed.name || null,
          agent_type: spawn.agent_type || 'default',
          status: 'running',
          description: spawn.description || null,
          source_event: 'response_item',
          source_tool: 'spawn_agent',
          rollout_offset: position.byteOffset ?? null,
          rollout_line: position.lineIndex ?? null
        },
        source: 'rollout',
        confidence: 'actual'
      });
      return result?.inserted ? 1 : 0;
    }

    if (toolName === 'wait_agent') {
      const parsed = parseToolArgs(output);
      const wait = this._subagentWaitByCallId.get(callId) || null;
      let written = 0;
      for (const status of waitAgentStatuses(parsed, wait?.targets || [])) {
        const waitLatencyMs = wait ? elapsedMs(wait.startedAt, timestamp) : null;
        if (status.completed) {
          written += this._insertSubagentStop(status.agentId, timestamp, mapping, 'wait_agent', position, status.summary, {
            waitLatencyMs
          });
        } else if (status.timedOut) {
          written += this._insertSubagentUpdate(status.agentId, timestamp, mapping, 'wait_agent', position, {
            status: 'waiting',
            summary: 'Subagent wait timed out',
            lastActivity: 'Wait timed out',
            waitStartedAt: wait?.startedAt || null,
            waitLatencyMs,
            waitTimeoutMs: wait?.timeoutMs ?? null,
            waitTimedOut: true,
            failureReason: 'wait_timeout'
          });
        }
      }
      return written;
    }

    if (toolName === 'close_agent') {
      const parsed = parseToolArgs(output);
      const agentId = agentIdFromObject(parsed) || agentIdFromObject(parsed.previous_status);
      return agentId ? this._insertSubagentStop(agentId, timestamp, mapping, 'close_agent', position) : 0;
    }

    return 0;
  }

  _ingestSubagentLifecycleCall(toolName, args, timestamp, mapping, position = {}, callId = null) {
    if (toolName === 'send_input') {
      const agentId = agentIdFromObject(args);
      return agentId ? this._insertSubagentUpdate(agentId, timestamp, mapping, 'send_input', position, {
        status: 'running',
        summary: 'Subagent input sent',
        lastActivity: 'Input sent'
      }, callId) : 0;
    }
    if (toolName === 'wait_agent') {
      const targets = subagentTargetsFromArgs(args);
      let written = 0;
      if (callId) {
        this._subagentWaitByCallId.set(callId, {
          startedAt: timestamp,
          targets,
          timeoutMs: numberOrNull(args.timeout_ms ?? args.timeoutMs)
        });
      }
      for (const agentId of targets) {
        written += this._insertSubagentUpdate(agentId, timestamp, mapping, 'wait_agent', position, {
          status: 'waiting',
          summary: 'Waiting for subagent',
          lastActivity: 'Waiting for completion',
          waitStartedAt: timestamp,
          waitTimeoutMs: numberOrNull(args.timeout_ms ?? args.timeoutMs)
        }, callId);
      }
      return written;
    }
    if (toolName !== 'close_agent') return 0;
    const agentId = agentIdFromObject(args);
    return agentId ? this._insertSubagentStop(agentId, timestamp, mapping, 'close_agent', position) : 0;
  }

  _insertSubagentUpdate(agentId, timestamp, mapping, sourceTool, position = {}, opts = {}, callId = null) {
    const positionId = rolloutPositionId('subagent_update', mapping, position);
    const eventKey = callId || `${sourceTool}-${positionId}`;
    const ingestId = `codex-subagent-update-${mapping.session_id || 'unknown'}-${agentId}-${eventKey}`;
    const result = this._insertEvent({
      id: stableEventId(ingestId),
      ingest_id: ingestId,
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      event_type: 'subagent_update',
      category: 'subagent',
      summary: opts.summary || 'Subagent updated',
      duration_ms: null,
      metadata: {
        agent_id: agentId,
        status: opts.status || 'running',
        last_activity: opts.lastActivity || opts.summary || null,
        source_event: 'response_item',
        source_tool: sourceTool,
        rollout_offset: position.byteOffset ?? null,
        rollout_line: position.lineIndex ?? null,
        wait_started_at: opts.waitStartedAt || null,
        wait_latency_ms: opts.waitLatencyMs ?? null,
        wait_timeout_ms: opts.waitTimeoutMs ?? null,
        wait_timed_out: opts.waitTimedOut || false,
        failure_reason: opts.failureReason || null
      },
      source: 'rollout',
      confidence: 'actual'
    });
    return result?.inserted ? 1 : 0;
  }

  _insertSubagentStop(agentId, timestamp, mapping, sourceTool, position = {}, completionSummary = null, opts = {}) {
    const ingestId = `codex-subagent-stop-${mapping.session_id || 'unknown'}-${agentId}`;
    const summary = completionSummary ? `Subagent completed: ${completionSummary}` : 'Subagent completed';
    const durationMs = elapsedMs(this._subagentStartedAt.get(agentId), timestamp);
    const result = this._insertEvent({
      id: stableEventId(ingestId),
      ingest_id: ingestId,
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      event_type: 'subagent_stop',
      category: 'subagent',
      summary,
      duration_ms: durationMs,
      metadata: {
        agent_id: agentId,
        status: 'completed',
        completion_summary: completionSummary,
        wait_latency_ms: opts.waitLatencyMs ?? null,
        source_event: 'response_item',
        source_tool: sourceTool,
        rollout_offset: position.byteOffset ?? null,
        rollout_line: position.lineIndex ?? null
      },
      source: 'rollout',
      confidence: 'actual'
    });
    if (result?.inserted) this._subagentStartedAt.delete(agentId);
    return result?.inserted ? 1 : 0;
  }

  _ingestMessage(item, payload, timestamp, mapping, position = {}) {
    const textBlocks = Array.isArray(item.content)
      ? item.content
        .filter(c => c.type === 'output_text' && c.text?.trim())
        .map(c => c.text.trim())
      : [];
    if (textBlocks.length === 0) return 0;

    const text = textBlocks.join('\n');
    const summary = this._sanitizer.safeAssistantSummary(text, ASSISTANT_MESSAGE_SUMMARY_LIMIT);
    if (!summary) return 0;
    const ingestId = this._messageIngestId(item.role, mapping.session_id, timestamp, summary);
    const event = {
      id: stableEventId(ingestId),
      ingest_id: ingestId,
      timestamp,
      runtime: 'codex',
      session_id: mapping.session_id,
      event_type: 'assistant_message',
      category: 'assistant',
      summary,
      duration_ms: null,
      metadata: {
        role: item.role,
        phase: payload.phase || item.phase || null,
        content_types: [...new Set(item.content.map(c => c.type).filter(Boolean))],
        rollout_offset: position.byteOffset ?? null,
        rollout_line: position.lineIndex ?? null
      },
      source: 'rollout',
      confidence: 'actual'
    };

    const result = this._insertEvent(event);
    return result?.inserted ? 1 : 0;
  }

  _insertEvent(event) {
    const result = this.store.insertEvent(event);
    if (result?.inserted && this._onEvent) {
      this._onEvent(event);
    }
    return result;
  }

  _messageIngestId(role, sessionId, timestamp, text) {
    const hash = crypto.createHash('sha256')
      .update(`${sessionId || 'unknown'}\n${timestamp || ''}\n${text}`)
      .digest('hex')
      .slice(0, 24);
    return `codex-${role || 'message'}-${sessionId || 'unknown'}-${hash}`;
  }

  _summarizeToolCall(name, args) {
    if (!name) return 'Tool call';
    if (name === 'apply_patch') return summarizePatchCall(args);
    const toolArgs = parseToolArgs(args);
    const normalizedName = normalizeToolName(name);
    if (normalizedName === 'send_input') return `Send input to subagent: ${shortAgentId(toolArgs.target || toolArgs.id)}`;
    if (normalizedName === 'wait_agent') {
      const targets = subagentTargetsFromArgs(toolArgs);
      return targets.length === 1 ? `Wait for subagent: ${shortAgentId(targets[0])}` : 'Wait for subagents';
    }
    if (normalizedName === 'close_agent') return `Close subagent: ${shortAgentId(toolArgs.target || toolArgs.id)}`;
    if (normalizedName === 'spawn_agent') return `Start subagent${toolArgs.agent_type ? `: ${toolArgs.agent_type}` : ''}`;
    if (normalizedName === 'write_stdin') return summarizeShellContinuation(toolArgs);
    if (name === 'exec_command' || name === 'functions.exec_command') {
      return summarizeShellCommand(toolArgs);
    }
    return name.replace(/^functions\./, '');
  }

  _resolveModelPrice(model, serviceTier = 'standard') {
    if (!model) return null;
    const prices = modelPricesForRuntime(this.config, 'codex', serviceTier);
    // Built-in IDs stay exact/date even after Settings materializes their rows
    // in config. Custom keys retain the legacy prefix contract in either tier.
    const matches = Object.keys(prices).filter(prefix => model === prefix ||
      (!BUILTIN_CODEX_MODEL_IDS.has(prefix) && model.startsWith(prefix)) ||
      (model.startsWith(`${prefix}-`) && /^\d{4}-\d{2}-\d{2}$/.test(model.slice(prefix.length + 1))));
    matches.sort((a, b) => b.length - a.length);
    return matches.length ? prices[matches[0]] : null;
  }

  _calculateCost(usage, price, hasRequestUsage = true) {
    if (!price) return null;
    if (hasRequestUsage && price.longContext && usage.input > price.longContext.inputTokenThreshold) {
      price = price.longContext;
    }
    const uncachedInput = Math.max(usage.input - usage.cache_read - usage.cache_creation, 0);
    const input = uncachedInput * price.input / PER_MTOK;
    const output = usage.output * price.output / PER_MTOK;
    const cacheRead = usage.cache_read * price.cacheRead / PER_MTOK;
    const cacheCreation = usage.cache_creation * price.cacheCreation / PER_MTOK;
    return input + output + cacheRead + cacheCreation;
  }

  _clearRuntimeInfo(sessionId) {
    this._updateRuntimeInfo({ sessionId: sessionId ?? null, replace: true });
  }

  _updateRuntimeInfo({ sessionId, model, serviceTier, effort, cliVersion, timestamp, replace = false }) {
    const prev = this._runtimeInfo;
    const sessionChanged = sessionId && prev?.session_id && sessionId !== prev.session_id;
    const next = replace || sessionChanged ? {} : { ...(prev || {}) };
    let hasUpdate = replace;
    if (replace || sessionChanged || serviceTier !== undefined) next.service_tier = serviceTier ?? null;
    if (replace || sessionChanged || effort !== undefined) next.reasoning_effort = effort ?? null;
    if (model != null) {
      next.model = model;
      next.model_id = model;
      hasUpdate = true;
    }
    if (sessionId != null || replace) {
      next.session_id = sessionId;
      hasUpdate = true;
    }
    if (serviceTier != null) {
      next.service_tier = serviceTier;
      hasUpdate = true;
    }
    if (cliVersion != null) {
      next.cli_version = cliVersion;
      hasUpdate = true;
    }
    if (!hasUpdate) return;
    next.updated_at = timestamp || new Date().toISOString();
    if (
      prev?.model_id === next.model_id &&
      prev?.session_id === next.session_id &&
      prev?.service_tier === next.service_tier &&
      prev?.reasoning_effort === next.reasoning_effort &&
      prev?.cli_version === next.cli_version
    ) {
      this._runtimeInfo = { ...prev, updated_at: next.updated_at };
      return;
    }
    this._runtimeInfo = next;
    if (this._onRuntimeInfo) this._onRuntimeInfo(next);
  }

  _getTranscriptMetadata(transcriptPath) {
    const stat = fs.statSync(transcriptPath);
    const cached = this._metadataByPath.get(transcriptPath);
    if (cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs && cached.ino === stat.ino) return cached;

    const metadata = { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, ino: stat.ino };
    try {
      const text = fs.readFileSync(transcriptPath, 'utf8');
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === 'turn_context') {
          metadata.model = event.payload?.model || undefined;
          metadata.serviceTier = runtimeServiceTier(event.payload?.service_tier ?? event.payload?.serviceTier);
          metadata.effort = runtimeEffort(event.payload || {});
          metadata.modelTimestamp = event.timestamp || null;
        }
        if (event.type === 'session_meta' && event.payload?.cli_version) {
          metadata.cliVersion = event.payload.cli_version;
          metadata.cliVersionTimestamp = event.timestamp || null;
        }
        if (event.type === 'event_msg' && event.payload?.type === 'token_count' && event.payload.rate_limits) {
          metadata.rateLimits = event.payload.rate_limits;
          metadata.rateLimitTimestamp = event.timestamp || event.payload.timestamp || null;
        }
      }
    } catch {
      // Missing metadata is non-fatal; token and context metrics can still be recorded.
    }

    this._metadataByPath.set(transcriptPath, metadata);
    return metadata;
  }

  _backfillRateLimits(mapping, sessionMeta) {
    return 0;
  }
}

function runtimeServiceTier(value) {
  return value === 'priority' || value === 'standard' ? value : null;
}

function runtimeEffort(payload) {
  const value = payload.effort ?? payload.reasoning_effort;
  return typeof value === 'string' && value.trim() ? value : null;
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function rateLimitDimensions(limit) {
  if (!limit || typeof limit !== 'object') return null;
  const value = numberOrNull(limit.percent_used ?? limit.usage_pct ?? limit.used_percent);
  if (value == null) return null;
  return {
    value,
    window_minutes: limit.window_minutes ?? null,
    resets_at: limit.resets_at ?? null
  };
}

function applyRateLimitDimensions(dimensions, rateLimits) {
  for (const limit of [rateLimits?.primary, rateLimits?.secondary]) {
    const rate = rateLimitDimensions(limit);
    if (!rate) continue;

    if (Number(rate.window_minutes) === 300) {
      dimensions.rate_limit = rate.value;
      dimensions.rate_limit_window_minutes = rate.window_minutes;
      dimensions.rate_limit_resets_at = rate.resets_at;
    } else if (Number(rate.window_minutes) === 10080) {
      dimensions.rate_limit_7d = rate.value;
      dimensions.rate_limit_7d_window_minutes = rate.window_minutes;
      dimensions.rate_limit_7d_resets_at = rate.resets_at;
    }
  }
}

function stableEventId(seed) {
  return crypto.createHash('sha256')
    .update(String(seed))
    .digest('hex');
}

function rolloutPositionId(kind, mapping, position = {}) {
  const transcriptPath = mapping?.transcript_path || 'unknown';
  const sessionId = mapping?.session_id || 'unknown';
  const byteOffset = Number.isFinite(position.byteOffset) ? position.byteOffset : 'unknown';
  const lineIndex = Number.isFinite(position.lineIndex) ? position.lineIndex : 'unknown';
  const hash = crypto.createHash('sha256')
    .update(`${kind}\n${sessionId}\n${transcriptPath}\n${byteOffset}\n${lineIndex}`)
    .digest('hex')
    .slice(0, 24);
  return `${kind}-${sessionId}-${byteOffset}-${lineIndex}-${hash}`;
}

function timestampForEvent(event) {
  return event.timestamp || event.payload?.timestamp || new Date().toISOString();
}

function elapsedMs(startedAt, endedAt) {
  if (!startedAt || !endedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = new Date(endedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return end - start;
}

function normalizeUsage(usage) {
  return {
    input: numberOrNull(usage.input_tokens) || 0,
    output: numberOrNull(usage.output_tokens) || 0,
    cache_read: numberOrNull(usage.cached_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.cache_read_input_tokens) || 0,
    cache_creation: numberOrNull(usage.cache_write_input_tokens ?? usage.input_tokens_details?.cache_write_tokens ?? usage.cache_creation_input_tokens) || 0,
    reasoning: numberOrNull(usage.reasoning_output_tokens ?? usage.reasoning_tokens) || 0
  };
}

function parseToolArgs(args) {
  if (!args) return {};
  if (typeof args === 'object') return args;
  if (typeof args !== 'string') return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

function normalizeToolName(name) {
  if (!name || typeof name !== 'string') return '';
  return name.replace(/^functions\./, '');
}

function summarizeShellContinuation(args) {
  const sessionId = args?.session_id != null ? String(args.session_id) : null;
  const chars = typeof args?.chars === 'string' ? args.chars : '';
  const hasInput = chars.length > 0;
  const action = hasInput ? 'Continue shell session' : 'Wait for command output';
  return sessionId ? `${action}: ${sessionId}` : action;
}

function subagentTargetFromArgs(toolName, args) {
  if (toolName === 'send_input') return agentIdFromObject(args);
  if (toolName === 'close_agent') return agentIdFromObject(args);
  const targets = subagentTargetsFromArgs(args);
  if (toolName === 'wait_agent' && targets?.length === 1) return targets[0];
  return null;
}

function subagentTargetsFromArgs(args) {
  if (!args || typeof args !== 'object') return [];
  const values = [];
  if (Array.isArray(args.targets)) values.push(...args.targets);
  if (Array.isArray(args.ids)) values.push(...args.ids);
  if (Array.isArray(args.agent_ids)) values.push(...args.agent_ids);
  if (Array.isArray(args.agentIds)) values.push(...args.agentIds);
  values.push(args.target, args.id, args.agent_id, args.agentId);
  return uniqueStrings(values);
}

function waitAgentStatuses(output, fallbackTargets = []) {
  const statuses = new Map();
  if (!output || typeof output !== 'object') return [];
  const parentTimedOut = Boolean(output.timed_out || output.timedOut);
  const add = (record) => {
    if (!record?.agentId || (!record.completed && !record.timedOut)) return;
    const key = `${record.agentId}:${record.completed ? 'completed' : 'timeout'}`;
    statuses.set(key, record);
  };

  const collectStatus = (value, fallbackAgentId = null) => {
    if (Array.isArray(value)) {
      for (const entry of value) collectStatus(entry);
      return;
    }
    if (!value || typeof value !== 'object') {
      if (fallbackAgentId) add(normalizeWaitStatus(fallbackAgentId, value, parentTimedOut));
      return;
    }
    const agentId = agentIdFromObject(value) || fallbackAgentId;
    if (agentId) add(normalizeWaitStatus(agentId, value, parentTimedOut));
    if (value.status && typeof value.status === 'object' && !Array.isArray(value.status)) {
      for (const [nestedAgentId, nestedValue] of Object.entries(value.status)) {
        add(normalizeWaitStatus(nestedAgentId, nestedValue, parentTimedOut));
      }
    }
  };

  if (Array.isArray(output.status)) {
    collectStatus(output.status);
  } else if (output.status && typeof output.status === 'object') {
    for (const [agentId, value] of Object.entries(output.status)) {
      add(normalizeWaitStatus(agentId, value, parentTimedOut));
    }
  } else {
    collectStatus(output);
  }

  if (output.completed && typeof output.completed === 'object' && !Array.isArray(output.completed)) {
    for (const [agentId, value] of Object.entries(output.completed)) {
      add({
        agentId,
        completed: true,
        timedOut: false,
        summary: summarizeCompletion(value)
      });
    }
  } else if (output.completed && fallbackTargets.length === 1) {
    add({
      agentId: fallbackTargets[0],
      completed: true,
      timedOut: false,
      summary: summarizeCompletion(output.completed)
    });
  }

  if (parentTimedOut) {
    for (const agentId of fallbackTargets) {
      add({
        agentId,
        completed: false,
        timedOut: true,
        summary: null
      });
    }
  }

  return [...statuses.values()];
}

function normalizeWaitStatus(agentId, value, parentTimedOut) {
  if (!agentId) return null;
  if (value && typeof value === 'object') {
    const state = String(value.status || value.state || '').toLowerCase();
    const completedValue = Object.prototype.hasOwnProperty.call(value, 'completed')
      ? value.completed
      : completionValueFromState(state, value);
    const completed = completedValue != null;
    const timedOut = Boolean(parentTimedOut || value.timed_out || value.timedOut || state === 'timeout' || state === 'timed_out');
    return {
      agentId,
      completed,
      timedOut: completed ? false : timedOut,
      summary: completed ? summarizeCompletion(completedValue) : null
    };
  }
  const state = String(value || '').toLowerCase();
  const completed = ['completed', 'complete', 'done', 'success', 'succeeded'].includes(state);
  const timedOut = parentTimedOut || state === 'timeout' || state === 'timed_out';
  return {
    agentId,
    completed,
    timedOut: completed ? false : timedOut,
    summary: null
  };
}

function completionValueFromState(state, value) {
  if (!['completed', 'complete', 'done', 'success', 'succeeded'].includes(state)) return null;
  return value.summary || value.message || value.result || value.output || value.status || true;
}

function agentIdFromObject(value) {
  if (!value || typeof value !== 'object') return null;
  return firstString(value.target, value.id, value.agent_id, value.agentId);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function uniqueStrings(values) {
  const result = [];
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || seen.has(value)) continue;
    result.push(value);
    seen.add(value);
  }
  return result;
}

function summarizeCompletion(value) {
  if (typeof value === 'string') return truncateText(redactCredentials(value.trim().replace(/\s+/g, ' ')), 160);
  if (value && typeof value === 'object') {
    const text = value.summary || value.message || value.status || null;
    if (typeof text === 'string') return truncateText(redactCredentials(text.trim().replace(/\s+/g, ' ')), 160);
  }
  return null;
}

function shortAgentId(agentId) {
  return agentId ? String(agentId).slice(0, 12) : 'unknown';
}

function truncateText(text, limit) {
  if (typeof text !== 'string' || text.length <= limit) return text;
  return text.slice(0, limit - 3) + '...';
}

function summarizePatchCall(args) {
  const patch = typeof args === 'string' ? args : args?.input || args?.patch || '';
  const files = extractPatchFiles(patch);
  return files.length > 0 ? `Edit files: ${files.join(', ')}` : 'Edit files';
}

function summarizeShellCommand(args) {
  const cmd = typeof args === 'string' ? args : args?.cmd || args?.command || '';
  if (!cmd || typeof cmd !== 'string') return 'Run shell command';
  const line = firstCommandLine(cmd);
  const fullCommand = cmd.replace(/\s+/g, ' ').trim();
  const readable = readableCommand(line);
  if (/^git\s+diff\s+--check\b/.test(line) ||
      /^node\s+--check\b/.test(line) ||
      /(?:playwright|puppeteer)/i.test(fullCommand)) {
    return `Run verification: ${browserCheckSummary(fullCommand) || readable}`;
  }
  if (/^(npm|pnpm|yarn)\s+(test|run\s+(test|check|lint|smoke|ci))\b/.test(line) ||
      /^node\s+--test\b/.test(line) ||
      /^go\s+test\b/.test(line) ||
      /^make\s+(test|ci|check|smoke)\b/.test(line)) {
    return `Run verification: ${readable}`;
  }
  if (/^git\s+(status|log|show|branch|diff)\b/.test(line)) return `Inspect git state: ${readable}`;
  if (/^git\s+(push|commit|merge|rebase|fetch|pull)\b/.test(line)) return `Update git branch: ${readable}`;
  if (/^(rg|grep|find|ls|sed|cat|nl|wc)\b/.test(line)) return `Inspect files: ${readable}`;
  if (/^pm2\s+(restart|reload|start|stop)\b/.test(line)) return `Restart service: ${readable}`;
  if (/^pm2\s+(status|list|logs|describe)\b/.test(line)) return `Check service status: ${readable}`;
  if (/^(curl|wget)\b/.test(line)) return `Check HTTP endpoint: ${readable}`;
  if (/^sqlite3\b/.test(line)) return `Inspect database: ${readable}`;
  if (/^gh\s+pr\b/.test(line)) return `Check pull request: ${readable}`;
  if (/^zylos\s+(upgrade|install|runtime|restart)\b/.test(line)) return `Update Zylos runtime: ${readable}`;
  return `Run shell command: ${readable}`;
}

function browserCheckSummary(cmd) {
  if (!/(?:playwright|puppeteer)/i.test(cmd)) return null;
  if (/screenshot/i.test(cmd)) return 'browser screenshot check';
  if (/(?:getBoundingClientRect|evaluate|locator|page\.)/i.test(cmd)) return 'browser render check';
  return 'browser check';
}

function firstCommandLine(cmd) {
  let line = cmd.split('\n').map(l => l.trim()).find(l => l && !l.startsWith('#')) || '';
  line = line.replace(/^cd\s+\S+\s*&&\s*/i, '');
  line = line.replace(/^export\s+\$\([^)]*\)\s*&&\s*/i, '');
  const pipeIdx = line.indexOf('|');
  if (pipeIdx > 0) line = line.slice(0, pipeIdx).trim();
  return line;
}

function readableCommand(line) {
  const redacted = redactCredentials(line)
    .replace(/(?<=^|[\s"'=])(?:\/(?:home|Users|tmp|var|usr|opt|etc|root)(?:\/[^\s"'|;:]+){3,}|~(?:\/[^\s"'|;:]+){3,})/g, shortenPath);
  return redacted.length > 120 ? redacted.slice(0, 117) + '...' : redacted;
}

function extractPatchFiles(patch) {
  if (typeof patch !== 'string' || !patch) return [];
  const files = [];
  const seen = new Set();
  const patterns = [
    /^\*\*\* (?:Add|Update|Delete) File:\s+(.+)$/gm,
    /^\*\*\* Move to:\s+(.+)$/gm
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(patch)) !== null) {
      const file = shortenPath(match[1].trim());
      if (file && !seen.has(file)) {
        files.push(file);
        seen.add(file);
      }
      if (files.length >= 3) return files;
    }
  }
  return files;
}

function shortenPath(fullPath) {
  const normalized = String(fullPath).replace(/^["']|["']$/g, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return parts.slice(-3).join('/');
}

function redactCredentials(text) {
  return text
    .replace(/sk-[a-zA-Z0-9_-]{20,}/g, '[REDACTED]')
    .replace(/xoxb-[a-zA-Z0-9-]+/g, '[REDACTED]')
    .replace(/ghp_[a-zA-Z0-9]{36,}/g, '[REDACTED]')
    .replace(/Bearer\s+[a-zA-Z0-9._-]+/g, 'Bearer [REDACTED]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]');
}
