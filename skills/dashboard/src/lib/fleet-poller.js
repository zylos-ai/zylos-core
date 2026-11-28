import { agentColor } from '../../public/js/agent-color.js';
import { sanitizeFleetGroupSummary, fleetGroupSummary } from './workbench/fleet-summary.js';
import { compareVersions } from './version-utils.js';

// Hub pages use the peer's list APIs through the Fleet proxy.
const MINIMUM_LIST_API_VERSION = '1.0.0-beta.16';

const CHAT_LIST = '/api/conversations?tab=mine';
const CHAT_STREAM = '/api/stream?chat=1&chat_tab=mine';

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2500;
// Liveness is connection-based (#180): an agent is OFFLINE only when its SSE
// connection is down and polling keeps failing (see FAILURE_GRACE_MS) — never
// because pushed events are sparse (an idle agent legitimately emits nothing
// for long stretches).
// The idle timeout guards against half-open connections: the server emits
// keepalives every 15s, so 45s of byte silence means the connection is dead.
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 45_000;
// A slow peer is not a lost one: once a complete read has succeeded, a timeout,
// connection, unreachable or bad-payload failure keeps the last row and data
// until failures have continued for 30s, counted from the first failure since
// the last success (an idle peer on SSE can have an old last_seen); the first
// failure after that marks the agent OFFLINE. auth_failed, version_unsupported
// and failures of an agent never read successfully apply immediately.
const FAILURE_GRACE_MS = 30_000;
const IMMEDIATE_FAILURE_REASONS = new Set(['auth_failed', 'version_unsupported']);
const DEFAULT_JITTER_MS = 500;
const TOKEN_REFRESH_SKEW_MS = 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_SLOW_THRESHOLD_MS = 1500;
const DEFAULT_LATENCY_PROBE_INTERVAL_MS = 30_000;
const LATENCY_SAMPLE_LIMIT = 20;
const DEGRADED_PROBE_FAILURES = 2;
const CONNECTION_LOG_WINDOW_MS = 60_000;
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
    runtimeInfo?.codex_update
  );
}

