import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fastModeMultiplierForRuntime, modelPricesForRuntime } from '../config.js';
import { Sanitizer } from '../sanitizer.js';
import { UsageTranscripts, groupMainTranscript } from './usage-transcripts.js';
import { sameSourceFile } from '../source-file-identity.js';

const PER_MTOK = 1_000_000;
const ASSISTANT_MESSAGE_SUMMARY_LIMIT = 500;

// What a cache write costs, as a multiple of the model's own input price:
// 5-minute TTL is 1.25x input, 1-hour TTL is 2x. Derived from `input` instead
// of tabulated per model on purpose — a per-model 5m column would drift out of
// step the next time an input price changes, which is exactly how the single
// `cacheCreation` column came to bill every write at the 1-hour rate. Cache
// *reads* have model-specific rates in their own `cacheRead` column.
const CACHE_WRITE_INPUT_MULTIPLIER = {
  ephemeral_5m_input_tokens: 1.25,
  ephemeral_1h_input_tokens: 2
};

export class ConversationCollector {
  constructor(store, config, { transcripts, getSnapshot } = {}) {
    this.store = store;
    this.config = config;
    this.transcripts = transcripts || new UsageTranscripts(store, config, { getSnapshot });
    this._timer = null;
    this._offsets = new Map();
    this._seenUuids = new Set();
    this._onEvent = null;
    this._onMetric = null;
    this._lastUserPromptAt = null;
    this._sanitizer = config.sanitizer || new Sanitizer(config.zylosDir || path.join(process.env.HOME, 'zylos'));
  }

  // A single API response is written to the transcript as one line per content
  // block (thinking / text / tool_use), so 2-5 lines share the same requestId
  // and message.id and each carry a COPY of the whole response's usage. The
  // usage must therefore be attributed per request, not per line — keying on
  // uuid (the line's identity) bills one response 2-5 times over.
  _requestKeyFor(msg) {
    return msg.requestId || msg.message?.id || msg.uuid || null;
  }

  _findUsageByRequestKey(requestKey) {
    try {
      const row = this.store.db.prepare(
        `SELECT id, timestamp, session_id, metric_value, dimensions FROM metric_points
         WHERE source = 'jsonl_usage' AND metric_name = 'usage_event'
           AND json_extract(dimensions, '$.request_id') = ?
         LIMIT 1`
      ).get(requestKey);
      if (!row) return null;
      let dimensions = null;
      try { dimensions = row.dimensions ? JSON.parse(row.dimensions) : null; } catch { /* keep null */ }
      return { ...row, dimensions };
    } catch { return null; }
  }

  _resolveModelPrice(model) {
    if (!model) return null;
    const prices = modelPricesForRuntime(this.config, 'claude');
    // A specific model (including a configured override) must win over its
    // family prefix, regardless of the table's insertion order.
    let matchedPrefix = null;
    for (const prefix of Object.keys(prices)) {
      if (model.startsWith(prefix) && (matchedPrefix === null || prefix.length > matchedPrefix.length)) {
        matchedPrefix = prefix;
      }
    }
    return matchedPrefix === null ? null : prices[matchedPrefix];
  }

  // Cache writes are billed by the TTL that was requested, so a single
  // cache_creation figure cannot be priced correctly. The transcript records
  // both a flat total and a nested per-TTL breakdown; prefer the breakdown.
  // Without one the TTL is not knowable from the line, so the write keeps the
  // pre-split 1-hour treatment rather than being guessed at.
  static _cacheCreationTokensByTtl(usage) {
    const flat = usage.cache_creation_input_tokens || 0;
    const breakdown = usage.cache_creation;
    if (!breakdown || typeof breakdown !== 'object') return { untyped: flat };

    const byTtl = {};
    let typed = 0;
    for (const key of Object.keys(CACHE_WRITE_INPUT_MULTIPLIER)) {
      const tokens = breakdown[key] || 0;
      if (tokens > 0) byTtl[key] = tokens;
      typed += tokens;
    }
    // A TTL class this build does not know about must not silently drop off the
    // bill. Charge the remainder at the 1-hour rate — the most expensive of the
    // known writes — so an unrecognised TTL over-reports rather than under.
    const untyped = flat - typed;
    if (untyped > 0) byTtl.untyped = untyped;
    return byTtl;
  }

