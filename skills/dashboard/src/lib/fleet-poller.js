import { agentColor } from './agent-color.js';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2500;
// Liveness is connection-based (#180): an agent is OFFLINE only when its SSE
// connection is down and polling fails — never because pushed events are
// sparse (an idle agent legitimately emits nothing for long stretches).
// The idle timeout guards against half-open connections: the server emits
// keepalives every 15s, so 45s of byte silence means the connection is dead.
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 45_000;
const DEFAULT_JITTER_MS = 500;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_SLOW_THRESHOLD_MS = 1500;
const DEFAULT_LATENCY_PROBE_INTERVAL_MS = 30_000;
const LATENCY_SAMPLE_LIMIT = 20;
const DEGRADED_PROBE_FAILURES = 2;
const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH']);
const FAILURE_REASONS = new Set(['timeout', 'conn_refused', 'bad_payload', 'auth_failed', 'version_unsupported', 'unreachable']);
const LINK_QUALITIES = new Set(['ok', 'slow', 'degraded', 'stale', 'down']);

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function joinUrl(baseUrl, apiPath) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const path = String(apiPath || '').replace(/^\/+/, '');
  return `${base}/${path}`;
}

function nextCompleteLineBreak(buffer) {
  const match = buffer.match(/\r\n|\r|\n/);
  if (!match) return null;
  if (match[0] === '\r' && match.index === buffer.length - 1) return null;
  return match;
}

export class SseEventParser {
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = '';
    this.event = 'message';
    this.data = [];
    this.id = null;
  }

  push(chunk) {
    this.buffer += chunk;
    let newline = nextCompleteLineBreak(this.buffer);
    while (newline) {
      const newlineIndex = newline.index;
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + newline[0].length);
      this._processLine(line);
      newline = nextCompleteLineBreak(this.buffer);
    }
  }

  flush() {
    if (this.buffer) {
      this.push('\n');
      this.buffer = '';
    }
  }

  _processLine(line) {
    if (line === '') {
      this._dispatch();
      return;
    }
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') this.event = value || 'message';
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
  }

  _dispatch() {
    if (this.data.length === 0) {
      this.event = 'message';
      this.id = null;
      return;
    }
    this.onEvent({
      event: this.event || 'message',
      data: this.data.join('\n'),
      id: this.id
    });
    this.event = 'message';
    this.data = [];
    this.id = null;
  }
}