function percentile95(values) {
  const sorted = (Array.isArray(values) ? values : []).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
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
  if (reason === 'version_unsupported') err.status = 502;
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

function sanitizeChat(chat) {
  if (!Number.isSafeInteger(chat?.unread_conversations) || chat.unread_conversations < 0) return null;
  if (chat.latest === null) return { latest: null, unread_conversations: chat.unread_conversations };
  const { at, title, preview } = chat.latest ?? {};
  if (typeof at !== 'string' || !Number.isFinite(Date.parse(at)) ||
      typeof title !== 'string' || typeof preview !== 'string') return null;
  return { latest: { at: new Date(at).toISOString(), title, preview }, unread_conversations: chat.unread_conversations };
}

function sanitizeRecord(record) {
  return {
    name: record.name,
    avatar_version: stringOrNull(record.avatar_version),
    supervisor_paused: typeof record.supervisor_paused === 'boolean' ? record.supervisor_paused : null,
    session_mode: ['single', 'multi'].includes(record.session_mode) ? record.session_mode : null,
    group_summary: record.session_mode === 'multi' ? sanitizeFleetGroupSummary(record.group_summary) : null,
    color: record.color,
    hue: record.hue,
    state: record.state,
    rate_limit_pct: record.rate_limit_pct ?? null,
    rate_limit_7d_pct: record.rate_limit_7d_pct ?? null,
    rate_limit_7d_recorded_at: record.rate_limit_7d_recorded_at ?? null,
    rate_limit_7d_live: record.rate_limit_7d_live ?? null,
    daily_cost: record.daily_cost,
    weekly_cost: record.weekly_cost,
    cpu_pct: record.cpu_pct,
    mem_pct: record.mem_pct,
    disk_pct: record.disk_pct,
    has_upgrade: record.has_upgrade === true,
    last_seen: record.last_seen,
    pulse_rate: record.pulse_rate,
    health_reason: record.health_reason,
    link: sanitizeLink(record.link),
    latency: { samples: Array.isArray(record.latency?.samples) ? record.latency.samples.map(sample => ({
      at: stringOrNull(sample.at), ms: numberOrNull(sample.ms),
    })).slice(-LATENCY_SAMPLE_LIMIT) : [] },
    updated_at: record.updated_at,
    base_url: record.base_url,
    self: record.self === true,
    access: record.access === 'admin' ? 'admin' : 'read',
    chat: record.self || record.access === 'admin' ? sanitizeChat(record.chat) : null
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
  // A state payload proves Dashboard reachability, for self and remotes alike.
  const healthReason = liveState === 'IDLE' ? 'idle' : 'ok';
  return sanitizeRecord({
    name,
    base_url: opts.base_url ?? agentConfig.base_url ?? null,
    color: color?.color,
    hue: color?.hue,
    state: liveState,
    avatar_version: statePayload?.agent?.avatar_version,
    supervisor_paused: statePayload?.supervisor_paused,
    session_mode: statePayload?.session_mode,
    group_summary: statePayload?.group_summary,
    chat: statePayload?.chat,
    rate_limit_pct: statePayload?.rate_limit_pct ?? null,
    rate_limit_7d_pct: statePayload?.rate_limit_7d_pct ?? null,
    rate_limit_7d_recorded_at: statePayload?.rate_limit_7d_recorded_at ?? null,
    rate_limit_7d_live: statePayload?.rate_limit_7d_live ?? null,
    daily_cost: statePayload?.daily_cost ?? metricValue(statePayload, 'daily_cost'),
    weekly_cost: statePayload?.weekly_cost ?? null,
    cpu_pct: numberOrNull(systemMetrics?.cpu_pct),
    mem_pct: memPct(systemMetrics),
    disk_pct: numberOrNull(systemMetrics?.disk_pct ?? systemMetrics?.disk_used_pct),
    has_upgrade: hasUpgrade(runtimeInfo),
    last_seen: nowIso(nowMs),
    pulse_rate: 1,
    health_reason: healthReason,
    link: sanitizeLink(opts.link),
    updated_at: nowIso(nowMs),
    self,
    access: opts.access
  });
}

// Assemble fleet presentation from the same object APIs used by the local UI.
export function fleetStateFromObjects(instance, counts, usage, running) {
  const stateKeys = ['working', 'idle', 'starting', 'stopping', 'unknown'];
  const count = value => Number.isSafeInteger(value) && value >= 0;
  const cost = value => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const mode = instance?.session_mode?.sessionMode;
  if (!instance || ![null, 'single', 'multi', 'unreadable'].includes(mode) ||
      typeof counts?.listKnown !== 'boolean' || !counts?.running?.states || !count(counts.running.total) ||
      stateKeys.some(key => !count(counts.running.states[key])) ||
      stateKeys.reduce((sum, key) => sum + counts.running.states[key], 0) !== counts.running.total ||
      !cost(usage?.today?.cost) || !cost(usage?.sevenDay?.cost) || !Array.isArray(running?.rows)) throw reasonError('bad_payload');
  const states = counts.running.states;
  const runtime = instance.default_runtime;
  const account = instance.accounts?.[runtime];
  // Compact catalog rows carry state and flags, never raw process observations.
  // The established summary helper still owns precedence and bounded problems.
  const summaryRows = running.rows.map(row => ({
    sessionGroup: row.id, presence: row.state?.kind === 'unknown' ? 'unknown' : row.state?.kind === 'starting' ? 'starting' : 'running', runtime: row.runtime,
    name: row.displayName ? { displayName: row.displayName } : null,
    state: { kind: ({ working: 'busy', starting: 'waiting', stopping: 'waiting' }[row.state?.kind] ?? row.state?.kind) },
    noResponse: row.flags?.noResponse && Number.isFinite(Date.parse(row.flags.noResponse.since)) ? { since: Date.parse(row.flags.noResponse.since) } : null,
    flags: row.flags,
  }));
  return { agent: instance.agent, session_mode: mode,
    state: !['single', 'multi'].includes(mode) || counts.listKnown === false ? 'UNKNOWN' : states.working > 0 ? 'BUSY' : states.unknown > 0 ? 'UNKNOWN' : 'IDLE',
    supervisor_paused: instance.supervisorPaused,
    runtime_info: {
      zylos_update: instance.versions?.zylos?.update ?? null,
      cc_update: instance.versions?.claude?.update ?? null,
      codex_update: instance.versions?.codex?.update ?? null },
    system_metrics: instance.resources,
    group_summary: fleetGroupSummary({ mode, readAt: typeof counts.readAt === 'number' ? counts.readAt : Date.parse(counts.readAt), listKnown: counts.listKnown,
      rows: summaryRows, groupCounts: counts, failedRows: running.failedRows?.map(row => ({ ...row, sessionGroup: row.id ?? row.sessionGroup })),
      attentionFailures: running.attentionFailures,
      instance: { ...instance, pool: counts.pool } }),
    rate_limit_7d_pct: account?.used_percentage ?? account?.usedPercentage ?? null,
    rate_limit_7d_live: account?.live ?? null, rate_limit_7d_recorded_at: account?.recordedAt ?? null,
    daily_cost: usage.today.cost, weekly_cost: usage.sevenDay.cost };
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
    this.log = options.log || ((level, line) => console[level](line));
    // One fixed-size summary per configured agent, shared by failures and
    // fallback transitions. Never retain a growing set of failure reasons.
    this.connectionLogs = new Map();
    // Start of each agent's current run of failed reads; cleared by a success.
    this.failingSince = new Map();
    this.records = new Map();
    this.tokens = new Map();
    this.chatReads = new Map();
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
        daily_cost: null,
        weekly_cost: null,
        cpu_pct: null,
        mem_pct: null,
        disk_pct: null,
        has_upgrade: false,
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
    this.pollOnce().finally(() => {
      if (!this.running) return;
      for (const agent of this.agents) {
        this._startLatencyProbe(agent);
        this._connectSse(agent);
      }
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
    this.chatReads.clear();
    for (const name of this.connectionLogs.keys()) this._flushConnectionLog(name, true);
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
      daily_cost: null,
      weekly_cost: null,
      cpu_pct: null,
      mem_pct: null,
      disk_pct: null,
      has_upgrade: false,
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
    this._pollAgentAndNotify(normalized).finally(() => {
      if (!this.running || !this._isCurrentAgent(normalized)) return;
      this._startLatencyProbe(normalized);
      this._connectSse(normalized);
    });
    this.onPoll?.(this.getFleet());
  }

  removeAgent(name) {
    this._flushConnectionLog(name, true);
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
    this.chatReads.delete(name);
    this.failingSince.delete(name);
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

  _logConnectionEvent(agent, kind, line, reason = null) {
    if (!this._isCurrentAgent(agent)) return;
    let state = this.connectionLogs.get(agent.name);
    if (!state) {
      state = { started: null, timer: null, failureSeen: false, fallbackSeen: false,
        lastReason: null, failures: 0, starts: 0, stops: 0 };
      this.connectionLogs.set(agent.name, state);
    }
    if (state.started !== null && this.now() - state.started >= CONNECTION_LOG_WINDOW_MS) {
      this._flushConnectionLog(agent.name);
    }
    if (state.started === null) {
      state.started = this.now();
      state.timer = this.setTimeout(() => this._flushConnectionLog(agent.name), CONNECTION_LOG_WINDOW_MS);
      state.timer.unref?.();
    }
    if (kind === 'failure') {
      if (!state.failureSeen || state.lastReason !== reason) this.log('warn', line);
      else state.failures++;
      state.failureSeen = true;
      state.lastReason = reason;
    } else {
      if (!state.fallbackSeen) this.log('log', line);
      else if (kind === 'fallback-start') state.starts++;
      else state.stops++;
      state.fallbackSeen = true;
    }
  }

  _flushConnectionLog(name, remove = false) {
    const state = this.connectionLogs.get(name);
    if (!state) return;
    if (state.timer) this.clearTimeout(state.timer);
    if (state.failures + state.starts + state.stops > 0) {
      this.log('log', `[fleet] repeated connection events agent=${name} window_ms=${Math.max(0, this.now() - state.started)} sse_failure_repeats=${state.failures} fallback_started=${state.starts} fallback_stopped=${state.stops}`);
    }
    state.started = null;
    state.timer = null;
    state.failureSeen = false;
    state.fallbackSeen = false;
    state.lastReason = null;
    state.failures = state.starts = state.stops = 0;
    if (remove) this.connectionLogs.delete(name);
  }

  async getSessionToken(agentName, options = {}) {
    const agent = this.agents.find(a => a.name === agentName);
    if (!agent) {
      const err = new Error('unknown_agent');
      err.status = 404;
      throw err;
    }
    return this._getCompatibleToken(agent, { force: Boolean(options.force), recheck: Boolean(options.recheck) });
  }

  async _getCompatibleToken(agent, { force = false, recheck = false } = {}) {
    const generation = this._agentGeneration(agent);
    const ensureCurrent = () => {
      if (!this._isCurrentAgent(agent, generation)) throw Object.assign(reasonError('unknown_agent'), { status: 404 });
    };
    let token = await this._ensureToken(agent, { force });
    ensureCurrent();
    let cached = this.tokens.get(agent.name);
    if (cached?.token === token && cached.listApiSupported !== undefined) {
      if (!cached.listApiSupported) throw reasonError('version_unsupported');
      if (!recheck) return token;
    }

    let response = await this._fetchObject(agent, token, '/api/instance');
    if (response.status === 401 && !force) {
      ensureCurrent();
      token = await this._ensureToken(agent, { force: true });
      ensureCurrent();
      cached = this.tokens.get(agent.name);
      response = await this._fetchObject(agent, token, '/api/instance');
    }
    if (!response.ok && response.status !== 404) {
      throw Object.assign(reasonError(classifyHttpStatus(response)), { status: response.status });
    }
    try {
      await this._readSupportedInstance(agent, response, cached?.token === token ? cached : null);
    } catch (error) {
      if (this._isCurrentAgent(agent, generation) && error.reason === 'version_unsupported') {
        this._setFailure(agent, error.reason);
        this.onPoll?.(this.getFleet());
      }
      throw error;
    }
    ensureCurrent();
    return token;
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

  getAgentRecord(name) {
    const agent = this.agents.find(candidate => candidate.name === name);
    return agent ? this._recordWithLink(agent) : null;
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
      access: this.getAgentAccess(agent.name),
      link: this._deriveLink(agent, record),
      latency: { samples: (this.latency.get(agent.name)?.samples || []).map(sample => ({
        at: nowIso(sample.sampledAtMs), ms: sample.latencyMs,
      })) }
    });
  }

  _deriveLink(agent, record = {}) {
    const state = this.latency.get(agent.name);
    const samples = state?.samples || [];
    const lastSample = samples.findLast(sample => sample.latencyMs !== null) || null;
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

    if (latencies.filter(Number.isFinite).length >= 5 && p95 != null && p95 > this.slowThresholdMs) {
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
      const err = reasonError(classifyHttpStatus(resp, { tokenEndpoint: true }));
      err.status ??= resp.status;
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
      await this._refreshChat(agent, token);
    } catch (err) {
      if (!this._isCurrentAgent(agent, generation)) return;
      this._setFailure(agent, classifyError(err));
    }
  }

  async _pollAgentAndNotify(agent) {
    await this._pollAgent(agent);
    this.onPoll?.(this.getFleet());
  }

  async _fetchChat(agent, token, signal) {
    const deadline = new AbortController();
    const timer = this.setTimeout(() => deadline.abort(), this.timeoutMs);
    timer.unref?.();
    try {
      const response = await this.fetch(joinUrl(agent.base_url, CHAT_LIST), {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        return null;
      }
      return sanitizeChat((await response.json())?.summary);
    } catch {
      return null;
    } finally {
      this.clearTimeout(timer);
    }
  }

  async _refreshChat(agent, token, signal) {
    const generation = this._agentGeneration(agent);
    const current = () => !signal?.aborted && this._isCurrentAgent(agent, generation) &&
      this.tokens.get(agent.name)?.token === token;
    if (!current() || this.getAgentAccess(agent.name) !== 'admin') return false;

    // Full reads and chat events update the same record in request order.
    const previous = this.chatReads.get(agent.name);
    const read = Promise.resolve(previous).then(async () => {
      if (!current()) return false;
      const chat = await this._fetchChat(agent, token, signal);
      if (!current()) return false;
      const record = this.records.get(agent.name);
      if (!record || FAILURE_REASONS.has(record.health_reason) || JSON.stringify(record.chat) === JSON.stringify(chat)) return false;
      this.records.set(agent.name, { ...record, chat });
      return true;
    });
    this.chatReads.set(agent.name, read);
    try { return await read; }
    finally {
      if (this.chatReads.get(agent.name) === read) this.chatReads.delete(agent.name);
    }
  }

  _queueChatRead(agent, stream) {
    if (!stream) return;
    stream.chatDirty = true;
    if (stream.chatPending) return;
    stream.chatPending = true;
    const signal = stream.controller?.signal;
    queueMicrotask(async () => {
      try {
        while (stream.chatDirty && !signal?.aborted && this._isCurrentAgent(agent, undefined, stream)) {
          stream.chatDirty = false;
          if (await this._refreshChat(agent, this.tokens.get(agent.name)?.token, signal)) this.onPoll?.(this.getFleet());
        }
      } finally {
        stream.chatPending = false;
      }
    });
  }

  _fetchObject(agent, token, apiPath) {
    return fetchWithTimeout(this.fetch, joinUrl(agent.base_url, apiPath), {
      method: 'GET', headers: { Authorization: `Bearer ${token}` }
    }, this.timeoutMs);
  }

  // Only a 404 or an explicitly older version is unsupported. A missing, empty,
  // unparsable version or an unreadable body is a bad payload that leaves the
  // cached version verdict untouched, so a busy peer is not reported as old.
  async _readSupportedInstance(agent, response, cached) {
    let supported = false;
    let instance = null;
    if (response.ok) {
      instance = await response.json().catch(() => null);
      const comparison = compareVersions(instance?.versions?.zylos?.installed, MINIMUM_LIST_API_VERSION, { prerelease: true });
      if (comparison === null) throw reasonError('bad_payload');
      supported = comparison >= 0;
    }
    if (cached && this.tokens.get(agent.name) === cached) cached.listApiSupported = supported;
    if (!supported) throw reasonError('version_unsupported');
    return instance;
  }

  async _readGroupPages(agent, token, path, first, generation) {
    let items = [];
    let response = first;
    const visited = new Set();
    let restarted = false;
    while (this._isCurrentAgent(agent, generation)) {
      const page = await readJsonOrBadPayload(response);
      if (!response.ok) {
        if (response.status !== 400 || page?.error?.code !== 'invalid_cursor' || !visited.size || restarted) {
          throw reasonError(classifyHttpStatus(response));
        }
        items = [];
        visited.clear();
        restarted = true;
        response = await this._fetchObject(agent, token, path);
        continue;
      }
      if (!Array.isArray(page?.items)) throw reasonError('bad_payload');
      items.push(...page.items);
      const cursor = page.nextCursor;
      if (cursor == null) return items;
      if (typeof cursor !== 'string' || !cursor || visited.has(cursor)) throw reasonError('bad_payload');
      visited.add(cursor);
      if (this._isCurrentAgent(agent, generation)) {
        response = await this._fetchObject(agent, token, `${path}&cursor=${encodeURIComponent(cursor)}`);
      }
    }
    return items;
  }

  async _fetchState(agent, token) {
    const generation = this._agentGeneration(agent);
    const cached = this.tokens.get(agent.name);
    const instanceResponse = await this._fetchObject(agent, token, '/api/instance');
    if (!instanceResponse.ok && instanceResponse.status !== 404) return instanceResponse;
    const instance = await this._readSupportedInstance(agent, instanceResponse, cached?.token === token ? cached : null);
    if (!this._isCurrentAgent(agent, generation)) throw reasonError('unknown_agent');
    const runningPath = '/api/groups?side=running';
    const responses = await Promise.all(['/api/groups/counts', '/api/usage/summary', runningPath].map(apiPath =>
      this._fetchObject(agent, token, apiPath)));
    const failed = responses.find(response => !response.ok);
    if (failed) return failed;
    const [counts, usage, rows] = await Promise.all([
      ...responses.slice(0, 2).map(response => readJsonOrBadPayload(response)),
      this._readGroupPages(agent, token, runningPath, responses[2], generation),
    ]);
    const running = { rows };
    if (counts?.offline?.startFailed > 0 && this._isCurrentAgent(agent, generation)) {
      try {
        const failedPath = '/api/groups?side=offline&flag=startFailed';
        const first = await this._fetchObject(agent, token, failedPath);
        running.failedRows = await this._readGroupPages(agent, token, failedPath, first, generation);
      } catch { running.attentionFailures = [...(running.attentionFailures ?? []), 'offline_start_failed']; }
    }
    const state = fleetStateFromObjects(instance, counts, usage, running);
    return { ok: true, status: 200, json: async () => state };
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
    try {
      await this._getCompatibleToken(agent);
      if (!this._isCurrentAgent(agent, generation)) return;
      const startedAtMs = this.now();
      let resp = await this._fetchHealth(agent, `Bearer ${agent.read_api_key}`);
      if (!this._isCurrentAgent(agent, generation)) return;
      if (resp.status === 401 || resp.status === 403) {
        this.tokens.delete(agent.name);
        const token = await this._getCompatibleToken(agent, { force: true });
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
      if (!this._isCurrentAgent(agent, generation) || err?.reason === 'version_unsupported') return;
      state.samples.push({ latencyMs: null, sampledAtMs: this.now() });
      if (state.samples.length > LATENCY_SAMPLE_LIMIT) {
        state.samples.splice(0, state.samples.length - LATENCY_SAMPLE_LIMIT);
      }
      state.consecutiveFailures += 1;
      state.failureReason = classifyError(err);
    }
    this.onPoll?.(this.getFleet());
  }

  _fetchStream(agent, token, signal, path = '/api/stream') {
    const deadline = new AbortController();
    let deadlineHit = false;
    const timer = this.setTimeout(() => {
      deadlineHit = true;
      deadline.abort();
    }, this.timeoutMs);
    timer.unref?.();
    const signals = signal ? [signal, deadline.signal] : [deadline.signal];
    const combinedSignal = AbortSignal.any(signals);
    return this.fetch(joinUrl(agent.base_url, path), {
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
    this.failingSince.delete(agent.name);
    this.records.set(agent.name, stateToFleetRecord(agent, { ...state, chat: this.records.get(agent.name)?.chat }, {
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
        this._logConnectionEvent(agent, 'failure', `[fleet] sse connect failed agent=${agent.name} reason=${reason} retry_in_ms=${retryInMs ?? 'none'}`, reason);
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
    let token = await this._getCompatibleToken(agent, { recheck: true });
    if (!this._isCurrentAgent(agent, generation, stream)) return;
    signal.throwIfAborted();
    const openStream = async () => {
      if (this.getAgentAccess(agent.name) === 'admin') {
        const response = await this._fetchStream(agent, token, signal, CHAT_STREAM);
        // Older peers and peers that decline chat still publish fleet state.
        if (![400, 403, 404, 429].includes(response.status)) return response;
        await response.body?.cancel().catch(() => {});
      }
      signal.throwIfAborted();
      return this._fetchStream(agent, token, signal);
    };
    let resp = await openStream();
    if (!this._isCurrentAgent(agent, generation, stream)) return;
    if (resp.status === 401) {
      this.tokens.delete(agent.name);
      token = await this._getCompatibleToken(agent, { force: true });
      if (!this._isCurrentAgent(agent, generation, stream)) return;
      signal.throwIfAborted();
      resp = await openStream();
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
    try {
      await this._pollAgentAndNotify(agent);
      if (signal.aborted) {
        await resp.body.cancel().catch(() => {});
        return;
      }
      if (stream.compatibilityTimer) this.clearTimeout(stream.compatibilityTimer);
      stream.compatibilityTimer = this.setTimeout(() => {
        const current = this.streams.get(agent.name);
        if (this.running && current === stream && !current.seenFleetState) this._startFallbackPolling(agent, 'compatibility-timer');
      }, this.pollIntervalMs);
      stream.compatibilityTimer.unref?.();
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
    const stream = this.streams.get(agent.name);
    if (['chat_messages_changed', 'chat_unavailable'].includes(event.event)) {
      this._queueChatRead(agent, stream);
      return;
    }
    if (!['instance', 'groups', 'chat_ready'].includes(event.event)) return;
    if (stream) {
      stream.seenFleetState = true;
      if (stream.compatibilityTimer) { this.clearTimeout(stream.compatibilityTimer); stream.compatibilityTimer = null; }
      if (event.event === 'chat_ready') {
        this._stopFallbackPolling(agent, 'sse-takeover');
        // The connection's initial state read already fetched the summary.
        return;
      }
      if (stream.objectReadPending) { stream.objectReadDirty = true; return; }
      stream.objectReadPending = true;
    }
    this._pollAgentAndNotify(agent).finally(() => {
      if (stream) {
        stream.objectReadPending = false;
        if (stream.objectReadDirty && this._isCurrentAgent(agent, undefined, stream)) {
          stream.objectReadDirty = false;
          this._handleSseEvent(agent, { event: 'groups' });
        }
      }
    });
    this._stopFallbackPolling(agent, 'sse-takeover');
  }

  _startFallbackPolling(agent, trigger = 'unknown') {
    if (!this.running) return;
    const generation = this._agentGeneration(agent);
    if (!this._isCurrentAgent(agent, generation)) return;
    const stream = this._streamState(agent);
    if (stream.pollTimer) return;
    this._logConnectionEvent(agent, 'fallback-start', `[fleet] fallback polling started agent=${agent.name} trigger=${trigger}`);
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
    this._logConnectionEvent(agent, 'fallback-stop', `[fleet] fallback polling stopped agent=${agent.name} trigger=${trigger}`);
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
    const nowMs = this.now();
    if (!this.failingSince.has(agent.name)) this.failingSince.set(agent.name, nowMs);
    // Only a row that shows a successful read is held; a row already marked
    // failed takes the newest reason.
    if (!IMMEDIATE_FAILURE_REASONS.has(reason) && !FAILURE_REASONS.has(existing.health_reason) &&
        Number.isFinite(Date.parse(existing.last_seen || '')) &&
        nowMs - this.failingSince.get(agent.name) < FAILURE_GRACE_MS) {
      // Keep the last good row; refreshing updated_at shows the self-heal
      // watchdog that this agent is still being read, not frozen.
      this.records.set(agent.name, { ...existing, chat: null, updated_at: nowIso(nowMs) });
      return;
    }
    const color = agentColor(agent.name);
    this.records.set(agent.name, sanitizeRecord({
      name: agent.name,
      avatar_version: existing.avatar_version,
      base_url: agent.base_url,
      color: color.color,
      hue: color.hue,
      state: reason === 'version_unsupported' ? 'UNKNOWN' : 'OFFLINE',
      daily_cost: existing.daily_cost ?? null,
      weekly_cost: existing.weekly_cost ?? null,
      cpu_pct: existing.cpu_pct ?? null,
      mem_pct: existing.mem_pct ?? null,
      disk_pct: existing.disk_pct ?? null,
      has_upgrade: existing.has_upgrade === true,
      last_seen: existing.last_seen || null,
      pulse_rate: 0,
      health_reason: reason,
      updated_at: nowIso(nowMs)
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