  // Returns price-weighted tokens (per MTOK, un-scaled) so the caller keeps
  // ownership of the fast-mode multiplier and the PER_MTOK division.
  _cacheCreationRate(usage, price) {
    const byTtl = ConversationCollector._cacheCreationTokensByTtl(usage);
    let weighted = 0;
    for (const [ttl, tokens] of Object.entries(byTtl)) {
      const inputMultiple = CACHE_WRITE_INPUT_MULTIPLIER[ttl];
      weighted += inputMultiple != null && price.input != null
        ? tokens * price.input * inputMultiple
        : tokens * (price.cacheCreation || 0);
    }
    return weighted;
  }

  _calculateCost(usage, price, speed) {
    if (!price) return null;
    const multiplier = speed === 'fast' ? (fastModeMultiplierForRuntime(this.config, 'claude', price) || 6) : 1;
    const input = (usage.input_tokens || 0) * price.input * multiplier / PER_MTOK;
    const output = (usage.output_tokens || 0) * price.output * multiplier / PER_MTOK;
    const cacheRead = (usage.cache_read_input_tokens || 0) * price.cacheRead * multiplier / PER_MTOK;
    const cacheCreation = this._cacheCreationRate(usage, price) * multiplier / PER_MTOK;
    return input + output + cacheRead + cacheCreation;
  }

  async collect() {
    let messages = 0;
    const written = await this.transcripts.collect('claude', (mapping, originCurrent) => {
      const file = mapping.transcript_path;
      this._offsets.set(file, mapping.byte_offset);
      this._seenUuids.clear();
      try {
        const written = this._collectFile(file, {
        sessionId: mapping.session_id, group: mapping.session_group, runId: mapping.run_id,
        agentId: mapping.parent_path ? path.basename(file, '.jsonl').replace(/^agent-/, '') : null,
        usageOnly: Boolean(mapping.parent_path) || !originCurrent && !groupMainTranscript(mapping),
        origin: originCurrent,
        });
        messages += this._lastFileMessages;
        return { written, byteOffset: this._offsets.get(file) };
      } finally {
        this._offsets.delete(file);
      }
    });
    if (messages > 0) {
      this.store.upsertSourceHealth('conversation_reader', 'collector_liveness', 'healthy', {
        last_success: new Date().toISOString(), messages_ingested: messages,
      });
    }
    return written;
  }

  // Assistant words of other groups' main transcripts are stored for their conversation pages but never reach the
  // origin state engine or the origin turn timing.
  _collectFile(jsonlPath, options = {}) {
    let identity;
    try { identity = fs.statSync(jsonlPath); } catch { return 0; }
    return this.store.db.transaction(() => {
      if (!sameSourceFile(jsonlPath, identity)) return 0;
      return this._collectCurrentFile(jsonlPath, options);
    }).immediate();
  }