async function fetchWithTimeout(fetchImpl, url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function metricValue(state, name) {
  const source = state?.metrics?.[name] ?? state?.metric?.[name];
  if (source && typeof source === 'object') {
    return source.value ?? source.current ?? source.percent ?? null;
  }
  return source ?? null;
}

function numberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringOrNull(value) {
  const text = String(value || '').trim();
  return text || null;
}

function memPct(systemMetrics) {
  const explicit = numberOrNull(systemMetrics?.mem_pct ?? systemMetrics?.mem_used_pct);
  if (explicit != null) return explicit;
  const used = numberOrNull(systemMetrics?.mem_used_bytes);
  const total = numberOrNull(systemMetrics?.mem_total_bytes);
  return used != null && total > 0 ? (used / total) * 100 : null;
}

function hasUpgrade(runtimeInfo) {
  return Boolean(
    runtimeInfo?.zylos_update ||
    runtimeInfo?.cc_update ||
    runtimeInfo?.cc_restart ||
    runtimeInfo?.codex_update ||
    runtimeInfo?.codex_restart ||
    runtimeInfo?.pending_restart
  );
}

function hasSubagent(state) {
  return Array.isArray(state?.active_subagents) && state.active_subagents.length > 0;
}

function subagentCount(state) {
  return Array.isArray(state?.active_subagents) ? state.active_subagents.length : 0;
}

function deriveActivity(state) {
  if (state?.running_tools?.length > 0) return state.running_tools[0].tool_detail || state.running_tools[0].tool_name || 'Running tool';
  if (state?.active_subagents?.length > 0) return state.active_subagents[0].last_activity || state.active_subagents[0].description || 'Subagent active';
  // The single-agent view shows the prompt line only transiently; its Current
  // Activity body is the last assistant message. The producer clears
  // last_message on each new prompt, so preferring it here reproduces those
  // semantics: the prompt summary shows only while the turn is still open.
  const msg = state?.last_message;
  const msgText = typeof msg === 'string' ? msg : msg?.text;
  return msgText || state?.last_prompt?.summary || state?.reason || null;
}

// Mirror of the single-agent Current Activity feed (renderToolFeed): running
// tools first, a synthetic "thinking" entry when busy with no visible tool.
// Falls back to [] so consumers can degrade to the single-line `activity`.
function deriveActivityFeed(state) {
  const feed = [];
  const tools = Array.isArray(state?.running_tools) ? state.running_tools : [];
  for (const tool of tools.slice(0, 3)) {
    feed.push({
      kind: 'tool',
      label: tool.tool_detail
        ? `${tool.tool_name || 'tool'}: ${tool.tool_detail}`
        : (tool.tool_name || 'Running tool'),
      started_at: tool.started_at || null
    });
  }
  if (feed.length === 0 && String(state?.state || '').toUpperCase() === 'BUSY') {
    feed.push({ kind: 'thinking', label: null, started_at: null });
  }
  return feed;
}

function percentile95(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? null;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateStatePayload(value) {
  if (!isPlainObject(value) || typeof value.state !== 'string' || value.state.trim() === '') {
    const err = new Error('bad_payload');
    err.reason = 'bad_payload';
    throw err;
  }
  return value;
}

function validateHealthPayload(value) {
  if (!isPlainObject(value)) {
    const err = new Error('bad_payload');
    err.reason = 'bad_payload';
    throw err;
  }
  return value;
}

async function readJsonOrBadPayload(resp, validate = value => value) {
  let body;
  try {
    body = await resp.json();
  } catch {
    const err = new Error('bad_payload');
    err.reason = 'bad_payload';
    throw err;
  }
  return validate(body);
}

function classifyError(err) {
  if (err?.reason) return err.reason;
  if (err?.name === 'AbortError') return 'timeout';
  const code = err?.cause?.code || err?.code;
  if (CONNECTION_ERROR_CODES.has(code)) return 'conn_refused';
  if (Array.isArray(err?.cause?.errors) && err.cause.errors.some(item => CONNECTION_ERROR_CODES.has(item?.code))) {
    return 'conn_refused';
  }
  return 'unreachable';
}

function classifyHttpStatus(resp, { tokenEndpoint = false } = {}) {
  if (resp.status === 401 || resp.status === 403) return 'auth_failed';
  if (tokenEndpoint && resp.status === 404) return 'version_unsupported';
  return 'unreachable';
}

function reasonError(reason) {
  const err = new Error(reason);
  err.reason = reason;
  return err;
}

function sanitizeLink(link) {
  const quality = LINK_QUALITIES.has(link?.quality) ? link.quality : 'ok';
  return {
    latency_ms: numberOrNull(link?.latency_ms),
    latency_p95_ms: numberOrNull(link?.latency_p95_ms),
    sampled_at: stringOrNull(link?.sampled_at),
    quality,
    reason: stringOrNull(link?.reason)
  };
}

function sanitizeRecord(record) {
  return {
    name: record.name,
    color: record.color,
    hue: record.hue,
    state: record.state,
    activity: record.activity,
    activity_feed: Array.isArray(record.activity_feed) ? record.activity_feed : [],
    rate_limit_pct: record.rate_limit_pct ?? null,
    rate_limit_7d_pct: record.rate_limit_7d_pct ?? null,
    context_pct: record.context_pct,
    cost: record.cost,
    session_cost: record.session_cost,
    daily_cost: record.daily_cost,
    weekly_cost: record.weekly_cost,
    model: record.model,
    effort: record.effort,
    new_session_threshold: record.new_session_threshold,
    cpu_pct: record.cpu_pct,
    mem_pct: record.mem_pct,
    disk_pct: record.disk_pct,
    has_upgrade: record.has_upgrade === true,
    has_subagent: record.has_subagent === true,
    subagent_count: Number.isFinite(record.subagent_count) ? record.subagent_count : 0,
    last_seen: record.last_seen,
    pulse_rate: record.pulse_rate,
    health_reason: record.health_reason,
    link: sanitizeLink(record.link),
    updated_at: record.updated_at,
    base_url: record.base_url,
    self: record.self === true,
    access: record.access === 'admin' ? 'admin' : 'read'
  };
}

export function stateToFleetRecord(agentConfig = {}, statePayload = {}, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const self = opts.self === true;
  const name = agentConfig.name ?? statePayload?.agent?.name;
  // Identity color/hue is keyed to the name DISPLAYED on this wall (local
  // fleet config), never the remote's self-reported identity: an unconfigured
  // remote falls back to a hostname-derived hue that can collide with other
  // tiles (issue: Jinglever's hostname hashed to ~the same hue as zylos-01).
  const color = agentConfig.color?.color
    ? agentConfig.color
    : {
        color: agentConfig.color || agentColor(name).color,
        hue: agentConfig.hue ?? agentColor(name).hue
      };
  const runtimeInfo = statePayload?.runtime_info || null;
  const systemMetrics = statePayload?.system_metrics || null;
  const liveState = statePayload?.state || 'UNKNOWN';
  const offline = liveState === 'OFFLINE' || liveState === 'UNKNOWN';
  const pulseRate = self && offline ? 0 : 1;
  const healthReason = liveState === 'IDLE' ? 'idle' : (self && offline ? 'offline' : 'ok');
  return sanitizeRecord({
    name,
    base_url: opts.base_url ?? agentConfig.base_url ?? null,
    color: color?.color,
    hue: color?.hue,
    state: liveState,
    activity: deriveActivity(statePayload),
    activity_feed: deriveActivityFeed(statePayload),
    rate_limit_pct: statePayload?.rate_limit_pct ?? null,
    rate_limit_7d_pct: statePayload?.rate_limit_7d_pct ?? null,
    context_pct: statePayload?.context_pct ?? metricValue(statePayload, 'context_pct'),
    cost: statePayload?.session_cost ?? statePayload?.daily_cost ?? statePayload?.weekly_cost ?? metricValue(statePayload, 'session_cost') ?? metricValue(statePayload, 'daily_cost'),
    session_cost: statePayload?.session_cost ?? metricValue(statePayload, 'session_cost'),
    daily_cost: statePayload?.daily_cost ?? metricValue(statePayload, 'daily_cost'),
    weekly_cost: statePayload?.weekly_cost ?? null,
    model: runtimeInfo?.model || runtimeInfo?.model_id || null,
    effort: runtimeInfo?.effort || null,
    new_session_threshold: statePayload?.new_session_threshold ?? null,
    cpu_pct: numberOrNull(systemMetrics?.cpu_pct),
    mem_pct: memPct(systemMetrics),
    disk_pct: numberOrNull(systemMetrics?.disk_pct ?? systemMetrics?.disk_used_pct),
    has_upgrade: hasUpgrade(runtimeInfo),
    has_subagent: hasSubagent(statePayload),
    subagent_count: subagentCount(statePayload),
    last_seen: nowIso(nowMs),
    pulse_rate: pulseRate,
    health_reason: healthReason,
    link: sanitizeLink(opts.link),
    updated_at: nowIso(nowMs),
    self,
    access: opts.access
  });
}

export class FleetPoller {
  constructor(config = {}, options = {}) {
    const fleet = config.fleet || {};
    this.agents = Array.isArray(fleet.agents) ? fleet.agents : [];
    this.pollIntervalMs = toNumber(fleet.poll_interval_ms, DEFAULT_POLL_INTERVAL_MS);
    this.timeoutMs = toNumber(fleet.timeout_ms, DEFAULT_TIMEOUT_MS);
    this.sseIdleTimeoutMs = toNumber(fleet.sse_idle_timeout_ms, DEFAULT_SSE_IDLE_TIMEOUT_MS);
    this.jitterMs = toNumber(fleet.jitter_ms, DEFAULT_JITTER_MS);
    this.slowThresholdMs = toNumber(fleet.slow_threshold_ms, DEFAULT_SLOW_THRESHOLD_MS);
    this.latencyProbeIntervalMs = toNumber(fleet.latency_probe_interval_ms, DEFAULT_LATENCY_PROBE_INTERVAL_MS);
    this.reconnectBaseMs = toNumber(fleet.sse_reconnect_base_ms, DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = toNumber(fleet.sse_reconnect_max_ms, DEFAULT_RECONNECT_MAX_MS);
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || (() => Date.now());
    this.setTimeout = options.setTimeout || setTimeout;
    this.clearTimeout = options.clearTimeout || clearTimeout;
    this.onPoll = typeof options.onPoll === 'function' ? options.onPoll : null;
    this.records = new Map();
    this.tokens = new Map();
    this.streams = new Map();
    this.latency = new Map();
    this.agentGenerations = new Map();
    this.running = false;
    this.timer = null;
    this.watchdogTimer = null;

    for (const agent of this.agents) {
      const color = agentColor(agent.name);
      this.records.set(agent.name, sanitizeRecord({
        name: agent.name,
        base_url: agent.base_url,
        color: color.color,
        hue: color.hue,
        state: 'UNKNOWN',
        activity: null,
        context_pct: null,
        cost: null,
        session_cost: null,
        daily_cost: null,
        weekly_cost: null,
        model: null,
        effort: null,
        new_session_threshold: null,
        cpu_pct: null,
        mem_pct: null,
        disk_pct: null,
        has_upgrade: false,
        has_subagent: false,
        subagent_count: 0,
        last_seen: null,
        pulse_rate: null,
        health_reason: 'not_polled',
        updated_at: nowIso(this.now()),
        access: 'read'
      }));
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._startSelfHealWatchdog();
    if (this.agents.length === 0) return;
    for (const agent of this.agents) this._startLatencyProbe(agent);
    this.pollOnce().finally(() => {
      if (!this.running) return;
      for (const agent of this.agents) this._connectSse(agent);
    });
  }

  stop() {
    this.running = false;
    if (this.timer) this.clearTimeout(this.timer);
    this.timer = null;
    if (this.watchdogTimer) this.clearTimeout(this.watchdogTimer);
    this.watchdogTimer = null;
    for (const state of this.latency.values()) {
      if (state.timer) this.clearTimeout(state.timer);
    }
    this.latency.clear();
    for (const stream of this.streams.values()) {
      if (stream.compatibilityTimer) this.clearTimeout(stream.compatibilityTimer);
      if (stream.pollTimer) this.clearTimeout(stream.pollTimer);
      if (stream.reconnectTimer) this.clearTimeout(stream.reconnectTimer);
      if (stream.idleTimer) this.clearTimeout(stream.idleTimer);
      stream.controller?.abort();
    }
    this.streams.clear();
  }

  addAgent(agent) {
    const existingIndex = this.agents.findIndex(a => a.name === agent.name);
    if (existingIndex >= 0) this.removeAgent(agent.name);
    const normalized = { ...agent };
    this.agents.push(normalized);
    this.agentGenerations.set(normalized.name, (this.agentGenerations.get(normalized.name) || 0) + 1);
    const color = agentColor(normalized.name);
    this.records.set(normalized.name, sanitizeRecord({
      name: normalized.name,
      base_url: normalized.base_url,
      color: color.color,
      hue: color.hue,
      state: 'UNKNOWN',
      activity: null,
      context_pct: null,
      cost: null,
      session_cost: null,
      daily_cost: null,
      weekly_cost: null,
      model: null,
      effort: null,
      new_session_threshold: null,
      cpu_pct: null,
      mem_pct: null,
      disk_pct: null,
      has_upgrade: false,
      has_subagent: false,
      subagent_count: 0,
      last_seen: null,
      pulse_rate: null,
      health_reason: 'not_polled',
      updated_at: nowIso(this.now()),
      access: 'read'
    }));
    if (!this.running) {
      this.running = true;
      this._startSelfHealWatchdog();
    }
    this._startLatencyProbe(normalized);
    this._pollAgentAndNotify(normalized);
    this._connectSse(normalized);
    this.onPoll?.(this.getFleet());
  }

  removeAgent(name) {
    this.agents = this.agents.filter(a => a.name !== name);
    this.agentGenerations.set(name, (this.agentGenerations.get(name) || 0) + 1);
    const stream = this.streams.get(name);
    if (stream) {
      if (stream.compatibilityTimer) this.clearTimeout(stream.compatibilityTimer);
      if (stream.pollTimer) this.clearTimeout(stream.pollTimer);
      if (stream.reconnectTimer) this.clearTimeout(stream.reconnectTimer);
      if (stream.idleTimer) this.clearTimeout(stream.idleTimer);
      stream.controller?.abort();
    }
    this.streams.delete(name);
    const latency = this.latency.get(name);
    if (latency?.timer) this.clearTimeout(latency.timer);
    this.latency.delete(name);
    this.tokens.delete(name);
    this.records.delete(name);
    this.onPoll?.(this.getFleet());
  }

  getFleet() {
    const agents = this.agents.map(agent => this._recordWithLink(agent)).filter(Boolean);
    return {
      agents,
      count: agents.length,
      updated_at: nowIso(this.now())
    };
  }

  async getSessionToken(agentName, options = {}) {
    const agent = this.agents.find(a => a.name === agentName);
    if (!agent) {
      const err = new Error('unknown_agent');
      err.status = 404;
      throw err;
    }
    return this._ensureToken(agent, { force: Boolean(options.force) });
  }

  _agentGeneration(agent) {
    return this.agentGenerations.get(agent.name) || 0;
  }

  _isCurrentAgent(agent, generation = this._agentGeneration(agent), stream = null) {
    const current = this.agents.find(a => a.name === agent.name);
    if (!current || current !== agent) return false;
    if ((this.agentGenerations.get(agent.name) || 0) !== generation) return false;
    if (stream && this.streams.get(agent.name) !== stream) return false;
    return true;
  }

  getAgentAccess(agentName) {
    const cached = this.tokens.get(agentName);
    return cached?.scope === 'admin' ? 'admin' : 'read';
  }

  async pollOnce() {
    await Promise.all(this.agents.map(agent => this._pollAgent(agent)));
    const fleet = this.getFleet();
    this.onPoll?.(fleet);
    return fleet;
  }

  _scheduleNext() {
    if (!this.running) return;
    const jitter = this.jitterMs > 0 ? Math.floor(Math.random() * this.jitterMs) : 0;
    this.timer = this.setTimeout(() => {
      this.pollOnce().finally(() => this._scheduleNext());
    }, this.pollIntervalMs + jitter);
    this.timer.unref?.();
  }

  _streamState(agent) {
    let state = this.streams.get(agent.name);
    if (!state) {
      state = {
        controller: null,
        compatibilityTimer: null,
        pollTimer: null,
        reconnectTimer: null,
        idleTimer: null,
        backoffMs: this.reconnectBaseMs,
        connecting: false,
        connectingSince: null,
        reading: false,
        seenFleetState: false
      };
      this.streams.set(agent.name, state);
    }
    return state;
  }

  _latencyState(agent) {
    let state = this.latency.get(agent.name);
    if (!state) {
      state = {
        samples: [],
        consecutiveFailures: 0,
        failureReason: null,
        timer: null
      };
      this.latency.set(agent.name, state);
    }
    return state;
  }

  _recordWithLink(agent) {
    const record = this.records.get(agent.name);
    if (!record) return null;
    return sanitizeRecord({
      ...record,
      link: this._deriveLink(agent, record)
    });
  }

  _deriveLink(agent, record = {}) {
    const state = this.latency.get(agent.name);
    const samples = state?.samples || [];
    const lastSample = samples.at(-1) || null;
    const latencies = samples.map(sample => sample.latencyMs);
    const p95 = percentile95(latencies);
    const base = {
      latency_ms: lastSample?.latencyMs ?? null,
      latency_p95_ms: p95,
      sampled_at: lastSample ? nowIso(lastSample.sampledAtMs) : null,
      quality: 'ok',
      reason: null
    };

    if (record.pulse_rate === 0 || FAILURE_REASONS.has(record.health_reason)) {
      return { ...base, quality: 'down', reason: record.health_reason || 'unreachable' };
    }

    const lastSeenMs = Date.parse(record.last_seen || '');
    const staleAfterMs = Math.max(this.pollIntervalMs * 3, 15_000);
    if (Number.isFinite(lastSeenMs) && this.now() - lastSeenMs > staleAfterMs) {
      return { ...base, quality: 'stale', reason: 'stale' };
    }

    if ((state?.consecutiveFailures || 0) >= DEGRADED_PROBE_FAILURES) {
      return { ...base, quality: 'degraded', reason: state.failureReason || 'unreachable' };
    }

    if (samples.length >= 5 && p95 != null && p95 > this.slowThresholdMs) {
      return { ...base, quality: 'slow', reason: null };
    }

    return base;
  }

  async _ensureToken(agent, { force = false } = {}) {
    const generation = this._agentGeneration(agent);
    const cached = this.tokens.get(agent.name);
    const now = this.now();
    if (!force && cached?.token && cached.expiresAtMs - TOKEN_REFRESH_SKEW_MS > now) {
      return cached.token;
    }

    let resp;
    try {
      resp = await fetchWithTimeout(this.fetch, joinUrl(agent.base_url, '/api/auth/token'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${agent.read_api_key}` }
      }, this.timeoutMs);
    } catch (err) {
      err.reason = classifyError(err);
      throw err;
    }

    if (!resp.ok) {
      const err = new Error(classifyHttpStatus(resp, { tokenEndpoint: true }));
      err.reason = classifyHttpStatus(resp, { tokenEndpoint: true });
      err.status = resp.status;
      throw err;
    }

    const body = await readJsonOrBadPayload(resp);
    if (!body?.token) {
      const err = new Error('auth_failed');
      err.reason = 'auth_failed';
      throw err;
    }

    const parsedExpiresAtMs = body.expires_at ? Date.parse(body.expires_at) : NaN;
    const expiresAtMs = Number.isFinite(parsedExpiresAtMs)
      ? parsedExpiresAtMs
      : now + toNumber(body.ttl_seconds, 86400) * 1000;
    const scope = body.scope === 'admin' ? 'admin' : 'read';
    if (!this._isCurrentAgent(agent, generation)) return body.token;
    this.tokens.set(agent.name, { token: body.token, expiresAtMs, scope });
    return body.token;
  }

  async _pollAgent(agent) {
    const generation = this._agentGeneration(agent);
    if (!this._isCurrentAgent(agent, generation)) return;
    try {
      let token = await this._ensureToken(agent);
      if (!this._isCurrentAgent(agent, generation)) return;
      let resp = await this._fetchState(agent, token);
      if (!this._isCurrentAgent(agent, generation)) return;
      if (resp.status === 401) {
        this.tokens.delete(agent.name);
        token = await this._ensureToken(agent, { force: true });
        if (!this._isCurrentAgent(agent, generation)) return;
        resp = await this._fetchState(agent, token);
        if (!this._isCurrentAgent(agent, generation)) return;
      }
      if (resp.status === 401 || resp.status === 403) {
        this._setFailure(agent, 'auth_failed');
        return;
      }
      if (!resp.ok) {
        this._setFailure(agent, classifyHttpStatus(resp));
        return;
      }
      const state = await readJsonOrBadPayload(resp, validateStatePayload);
      if (!this._isCurrentAgent(agent, generation)) return;
      this._setSuccess(agent, state);
    } catch (err) {
      if (!this._isCurrentAgent(agent, generation)) return;
      this._setFailure(agent, classifyError(err));
    }
  }

  async _pollAgentAndNotify(agent) {
    await this._pollAgent(agent);
    this.onPoll?.(this.getFleet());
  }

  _fetchState(agent, token) {
    return fetchWithTimeout(this.fetch, joinUrl(agent.base_url, '/api/state'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` }
    }, this.timeoutMs);
  }

  _fetchHealth(agent, authorization) {
    return fetchWithTimeout(this.fetch, joinUrl(agent.base_url, '/api/health'), {
      method: 'GET',
      headers: { Authorization: authorization }
    }, this.timeoutMs);
  }

  _startLatencyProbe(agent) {
    if (!this.running || !this._isCurrentAgent(agent)) return;
    const generation = this._agentGeneration(agent);
    const state = this._latencyState(agent);
    if (state.timer) return;
    const run = () => {
      if (!this.running || !this._isCurrentAgent(agent, generation)) return;
      state.timer = null;
      this._probeAgentLatency(agent).finally(() => {
        if (!this.running || !this._isCurrentAgent(agent, generation)) return;
        state.timer = this.setTimeout(run, this.latencyProbeIntervalMs);
        state.timer.unref?.();
      });
    };
    state.timer = this.setTimeout(run, 0);
    state.timer.unref?.();
  }

  async _probeAgentLatency(agent) {
    const generation = this._agentGeneration(agent);
    const state = this._latencyState(agent);
    const startedAtMs = this.now();
    try {
      let resp = await this._fetchHealth(agent, `Bearer ${agent.read_api_key}`);
      if (!this._isCurrentAgent(agent, generation)) return;
      if (resp.status === 401 || resp.status === 403) {
        this.tokens.delete(agent.name);
        const token = await this._ensureToken(agent, { force: true });
        if (!this._isCurrentAgent(agent, generation)) return;
        resp = await this._fetchHealth(agent, `Bearer ${token}`);
      }
      if (!resp.ok) {
        const err = new Error(classifyHttpStatus(resp));
        err.reason = classifyHttpStatus(resp);
        throw err;
      }
      await readJsonOrBadPayload(resp, validateHealthPayload);
      if (!this._isCurrentAgent(agent, generation)) return;
      const sampledAtMs = this.now();
      state.samples.push({
        latencyMs: Math.max(0, sampledAtMs - startedAtMs),
        sampledAtMs
      });
      if (state.samples.length > LATENCY_SAMPLE_LIMIT) {
        state.samples.splice(0, state.samples.length - LATENCY_SAMPLE_LIMIT);
      }
      state.consecutiveFailures = 0;
      state.failureReason = null;
    } catch (err) {
      if (!this._isCurrentAgent(agent, generation)) return;
      state.consecutiveFailures += 1;
      state.failureReason = classifyError(err);
    }
    this.onPoll?.(this.getFleet());
  }

  _fetchStream(agent, token, signal) {
    const deadline = new AbortController();
    let deadlineHit = false;
    const timer = this.setTimeout(() => {
      deadlineHit = true;
      deadline.abort();
    }, this.timeoutMs);
    timer.unref?.();
    const signals = signal ? [signal, deadline.signal] : [deadline.signal];
    const combinedSignal = AbortSignal.any(signals);
    return this.fetch(joinUrl(agent.base_url, '/api/stream'), {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: combinedSignal
    }).catch((err) => {
      if (deadlineHit && !signal?.aborted) throw reasonError('timeout');
      throw err;
    }).finally(() => {
      this.clearTimeout(timer);
    });
  }

  _setSuccess(agent, state) {
    this.records.set(agent.name, stateToFleetRecord(agent, state, {
      self: false,
      base_url: agent.base_url,
      nowMs: this.now(),
      access: this.getAgentAccess(agent.name)
    }));
  }

  _connectSse(agent) {
    if (!this.running) return;
    const generation = this._agentGeneration(agent);
    if (!this._isCurrentAgent(agent, generation)) return;
    const stream = this._streamState(agent);
    if (stream.connecting) return;
    stream.connecting = true;
    stream.connectingSince = this.now();
    stream.controller?.abort();
    stream.controller = new AbortController();
    this._runSse(agent, stream, stream.controller.signal)
      .catch((err) => {
        if (!this.running || err?.name === 'AbortError' || !this._isCurrentAgent(agent, generation, stream)) return;
        const reason = classifyError(err);
        this._startFallbackPolling(agent, 'sse-failure');
        const retryInMs = this._scheduleReconnect(agent);
        console.warn(`[fleet] sse connect failed agent=${agent.name} reason=${reason} retry_in_ms=${retryInMs ?? 'none'}`);
      })
      .finally(() => {
        if (this._isCurrentAgent(agent, generation, stream)) {
          stream.connecting = false;
          stream.connectingSince = null;
        }
      });
  }

  async _runSse(agent, stream, signal) {
    const generation = this._agentGeneration(agent);
    let token = await this._ensureToken(agent);
    if (!this._isCurrentAgent(agent, generation, stream)) return;
    let resp = await this._fetchStream(agent, token, signal);
    if (!this._isCurrentAgent(agent, generation, stream)) return;
    if (resp.status === 401) {
      this.tokens.delete(agent.name);
      token = await this._ensureToken(agent, { force: true });
      if (!this._isCurrentAgent(agent, generation, stream)) return;
      resp = await this._fetchStream(agent, token, signal);
      if (!this._isCurrentAgent(agent, generation, stream)) return;
    }
    if (resp.status === 401 || resp.status === 403) {
      this._setFailure(agent, 'auth_failed');
      throw reasonError('auth_failed');
    }
    if (!resp.ok || !resp.body) {
      const reason = resp.status === 404 ? 'version_unsupported' : 'unreachable';
      this._setFailure(agent, reason);
      throw reasonError(reason);
    }

    stream.reading = true;
    this._stopFallbackPolling(agent, 'sse-takeover');
    stream.backoffMs = this.reconnectBaseMs;
    stream.seenFleetState = false;
    await this._pollAgentAndNotify(agent);
    if (stream.compatibilityTimer) this.clearTimeout(stream.compatibilityTimer);
    stream.compatibilityTimer = this.setTimeout(() => {
      const current = this.streams.get(agent.name);
      if (this.running && current === stream && !current.seenFleetState) this._startFallbackPolling(agent, 'compatibility-timer');
    }, this.pollIntervalMs);
    stream.compatibilityTimer.unref?.();
    try {
      await this._readSseBody(agent, stream, resp.body, signal);
    } finally {
      stream.reading = false;
      this._clearIdleWatchdog(stream);
    }
    if (this.running && !signal.aborted) throw new Error('sse_closed');
  }

  async _readSseBody(agent, stream, body, signal) {
    const decoder = new TextDecoder();
    const parser = new SseEventParser((event) => this._handleSseEvent(agent, event));
    this._armIdleWatchdog(agent, stream);
    if (body.getReader) {
      const reader = body.getReader();
      try {
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          this._armIdleWatchdog(agent, stream);
          parser.push(decoder.decode(value, { stream: true }));
        }
      } finally {
        try { reader.releaseLock(); } catch { /* already released */ }
      }
    } else {
      for await (const chunk of body) {
        if (signal.aborted) break;
        this._armIdleWatchdog(agent, stream);
        parser.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
      }
    }
    parser.push(decoder.decode());
    parser.flush();
  }

  _handleSseEvent(agent, event) {
    if (!this._isCurrentAgent(agent)) return;
    if (event.event === 'auth_expired') {
      this.tokens.delete(agent.name);
      const err = new Error('auth_expired');
      err.reason = 'auth_expired';
      throw err;
    }
    if (event.event !== 'fleet_state') return;
    const stream = this.streams.get(agent.name);
    if (stream) {
      stream.seenFleetState = true;
      if (stream.compatibilityTimer) {
        this.clearTimeout(stream.compatibilityTimer);
        stream.compatibilityTimer = null;
      }
    }
    let state;
    try {
      state = JSON.parse(event.data || '{}');
    } catch {
      return;
    }
    try {
      validateStatePayload(state);
    } catch {
      return;
    }
    this._setSuccess(agent, state);
    this._stopFallbackPolling(agent, 'sse-takeover');
    this.onPoll?.(this.getFleet());
  }

  _startFallbackPolling(agent, trigger = 'unknown') {
    if (!this.running) return;
    const generation = this._agentGeneration(agent);
    if (!this._isCurrentAgent(agent, generation)) return;
    const stream = this._streamState(agent);
    if (stream.pollTimer) return;
    console.log(`[fleet] fallback polling started agent=${agent.name} trigger=${trigger}`);
    const run = () => {
      if (!this.running || !this._isCurrentAgent(agent, generation, stream)) return;
      this._pollAgentAndNotify(agent).finally(() => {
        const current = this.streams.get(agent.name);
        if (!this.running || !this._isCurrentAgent(agent, generation, stream) || current !== stream || !current.pollTimer) return;
        current.pollTimer = this.setTimeout(run, this.pollIntervalMs);
        current.pollTimer.unref?.();
      });
    };
    stream.pollTimer = this.setTimeout(run, 0);
    stream.pollTimer.unref?.();
  }

  _stopFallbackPolling(agent, trigger = 'unknown') {
    const stream = this.streams.get(agent.name);
    if (!stream?.pollTimer) return;
    this.clearTimeout(stream.pollTimer);
    stream.pollTimer = null;
    console.log(`[fleet] fallback polling stopped agent=${agent.name} trigger=${trigger}`);
  }

  _scheduleReconnect(agent) {
    if (!this.running) return;
    const generation = this._agentGeneration(agent);
    if (!this._isCurrentAgent(agent, generation)) return;
    const stream = this._streamState(agent);
    if (stream.reconnectTimer) this.clearTimeout(stream.reconnectTimer);
    const delay = stream.backoffMs;
    stream.backoffMs = Math.min(stream.backoffMs * 2, this.reconnectMaxMs);
    stream.reconnectTimer = this.setTimeout(() => {
      if (!this._isCurrentAgent(agent, generation, stream)) return;
      stream.reconnectTimer = null;
      this._connectSse(agent);
    }, delay);
    stream.reconnectTimer.unref?.();
    return delay;
  }

  _setFailure(agent, reason) {
    const existing = this.records.get(agent.name) || {};
    const color = agentColor(agent.name);
    this.records.set(agent.name, sanitizeRecord({
      name: agent.name,
      base_url: agent.base_url,
      color: color.color,
      hue: color.hue,
      state: reason === 'version_unsupported' ? 'UNKNOWN' : 'OFFLINE',
      activity: existing.activity || null,
      context_pct: existing.context_pct ?? null,
      cost: existing.cost ?? null,
      session_cost: existing.session_cost ?? null,
      daily_cost: existing.daily_cost ?? null,
      weekly_cost: existing.weekly_cost ?? null,
      model: existing.model ?? null,
      effort: existing.effort ?? null,
      new_session_threshold: existing.new_session_threshold ?? null,
      cpu_pct: existing.cpu_pct ?? null,
      mem_pct: existing.mem_pct ?? null,
      disk_pct: existing.disk_pct ?? null,
      has_upgrade: existing.has_upgrade === true,
      has_subagent: existing.has_subagent === true,
      subagent_count: Number.isFinite(existing.subagent_count) ? existing.subagent_count : 0,
      last_seen: existing.last_seen || null,
      pulse_rate: 0,
      health_reason: reason,
      updated_at: nowIso(this.now())
    }));
  }

  // Connection-level watchdog (#180). The server writes a keepalive comment
  // every 15s even when no events fire, so prolonged byte silence means the
  // connection is half-open (e.g. remote power loss, NAT table drop). Abort
  // it and let fallback polling + reconnect determine the real state. This
  // watches the *connection*, never the event rate — a quiet stream on a
  // healthy connection keeps the last pushed state indefinitely.
  _armIdleWatchdog(agent, stream) {
    if (stream.idleTimer) this.clearTimeout(stream.idleTimer);
    stream.idleTimer = this.setTimeout(() => {
      stream.idleTimer = null;
      if (!this.running || !this._isCurrentAgent(agent, this._agentGeneration(agent), stream)) return;
      stream.controller?.abort();
      this._startFallbackPolling(agent, 'idle-watchdog');
      this._scheduleReconnect(agent);
    }, this.sseIdleTimeoutMs);
    stream.idleTimer.unref?.();
  }

  _clearIdleWatchdog(stream) {
    if (!stream.idleTimer) return;
    this.clearTimeout(stream.idleTimer);
    stream.idleTimer = null;
  }

  _startSelfHealWatchdog() {
    if (!this.running || this.watchdogTimer) return;
    const tick = () => {
      this.watchdogTimer = null;
      if (!this.running) return;
      for (const agent of this.agents) this._checkSelfHeal(agent);
      if (!this.running) return;
      this.watchdogTimer = this.setTimeout(tick, this.pollIntervalMs);
      this.watchdogTimer.unref?.();
    };
    this.watchdogTimer = this.setTimeout(tick, this.pollIntervalMs);
    this.watchdogTimer.unref?.();
  }

  _checkSelfHeal(agent) {
    const generation = this._agentGeneration(agent);
    if (!this._isCurrentAgent(agent, generation)) return;
    const stream = this._streamState(agent);
    if (stream.reading) return;

    const nowMs = this.now();
    const connectingSince = Number(stream.connectingSince);
    const connectingAgeMs = stream.connecting && Number.isFinite(connectingSince) ? nowMs - connectingSince : 0;
    const connectingBoundMs = this.timeoutMs * 2 + this.reconnectMaxMs;
    if (stream.connecting && connectingAgeMs <= connectingBoundMs) return;
    if (stream.connecting) {
      stream.controller?.abort();
      stream.connecting = false;
      stream.connectingSince = null;
      this._startFallbackPolling(agent, 'watchdog');
      this._scheduleReconnect(agent);
      console.warn(`[fleet] watchdog revived agent=${agent.name} classification=wedged-connecting frozen_ms=${Math.max(0, connectingAgeMs)}`);
      return;
    }

    if (stream.pollTimer || stream.reconnectTimer) return;
    const record = this.records.get(agent.name);
    const updatedAtMs = Date.parse(record?.updated_at || '');
    if (!Number.isFinite(updatedAtMs)) return;
    const frozenMs = nowMs - updatedAtMs;
    if (frozenMs <= this.pollIntervalMs * 2) return;
    this._startFallbackPolling(agent, 'watchdog');
    this._scheduleReconnect(agent);
    console.warn(`[fleet] watchdog revived agent=${agent.name} classification=dead frozen_ms=${Math.max(0, frozenMs)}`);
  }
}