  _collectCurrentFile(jsonlPath, { sessionId = null, agentId = null, usageOnly = false, group = null, runId = null, origin = true } = {}) {
    this._lastFileMessages = 0;
    const startOffset = this._offsets.get(jsonlPath) || 0;

    let stat;
    try { stat = fs.statSync(jsonlPath); } catch { return 0; }
    if (stat.size <= startOffset) return 0;

    const buf = Buffer.alloc(stat.size - startOffset);
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, startOffset);
    } finally {
      fs.closeSync(fd);
    }

    const chunk = buf.toString('utf8');
    const lastNewline = chunk.lastIndexOf('\n');
    if (lastNewline === -1) return 0;
    const consumed = Buffer.byteLength(chunk.slice(0, lastNewline + 1), 'utf8');

    // Each line with its byte offset in the file, which names a queued message's removal when nothing else does.
    const lines = [];
    let position = startOffset;
    for (const text of chunk.slice(0, lastNewline).split('\n')) {
      if (text.trim()) lines.push({ text, offset: position });
      position += Buffer.byteLength(text, 'utf8') + 1;
    }

    let written = 0;
    let usageWritten = 0;
    const now = new Date().toISOString();

    for (const { text: line, offset } of lines) {
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      // A message the runtime takes from its own queue after a turn starts work without any hook event; this line is
      // the only record of it, so the Dashboard sees the main agent taking new input after it stopped. A message
      // typed into the session and taken into the turn still running leaves the queue as a `remove` line instead,
      // which is recorded so the message is not taken for one still waiting there; a subtask's report taken that way
      // is not a typed message and is left out. The queued text is only checked for that, never stored. A subtask's
      // own transcript is always read usage-only, so only the main agent's transcript records them.
      if (msg.type === 'queue-operation') {
        const type = { dequeue: 'input_dequeue', remove: 'input_remove' }[msg.operation];
        const report = msg.operation === 'remove' && typeof msg.content === 'string' && msg.content.startsWith('<task-notification>');
        // Several messages taken into a turn at once leave the queue in the same millisecond: each removal is told
        // apart by the queued command's id, or by its line when it has none.
        const removal = msg.operation === 'remove' ? (typeof msg.commandUuid === 'string' && msg.commandUuid ? msg.commandUuid : `@${offset}`) : null;
        if (type && !report && !usageOnly) written += this._ingestQueue(type, msg.timestamp, msg.sessionId || sessionId, group, runId, removal);
        continue;
      }

      const uuid = msg.uuid;
      if (!uuid || this._seenUuids.has(uuid)) continue;
      this._seenUuids.add(uuid);

      const timestamp = msg.timestamp || now;
      // Subagent records carry their own sessionId. Bill them to the parent
      // session or their spend never rolls up into the session total the
      // statusline reports.
      const rowSessionId = agentId ? sessionId : (msg.sessionId || sessionId);

      if (msg.type === 'user') {
        if (usageOnly || !origin) continue;
        const userContent = msg.message?.content;
        const isToolResult = Array.isArray(userContent) &&
          userContent.every(c => c.type === 'tool_result');
        if (!isToolResult) {
          // turn-start (user_prompt_submit) is emitted by the Claude hook, not
          // from JSONL — emitting here too would double-fire. Keep the timestamp
          // tracking for assistant-message turn-duration computation.
          this._lastUserPromptAt = timestamp;
        }
        continue;
      }

      if (msg.type !== 'assistant') continue;

      const message = msg.message;
      if (!message) continue;

      const content = message.content;
      const usage = message.usage;
      const model = message.model;

      const projects = this._extractProjectsFromContent(content);

      if (usage) {
        const speed = usage.speed || 'standard';
        usageWritten += this._ingestUsage(
          usage, model, rowSessionId, timestamp, uuid, speed, projects,
          this._requestKeyFor(msg), agentId, group, runId
        );
      }

      if (usageOnly || !Array.isArray(content)) continue;

      const textBlocks = content
        .filter(c => c.type === 'text' && c.text?.trim())
        .map(c => c.text.trim());

      if (textBlocks.length === 0) continue;

      const text = textBlocks.join('\n');
      const hasToolUse = content.some(c => c.type === 'tool_use');
      const turnDuration = origin && this._lastUserPromptAt
        ? Math.max(0, new Date(timestamp).getTime() - new Date(this._lastUserPromptAt).getTime())
        : null;

      try {
        const summary = this._sanitizer.safeAssistantSummary(text, ASSISTANT_MESSAGE_SUMMARY_LIMIT);
        if (!summary) continue;
        const event = {
          id: crypto.randomUUID(),
          ingest_id: `conv-${uuid}`,
          timestamp,
          runtime: 'claude',
          session_id: rowSessionId,
          session_group: group,
          run_id: runId,
          event_type: 'assistant_message',
          category: 'assistant',
          summary,
          duration_ms: hasToolUse ? null : turnDuration,
          metadata: JSON.stringify({
            uuid,
            has_tool_use: hasToolUse,
            content_types: [...new Set(content.map(c => c.type))]
          }),
          source: 'conversation',
          confidence: 'actual'
        };
        const result = this.store.insertEvent(event);
        if (result?.inserted) {
          if (origin && this._onEvent) {
            this._onEvent({ ...event, metadata: JSON.parse(event.metadata) });
          }
          written++;
          this._lastFileMessages++;
        }
      } catch (err) {
        if (!err.message?.includes('UNIQUE constraint')) {
          process.stderr.write(`[conversation-collector] ${err.message}\n`);
        }
      }

      if (origin && !hasToolUse) {
        // turn-end (stop) is emitted by the Claude hook, not from JSONL —
        // emitting here too would double-fire. Reset the turn marker.
        this._lastUserPromptAt = null;
      }
    }

    this._offsets.set(jsonlPath, startOffset + consumed);
    return written + usageWritten;
  }

  _ingestQueue(type, timestamp, sessionId, group, runId, removal = null) {
    if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return 0;
    try {
      const result = this.store.insertEvent({
        id: crypto.randomUUID(),
        ingest_id: type === 'input_dequeue' ? `queue-dequeue-${sessionId ?? ''}-${timestamp}` : `queue-remove-${sessionId ?? ''}-${timestamp}-${removal}`,
        timestamp,
        runtime: 'claude',
        session_id: sessionId,
        session_group: group,
        run_id: runId,
        event_type: type,
        category: 'turn',
        metadata: {},
        source: 'conversation',
        confidence: 'actual'
      });
      return result?.inserted ? 1 : 0;
    } catch (err) {
      if (!err.message?.includes('UNIQUE constraint')) process.stderr.write(`[conversation-collector] ${err.message}\n`);
      return 0;
    }
  }

  _ingestUsage(usage, model, sessionId, timestamp, uuid, speed, projects = [], requestKey = null, agentId = null, group = null, runId = null) {
    const inputTokens = usage.input_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheCreation = usage.cache_creation_input_tokens || 0;
    const totalInput = inputTokens + cacheRead + cacheCreation;

    if (totalInput === 0 && outputTokens === 0) return 0;

    const key = requestKey || uuid;
    if (!key) return 0;

    // Store range filters compare ISO text against UTC bounds. Normalize before
    // both insertion and attribution selection so offsets cannot hide a request
    // from its actual hour/day window. Leave invalid input handling unchanged.
    const parsedTimestamp = Date.parse(timestamp);
    if (Number.isFinite(parsedTimestamp)) timestamp = new Date(parsedTimestamp).toISOString();

    // Persist the TTL split, not just the flat total: it is the only record of
    // how a cache write was priced, and it cannot be reconstructed from the
    // total afterwards. Written as explicit zeros whenever the transcript
    // carried a breakdown, so a missing field means "TTL unknown for this row"
    // rather than "zero 5-minute tokens" when inspecting the charged usage.
    const ttlDims = {};
    if (usage.cache_creation && typeof usage.cache_creation === 'object') {
      const byTtl = ConversationCollector._cacheCreationTokensByTtl(usage);
      ttlDims.cache_creation_5m = byTtl.ephemeral_5m_input_tokens || 0;
      ttlDims.cache_creation_1h = byTtl.ephemeral_1h_input_tokens || 0;
      if (byTtl.untyped) ttlDims.cache_creation_unknown_ttl = byTtl.untyped;
    }

    const dims = {
      input: inputTokens,
      total_input: totalInput,
      uncached_input: inputTokens,
      output: outputTokens,
      cache_read: cacheRead,
      cache_creation: cacheCreation,
      runtime_semantics: 'claude_split_cache',
      ...ttlDims,
      model,
      speed,
      request_id: key,
      uuid
    };
    dims.run_id = runId;
    if (agentId) dims.agent_id = agentId;
    if (projects.length > 0) dims.projects = projects;

    const price = this._resolveModelPrice(model);
    const cost = this._calculateCost(usage, price, speed);
    if (cost != null) dims.cost = cost;
    if (totalInput > 0) dims.cache_hit_rate = cacheRead / totalInput;

    const existing = this._findUsageByRequestKey(key);
    if (existing) {
      // Same API response, seen again via another content-block line (or a
      // crash-recovery re-read). Never insert a second row for it. Upsert
      // rather than skip so a later line carrying more complete usage still
      // wins — in observed transcripts the copies are byte-identical, but the
      // collector must not depend on that holding for every response shape.
      this._upsertUsage(existing, dims, totalInput, timestamp, sessionId);
      this.store.updateMetric(existing.id, { session_group: group });
      return 0;
    }

    const point = {
      timestamp, runtime: 'claude', session_id: sessionId, session_group: group,
      metric_name: 'usage_event', metric_value: totalInput,
      dimensions: dims,
      source: 'jsonl_usage', confidence: 'actual'
    };
    this.store.insertMetric(point);
    if (this._onMetric) this._onMetric(point);

    this.store.upsertSourceHealth('jsonl_usage', 'collector_liveness', 'healthy', {
      last_success: timestamp, model, tokens: totalInput + outputTokens
    });
    return 1;
  }

  // Token totals of a usage row, used to decide which copy of one response's
  // usage is the most complete.
  static _usageWeight(dims) {
    if (!dims) return -1;
    return (dims.input || 0) + (dims.output || 0) +
      (dims.cache_read || 0) + (dims.cache_creation || 0);
  }

  _upsertUsage(existing, dims, totalInput, timestamp, sessionId) {
    if (typeof this.store.updateMetric !== 'function') return;

    const prev = existing.dimensions;
    const takeNewUsage = ConversationCollector._usageWeight(dims) >
      ConversationCollector._usageWeight(prev);

    // Projects are extracted per content block, so the tool_use line knows
    // things the thinking line does not. Union them or attribution is lost.
    const mergedProjects = [...new Set([...(prev?.projects || []), ...(dims.projects || [])])];

    const next = takeNewUsage ? { ...prev, ...dims } : { ...dims, ...prev };
    if (mergedProjects.length > 0) next.projects = mergedProjects;
    else delete next.projects;

    const nextValue = takeNewUsage ? totalInput : existing.metric_value;
    // Attribution is independent of usage completeness: a smaller, earlier
    // block may arrive after the final block, even after a collector restart.
    // Compare instants (not ISO strings, which may use different UTC offsets).
    // Equal instants use session then timestamp text as stable tie-breaks.
    const incomingTime = Date.parse(timestamp);
    const previousTime = Date.parse(existing.timestamp);
    const timeOrder = Number.isFinite(incomingTime) && Number.isFinite(previousTime)
      ? incomingTime - previousTime
      : (timestamp < existing.timestamp ? -1 : timestamp > existing.timestamp ? 1 : 0);
    const incomingSession = sessionId || '';
    const previousSession = existing.session_id || '';
    const takeNewAttribution = timeOrder < 0 || (timeOrder === 0 &&
      (incomingSession < previousSession ||
        (incomingSession === previousSession && timestamp < existing.timestamp)));
    const changed = takeNewAttribution ||
      JSON.stringify(next) !== JSON.stringify(prev) || nextValue !== existing.metric_value;
    if (!changed) return;

    // Update the earliest time and its owning session together, without
    // replacing the more complete usage with the earlier block's partial usage.
    this.store.updateMetric(existing.id, {
      metric_value: nextValue, dimensions: next,
      ...(takeNewAttribution ? { timestamp, session_id: sessionId || null } : {})
    });
    if (takeNewUsage) {
      this.store.upsertSourceHealth('jsonl_usage', 'collector_liveness', 'healthy', {
        last_success: timestamp, model: next.model, tokens: nextValue + (next.output || 0)
      });
    }
  }

  _extractProjectsFromContent(content) {
    if (!Array.isArray(content)) return [];
    const projects = new Set();
    for (const block of content) {
      if (block.type !== 'tool_use') continue;
      const fp = block.input?.file_path || block.input?.path;
      if (fp) {
        const project = this._extractProject(fp);
        if (project) projects.add(project);
        continue;
      }
      const cmd = block.input?.command;
      if (cmd) {
        const project = this._extractProjectFromCommand(cmd);
        if (project) projects.add(project);
      }
    }
    return [...projects];
  }

  _extractProject(filePath) {
    if (!filePath) return null;
    const parts = filePath.replace(/^\/+/, '').split('/');
    const wsIdx = parts.indexOf('workspace');
    if (wsIdx >= 0 && parts[wsIdx + 1]) return parts[wsIdx + 1];
    const skillsIdx = parts.indexOf('skills');
    if (skillsIdx >= 0 && parts[skillsIdx + 1]) return parts[skillsIdx + 1];
    return null;
  }

  _extractProjectFromCommand(cmd) {
    if (!cmd) return null;
    const m = cmd.match(/(?:workspace|skills)\/([^/\s]+)/);
    return m ? m[1] : null;
  }

  /** A pass for the timer or for a stop that just arrived: one asked for while another runs joins it. */
  collectShared() {
    this._collecting ??= this.collect().finally(() => { this._collecting = null; });
    return this._collecting;
  }

  /**
   * After new events were imported (`types`, their event types): when a turn ended, the runtime may take a queued
   * message at once, which only its transcript records, so read the transcripts shortly after a stop instead of
   * waiting up to the next timed pass.
   */
  afterImport({ types } = {}, { delayMs = 300, setTimer = setTimeout } = {}) {
    if (!types?.includes('stop') || this._stopTimer) return;
    this._stopTimer = setTimer(() => {
      this._stopTimer = null;
      this.collectShared().catch(error => process.stderr.write(`[conversation-collector] ${error.message}\n`));
    }, delayMs);
    this._stopTimer?.unref?.();
  }

  start(intervalMs = 5_000) {
    this.stop();
    const collect = () => this.collectShared().catch(error => {
      process.stderr.write(`[conversation-collector] ${error.message}\n`);
    });
    collect();
    this._timer = setInterval(collect, intervalMs);
    this._timer.unref();
  }

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
    if (this._stopTimer) { clearTimeout(this._stopTimer); this._stopTimer = null; }
  }
}
