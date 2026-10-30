import { ObserverHistory } from './observer-history.js?v=2';
import { validAgentSize, validObserverSize } from './observer-size.js?v=2';
import { pct, resolveCpuDisplay } from './gauge-utils.js';
import { setAssetRoot, getLocale, initI18n, t, renderI18n } from './i18n.js?v=2';
import { renderAgentFleet, liveStateMood, MASCOT_BY_MOOD } from './agent-fleet.js';
import { createFleetSounds } from './fleet-sounds.js';
import { priceWithEditedBaseRates } from './pricing-form.js';
import {
  captureMetricTarget,
  isMetricTargetCurrent,
} from './response-order.js';
import { refreshDashboardState } from './state-refresh.js';
import { formatActionResult } from './action-result.js';
import { pendingDepthValue, sessionBlockTitleKey, stateTitleKey } from './state-presentation.js';
import {
  effortOptionState,
  mergeRuntimeInfo,
  modelOptionState,
  runtimeLabels,
  submitSelectAction,
} from './runtime-ui.js';

const BASE_PATH = document.documentElement.dataset.basePath || '';
const ASSET_ROOT = `${BASE_PATH}/_assets`;
setAssetRoot(ASSET_ROOT);

// When served via the fleet proxy (/fleet/<name>/) this page shows a REMOTE
// agent's detail. The remote's own /api/fleet must not drive the view (its
// fleet config is unrelated to the wall the viewer came from), and the back
// control returns to the parent dashboard root instead of an in-app view.
const REMOTE_AGENT_MATCH = BASE_PATH.match(/\/fleet\/([^/]+)$/);
const REMOTE_AGENT = REMOTE_AGENT_MATCH ? decodeURIComponent(REMOTE_AGENT_MATCH[1]) : null;
const PARENT_DASHBOARD_PATH = REMOTE_AGENT ? `${BASE_PATH.slice(0, REMOTE_AGENT_MATCH.index)}/` : null;
const REMOTE_ACCESS = document.documentElement.dataset.remoteAccess === 'admin' ? 'admin' : 'read';

const METRICS = ['context_pct', 'rate_limit', 'rate_limit_7d', 'session_cost', 'ttft', 'turn_duration'];
const THEMES = ['light'];
const THEME_KEY = 'zylos-dashboard-theme';
const PROMPT_TRANSIENT_SECONDS = 5;
function effortLabel(level) { return t(`effort.${level}`) || level?.charAt(0).toUpperCase() + level?.slice(1) || ''; }

const state = {
  dashboardState: null,
  metrics: new Map(),
  health: null,
  system: null,
  summary: null,
  communication: null,
  fleet: null,
  timeline: null,
  sourceUpdatedAt: null,
  metricsUpdatedAt: null,
  healthUpdatedAt: null,
  summaryUpdatedAt: null,
  commUpdatedAt: null,
  timelineUpdatedAt: null,
  timer: null,
  pollTimer: null,
  fleetFallbackTimer: null,
  fleetHoverPaused: false,
  pendingFleet: null,
  eventSource: null,
  charts: {},
  lastCpuPct: null,
  multiAgent: false,
  fleetViewActive: false,
  fleetModeInitialized: false,
  remoteAgent: null,
  navigationGeneration: 0,
  observer: {
    status: null,
    lease: null,
    ws: null,
    iframe: null,
    channel: null,
    renewTimer: null,
    opening: false,
    endpointPrefix: null,
    generation: 0,
    statusGeneration: 0,
    lifecycleGeneration: 0,
    lifecyclePending: null,
    statusRequest: null,
    sizePending: null
  },
  memory: {
    tree: null,
    selectedPath: null,
    file: null,
    git: null,
    mode: 'rendered',
    collapsed: new Set(),
    loading: false,
    error: null,
    editing: false,
    draft: '',
    draftNotice: false,
    dirty: false,
    saving: false,
    conflict: null,
    conflictRetryText: '',
    liveNotice: null,
    draftTimer: null,
    liveCheckTimer: null
  }
};

const $ = (sel) => document.querySelector(sel);

function api(path) { return `${BASE_PATH}${path}`; }

// ─── In-page remote agent viewing (#203 Option B) ───
// While a remote agent is being viewed, agent-scoped data paths are re-rooted
// at the server-side proxy (/fleet/<name>/api/...). Fleet-wall data and auth
// endpoints always come from our own dashboard root. In the standalone remote
// document (REMOTE_AGENT mode) BASE_PATH already targets the remote, so
// state.remoteAgent stays null there and these helpers pass through.
function remotePrefix() {
  return state.remoteAgent ? `/fleet/${encodeURIComponent(state.remoteAgent)}` : '';
}

function agentPath(path) {
  if (!state.remoteAgent) return path;
  if (!path.startsWith('/api/') || path === '/api/fleet') return path;
  return `${remotePrefix()}${path}`;
}

function observerEndpoint(path) {
  return state.remoteAgent ? api(`${remotePrefix()}${path}`) : api(path);
}

function remoteAccess() {
  if (state.remoteAgent) {
    const agent = state.fleet?.agents?.find(a => a.name === state.remoteAgent);
    return agent?.access === 'admin' ? 'admin' : 'read';
  }
  if (REMOTE_AGENT) return REMOTE_ACCESS;
  return 'admin';
}

function remoteIsReadOnly() {
  return (state.remoteAgent || REMOTE_AGENT) && remoteAccess() !== 'admin';
}

function viewedAgentName() {
  return state.remoteAgent || REMOTE_AGENT || state.dashboardState?.agent?.name || '';
}

// ─── Theme ───
function initTheme(theme) {
  const stored = localStorage.getItem(THEME_KEY);
  const resolved = THEMES.includes(theme) ? theme : (THEMES.includes(stored) ? stored : 'light');
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem(THEME_KEY, resolved);
}

// ─── Formatting ───
// Input is always a 0-100 percentage (statusline, Codex percent_used, system
// metrics). No fraction inference — 0.5 means 0.5%, not 50% (#251).
function barPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function barColor(pctValue) {
  const p = barPct(pctValue);
  if (p < 50) return '';
  if (p <= 75) return 'bar-warning';
  return 'bar-danger';
}

// Input is a 0-1 ratio (cache_hit_rate is computed as read/total). Always
// scale; do not pass 0-100 percentages here.
function pctDecimal(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return `${Math.max(0, Math.min(100, n * 100)).toFixed(1)}%`;
}

function tok(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

function usd(v) {
  if (v == null) return '--';
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD', maximumFractionDigits: n < 1 ? 4 : 2
  }).format(n);
}

function bytes(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '--';
  if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
  return `${Math.round(n / 1048576)} MB`;
}

function dur(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ageSec(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
}

function fmtAge(ts) {
  const a = ageSec(ts);
  if (a === null) return '--';
  if (a < 2) return t('time.just_now');
  if (a < 60) return t('time.seconds', { count: a });
  if (a < 3600) return t('time.minutes', { m: Math.floor(a / 60), s: a % 60 });
  const h = Math.floor(a / 3600);
  const m = Math.floor((a % 3600) / 60);
  return m > 0 ? t('time.hours', { h, m }) : t('time.hours_exact', { h });
}

function rateWindowExpired(resetsAt) {
  const ts = Number(resetsAt);
  if (!Number.isFinite(ts) || ts <= 0) return false;
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return ms <= Date.now();
}

function fmtResetTime(unixSeconds) {
  const ts = Number(unixSeconds);
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const diff = ms - Date.now();
  if (diff <= 0) return t('reset.now');
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 24) { const d = Math.floor(h / 24); return t('reset.days', { d, h: h % 24 }); }
  if (h > 0) return t('reset.hours', { h, m });
  return t('reset.minutes', { m });
}

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function agentFleetLabels() {
  return {
    title: t('agent_fleet.title'),
    subtitle: t('agent_fleet.subtitle'),
    busy: t('agent_fleet.busy'),
    thinking: t('agent_fleet.thinking'),
    idle: t('agent_fleet.idle'),
    stuck: t('agent_fleet.stuck'),
    offline: t('agent_fleet.offline'),
    unreachable: t('agent_fleet.unreachable'),
    versionUnsupported: t('agent_fleet.version_unsupported'),
    authFailed: t('agent_fleet.auth_failed'),
    slow: t('agent_fleet.slow'),
    degraded: t('agent_fleet.degraded'),
    stale: t('agent_fleet.stale'),
    linkLatency: t('agent_fleet.link_latency'),
    linkDegraded: t('agent_fleet.link_degraded'),
    reasonLabels: {
      timeout: t('agent_fleet.timeout'),
      conn_refused: t('agent_fleet.conn_refused'),
      bad_payload: t('agent_fleet.bad_payload'),
      stale: t('agent_fleet.stale_data')
    },
    noActivity: t('agent_fleet.no_activity'),
    context: t('label.context'),
    contextChipTitle: t('agent_fleet.context_chip_title'),
    model: t('agent_fleet.model'),
    sessionCost: t('cost.session'),
    dailyCost: t('cost.today'),
    weeklyCost: t('cost.7d'),
    cpu: t('label.cpu'),
    memory: t('label.memory'),
    disk: t('label.disk'),
    rate5h: t('agent_fleet.rate_5h'),
    rate7d: t('agent_fleet.rate_7d'),
    thinkingActivity: t('activity.thinking'),
    subagent: t('label.subagents'),
    empty: t('agent_fleet.empty')
  };
}

// ─── State helpers ───
function normState(v) { return String(v || 'UNKNOWN').toUpperCase(); }

function stateClass(v) { return `state-${normState(v).toLowerCase().replaceAll('_', '-')}`; }

function latestTool(tools = []) {
  return [...tools].sort((a, b) => new Date(b.started_at) - new Date(a.started_at))[0] || null;
}

function stateTitle(p, mood) {
  return t(stateTitleKey(p?.state, mood));
}


function confLabel(v) {
  if (!v) return '--';
  const key = `confidence.${String(v).toLowerCase()}`;
  const r = t(key);
  return r === key ? String(v) : r;
}

function srcLabel(m) {
  if (!m || metVal(m) === null) return t('confidence.unavailable');
  const src = m.selected_source || m.source || '';
  const friendly = {
    'core-session-reader': t('metric.current_session'),
    statusline: t('metric.current_session'),
    statusline_current_usage: t('metric.current_session'),
    jsonl_usage: t('source.jsonl_usage'),
    rollout: t('source.rollout'),
    token_price_estimated: t('source.estimated'),
    derived_token_estimate: t('source.estimated'),
    hook_postToolUse: t('source.tool_hooks')
  };
  return friendly[src] || src || t('confidence.unavailable');
}

function metVal(m) {
  if (!m) return null;
  if (m.value && typeof m.value === 'object') return m.value;
  return m.value ?? m.current ?? m.percent ?? null;
}

// ─── Runtime Visibility ───
let _lastRuntimeApplied = null;

function applyRuntimeVisibility() {
  const rt = state.dashboardState?.runtime_info?.runtime || 'claude';
  if (rt === _lastRuntimeApplied) return;
  _lastRuntimeApplied = rt;
  const runtimeCard = $('.runtime-card');
  const capacityCard = $('[aria-labelledby="capacity-title"]');
  const timelineCard = $('.timeline-card');
  const trendsTab = $('[data-tab="trends"]');
  const trendsPanel = $('#tab-trends');

  if (runtimeCard) runtimeCard.hidden = false;
  if (capacityCard) capacityCard.hidden = false;
  if (timelineCard) timelineCard.hidden = false;
  if (trendsTab) trendsTab.hidden = false;

  const latencyCard = $('.latency-card');
  if (latencyCard) latencyCard.hidden = rt !== 'codex';

  if (trendsPanel && trendsTab?.classList.contains('active')) trendsPanel.hidden = false;
}

// ─── Render: Info Bar ───
// Header version + tab-bar agent name. The version is this page's own
// dashboard component version: set once from the first payload that carries
// it (the local server's /api/state, or the remote's own document in
// standalone remote mode) and never overwritten — in-page remote viewing
// swaps dashboardState to the remote agent's payload, whose version belongs
// to a different install.
function renderIdentityChrome() {
  const versionEl = $('#dashboard-version');
  const version = state.dashboardState?.dashboard_version;
  if (versionEl && version && !versionEl.textContent) {
    versionEl.textContent = `v${version}`;
    versionEl.hidden = false;
  }
  const nameEl = $('#tab-bar-agent-name');
  if (nameEl) {
    const name = viewedAgentName();
    nameEl.textContent = name;
    nameEl.hidden = !name;
  }
}

function renderInfoBar() {
  renderIdentityChrome();
  const bar = $('#info-bar');
  if (!bar) return;
  const ri = state.dashboardState?.runtime_info;
  if (!ri) { bar.textContent = ''; return; }

  const parts = [];
  if (ri.zylos_version) {
    let zv = `zylos v${ri.zylos_version}`;
    if (ri.zylos_update) zv += ` <span class="info-bar-hint" id="zylos-update-hint" role="button" tabindex="0" title="${esc(t('info.zylos_update_hint', { version: ri.zylos_update }))}">↑${esc(ri.zylos_update)}</span>`;
    parts.push(zv);
  }
  parts.push(...runtimeLabels(ri, t, effortLabel).map(esc));
  if (ri.runtime === 'codex') {
    const codexVersion = ri.codex_running || ri.codex_version || ri.codex_installed;
    if (codexVersion) {
      let cv = `Codex v${esc(codexVersion)}`;
      if (ri.codex_restart) cv += ` <span class="info-bar-update" title="${esc(t('info.restart_available', { version: ri.codex_restart }))}">↑${esc(ri.codex_restart)}</span>`;
      else if (ri.codex_update) cv += ` <span class="info-bar-update" title="${esc(t('info.update_available', { version: ri.codex_update }))}">↑${esc(ri.codex_update)}</span>`;
      parts.push(cv);
    }
  } else if (ri.cc_version) {
    let cv = `CC v${esc(ri.cc_version)}`;
    if (ri.cc_restart) cv += ` <span class="info-bar-update" title="${esc(t('info.restart_available', { version: ri.cc_restart }))}">↑${esc(ri.cc_restart)}</span>`;
    else if (ri.cc_update) cv += ` <span class="info-bar-update" title="${esc(t('info.update_available', { version: ri.cc_update }))}">↑${esc(ri.cc_update)}</span>`;
    parts.push(cv);
  }

  const readOnly = remoteIsReadOnly();
  const actionsTitle = readOnly ? ` title="${esc(t('remote.actions_read_only_tooltip'))}"` : '';
  const settingsTitle = readOnly ? ` title="${esc(t('remote.settings_read_only_tooltip'))}"` : '';
  const buttons = `<span class="info-bar-buttons"><button class="info-bar-actions-btn" id="actions-btn" type="button"${readOnly ? ' disabled' : ''}${actionsTitle}>${esc(t('btn.actions'))}</button><button class="info-bar-gear" id="settings-btn" type="button" aria-label="${esc(t('btn.settings'))}"${settingsTitle}>⚙️</button></span>`;
  bar.innerHTML = `<span class="info-bar-text">${parts.join(' · ')}</span>${buttons}`;
}

// ─── Render: State ───
const FEED_MAX = 5;
const prevToolIds = new Set();

function mascotClass(agentState) {
  const s = normState(agentState);
  if (s === 'BUSY') return 'mascot-busy';
  if (s === 'IDLE') return 'mascot-idle';
  if (s === 'OFFLINE') return 'mascot-offline';
  if (s === 'WAITING_HUMAN') return 'mascot-waiting';
  if (s === 'POSSIBLY_STUCK') return 'mascot-possibly-stuck';
  if (s === 'STUCK') return 'mascot-stuck';
  return '';
}

function renderState() {
  const title = $('#runtime-title');
  if (title) {
    title.removeAttribute('data-i18n');
    title.textContent = t(sessionBlockTitleKey(state.dashboardState?.sessionGroup));
  }
  const p = state.dashboardState;
  // Same octopus mascot set + mood logic as Agent Fleet (busy with no visible
  // tool = thinking), so the agent looks identical in its tile and its detail.
  const mood = liveStateMood(p);
  const dot = $('#state-dot');
  if (dot) dot.className = `state-dot ${stateClass(p?.state)}`;
  $('#state-title').textContent = p ? stateTitle(p, mood) : t('state.unknown_simple');
  const mascotArea = $('#mascot-area');
  if (mascotArea) {
    mascotArea.className = `mascot-area ${mascotClass(p?.state)}`;
    const sprite = $('#mascot-sprite');
    if (sprite) {
      const file = MASCOT_BY_MOOD[mood] || MASCOT_BY_MOOD.idle;
      const hue = Number(p?.agent?.hue) || 0;
      sprite.innerHTML = `<img class="mascot-img" src="${ASSET_ROOT}/img/mascot/${file}" alt="" style="filter:hue-rotate(${hue}deg)">`;
    }
  }
  $('#state-updated').textContent = fmtAge(p?.updated_at || state.sourceUpdatedAt);

  const tools = p?.running_tools || [];

  renderToolFeed(tools, p);
  renderSubagents(p);
  renderAssistantMessage(p);
}

function renderToolFeed(tools, p) {
  const feed = $('#tool-feed');
  const currentIds = new Set(tools.map((t) => t.tool_use_id));
  const s = normState(p?.state);

  // Render prompt source as a transient feed item
  const promptId = '_prompt';
  const existingPrompt = feed.querySelector(`[data-tool-id="${promptId}"]`);
  const lp = p?.last_prompt;
  if (lp && lp.timestamp) {
    const promptAge = ageSec(lp.timestamp) ?? 0;
    const isNewPrompt = existingPrompt && existingPrompt.dataset.promptTs !== lp.timestamp;
    if (isNewPrompt) {
      existingPrompt.remove();
    }
    const current = isNewPrompt ? null : existingPrompt;
    if (promptAge < PROMPT_TRANSIENT_SECONDS) {
      if (!current) {
        const el = document.createElement('div');
        el.className = 'tool-feed-item prompt-source';
        el.dataset.toolId = promptId;
        el.dataset.promptTs = lp.timestamp;
        el.dataset.addedAt = String(Date.now());
        el.innerHTML = `<span class="mono tool-detail">${esc(lp.summary)}</span><span class="tool-status">${dur(promptAge)}</span>`;
        feed.prepend(el);
      } else {
        current.querySelector('.tool-status').textContent = dur(promptAge);
      }
    } else if (current && !current.classList.contains('done')) {
      current.classList.add('done');
      setTimeout(() => {
        if (current.parentNode) {
          current.classList.add('removing');
          current.addEventListener('animationend', () => current.remove(), { once: true });
        }
      }, 5000);
    }
  } else if (existingPrompt) {
    existingPrompt.remove();
  }

  for (const id of prevToolIds) {
    if (!currentIds.has(id)) {
      const el = feed.querySelector(`[data-tool-id="${id}"]`);
      if (el && !el.classList.contains('done')) {
        const statusEl = el.querySelector('.tool-status');
        if (statusEl) statusEl.textContent = '✓';
        const age = Date.now() - (Number(el.dataset.addedAt) || 0);
        const greyDelay = Math.max(0, 2000 - age);
        setTimeout(() => {
          el.classList.add('done');
          setTimeout(() => {
            if (el.parentNode) {
              el.classList.add('removing');
              el.addEventListener('animationend', () => el.remove(), { once: true });
            }
          }, 10000);
        }, greyDelay);
      }
    }
  }

  for (const tool of tools) {
    let el = feed.querySelector(`[data-tool-id="${tool.tool_use_id}"]`);
    const elapsed = ageSec(tool.started_at) ?? tool.duration_s ?? 0;
    const detail = tool.tool_detail ? `: ${esc(tool.tool_detail)}` : '';
    const label = `${esc(tool.tool_name || 'tool')}${detail}`;

    if (!el) {
      el = document.createElement('div');
      el.className = 'tool-feed-item';
      el.dataset.toolId = tool.tool_use_id;
      el.dataset.addedAt = String(Date.now());
      el.innerHTML = `<span class="mono tool-detail">${label}</span><span class="tool-status">${dur(elapsed)}</span>`;
      feed.appendChild(el);
    } else if (!el.classList.contains('done')) {
      el.querySelector('.tool-status').textContent = dur(elapsed);
    }
  }

  const thinkingId = '_thinking';
  const existingThinking = feed.querySelector(`[data-tool-id="${thinkingId}"]`);
  const shouldThink = s === 'BUSY' && tools.length === 0;
  if (shouldThink) {
    if (!existingThinking) {
      const el = document.createElement('div');
      el.className = 'tool-feed-item thinking';
      el.dataset.toolId = thinkingId;
      el.dataset.startedAt = new Date().toISOString();
      el.innerHTML = `<span class="mono tool-detail">${esc(t('activity.thinking'))}</span><span class="tool-status">0s</span>`;
      feed.appendChild(el);
    } else {
      const thinkAge = ageSec(existingThinking.dataset.startedAt) ?? 0;
      existingThinking.querySelector('.tool-status').textContent = dur(thinkAge);
    }
  } else if (existingThinking) {
    existingThinking.remove();
  }

  trimFeed(feed);

  const fallback = $('#activity-fallback');
  const hasItems = feed.querySelector('.tool-feed-item') !== null;
  if (hasItems || s === 'IDLE') {
    fallback.hidden = true;
  } else {
    fallback.hidden = false;
    if (s === 'OFFLINE') fallback.textContent = t('activity.offline');
    else if (s === 'WAITING_HUMAN') fallback.textContent = t('activity.waiting');
    else fallback.textContent = p?.reason || t('value.unavailable');
  }

  prevToolIds.clear();
  for (const id of currentIds) prevToolIds.add(id);
}

function trimFeed(feed) {
  const items = feed.querySelectorAll('.tool-feed-item');
  if (items.length <= FEED_MAX) return;
  const doneItems = [...items].filter((el) => el.classList.contains('done'));
  let excess = items.length - FEED_MAX;
  for (const el of doneItems) {
    if (excess <= 0) break;
    el.classList.add('removing');
    el.addEventListener('animationend', () => el.remove(), { once: true });
    excess--;
  }
}

// ─── Render: Assistant Message ───
function renderAssistantMessage(p) {
  const el = $('#assistant-message');
  const msg = p?.last_message;
  if (msg?.text) {
    el.textContent = msg.text;
    el.hidden = false;
  } else {
    el.hidden = true;
  }
}

// ─── Render: Subagents ───
const prevSubagentIds = new Set();

function subagentDiagnosticParts(agent) {
  const parts = [];
  if (agent.wait_timed_out || agent.failure_reason) {
    parts.push(t(`subagent.reason.${agent.failure_reason}`) || agent.failure_reason || t('subagent.wait_timed_out'));
  }
  if (agent.status === 'waiting' && agent.wait_duration_s != null) {
    parts.push(`${t('subagent.waiting_for')} ${dur(agent.wait_duration_s)}`);
  }
  if (agent.wait_timeout_ms != null) {
    parts.push(`${t('subagent.timeout')} ${fmtDuration(agent.wait_timeout_ms)}`);
  }
  if (agent.wait_latency_ms != null) {
    parts.push(`${t('subagent.wait_latency')} ${fmtDuration(agent.wait_latency_ms)}`);
  }
  return parts;
}

function subagentActivityHtml(agent) {
  const items = (agent.recent_activity || []).slice(-3);
  if (items.length === 0) return '';
  return `<div class="subagent-activity">${items.map((item) => {
    const age = item.timestamp ? fmtAge(item.timestamp) : '';
    return `<div class="subagent-activity-item"><span>${esc(item.summary || '')}</span><span>${esc(age)}</span></div>`;
  }).join('')}</div>`;
}

function compactSubagentText(value, limit = 80) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function renderSubagents(p) {
  const agents = p?.active_subagents || [];
  const section = $('#subagent-section');
  const list = $('#subagent-list');
  const badge = $('#subagent-count');

  const currentAgentIds = new Set(agents.map((a) => a.agent_id));

  const hasContent = agents.length > 0 ||
    list.querySelector('.subagent-group') !== null;
  section.classList.toggle('visible', hasContent);
  section.closest('.runtime-split')?.classList.toggle('has-subagents', hasContent);
  badge.textContent = String(agents.length);
  badge.hidden = agents.length === 0;

  for (const id of prevSubagentIds) {
    if (!currentAgentIds.has(id)) {
      const grp = list.querySelector(`[data-agent-id="${id}"]`);
      if (grp && !grp.classList.contains('done')) {
        const timeEl = grp.querySelector('.subagent-group-time');
        if (timeEl) timeEl.textContent = '✓';
        grp.classList.add('done');
        setTimeout(() => {
          if (grp.parentNode) {
            grp.classList.add('removing');
            grp.addEventListener('animationend', () => {
              grp.remove();
              if (!list.querySelector('.subagent-group')) {
                section.classList.remove('visible');
                section.closest('.runtime-split')?.classList.remove('has-subagents');
              }
            }, { once: true });
          }
        }, 10000);
      }
    }
  }

  for (const agent of agents) {
    let grp = list.querySelector(`[data-agent-id="${agent.agent_id}"]`);
    const label = compactSubagentText(agent.nickname || agent.description || agent.agent_type || t('activity.subagent'), 32);
    const shortId = agent.agent_id.slice(0, 7);
    const subtitleParts = [];
    if (agent.nickname && agent.description) subtitleParts.push(compactSubagentText(agent.description, 64));
    if (agent.agent_type && (agent.nickname || agent.description)) subtitleParts.push(agent.agent_type);
    if (agent.status && agent.status !== 'running') subtitleParts.push(agent.status);
    if (agent.last_activity && agent.last_activity !== 'Subagent started') subtitleParts.push(compactSubagentText(agent.last_activity, 48));
    const subtitle = compactSubagentText(subtitleParts.length ? subtitleParts.join(' · ') : shortId, 96);
    const labelHtml = `<span class="subagent-label-main">${esc(label)}</span><span class="subagent-label-sub">${esc(subtitle)}</span>`;
    const diagnostics = subagentDiagnosticParts(agent);
    const diagnosticsHtml = diagnostics.length
      ? `<div class="subagent-diagnostics">${diagnostics.map((part) => `<span>${esc(part)}</span>`).join('')}</div>`
      : '';

    if (!grp) {
      grp = document.createElement('div');
      grp.className = 'subagent-group';
      grp.dataset.agentId = agent.agent_id;
      grp.innerHTML =
        `<div class="subagent-group-head">` +
          `<span class="subagent-group-label">${labelHtml}</span>` +
          `<span class="subagent-group-time">${dur(agent.duration_s || 0)}</span>` +
        `</div>` +
        `<div class="subagent-diagnostics-slot">${diagnosticsHtml}</div>` +
        `<div class="subagent-activity-slot">${subagentActivityHtml(agent)}</div>` +
        `<div class="tool-feed"></div>`;
      list.appendChild(grp);
    } else if (!grp.classList.contains('done')) {
      grp.querySelector('.subagent-group-label').innerHTML = labelHtml;
      grp.querySelector('.subagent-group-time').textContent = dur(agent.duration_s || 0);
      grp.querySelector('.subagent-diagnostics-slot').innerHTML = diagnosticsHtml;
      grp.querySelector('.subagent-activity-slot').innerHTML = subagentActivityHtml(agent);
    }

    if (!grp.classList.contains('done')) {
      const feed = grp.querySelector('.tool-feed');
      const tools = agent.running_tools || [];
      const currentToolIds = new Set(tools.map((t) => t.tool_use_id));
      const existingItems = feed.querySelectorAll('.tool-feed-item');
      for (const el of existingItems) {
        if (!currentToolIds.has(el.dataset.toolId) && !el.classList.contains('done')) {
          const statusEl = el.querySelector('.tool-status');
          if (statusEl) statusEl.textContent = '✓';
          el.classList.add('done');
          setTimeout(() => {
            if (el.parentNode) {
              el.classList.add('removing');
              el.addEventListener('animationend', () => el.remove(), { once: true });
            }
          }, 5000);
        }
      }
      for (const tool of tools) {
        let el = feed.querySelector(`[data-tool-id="${tool.tool_use_id}"]`);
        const elapsed = ageSec(tool.started_at) ?? tool.duration_s ?? 0;
        const detail = tool.tool_detail ? `: ${esc(tool.tool_detail)}` : '';
        const toolLabel = `${esc(tool.tool_name || 'tool')}${detail}`;
        if (!el) {
          el = document.createElement('div');
          el.className = 'tool-feed-item';
          el.dataset.toolId = tool.tool_use_id;
          el.innerHTML = `<span class="mono tool-detail">${toolLabel}</span><span class="tool-status">${dur(elapsed)}</span>`;
          feed.appendChild(el);
        } else if (!el.classList.contains('done')) {
          el.querySelector('.tool-status').textContent = dur(elapsed);
        }
      }
      trimFeed(feed);
    }
  }

  prevSubagentIds.clear();
  currentAgentIds.forEach((id) => prevSubagentIds.add(id));
}

// ─── Render: Metrics ───
function renderMetrics() {
  const ctx = state.metrics.get('context_pct');
  const rate = state.metrics.get('rate_limit');
  const cost = state.metrics.get('session_cost') || state.metrics.get('daily_cost');

  const cv = metVal(ctx);
  const rv = metVal(rate);
  const ro = rv && typeof rv === 'object';
  const rate7d = state.metrics.get('rate_limit_7d');
  // A rate-limit reading whose window already reset is stale by definition —
  // statusline stops updating while the agent idles, so without this check a
  // final "100%" would keep painting red long after the quota refreshed (#224).
  const r5Expired = rateWindowExpired(rate?.dimensions?.rate_limit_resets_at ?? rate?.dimensions?.resets_at ?? rate?.resets_at);
  const r7Expired = rateWindowExpired(rate7d?.dimensions?.rate_limit_7d_resets_at ?? rate7d?.dimensions?.resets_at ?? rate7d?.resets_at);
  const r5 = r5Expired ? null : (ro ? (rv['5h'] ?? rv.five_hour ?? rv.short ?? rv.value) : rv);
  const r7 = r7Expired ? null : (metVal(rate7d) ?? (ro ? (rv['7d'] ?? rv.seven_day ?? rv.long) : null));

  $('#metric-context-value').textContent = pct(cv);
  const ctxBar = $('#metric-context-bar');
  const threshold = state.newSessionThreshold || 70;
  const cvNum = Number(cv);
  const cvAbs = Number.isFinite(cvNum) ? barPct(cvNum) : 0;
  ctxBar.style.width = `${barPct(cv)}%`;
  ctxBar.className = `progress-fill ${barColor(cv)}`;
  const thresholdMarker = $('#metric-context-threshold');
  if (thresholdMarker) {
    thresholdMarker.hidden = false;
    thresholdMarker.style.left = `${threshold}%`;
    thresholdMarker.title = t('metric.threshold_at', { value: threshold });
  }
  const thresholdLabel = $('#metric-context-threshold-label');
  if (thresholdLabel) {
    thresholdLabel.textContent = `${threshold}%`;
    thresholdLabel.style.left = `${threshold}%`;
  }
  $('#metric-context-source').textContent = srcLabel(ctx);

  $('#metric-rate-5h-value').textContent = r5 == null ? '--' : pct(r5);
  const r5Bar = $('#metric-rate-5h-bar');
  r5Bar.style.width = `${barPct(r5)}%`;
  r5Bar.className = `progress-fill ${barColor(r5)}`;

  $('#metric-rate-7d-value').textContent = r7 == null ? '--' : pct(r7);
  const r7Bar = $('#metric-rate-7d-bar');
  r7Bar.style.width = `${barPct(r7)}%`;
  r7Bar.className = `progress-fill ${barColor(r7)}`;

  // statusline_summary dims (post-#149 aggregation) use window-prefixed keys;
  // bare resets_at covers pre-aggregation rows still in the DB.
  const r5Reset = rate?.dimensions?.rate_limit_resets_at ?? rate?.dimensions?.resets_at ?? rate?.resets_at;
  const r7Reset = rate7d?.dimensions?.rate_limit_7d_resets_at ?? rate7d?.dimensions?.resets_at ?? rate7d?.resets_at;
  $('#metric-rate-5h-reset').textContent = r5Reset ? t('metric.resets', { time: fmtResetTime(r5Reset) }) : '';
  $('#metric-rate-7d-reset').textContent = r7Reset ? t('metric.resets', { time: fmtResetTime(r7Reset) }) : '';

  const agg = state.aggregated || {};
  const hasCostSession = agg.cost_session != null;
  $('#metric-cost-session').textContent = hasCostSession ? usd(agg.cost_session) : usd(metVal(cost));
  $('#metric-cost-today').textContent = agg.cost_today != null ? usd(agg.cost_today) : '--';
  $('#metric-cost-7d').textContent = agg['cost_7d'] != null ? usd(agg['cost_7d']) : '--';

  const costSessionLabel = $('#metric-cost-session-label');
  if (costSessionLabel) costSessionLabel.textContent = t('cost.session');

  // Tokens — stacked bar + cache ring
  const ts = agg.tokens_session;
  const tt = agg.tokens_today;
  const t7 = agg['tokens_7d'];
  const ttft = state.metrics.get('ttft');
  const turnDuration = state.metrics.get('turn_duration');

  // Session input/output stacked bar
  $('#metric-tokens-input').textContent = ts ? tok(ts.input) : '--';
  $('#metric-tokens-output').textContent = ts ? tok(ts.output) : '--';
  setTokenBar('tokens-bar', ts);

  // Cache hit ring
  const CACHE_RING_C = 2 * Math.PI * 22;
  const cacheEl = $('#cache-ring');
  if (cacheEl) {
    const cr = ts?.cache_rate; // 0-1 ratio by construction
    const cv = cr != null ? Math.max(0, Math.min(100, cr * 100)) : 0;
    cacheEl.style.strokeDasharray = CACHE_RING_C;
    cacheEl.style.strokeDashoffset = CACHE_RING_C * (1 - Math.min(100, cv) / 100);
  }
  $('#metric-tokens-cache').textContent = ts ? pctDecimal(ts.cache_rate) : '--';

  // Today / 7d rows
  const tokLine = (t) => t ? `↑${tok(t.input)} ↓${tok(t.output)}` : '--';
  $('#metric-tokens-today').textContent = tokLine(tt);
  $('#metric-tokens-7d').textContent = tokLine(t7);
  setTokenBar('tokens-bar-today', tt);
  setTokenBar('tokens-bar-7d', t7);

  const ttftEl = $('#metric-ttft');
  if (ttftEl) ttftEl.textContent = metVal(ttft) == null ? '--' : fmtDuration(metVal(ttft));
  const turnEl = $('#metric-turn-duration');
  if (turnEl) turnEl.textContent = metVal(turnDuration) == null ? '--' : fmtDuration(metVal(turnDuration));

  $('#metrics-updated').textContent = fmtAge(state.metricsUpdatedAt);
}

function setTokenBar(id, tokData) {
  const el = $(`#${id}`);
  if (!el || !tokData) return;
  const inp = Number(tokData.input) || 0;
  const out = Number(tokData.output) || 0;
  const total = inp + out;
  if (total === 0) return;
  const inputEl = el.querySelector('.tokens-bar-input');
  const outputEl = el.querySelector('.tokens-bar-output');
  if (inputEl) inputEl.style.width = `${(inp / total) * 100}%`;
  if (outputEl) outputEl.style.width = `${(out / total) * 100}%`;
}

// ─── Render: Health ───
const RING_CIRCUMFERENCE = 2 * Math.PI * 34; // r=34 → ~213.63

function ringLevel(pctVal) {
  if (pctVal >= 90) return 'level-danger';
  if (pctVal >= 70) return 'level-warn';
  return 'level-ok';
}

function ringLevelInverse(pctVal) {
  if (pctVal <= 50) return 'level-danger';
  if (pctVal <= 80) return 'level-warn';
  return 'level-ok';
}

function setRing(id, pctVal, levelFn) {
  const el = $(`#${id}`);
  if (!el) return;
  const v = Math.max(0, Math.min(100, pctVal));
  const offset = RING_CIRCUMFERENCE * (1 - v / 100);
  el.style.strokeDashoffset = offset;
  el.className.baseVal = `ring-fill ${(levelFn || ringLevel)(v)}`;
}

function renderHealth() {
  const sysResp = state.system || {};
  const sys = sysResp.system || sysResp;
  const pm2 = sysResp.pm2 || sys.pm2 || sys.pm2_services || sys.services || [];
  const svcs = Array.isArray(pm2) ? pm2 : (pm2.services || []);
  const svcStatus = (s) => String(s.status || s.pm2_env?.status || '').toLowerCase();
  const running = svcs.filter((s) => ['online', 'running', 'ok'].includes(svcStatus(s))).length;
  const total = svcs.length || Number(pm2.total) || 0;
  const downSvcs = svcs.filter((s) => !['online', 'running', 'ok'].includes(svcStatus(s)));

  const cpuVal = sys.cpu?.percent ?? sys.cpu_pct ?? sys.cpu;
  const memUsed = sys.memory?.used_bytes ?? sys.mem_used_bytes ?? sys.memory?.used ?? sys.memory;
  const memTotal = sys.memory?.total_bytes ?? sys.mem_total_bytes ?? sys.memory?.total;
  const diskVal = sys.disk?.used_pct ?? sys.disk_used_pct ?? sys.disk_pct ?? sys.disk?.percent ?? sys.disk;

  // PM2 — ring shows fraction (inverse color: green=high, red=low)
  const pm2Pct = total ? (running / total) * 100 : 0;
  $('#system-pm2').textContent = total ? `${running}/${total}` : '--';
  setRing('pm2-ring', pm2Pct, ringLevelInverse);
  const downList = $('#pm2-down-list');
  if (downList) {
    if (downSvcs.length > 0) {
      downList.textContent = '↓ ' + downSvcs.map((s) => s.name).join(', ');
      downList.className = 'gauge-detail alert';
    } else {
      downList.textContent = '';
      downList.className = 'gauge-detail';
    }
  }

  // CPU — retain last valid value when data is transiently missing
  const cpuResolved = resolveCpuDisplay(cpuVal, state.lastCpuPct);
  state.lastCpuPct = cpuResolved.lastGood;
  $('#system-cpu').textContent = cpuResolved.display;
  if (cpuResolved.lastGood !== null) {
    setRing('cpu-ring', cpuResolved.lastGood); // 0-100 percent; setRing clamps
  }

  // Memory — ring shows %, detail shows used/total
  const memDetail = $('#mem-detail');
  if (typeof memUsed === 'number' && memUsed > 100 && typeof memTotal === 'number' && memTotal > 0) {
    const memPctVal = (memUsed / memTotal) * 100;
    $('#system-memory').textContent = `${Math.round(memPctVal)}%`;
    setRing('mem-ring', memPctVal);
    if (memDetail) memDetail.textContent = `${bytes(memUsed)} / ${bytes(memTotal)}`;
  } else {
    $('#system-memory').textContent = typeof memUsed === 'number' && memUsed > 100 ? bytes(memUsed) : pct(memUsed);
    setRing('mem-ring', 0);
    if (memDetail) memDetail.textContent = '';
  }

  // Disk
  const diskPct = Number(diskVal);
  $('#system-disk').textContent = pct(diskVal);
  if (Number.isFinite(diskPct)) setRing('disk-ring', diskPct); // 0-100 percent; setRing clamps

  // Scheduler — timeline of upcoming tasks
  const sched = sysResp.scheduler;
  const schedCount = $('#scheduler-count');
  const schedTimeline = $('#scheduler-timeline');
  if (schedCount) {
    schedCount.textContent = sched?.pending ? t('sched.pending', { count: sched.pending }) : '';
  }
  if (schedTimeline) {
    const tasks = sched?.upcoming || [];
    if (tasks.length === 0) {
      schedTimeline.innerHTML = `<span class="gauge-detail">${esc(t('sched.no_pending'))}</span>`;
    } else {
      const now = Date.now();
      schedTimeline.innerHTML = tasks.map((task, i) => {
        const runAt = new Date(task.run_at);
        const isOverdue = runAt.getTime() < now;
        const time = runAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        const cls = isOverdue ? ' overdue' : '';
        const line = i < tasks.length - 1 ? '<div class="sched-line"></div>' : '';
        return `<div class="sched-item${cls}"><div class="sched-dot"></div><div class="sched-info"><div class="sched-time">${esc(time)}</div><div class="sched-name">${esc(task.name)}</div></div></div>${line}`;
      }).join('');
    }
  }

  $('#health-updated').textContent = fmtAge(state.healthUpdatedAt);
}

// ─── Render: Timeline ───
function fmtTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function timelineDotType(eventType) {
  if (eventType === 'session_start' || eventType === 'session_end') return 'session';
  if (eventType === 'turn_complete') return 'turn';
  if (eventType === 'user_prompt_submit') return 'prompt';
  if (eventType === 'assistant_message') return 'assistant';
  if (eventType === 'stop') return 'turn';
  if (eventType === 'permission_request') return 'permission';
  if (eventType === 'post_compact') return 'compact';
  if (eventType?.startsWith('subagent_')) return 'subagent';
  if (eventType === 'tool_call' || eventType === 'tool_result' || eventType === 'post_tool_use') return 'tool';
  return '';
}

function fmtDuration(ms) {
  if (ms == null || !Number.isFinite(Number(ms))) return '';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function timelineKind(event) {
  const type = event?.event_type || '';
  if (type === 'turn_complete') return t('timeline.kind.turn');
  if (type === 'session_start' || type === 'session_end') return t('timeline.kind.session');
  if (type === 'assistant_message') return t('timeline.kind.reply');
  if (type === 'user_prompt_submit') return t('timeline.kind.prompt');
  if (type === 'post_compact') return t('timeline.kind.compact');
  if (type === 'permission_request') return t('timeline.kind.permission');
  if (type === 'stop') return t('timeline.kind.turn');
  if (type === 'tool_call' || type === 'post_tool_use') return t('timeline.kind.tool');
  if (type === 'tool_result') return t('timeline.kind.done');
  if (type === 'subagent_start') return t('timeline.kind.subagent');
  if (type === 'subagent_update') return t('timeline.kind.subagent');
  if (type === 'subagent_stop') return t('timeline.kind.subagent');
  return type ? type.replace(/_/g, ' ') : '';
}

function timelineItemClass(event) {
  const type = event?.event_type || '';
  const classes = ['timeline-item'];
  const dot = timelineDotType(type);
  if (dot) classes.push(`timeline-item-${dot}`);
  if (type === 'turn_complete' || type === 'stop' || type === 'session_start' || type === 'session_end') {
    classes.push('timeline-boundary');
  }
  return classes.join(' ');
}

function renderTimeline() {
  const events = state.timeline || [];
  const gaps = state.timelineGaps || [];
  const container = $('#timeline-list');
  if (!events.length && !gaps.length) {
    container.innerHTML = `<p class="empty-state">${t('timeline.empty')}</p>`;
    return;
  }
  container.replaceChildren(...events.slice(0, 50).map((e) => {
    const el = document.createElement('div');
    el.className = timelineItemClass(e);
    const durStr = fmtDuration(e.duration_ms);
    const kind = timelineKind(e);
    el.innerHTML =
      `<span class="timeline-time">${fmtTime(e.timestamp)}</span>` +
      `<span class="timeline-dot" data-type="${timelineDotType(e.event_type)}"></span>` +
      `<span class="timeline-kind">${esc(kind)}</span>` +
      `<span class="timeline-summary">${esc(e.summary || e.event_type)}</span>` +
      `<span class="timeline-duration">${esc(durStr)}</span>`;
    return el;
  }));
  for (const gap of gaps) {
    const notice = document.createElement('p');
    notice.className = 'empty-state';
    notice.textContent = t('timeline.source_gap', { source: gap.name || gap.stream || 'Core', reason: gap.extra?.reason || gap.reason || 'unknown' });
    container.prepend(notice);
  }
  $('#timeline-updated').textContent = fmtAge(state.timelineUpdatedAt);
}


// ─── Render: Communication (inside Runtime) ───
const COMM_COLORS = ['#0d9488', '#6366f1', '#f59e0b', '#ef4444', '#8b5cf6', '#06b6d4', '#ec4899'];

function ageClass(ts) {
  const a = ageSec(ts);
  if (a === null) return 'age-normal';
  if (a < 60) return 'age-fresh';
  if (a < 3600) return 'age-normal';
  if (a < 86400) return 'age-stale';
  return 'age-old';
}

function renderComm() {
  const c = state.communication;
  const container = $('#comm-channels');
  if (!c || !Object.keys(c.channels || {}).length) {
    container.innerHTML = `<p class="empty-state">${t('comm.empty')}</p>`;
    $('#comm-pending').innerHTML = '';
    return;
  }

  const lastOb = c.last_outbound || {};
  const entries = Object.entries(c.channels).sort(([, a], [, b]) => (b.in + b.out) - (a.in + a.out));
  const maxTotal = Math.max(...entries.map(([, v]) => v.in + v.out), 1);

  container.replaceChildren(...entries.map(([ch, counts], i) => {
    const el = document.createElement('div');
    el.className = 'comm-row';
    const lastTs = lastOb[ch];
    const ageStr = lastTs ? fmtAge(lastTs) : '--';
    const total = counts.in + counts.out;
    const inPct = total ? (counts.in / total) * 100 : 50;
    const outPct = 100 - inPct;
    const color = COMM_COLORS[i % COMM_COLORS.length];
    el.innerHTML =
      `<span class="comm-dot" style="background:${color}"></span>` +
      `<span class="comm-channel">${esc(ch)}</span>` +
      `<span class="comm-bar-wrap">${counts.in}/${counts.out} <span class="comm-bar"><span class="comm-bar-in" style="width:${inPct}%"></span><span class="comm-bar-out" style="width:${outPct}%"></span></span></span>` +
      `<span class="comm-age ${ageClass(lastTs)}">${ageStr}</span>`;
    return el;
  }));

  const pendingEl = $('#comm-pending');
  const avgStr = c.avg_response_s != null ? `${t('comm.avg_response')}: ${dur(c.avg_response_s)}` : '';
  const pendingDepth = pendingDepthValue(c.pending_depth);
  const pendingStr = pendingDepth !== null && Number(pendingDepth) > 0
    ? `<span class="${c.pending_oldest_age_s > 300 ? 'warn' : ''}">${t('comm.pending')}: ${c.pending_depth}</span>` +
      (c.pending_oldest_age_s != null ? ` · ${t('comm.oldest')}: ${dur(c.pending_oldest_age_s)}` : '')
    : pendingDepth === '0' ? `${t('comm.pending')}: 0` : `${t('comm.pending')}: ${t('value.unknown')}`;
  pendingEl.innerHTML = [avgStr, pendingStr].filter(Boolean).join(' · ');

  $('#comm-updated').textContent = fmtAge(state.commUpdatedAt);
}

// Native title tooltips (e.g. the context chip) need the element under the
// cursor to survive ~1s, but the wall re-renders about once per second while
// any agent is busy (#188) and renderFleet() rebuilds the grid's DOM. Freeze
// rendering while the pointer is over the grid; apply the newest payload on
// leave. Side benefit: tiles don't jump while being read.
function setFleet(payload) {
  // Sound cues track the data path, not the render path: they must fire even
  // while hover-pause defers rendering. Re-applying a pending payload after
  // mouseleave is a no-op here (the mood map is already up to date).
  fleetSounds?.handleFleet(payload);
  state.fleet = payload;
  const modeChanged = state.fleetModeInitialized ? syncLiveFleetMode(payload) : false;
  if (state.fleetHoverPaused && !modeChanged) {
    state.pendingFleet = payload;
    return;
  }
  renderFleet();
}

let fleetSounds = null;

function initFleetSounds() {
  fleetSounds = createFleetSounds({
    button: $('#fleet-sound-toggle'),
    labels: () => ({
      soundOn: t('agent_fleet.sound_on'),
      soundOff: t('agent_fleet.sound_off')
    })
  });
}

function initFleetHoverPause() {
  const root = $('#agent-fleet-root');
  if (!root) return;
  root.addEventListener('mouseenter', () => { state.fleetHoverPaused = true; });
  root.addEventListener('mouseleave', () => {
    state.fleetHoverPaused = false;
    const pending = state.pendingFleet;
    state.pendingFleet = null;
    if (pending) setFleet(pending);
  });
}

function renderFleet() {
  const container = $('#agent-fleet-root');
  if (!container) return;
  renderAgentFleet(container, state.fleet, {
    basePath: BASE_PATH,
    mascotRoot: `${ASSET_ROOT}/img/mascot`,
    labels: agentFleetLabels()
  });
  const updated = $('#fleet-updated');
  if (updated) updated.textContent = fmtAge(state.fleet?.updated_at);
  fleetSounds?.refreshLabels();
}

function renderConnection(mode) {
  const pill = $('#connection-status');
  pill.dataset.state = mode;
  pill.textContent = t(`status.${mode}`);
}

function renderAll() {
  renderI18n();
  state.observer.history?.refreshLabels();
  initFleetManageButton();
  if (fleetManageModal) {
    const wasOpen = !fleetManageModal.hidden;
    const draft = {
      selfName: fleetManageModal.querySelector('#fleet-self-name')?.value || '',
      name: fleetManageModal.querySelector('#fleet-add-name')?.value || '',
      baseUrl: fleetManageModal.querySelector('#fleet-add-url')?.value || '',
      readKey: fleetManageModal.querySelector('#fleet-add-key')?.value || '',
      keyName: fleetManageModal.querySelector('#api-key-name')?.value || '',
      keyScope: fleetManageModal.querySelector('#api-key-scope')?.value || 'read',
      activeTab: fleetManageModal.querySelector('.modal-tab.active')?.dataset.tab || 'fleet',
      createdKey: fleetManageModal._createdKey || null
    };
    fleetManageModal.remove();
    fleetManageModal = null;
    if (wasOpen) openFleetManageModal(draft);
  }
  _lastRuntimeApplied = null;
  applyRuntimeVisibility();
  updateChartLabels();
  renderInfoBar();
  renderState();
  renderMetrics();
  renderHealth();
  renderTimeline();
  renderComm();
  renderFleet();
  renderMemory();
}

// ─── Data fetching ───
async function fetchJson(path) {
  const r = await fetch(api(agentPath(path)), { cache: 'no-store' });
  if (r.status === 401) {
    window.location.href = api('/login');
    throw new Error('unauthorized');
  }
  if (!r.ok) throw new Error(`${path} ${r.status}`);
  return r.json();
}

async function fetchAgentJson(path) {
  return requestAgentJson(path, { cache: 'no-store' });
}

async function requestAgentJson(path, options = {}) {
  const r = await fetch(api(agentPath(path)), {
    cache: 'no-store',
    ...options,
    headers: {
      ...(options.headers || {})
    }
  });
  if (r.status === 401) {
    window.location.href = api('/login');
    throw new Error('unauthorized');
  }
  if (!r.ok) {
    let payload = {};
    try { payload = await r.json(); } catch { /* ignore non-json errors */ }
    const err = new Error(payload.error || `${path} ${r.status}`);
    err.status = r.status;
    err.code = payload.error || null;
    err.current = payload.current || null;
    throw err;
  }
  return r.json();
}

function resetMemoryState() {
  if (state.memory?.draftTimer) clearTimeout(state.memory.draftTimer);
  stopMemoryLiveCheck();
  state.memory = {
    tree: null,
    selectedPath: null,
    file: null,
    git: null,
    mode: 'rendered',
    collapsed: new Set(),
    loading: false,
    error: null,
    editing: false,
    draft: '',
    draftNotice: false,
    dirty: false,
    saving: false,
    conflict: null,
    conflictRetryText: '',
    liveNotice: null,
    draftTimer: null,
    liveCheckTimer: null
  };
}

function fmtBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function memoryStatusMessage(code) {
  if (code === 'insufficient_scope') return t('memory.error_scope');
  if (code === 'memory_file_too_large') return t('memory.error_too_large');
  if (code === 'unsupported_memory_file') return t('memory.error_unsupported');
  if (code === 'invalid_memory_path') return t('memory.error_invalid_path');
  if (code === 'memory_file_not_found') return t('memory.error_not_found');
  if (code === 'memory_conflict') return t('memory.error_conflict');
  if (code === 'memory_conflict_latest_failed') return t('memory.error_conflict_latest_failed');
  if (code === 'invalid_memory_write') return t('memory.error_invalid_write');
  return t('memory.error_generic');
}

function memoryAgentKey() {
  return state.remoteAgent || REMOTE_AGENT || 'local';
}

function memoryDraftKey(filePath = state.memory.selectedPath) {
  if (!filePath) return null;
  return `zylos.memoryDraft.${memoryAgentKey()}.${filePath}`;
}

function saveMemoryDraft() {
  const key = memoryDraftKey();
  if (!key) return;
  try {
    if (state.memory.dirty) localStorage.setItem(key, state.memory.draft || '');
    else localStorage.removeItem(key);
  } catch {
    // Draft persistence is best-effort.
  }
}

function scheduleMemoryDraftSave() {
  if (state.memory.draftTimer) clearTimeout(state.memory.draftTimer);
  state.memory.draftTimer = setTimeout(() => {
    state.memory.draftTimer = null;
    saveMemoryDraft();
  }, 500);
}

function flushMemoryDraftSave() {
  if (state.memory?.draftTimer) {
    clearTimeout(state.memory.draftTimer);
    state.memory.draftTimer = null;
    saveMemoryDraft();
  }
}

function readMemoryDraft(filePath) {
  const key = memoryDraftKey(filePath);
  if (!key) return null;
  try {
    const value = localStorage.getItem(key);
    return value == null ? null : value;
  } catch {
    return null;
  }
}

function clearMemoryDraft(filePath = state.memory.selectedPath) {
  if (state.memory?.draftTimer) {
    clearTimeout(state.memory.draftTimer);
    state.memory.draftTimer = null;
  }
  const key = memoryDraftKey(filePath);
  if (!key) return;
  try { localStorage.removeItem(key); } catch { /* best-effort */ }
}

function stopMemoryLiveCheck() {
  if (state.memory?.liveCheckTimer) {
    clearInterval(state.memory.liveCheckTimer);
    state.memory.liveCheckTimer = null;
  }
}

function startMemoryLiveCheck() {
  stopMemoryLiveCheck();
  if (!state.memory.editing || !state.memory.file || state.memory.conflict || remoteIsReadOnly()) return;
  state.memory.liveCheckTimer = setInterval(() => {
    checkMemoryLiveSha().catch(() => {});
  }, 20_000);
}

async function checkMemoryLiveSha() {
  const file = state.memory.file;
  if (!state.memory.editing || !file?.path || state.memory.conflict || state.memory.saving || document.hidden) return;
  const latest = await fetchAgentJson(`/api/memory/file?path=${encodeURIComponent(file.path)}`);
  if (isCompleteMemoryFile(latest) && latest.sha256 !== file.sha256) {
    state.memory.liveNotice = latest;
    state.memory.conflict = buildMemoryConflict(latest, state.memory.draft, state.memory.draft);
    stopMemoryLiveCheck();
    renderMemory();
  }
}

function flattenMemoryFiles(node, files = []) {
  if (!node) return files;
  if (node.type === 'file') files.push(node);
  for (const child of node.children || []) flattenMemoryFiles(child, files);
  return files;
}

function preferredMemoryPath(root) {
  const files = flattenMemoryFiles(root).filter(f => f.renderable);
  return files.find(f => f.path === 'identity.md')?.path ||
    files.find(f => f.path?.endsWith('.md'))?.path ||
    files[0]?.path ||
    null;
}

// Chevron rotates 90° via the .expanded class — one icon, CSS owns the state.
const MEMORY_CARET_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>';
// Feather chevrons-down-up / chevrons-up-down for the fold-all toggle.
const MEMORY_FOLD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 20 5-5 5 5"/><path d="m7 4 5 5 5-5"/></svg>';
const MEMORY_UNFOLD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>';
const API_KEY_ROTATE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.74-5.95L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.74 5.95L3 16"/><path d="M3 21v-5h5"/></svg>';
const API_KEY_REVOKE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>';
const API_KEY_DELETE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

function collectMemoryDirPaths(node, out = []) {
  if (!node) return out;
  if (node.type === 'directory' && node.path) out.push(node.path);
  for (const child of node.children || []) collectMemoryDirPaths(child, out);
  return out;
}

function renderMemoryTreeNode(node, depth = 0) {
  if (!node) return '';
  if (node.type === 'directory') {
    const collapsed = node.path ? state.memory.collapsed.has(node.path) : false;
    const children = collapsed
      ? ''
      : (node.children || []).map(child => renderMemoryTreeNode(child, depth + 1)).join('');
    const label = node.path
      ? `<button class="memory-dir" type="button" data-dir="${esc(node.path)}" aria-expanded="${!collapsed}" style="padding-left:${8 + depth * 14}px"><span class="memory-dir-caret${collapsed ? '' : ' expanded'}">${MEMORY_CARET_ICON}</span>${esc(node.name)}</button>`
      : '';
    return `${label}${children}`;
  }
  const active = state.memory.selectedPath === node.path;
  const disabled = !node.renderable;
  const meta = [fmtBytes(node.size_bytes), fmtAge(node.mtime)].filter(Boolean).join(' · ');
  return `<button class="memory-file${active ? ' active' : ''}" type="button" data-path="${esc(node.path)}" style="padding-left:${8 + depth * 14}px"${disabled ? ' disabled' : ''}>
    <span class="memory-file-name">${esc(node.name)}</span>
    <span class="memory-file-meta">${esc(meta)}</span>
  </button>`;
}

// Memory content is semi-trusted (agent-written): html:false keeps raw HTML
// escaped, matching the XSS posture of the previous minimal renderer.
let markdownRenderer = null;

function getMarkdownRenderer() {
  if (!markdownRenderer && typeof window.markdownit === 'function') {
    markdownRenderer = window.markdownit({ html: false, linkify: true });
    const renderToken = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
    const defaultLinkOpen = markdownRenderer.renderer.rules.link_open || renderToken;
    markdownRenderer.renderer.rules.link_open = (tokens, idx, options, env, self) => {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultLinkOpen(tokens, idx, options, env, self);
    };
  }
  return markdownRenderer;
}

function renderMarkdown(text) {
  const source = String(text || '');
  const md = getMarkdownRenderer();
  // Vendored script failed to load: degrade to the escaped raw view.
  if (!md) return `<pre class="memory-raw"><code>${esc(source)}</code></pre>`;
  return md.render(source);
}

function isCompleteMemoryFile(value) {
  return !!value &&
    typeof value === 'object' &&
    typeof value.path === 'string' &&
    typeof value.sha256 === 'string' &&
    typeof value.text === 'string';
}

function memoryLineDiff(a, b) {
  const left = String(a || '').split('\n');
  const right = String(b || '').split('\n');
  const rows = [];
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) {
    rows.push({ type: 'same', text: left[prefix] });
    prefix++;
  }

  let leftEnd = left.length - 1;
  let rightEnd = right.length - 1;
  const suffix = [];
  while (leftEnd >= prefix && rightEnd >= prefix && left[leftEnd] === right[rightEnd]) {
    suffix.unshift({ type: 'same', text: left[leftEnd] });
    leftEnd--;
    rightEnd--;
  }

  const leftMid = left.slice(prefix, leftEnd + 1);
  const rightMid = right.slice(prefix, rightEnd + 1);
  if (leftMid.length * rightMid.length > 1_000_000) {
    if (leftMid.length || rightMid.length) {
      rows.push({
        type: 'summary',
        text: t('memory.diff_degraded', { mine: leftMid.length, theirs: rightMid.length })
      });
      for (const line of leftMid.slice(0, 80)) rows.push({ type: 'mine', text: line });
      for (const line of rightMid.slice(0, 80)) rows.push({ type: 'theirs', text: line });
    }
    return rows.concat(suffix);
  }

  const dp = Array.from({ length: leftMid.length + 1 }, () => Array(rightMid.length + 1).fill(0));
  for (let i = leftMid.length - 1; i >= 0; i--) {
    for (let j = rightMid.length - 1; j >= 0; j--) {
      dp[i][j] = leftMid[i] === rightMid[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < leftMid.length || j < rightMid.length) {
    if (i < leftMid.length && j < rightMid.length && leftMid[i] === rightMid[j]) {
      rows.push({ type: 'same', text: leftMid[i] });
      i++;
      j++;
    } else if (j < rightMid.length && (i >= leftMid.length || dp[i][j + 1] >= dp[i + 1][j])) {
      rows.push({ type: 'theirs', text: rightMid[j++] });
    } else if (i < leftMid.length) {
      rows.push({ type: 'mine', text: leftMid[i++] });
    }
  }
  return rows.concat(suffix);
}

function buildMemoryConflict(theirs, mine, manual = mine) {
  return {
    theirs,
    mine: String(mine || ''),
    manual: String(manual || ''),
    diff: memoryLineDiff(mine, theirs?.text || '')
  };
}

function renderMemoryConflict(conflict) {
  if (!conflict) return '';
  const diff = conflict.diff || [];
  const truncated = diff.length > 240;
  const rows = diff.slice(0, 240).map(row =>
    `<div class="memory-diff-row ${row.type}"><span>${row.type === 'same' ? ' ' : row.type === 'mine' ? '-' : row.type === 'theirs' ? '+' : '!'}</span><code>${esc(row.text)}</code></div>`
  ).join('');
  const notice = truncated ? `<div class="memory-diff-note">${esc(t('memory.diff_truncated', { count: diff.length - 240 }))}</div>` : '';
  return `<section class="memory-conflict" id="memory-conflict">
    <div class="memory-conflict-head">
      <strong>${esc(t('memory.conflict_title'))}</strong>
      <span>${esc(t('memory.conflict_body'))}</span>
    </div>
    <div class="memory-conflict-actions">
      <button class="memory-action" type="button" data-memory-conflict="mine">${esc(t('memory.use_mine'))}</button>
      <button class="memory-action" type="button" data-memory-conflict="theirs">${esc(t('memory.take_theirs'))}</button>
      <button class="memory-action primary" type="button" data-memory-conflict="manual">${esc(t('memory.manual_merge'))}</button>
    </div>
    <div class="memory-diff">${rows}${notice}</div>
  </section>`;
}

function renderMemoryContent() {
  const content = $('#memory-content');
  if (!content) return;
  const file = state.memory.file;
  if (!file) {
    content.innerHTML = `<p class="empty-state">${esc(t('memory.empty'))}</p>`;
    return;
  }
  if (state.memory.editing) {
    const conflict = renderMemoryConflict(state.memory.conflict);
    const notice = state.memory.draftNotice
      ? `<div class="memory-notice">${esc(t('memory.draft_restored'))} <button type="button" data-memory-discard-draft>${esc(t('memory.discard_draft'))}</button></div>`
      : '';
    const live = state.memory.liveNotice
      ? `<div class="memory-notice warning">${esc(t('memory.live_changed'))}</div>`
      : '';
    const retry = state.memory.error === 'memory_conflict_latest_failed'
      ? `<div class="memory-notice warning">${esc(t('memory.conflict_retry_body'))} <button type="button" data-memory-retry-conflict>${esc(t('memory.retry'))}</button></div>`
      : '';
    content.innerHTML = `${notice}${live}${retry}${conflict}<textarea class="memory-editor" id="memory-editor" spellcheck="false">${esc(state.memory.draft)}</textarea>`;
    const editor = $('#memory-editor');
    editor?.addEventListener('input', () => {
      state.memory.draft = editor.value;
      state.memory.dirty = state.memory.file ? state.memory.draft !== state.memory.file.text : true;
      state.memory.draftNotice = false;
      scheduleMemoryDraftSave();
      renderMemoryActions();
    });
    content.querySelector('[data-memory-discard-draft]')?.addEventListener('click', () => {
      clearMemoryDraft();
      state.memory.draft = state.memory.file?.text || '';
      state.memory.dirty = false;
      state.memory.draftNotice = false;
      clearMemoryDraft();
      renderMemory();
    });
    content.querySelector('[data-memory-retry-conflict]')?.addEventListener('click', () => {
      saveMemoryDraftToServer({ text: state.memory.conflictRetryText || state.memory.draft }).catch(() => {});
    });
    content.querySelectorAll('[data-memory-conflict]').forEach((btn) => {
      btn.addEventListener('click', () => resolveMemoryConflict(btn.dataset.memoryConflict).catch(() => {}));
    });
  } else if (state.memory.mode === 'raw' || !file.markdown) {
    content.innerHTML = `<pre class="memory-raw"><code>${esc(file.text)}</code></pre>`;
  } else {
    content.innerHTML = `<article class="memory-markdown">${renderMarkdown(file.text)}</article>`;
  }
}

function renderMemoryActions() {
  const file = state.memory.file;
  const editing = !!state.memory.editing;
  const editBtn = $('#memory-edit-btn');
  const saveBtn = $('#memory-save-btn');
  const resetBtn = $('#memory-reset-btn');
  if (editBtn) {
    editBtn.hidden = editing || !file || remoteIsReadOnly();
    editBtn.disabled = !file || state.memory.loading || state.memory.saving;
  }
  if (saveBtn) {
    saveBtn.hidden = !editing;
    saveBtn.disabled = state.memory.saving || !state.memory.dirty || !!state.memory.conflict;
    saveBtn.textContent = state.memory.saving ? t('memory.saving') : t('memory.save');
  }
  if (resetBtn) {
    resetBtn.hidden = !editing;
    resetBtn.disabled = state.memory.saving;
  }
  $('#memory-rendered-btn')?.toggleAttribute('disabled', editing);
  $('#memory-raw-btn')?.toggleAttribute('disabled', editing);
}

function renderMemory() {
  const tab = $('[data-tab="memory"]');
  const tree = $('#memory-tree');
  const title = $('#memory-file-title');
  const meta = $('#memory-meta');
  const status = $('#memory-status');
  const content = $('#memory-content');
  const renderedBtn = $('#memory-rendered-btn');
  const rawBtn = $('#memory-raw-btn');
  if (!tree || !title || !meta || !status || !content) return;

  const readOnly = remoteIsReadOnly();
  if (tab) {
    tab.disabled = readOnly;
    tab.title = readOnly ? t('memory.remote_read_only') : '';
  }
  renderedBtn?.classList.toggle('active', state.memory.mode === 'rendered');
  rawBtn?.classList.toggle('active', state.memory.mode === 'raw');
  renderMemoryActions();

  if (readOnly) {
    tree.innerHTML = '';
    title.textContent = t('memory.title');
    meta.textContent = '';
    status.textContent = t('memory.remote_read_only');
    status.hidden = false;
    content.innerHTML = '';
    renderMemoryActions();
    return;
  }

  if (state.memory.loading) {
    status.textContent = t('memory.loading');
    status.hidden = false;
  } else if (state.memory.error) {
    status.textContent = memoryStatusMessage(state.memory.error);
    status.hidden = false;
  } else {
    status.textContent = '';
    status.hidden = true;
  }

  tree.innerHTML = state.memory.tree ? renderMemoryTreeNode(state.memory.tree.root) : `<p class="empty-state">${esc(t('memory.loading'))}</p>`;
  tree.querySelectorAll('.memory-file').forEach((btn) => {
    btn.addEventListener('click', () => openMemoryFile(btn.dataset.path).catch(() => {}));
  });
  tree.querySelectorAll('.memory-dir').forEach((btn) => {
    btn.addEventListener('click', () => {
      const dir = btn.dataset.dir;
      if (!dir) return;
      if (state.memory.collapsed.has(dir)) state.memory.collapsed.delete(dir);
      else state.memory.collapsed.add(dir);
      renderMemory();
    });
  });
  const fold = $('#memory-fold');
  if (fold) {
    const dirs = collectMemoryDirPaths(state.memory.tree?.root);
    const allCollapsed = dirs.length > 0 && dirs.every(d => state.memory.collapsed.has(d));
    fold.disabled = dirs.length === 0;
    fold.innerHTML = allCollapsed ? MEMORY_UNFOLD_ICON : MEMORY_FOLD_ICON;
    fold.title = allCollapsed ? t('memory.expand_all') : t('memory.collapse_all');
    fold.setAttribute('aria-label', fold.title);
  }

  const file = state.memory.file;
  if (!file) {
    title.textContent = t('memory.select_file');
    meta.textContent = '';
  } else {
    title.textContent = file.path;
    const commit = state.memory.git?.commit;
    const parts = [
      fmtBytes(file.size_bytes),
      fmtAge(file.mtime),
      file.sha256 ? `sha ${file.sha256.slice(0, 8)}` : '',
      commit ? `${commit.short_hash} ${commit.subject}` : t('memory.no_commit')
    ].filter(Boolean);
    meta.textContent = parts.join(' · ');
  }
  renderMemoryContent();
  renderMemoryActions();
}

async function loadMemoryTree({ force = false } = {}) {
  if (remoteIsReadOnly()) {
    renderMemory();
    return;
  }
  if (state.memory.tree && !force) {
    renderMemory();
    return;
  }
  state.memory.loading = true;
  state.memory.error = null;
  renderMemory();
  try {
    state.memory.tree = await fetchAgentJson('/api/memory/tree');
    const selected = state.memory.selectedPath || preferredMemoryPath(state.memory.tree?.root);
    if (selected) await openMemoryFile(selected);
  } catch (err) {
    state.memory.error = err.code || 'memory_browser_failed';
  } finally {
    state.memory.loading = false;
    renderMemory();
  }
}

async function openMemoryFile(filePath) {
  if (!filePath || remoteIsReadOnly()) return;
  flushMemoryDraftSave();
  stopMemoryLiveCheck();
  state.memory.selectedPath = filePath;
  state.memory.file = null;
  state.memory.git = null;
  state.memory.loading = true;
  state.memory.error = null;
  state.memory.editing = false;
  state.memory.draft = '';
  state.memory.draftNotice = false;
  state.memory.dirty = false;
  state.memory.conflict = null;
  state.memory.conflictRetryText = '';
  state.memory.liveNotice = null;
  renderMemory();
  try {
    const encoded = encodeURIComponent(filePath);
    const [file, git] = await Promise.all([
      fetchAgentJson(`/api/memory/file?path=${encoded}`),
      fetchAgentJson(`/api/memory/git?path=${encoded}`).catch(() => ({ commit: null }))
    ]);
    state.memory.file = file;
    state.memory.git = git;
    state.memory.error = null;
    const draft = readMemoryDraft(file.path);
    if (draft != null && draft !== file.text) {
      state.memory.editing = true;
      state.memory.draft = draft;
      state.memory.draftNotice = true;
      state.memory.dirty = true;
      startMemoryLiveCheck();
    } else if (draft != null) {
      clearMemoryDraft(file.path);
    }
  } catch (err) {
    state.memory.error = err.code || 'memory_browser_failed';
  } finally {
    state.memory.loading = false;
    renderMemory();
  }
}

function startMemoryEdit() {
  if (!state.memory.file || remoteIsReadOnly()) return;
  state.memory.editing = true;
  state.memory.draft = state.memory.draft || state.memory.file.text || '';
  state.memory.dirty = state.memory.draft !== state.memory.file.text;
  state.memory.conflict = null;
  state.memory.liveNotice = null;
  startMemoryLiveCheck();
  renderMemory();
}

function resetMemoryEdit() {
  if (!state.memory.file) return;
  state.memory.editing = false;
  state.memory.draft = '';
  state.memory.draftNotice = false;
  state.memory.dirty = false;
  state.memory.conflict = null;
  state.memory.conflictRetryText = '';
  state.memory.liveNotice = null;
  clearMemoryDraft();
  stopMemoryLiveCheck();
  renderMemory();
}

async function saveMemoryDraftToServer({ text = state.memory.draft, sha256 = state.memory.file?.sha256 } = {}) {
  const file = state.memory.file;
  if (!file?.path || !sha256) return;
  flushMemoryDraftSave();
  state.memory.saving = true;
  state.memory.error = null;
  renderMemoryActions();
  try {
    const saved = await requestAgentJson(`/api/memory/file?path=${encodeURIComponent(file.path)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, sha256 })
    });
    state.memory.file = saved;
    state.memory.draft = saved.text;
    state.memory.dirty = false;
    state.memory.editing = false;
    state.memory.conflict = null;
    state.memory.conflictRetryText = '';
    state.memory.liveNotice = null;
    clearMemoryDraft(saved.path);
    state.memory.git = await fetchAgentJson(`/api/memory/git?path=${encodeURIComponent(saved.path)}`).catch(() => ({ commit: null }));
    await loadMemoryTree({ force: true });
  } catch (err) {
    if (err.code === 'memory_conflict') {
      const latest = await fetchAgentJson(`/api/memory/file?path=${encodeURIComponent(file.path)}`).catch(() => null);
      if (isCompleteMemoryFile(latest)) {
        state.memory.conflict = buildMemoryConflict(latest, text, text);
        state.memory.liveNotice = latest;
        state.memory.conflictRetryText = '';
      } else {
        state.memory.conflict = null;
        state.memory.conflictRetryText = String(text || '');
        state.memory.error = 'memory_conflict_latest_failed';
        renderMemory();
        return;
      }
    }
    state.memory.error = err.code || 'memory_browser_failed';
    renderMemory();
  } finally {
    state.memory.saving = false;
    renderMemory();
  }
}

async function resolveMemoryConflict(action) {
  const conflict = state.memory.conflict;
  if (!isCompleteMemoryFile(conflict?.theirs)) return;
  if (action === 'theirs') {
    state.memory.file = conflict.theirs;
    state.memory.draft = conflict.theirs.text;
    state.memory.dirty = false;
    state.memory.editing = false;
    state.memory.conflict = null;
    state.memory.conflictRetryText = '';
    state.memory.liveNotice = null;
    clearMemoryDraft(conflict.theirs.path);
    state.memory.git = await fetchAgentJson(`/api/memory/git?path=${encodeURIComponent(conflict.theirs.path)}`).catch(() => ({ commit: null }));
    renderMemory();
    return;
  }
  const text = action === 'manual' ? state.memory.draft : conflict.mine;
  await saveMemoryDraftToServer({ text, sha256: conflict.theirs.sha256 });
}

async function refreshState() {
  const data = await refreshDashboardState(state, fetchJson);
  if (!data) return;
  state.sourceUpdatedAt = data.updated_at || new Date().toISOString();
  if (data.new_session_threshold) {
    state.newSessionThreshold = data.new_session_threshold;
  }
  applyRuntimeVisibility();
  renderInfoBar();
  renderState();
  renderHealth();
}

async function refreshMetrics() {
  const target = captureMetricTarget(state);
  const stillCurrent = () => isMetricTargetCurrent(state, target);
  const results = await Promise.allSettled(METRICS.map(async (n) => [n, await fetchJson(`/api/metrics/${n}`)]));
  if (!stillCurrent()) return;
  let changed = false;
  for (const r of results) {
    if (r.status === 'fulfilled') { state.metrics.set(r.value[0], r.value[1]); changed = true; }
  }
  try {
    const aggKeys = [
      ['cost', 'session'], ['cost', 'today'], ['cost', '7d'],
      ['tokens', 'session'], ['tokens', 'today'], ['tokens', '7d']
    ];
    const aggResults = await Promise.allSettled(aggKeys.map(([m, p]) => fetchJson(`/api/metrics/aggregate?metric=${m}&period=${p}`)));
    if (!stillCurrent()) return;
    state.aggregated = {};
    aggKeys.forEach(([m, p], i) => {
      const r = aggResults[i];
      state.aggregated[`${m}_${p}`] = r.status === 'fulfilled' ? (r.value?.value ?? null) : null;
    });
    changed = true;
  } catch { /* aggregation endpoints not available yet */ }
  if (changed) {
    state.metricsUpdatedAt = new Date().toISOString();
    renderMetrics();
  }
}

async function refreshHealth() {
  const [h, s] = await Promise.allSettled([fetchJson('/api/health'), fetchJson('/api/system')]);
  if (h.status === 'fulfilled') state.health = h.value;
  if (s.status === 'fulfilled') state.system = s.value;
  state.healthUpdatedAt = new Date().toISOString();
  renderHealth();
}

async function refreshTimeline() {
  const since = new Date(Date.now() - 30 * 60_000).toISOString();
  const data = await fetchJson(`/api/timeline?since=${since}&limit=200&order=desc`);
  if (!data || typeof data !== 'object') return;
  state.timelineGaps = data.gaps || [];
  state.timeline = (data.events || []).filter((e) => (
    e.event_type !== 'pre_tool_use' &&
    e.event_type !== 'tool_result'
  ));
  state.timelineUpdatedAt = new Date().toISOString();
  renderTimeline();
}

async function refreshSummary() {
  state.summary = await fetchJson('/api/summary');
  state.summaryUpdatedAt = new Date().toISOString();
}

async function refreshComm() {
  state.communication = await fetchJson('/api/communication');
  state.commUpdatedAt = new Date().toISOString();
  renderComm();
}

function isSseOpen() {
  return !!window.EventSource && state.eventSource?.readyState === window.EventSource.OPEN;
}

async function refreshFleet() {
  try {
    const fleet = await fetchJson('/api/fleet');
    setFleet(fleet);
    renderConnection(isSseOpen() ? 'live' : 'polling');
    return fleet;
  } catch (err) {
    renderConnection('degraded');
    throw err;
  }
}

function setObserverNotice(message, status = 'idle') {
  const notice = $('#observer-notice');
  if (!notice) return;
  notice.textContent = message;
  notice.dataset.state = status;
}

function observerTargetKey() {
  const standaloneAgent = typeof REMOTE_AGENT === 'undefined' ? '' : REMOTE_AGENT;
  return `${state.remoteAgent || standaloneAgent || 'local'}\u0000${observerEndpoint('/api/observer')}`;
}

function observerSessionCurrent(generation, targetKey) {
  return state.observer.generation === generation && observerTargetKey() === targetKey;
}

function setObserverSizeStatus(message, status = 'idle') {
  const el = $('#observer-size-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = status;
}

const OBSERVER_SIZE_ERRORS = new Set(['invalid_size', 'agent_session_unavailable', 'observer_starting', 'agent_resize_failed']);

function observerSizeError(code, maxRows) {
  if (code === 'invalid_size' && Number.isInteger(maxRows)) return t('observer.size.error.rows_limit', { maxRows });
  return OBSERVER_SIZE_ERRORS.has(code) ? t(`observer.size.error.${code}`) : t('observer.size.failed', { code });
}

// Inputs are filled once per target so status refreshes never clobber edits.
// Producers without agentSize in their status predate Set size: hide it.
function renderObserverSizeForm(status = state.observer.status) {
  const form = $('#observer-size-form');
  if (!form) return;
  form.hidden = Boolean(state.observer.historyMode) || !validAgentSize(status?.agentSize);
  const apply = $('#observer-size-apply');
  if (apply) apply.disabled = remoteIsReadOnly() || Boolean(state.observer.sizePending);
  const targetKey = observerTargetKey();
  if (form.hidden || form.dataset.targetKey === targetKey) return;
  form.dataset.targetKey = targetKey;
  $('#observer-size-cols').value = String(status.agentSize.cols);
  $('#observer-size-rows').value = String(status.agentSize.rows);
  setObserverSizeStatus('');
}

async function applyObserverSize(event) {
  event.preventDefault();
  if (remoteIsReadOnly() || state.observer.sizePending) return;
  const size = {
    cols: Number($('#observer-size-cols')?.value),
    rows: Number($('#observer-size-rows')?.value)
  };
  if (!validAgentSize(size)) {
    setObserverSizeStatus(t('observer.size.error.invalid_size'), 'error');
    return;
  }
  const targetKey = observerTargetKey();
  const pending = state.observer.sizePending = { targetKey };
  renderObserverSizeForm();
  setObserverSizeStatus(t('observer.size.applying'), 'pending');
  try {
    const resp = await fetch(observerEndpoint('/api/observer/agent-size'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(size)
    });
    const data = await resp.json().catch(() => ({}));
    if (observerTargetKey() !== targetKey) return;
    if (!resp.ok || !validAgentSize(data.agentSize)) {
      setObserverSizeStatus(observerSizeError(data.error || `http_${resp.status}`, data.maxRows), 'error');
      return;
    }
    if (state.observer.status) state.observer.status.agentSize = data.agentSize;
    setObserverSizeStatus(t('observer.size.applied', data.agentSize), 'done');
  } catch {
    if (observerTargetKey() === targetKey) setObserverSizeStatus(observerSizeError('network'), 'error');
  } finally {
    if (state.observer.sizePending === pending) state.observer.sizePending = null;
    renderObserverSizeForm();
  }
}

function syncObserverSize(size) {
  if (!validObserverSize(size)) return;
  state.observer.channel?.postMessage({ type: 'size', cols: size.cols, rows: size.rows });
}

function syncObserverMetrics(iframe, metrics) {
  if (![metrics.width, metrics.height].every(value => Number.isFinite(value) && value > 0 && value <= 20000)) return;
  iframe.style.width = `max(100%, ${Math.ceil(metrics.width)}px)`;
  iframe.style.height = `max(100%, ${Math.ceil(metrics.height)}px)`;
}

function releaseObserverLease(endpoints, lease) {
  if (!lease?.id || !endpoints?.api) return;
  fetch(`${endpoints.api}/leases/${encodeURIComponent(lease.id)}/release`, {
    method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }
  }).catch(() => {});
}

function observerRequestError(data, status) {
  return Object.assign(new Error(data.error || t('observer.connect_failed')), { code: data.error, status });
}

function observerRetryable(error) {
  if ([401, 403].includes(error?.status)) return false;
  if (error?.status === 429) return true;
  return !error?.code && !error?.status ||
    ['upstream_unreachable', 'target_unavailable', 'target_size_changed', 'operation_obsolete', 'lease_not_found', 'lease_expired', 'lease_mismatch', 'pong_timeout', 'lease_invalid'].includes(error?.code);
}

async function recoverObserver(error) {
  const observer = state.observer;
  const intent = observer.intent;
  if (!intent || intent.targetKey !== observerTargetKey()) return;
  const retry = observerRetryable(error);
  await closeObserver({ preserveNotice: true, preserveIntent: retry });
  if (!retry) {
    setObserverNotice(error?.code === 'auth_expired' ? t('observer.session_expired') : error?.message || t('observer.not_available'), 'error');
    return;
  }
  if (observer.intent !== intent) return;
  setObserverNotice(t('observer.waiting_for_agent'), 'connecting');
  const delay = [1000, 2000, 4000, 8000, 15000][Math.min(intent.attempt++, 4)];
  observer.retryTimer = setTimeout(() => {
    observer.retryTimer = null;
    if (observer.intent === intent && intent.targetKey === observerTargetKey()) openObserver().catch(() => {});
  }, delay);
}

async function closeObserver({ release = true, preserveNotice = false, preserveIntent = false } = {}) {
  const observer = state.observer;
  if (!preserveIntent) observer.history?.setActive(false);
  clearTimeout(observer.retryTimer);
  observer.retryTimer = null;
  if (!preserveIntent) observer.intent = null;
  observer.abort?.abort();
  observer.abort = null;
  observer.generation = (Number.isInteger(observer.generation) ? observer.generation : 0) + 1;
  clearInterval(observer.renewTimer);
  observer.renewTimer = null;
  const lease = observer.lease;
  const endpoints = observer.endpointPrefix;
  observer.lease = null;
  observer.endpointPrefix = null;
  observer.opening = false;
  const ws = observer.ws;
  observer.ws = null;
  try { ws?.close(1000, 'viewer_closed'); } catch {}
  try { observer.channel?.postMessage({ type: 'shutdown' }); } catch {}
  try { observer.channel?.close(); } catch {}
  observer.channel = null;
  if (observer.iframe) {
    observer.iframe.srcdoc = '';
    observer.iframe.style.width = '';
    observer.iframe.style.height = '';
  }
  observer.iframe = null;
  if (release) releaseObserverLease(endpoints, lease);
  if (!preserveNotice) setObserverNotice(t('observer.closed'), 'idle');
}

async function renewObserverLease(generation, targetKey, lease, endpointPrefix) {
  if (!lease?.id || !endpointPrefix?.api) return;
  const resp = await fetch(`${endpointPrefix.api}/leases/${encodeURIComponent(lease.id)}/renew`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw observerRequestError(data, resp.status);
  if (!observerSessionCurrent(generation, targetKey) || state.observer.lease?.id !== lease.id) return;
  state.observer.lease = data;
}

async function openObserver() {
  const observer = state.observer;
  if (observer.opening || observer.lease) return;
  clearTimeout(observer.retryTimer);
  observer.retryTimer = null;
  if (!observer.intent) observer.intent = { targetKey: observerTargetKey(), attempt: 0 };
  const abort = typeof AbortController === 'function' ? new AbortController() : null;
  observer.abort = abort;
  const generation = observer.generation = (Number.isInteger(observer.generation) ? observer.generation : 0) + 1;
  const targetKey = observerTargetKey();
  const endpoints = {
    api: observerEndpoint('/api/observer'),
    frame: observerEndpoint('/observer/frame'),
    stream: observerEndpoint('/observer/stream')
  };
  observer.opening = true;
  setObserverNotice(t('observer.connecting'), 'connecting');
  try {
    let status = await refreshObserverStatus({ signal: abort?.signal });
    // A same-target refresh may supersede our request. Follow the current
    // request, including further supersessions, without abandoning the open.
    while (!status && observerSessionCurrent(generation, targetKey)) {
      const request = observer.statusRequest;
      if (!request || request.targetKey !== targetKey) break;
      status = await request.promise;
      if (request === observer.statusRequest) break;
      status = null;
    }
    if (!observerSessionCurrent(generation, targetKey)) return;
    if (status?.state !== 'installed' || status.desired?.enabled !== true || observerRecoveryReason(status)) {
      throw Object.assign(new Error(t(observerRecoveryReason(status) ? 'observer.recovery_hint' : 'observer.not_available')), { code: 'observer_unavailable' });
    }
    observer.endpointPrefix = endpoints;
    // Keep lease acquisition observable after cancellation so a late ID can be
    // released against its original target. Frame/status fetches are abortable.
    const leaseResp = await fetch(`${endpoints.api}/leases`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }
    });
    const lease = await leaseResp.json().catch(() => ({}));
    if (!leaseResp.ok) throw observerRequestError(lease, leaseResp.status);
    if (!observerSessionCurrent(generation, targetKey)) {
      releaseObserverLease(endpoints, lease);
      return;
    }
    observer.lease = lease;

    const frameResp = await fetch(endpoints.frame, { signal: abort?.signal, headers: { 'X-Observer-Lease': lease.id } });
    if (!frameResp.ok) {
      const data = await frameResp.json().catch(() => ({}));
      throw observerRequestError(data, frameResp.status);
    }
    const frameDocument = await frameResp.text();
    if (!observerSessionCurrent(generation, targetKey) || observer.lease?.id !== lease.id) return;
    const iframe = $('#observer-frame');
    observer.iframe = iframe;
    const messageChannel = new MessageChannel();
    observer.channel = messageChannel.port1;
    let frameReadyResolve;
    const frameReady = new Promise(resolve => { frameReadyResolve = resolve; });
    const frameReadyTimer = setTimeout(() => frameReadyResolve(false), 5000);
    const cancelFrameWait = () => frameReadyResolve(false);
    abort?.signal.addEventListener('abort', cancelFrameWait, { once: true });
    messageChannel.port1.onmessage = ({ data }) => {
      if (!observerSessionCurrent(generation, targetKey) || observer.lease?.id !== lease.id || observer.iframe !== iframe) return;
      if (data?.type === 'ready') { frameReadyResolve(true); setObserverNotice(t('observer.live_read_only'), 'live'); }
      else if (data?.type === 'metrics') syncObserverMetrics(iframe, data);
    };
    messageChannel.port1.start();
    iframe.onload = () => {
      if (!observerSessionCurrent(generation, targetKey) || observer.iframe !== iframe || !iframe.contentWindow) return;
      iframe.contentWindow.postMessage({ type: 'observer-init' }, '*', [messageChannel.port2]);
    };
    iframe.srcdoc = frameDocument;
    const ready = await frameReady;
    clearTimeout(frameReadyTimer);
    abort?.signal.removeEventListener('abort', cancelFrameWait);
    if (!observerSessionCurrent(generation, targetKey) || observer.lease?.id !== lease.id || observer.iframe !== iframe) return;
    if (!ready) throw new Error(t('observer.connect_failed'));

    const streamUrl = new URL(endpoints.stream, window.location.href);
    streamUrl.protocol = streamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    // Renewal replaces the stored lease, so use its newest one-time ticket.
    const ticket = observer.lease?.ticket;
    const ws = new WebSocket(streamUrl, ['zylos-observer-v1', `lease.${lease.id}`, ...(ticket ? [`ticket.${ticket}`] : [])]);
    observer.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onmessage = (event) => {
      if (!observerSessionCurrent(generation, targetKey) || observer.ws !== ws) return;
      if (typeof event.data === 'string') {
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'size') syncObserverSize(message);
        } catch {}
        return;
      }
      if (event.data instanceof ArrayBuffer && event.data.byteLength <= 262144) {
        if (observer.intent) observer.intent.attempt = 0;
        observer.channel?.postMessage({ type: 'render', bytes: event.data }, [event.data]);
      }
    };
    ws.onerror = () => {
      if (observerSessionCurrent(generation, targetKey) && observer.ws === ws) setObserverNotice(t('observer.disconnected'), 'error');
    };
    ws.onclose = (event) => {
      if (!observerSessionCurrent(generation, targetKey) || observer.ws !== ws) return;
      recoverObserver(event.reason === 'auth_expired' ? { code: 'auth_expired' } : undefined).catch(() => {});
    };
    observer.renewTimer = setInterval(() => {
      renewObserverLease(generation, targetKey, lease, endpoints).catch((error) => {
        if (!observerSessionCurrent(generation, targetKey) || observer.lease?.id !== lease.id) return;
        recoverObserver(error).catch(() => {});
      });
    }, 10_000);
    const target = $('#observer-target');
    if (target) target.textContent = t('observer.target', { name: viewedAgentName() || t('value.unknown') });
  } catch (error) {
    if (!observerSessionCurrent(generation, targetKey)) return;
    await recoverObserver(error);
  } finally {
    if (observer.generation === generation) observer.opening = false;
  }
}


function activeTabName() {
  return document.querySelector('.tab.active')?.dataset.tab || 'overview';
}

// ─── Fleet view switch (multi-agent mode) ───
// In multi-agent mode Agent Fleet is the top-level landing view and the
// single-agent dashboard is the "agent detail" view, reached by clicking the
// self tile. In single mode only the agent dashboard exists.
const VIEW_ANIM_CLASSES = ['is-entering', 'is-leaving', 'v-enter', 'v-leave-to-fleet', 'v-leave-to-agent'];
let cancelViewTransition = null;

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Animate between the two top-level views (fleet wall ↔ agent detail). The two
// views share a grid cell (#view-stack), so a cross-fade + subtle zoom reads as
// "zoom out to the fleet" / "zoom into one agent". Falls back to an instant swap
// when animation is unavailable or unwanted (reduced motion, no stack, already
// showing the target).
function transitionView(target, { animate = true } = {}) {
  const stack = $('#view-stack');
  const fleetView = $('#fleet-view');
  const agentDetail = $('#agent-detail');
  if (!fleetView || !agentDetail) return;
  // Both directions own the same pair of views. Retire the previous transition
  // before changing either view, including an immediate or reduced-motion swap.
  if (cancelViewTransition) cancelViewTransition();
  const inEl = target === 'fleet' ? fleetView : agentDetail;
  const outEl = target === 'fleet' ? agentDetail : fleetView;

  const cleanup = () => {
    [inEl, outEl].forEach((el) => el.classList.remove(...VIEW_ANIM_CLASSES));
    if (stack) stack.classList.remove('is-animating');
  };

  const alreadyActive = !inEl.hidden && outEl.hidden;
  if (!animate || !stack || alreadyActive || prefersReducedMotion()) {
    inEl.hidden = false;
    outEl.hidden = true;
    cleanup();
    return;
  }

  const leaveClass = target === 'fleet' ? 'v-leave-to-fleet' : 'v-leave-to-agent';
  // Render both views during the transition.
  stack.classList.add('is-animating');
  inEl.classList.add('is-entering', 'v-enter');
  inEl.hidden = false;
  outEl.classList.add('is-leaving');
  outEl.hidden = false;
  // Force reflow so the v-enter start state is applied before we animate away.
  void inEl.offsetWidth;

  let done = false;
  const frame = requestAnimationFrame(() => {
    if (done) return;
    inEl.classList.remove('v-enter');
    outEl.classList.add(leaveClass);
  });

  const finish = () => {
    if (done) return;
    cancelViewTransition();
    outEl.hidden = true;
  };
  const onEnd = (e) => {
    if (e.target !== inEl) return;
    if (e.propertyName !== 'opacity' && e.propertyName !== 'transform') return;
    finish();
  };
  inEl.addEventListener('transitionend', onEnd);
  const timer = setTimeout(finish, 460); // fallback if transitionend doesn't fire
  cancelViewTransition = () => {
    done = true;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    inEl.removeEventListener('transitionend', onEnd);
    cleanup();
    cancelViewTransition = null;
  };
}

// #222: the Memory tab pins the page frame (body becomes a fixed-height flex
// column, both memory panes scroll internally). The pin must drop whenever the
// memory tab stops being front-most — another tab, or the fleet wall sliding
// over the agent detail view.
function syncMemoryPinned() {
  const memoryTabActive = Boolean(document.querySelector('.tab[data-tab="memory"]')?.classList.contains('active'));
  document.body.classList.toggle('memory-tab-active', memoryTabActive && !state.fleetViewActive);
}

function showFleetView(opts = {}) {
  if (!state.multiAgent) return;
  if (opts.navigation !== false) state.navigationGeneration += 1;
  closeObserver({ release: true }).catch(() => {});
  state.fleetViewActive = true;
  syncMemoryPinned();
  refreshFleet().catch(() => {});
  transitionView('fleet', opts);
  scheduleFleetFallback();
}

function showAgentDetail(opts = {}) {
  if (opts.navigation !== false) state.navigationGeneration += 1;
  state.fleetViewActive = false;
  transitionView('agent', opts);
  clearFleetFallback();
  syncMemoryPinned();
}

function clearFleetFallback() {
  if (state.fleetFallbackTimer) {
    clearTimeout(state.fleetFallbackTimer);
    state.fleetFallbackTimer = null;
  }
}

function shouldReceiveFleetEvents() {
  return state.fleetViewActive && document.visibilityState !== 'hidden';
}

function scheduleFleetFallback() {
  clearFleetFallback();
  if (!shouldReceiveFleetEvents()) return;
  state.fleetFallbackTimer = setTimeout(() => {
    state.fleetFallbackTimer = null;
    refreshFleet().catch(() => {});
  }, 10_000);
}

function syncFleetSubscription() {
  if (shouldReceiveFleetEvents()) {
    scheduleFleetFallback();
  } else {
    clearFleetFallback();
  }
}

async function refreshAll() {
  const stateResult = await Promise.allSettled([refreshState()]);
  const fetches = [refreshHealth(), refreshComm(), refreshMetrics(), refreshTimeline(), refreshSummary()];
  if (state.fleetViewActive) fetches.push(refreshFleet());
  const restResults = await Promise.allSettled(fetches);
  const all = [...stateResult, ...restResults];
  const ok = all.some((r) => r.status === 'fulfilled');
  const sseOpen = isSseOpen();
  renderConnection(ok ? (sseOpen ? 'live' : 'polling') : 'degraded');
}

// ─── SSE ───
function applySse(name, data) {
  if (name === 'history_changed') { refreshTimeline().catch(() => {}); return; }
  if (!data || typeof data !== 'object') return;
  // A remote agent's stream describes its own fleet; never let it clobber ours.
  if (name === 'fleet' && state.remoteAgent) return;
  if (name === 'state_change') {
    const previousState = state.dashboardState;
    const nextRuntimeInfo = mergeRuntimeInfo(previousState, data);
    // The SSE state payload carries only raw state — the agent identity color
    // (hue) is added by /api/state, not by the broadcast. Preserve it across SSE
    // updates so the single-agent mascot stays tinted to match its Agent Fleet
    // tile instead of falling back to the untinted base art on every update.
    const prevAgent = state.dashboardState?.agent;
    state.dashboardState = data;
    if (nextRuntimeInfo) state.dashboardState.runtime_info = nextRuntimeInfo;
    if (!data.agent && prevAgent) state.dashboardState.agent = prevAgent;
    if (data.new_session_threshold) state.newSessionThreshold = data.new_session_threshold;
    state.sourceUpdatedAt = data.updated_at || new Date().toISOString();
    applyRuntimeVisibility();
    renderInfoBar(); renderState(); renderHealth(); updateRestartDot();
    refreshTimeline();
  } else if (name === 'metric_update') {
    const mn = data.metric_name || data.name;
    if (mn) {
      const previous = state.metrics.get(mn);
      const next = data.dimensions ? data : { ...data, dimensions: previous?.dimensions ?? null };
      state.metrics.set(mn, next);
      state.metricsUpdatedAt = new Date().toISOString();
      renderMetrics();
    }
  } else if (name === 'system_update') {
    state.system = data; state.healthUpdatedAt = new Date().toISOString(); renderHealth();
  } else if (name === 'health_update') {
    state.health = data; state.healthUpdatedAt = new Date().toISOString(); renderHealth();
  } else if (name === 'fleet') {
    setFleet(data);
    clearFleetFallback();
    scheduleFleetFallback();
  }
}

function connectSse() {
  if (!window.EventSource) return;
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  clearTimeout(state.sseReconnectTimer);

  const source = new EventSource(api(agentPath('/api/stream')));
  state.eventSource = source;

  source.onopen = () => {
    if (state.eventSource !== source) return;
    state.sseRetries = 0;
    renderConnection('live');
    refreshState().catch(() => {});
    refreshTimeline().catch(() => {});
  };

  source.onerror = () => {
    if (state.eventSource !== source) return;
    source.close();
    state.eventSource = null;
    renderConnection('reconnecting');
    scheduleSseReconnect();
  };

  for (const ev of ['state_change', 'metric_update', 'system_update', 'health_update', 'fleet', 'history_changed']) {
    state.eventSource.addEventListener(ev, (e) => {
      if (state.eventSource !== source) return;
      try { applySse(ev, JSON.parse(e.data)); renderConnection('live'); }
      catch { renderConnection('degraded'); }
    });
  }
}

function scheduleSseReconnect() {
  const delay = Math.min(1000 * Math.pow(2, state.sseRetries || 0), 30000);
  state.sseRetries = (state.sseRetries || 0) + 1;
  state.sseReconnectTimer = setTimeout(async () => {
    try {
      const r = await fetch(api(agentPath('/api/state')), { cache: 'no-store' });
      if (r.status === 401) {
        window.location.href = api('/login');
        return;
      }
      if (!r.ok) throw new Error(r.status);
    } catch {
      renderConnection('reconnecting');
      scheduleSseReconnect();
      return;
    }
    connectSse();
  }, delay);
}

// ─── Tabs ───
function initTabs() {
  const activateTab = (name, push = false) => {
    if (push) state.navigationGeneration += 1;
    if (name === 'memory' && remoteIsReadOnly()) name = 'overview';
    if (name === 'observer' && ($('#observer-tab')?.hidden || remoteIsReadOnly())) name = 'overview';
    if (activeTabName() === 'observer' && name !== 'observer') closeObserver({ release: true }).catch(() => {});
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    document.querySelectorAll('.tab-panel').forEach((p) => {
      const active = p.id === `tab-${name}`;
      p.classList.toggle('active', active);
      p.hidden = !active;
    });
    syncMemoryPinned();
    if (name === 'trends') refreshCharts();
    if (name === 'memory') loadMemoryTree().catch(() => {});
    if (name === 'observer') {
      openObserver().catch(() => {});
      if (state.observer.historyMode) state.observer.history?.setActive(true);
    }
    if (push) {
      const prefix = remotePrefix();
      const path = name === 'overview' ? `${prefix}/` : `${prefix}/${name}`;
      window.history.pushState({ tab: name }, '', api(path));
    }
  };
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      activateTab(btn.dataset.tab, true);
    });
  });
  window.addEventListener('popstate', async () => {
    const generation = ++state.navigationGeneration;
    const path = window.location.pathname;
    // In-page remote viewing only exists on the parent document; the
    // standalone remote document (REMOTE_AGENT) keeps plain tab routing.
    try {
      if (!REMOTE_AGENT) {
        const m = path.match(/\/fleet\/([^/]+)\/?(?:trends|memory|observer)?$/);
        if (m) {
          await enterRemoteAgent(decodeURIComponent(m[1]), { push: false });
        } else if (state.remoteAgent) {
          await exitRemoteAgent({ push: false });
        }
      }
    } catch {
      if (generation === state.navigationGeneration) renderConnection('degraded');
      return;
    }
    if (generation !== state.navigationGeneration) return;
    const tab = path.endsWith('/trends') ? 'trends' : path.endsWith('/memory') ? 'memory' : path.endsWith('/observer') ? 'observer' : 'overview';
    if (tab !== 'overview') showAgentDetail({ navigation: false });
    activateTab(tab, false);
  });
  document.addEventListener('visibilitychange', () => {
    syncFleetSubscription();
    // A backgrounded tab freezes SSE and the poll timers, so on return the
    // page may paint a pre-freeze frame (e.g. a rate-limit window that has
    // since reset) until the 10-30s fallbacks fire. Refetch now instead (#247).
    if (document.visibilityState === 'visible') refreshAll().catch(() => {});
  });
  const initialTab = window.location.pathname.endsWith('/trends') ? 'trends' : window.location.pathname.endsWith('/memory') ? 'memory' : window.location.pathname.endsWith('/observer') ? 'observer' : 'overview';
  activateTab(initialTab, false);
}

function initObserverControls() {
  const historyRoot = $('#observer-history');
  if (historyRoot) {
    state.observer.history = new ObserverHistory({ root: historyRoot, endpoint: observerEndpoint, t });
    document.querySelectorAll('[data-observer-view]').forEach(button => {
      button.addEventListener('click', () => {
        const historyMode = button.dataset.observerView === 'history';
        state.observer.historyMode = historyMode;
        historyRoot.hidden = !historyMode;
        $('#observer-frame').parentElement.hidden = historyMode;
        $('#observer-notice').hidden = historyMode;
        document.querySelectorAll('[data-observer-view]').forEach(control => {
          control.setAttribute('aria-pressed', String(control === button));
        });
        state.observer.history.setActive(historyMode);
        renderObserverSizeForm();
      });
    });
  }
  $('#observer-size-form')?.addEventListener('submit', (event) => { applyObserverSize(event).catch(() => {}); });

}

function initMemoryControls() {
  $('#memory-refresh')?.addEventListener('click', () => loadMemoryTree({ force: true }).catch(() => {}));
  $('#memory-edit-btn')?.addEventListener('click', startMemoryEdit);
  $('#memory-save-btn')?.addEventListener('click', () => saveMemoryDraftToServer().catch(() => {}));
  $('#memory-reset-btn')?.addEventListener('click', resetMemoryEdit);
  $('#memory-fold')?.addEventListener('click', () => {
    const dirs = collectMemoryDirPaths(state.memory.tree?.root);
    if (!dirs.length) return;
    const allCollapsed = dirs.every(d => state.memory.collapsed.has(d));
    state.memory.collapsed = allCollapsed ? new Set() : new Set(dirs);
    renderMemory();
  });
  document.querySelectorAll('.memory-mode').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.memory.mode = btn.dataset.mode === 'raw' ? 'raw' : 'rendered';
      renderMemory();
    });
  });
}

// ─── Fleet mode init ───
// Decide landing view based on fleet size. The self record is always present,
// so length >= 2 means at least one external agent is configured.
function hasFleetWall(fleet) {
  return !REMOTE_AGENT && (fleet?.agents?.length || 0) >= 2;
}

function syncLiveFleetMode(fleet) {
  const nextMultiAgent = hasFleetWall(fleet);
  if (nextMultiAgent === state.multiAgent) return false;
  state.multiAgent = nextMultiAgent;
  const backBtn = $('#back-to-fleet');
  if (nextMultiAgent) {
    if (backBtn) backBtn.hidden = false;
    showFleetView({ animate: !prefersReducedMotion() });
  } else {
    if (backBtn) backBtn.hidden = !REMOTE_AGENT;
    if (state.remoteAgent) exitRemoteAgent({ push: true });
    else showAgentDetail({ animate: !prefersReducedMotion() });
  }
  syncFleetSubscription();
  return true;
}

function applyFleetMode(fleet) {
  // Remote context: always the agent-detail view (the remote's own fleet
  // size is irrelevant here), with the back control returning to the wall
  // the viewer drilled down from.
  state.multiAgent = hasFleetWall(fleet);
  const backBtn = $('#back-to-fleet');
  const fleetView = $('#fleet-view');
  const agentDetail = $('#agent-detail');
  if (!state.multiAgent) {
    // Single mode: only the agent dashboard exists, no fleet view. The back
    // control survives only in remote context, where it leaves the page.
    state.fleetViewActive = false;
    if (backBtn) backBtn.hidden = !REMOTE_AGENT;
    if (fleetView) fleetView.hidden = true;
    if (agentDetail) agentDetail.hidden = false;
    syncFleetSubscription();
    state.fleetModeInitialized = true;
    return;
  }
  // Multi-agent mode: Agent Fleet is the landing view. The first paint shows
  // the single-agent dashboard (it is the safe default if JS/fleet fails), so
  // rather than swap instantly we briefly let it settle, then zoom out to the
  // wall — turning the unavoidable first frame into a deliberate transition.
  if (backBtn) backBtn.hidden = false;
  state.fleetViewActive = false;
  if (fleetView) fleetView.hidden = true;
  if (agentDetail) agentDetail.hidden = false;
  syncFleetSubscription();
  if (prefersReducedMotion()) {
    showFleetView({ animate: false });
  } else {
    setTimeout(() => showFleetView({ animate: true }), 380);
  }
  state.fleetModeInitialized = true;
}

// Clear all per-agent data and incremental DOM so two agents' panels never
// mix while switching the detail view between self and a remote agent.
function resetAgentData() {
  closeObserver({ release: true }).catch(() => {});
  if (state.observer.history) {
    state.observer.history.session = null;
    state.observer.history.entries.clear();
    state.observer.history.fields.clear();
    state.observer.history.el('entries').replaceChildren();
    state.observer.history.el('results').replaceChildren();
    state.observer.history.el('sessions').replaceChildren();
  }
  state.observer.statusGeneration += 1;
  state.observer.lifecycleGeneration = (state.observer.lifecycleGeneration || 0) + 1;
  state.observer.lifecyclePending = null;
  state.observer.statusRequest = null;
  state.observer.status = null;
  renderObserverStatus(null);
  const observerStatus = settingsModal?.querySelector('#observer-settings-status');
  if (observerStatus) {
    observerStatus.hidden = true;
    observerStatus.textContent = '';
  }
  state.dashboardState = null;
  state.metrics = new Map();
  state.aggregated = {};
  state.health = null;
  state.system = null;
  state.summary = null;
  state.communication = null;
  state.timeline = null;
  state.sourceUpdatedAt = null;
  state.metricsUpdatedAt = null;
  state.healthUpdatedAt = null;
  state.summaryUpdatedAt = null;
  state.commUpdatedAt = null;
  state.timelineUpdatedAt = null;
  resetMemoryState();
  prevSubagentIds.clear();
  const feed = $('#tool-feed');
  if (feed) feed.innerHTML = '';
  const subs = $('#subagent-list');
  if (subs) subs.innerHTML = '';
  const msg = $('#assistant-message');
  if (msg) { msg.hidden = true; msg.textContent = ''; }
  // Local-only modals must not survive a switch (e.g. browser-back into a
  // remote view while the Actions modal is open).
  closeActionsModal();
  closeSettingsModal();
  renderAll();
}

function enterRemoteAgent(name, { push = true } = {}) {
  // Single-agent dashboards have no fleet wall to come back to — never
  // activate remote viewing there, even if a stale history entry matches.
  if (!state.multiAgent) return;
  if (!name || state.remoteAgent === name) return;
  if (push) state.navigationGeneration += 1;
  state.remoteAgent = name;
  resetAgentData();
  connectSse();
  showAgentDetail({ navigation: false });
  const targetKey = observerTargetKey();
  if (push) window.history.pushState({ remoteAgent: name }, '', api(`${remotePrefix()}/`));
  return Promise.allSettled([refreshAll(), refreshObserverStatus({ quiet: true })]).then(() => {
    if (observerTargetKey() !== targetKey) return;
    if (activeTabName() === 'trends') refreshCharts();
  });
}

function exitRemoteAgent({ push = true } = {}) {
  if (push) state.navigationGeneration += 1;
  if (!state.remoteAgent) return;
  state.remoteAgent = null;
  resetAgentData();
  connectSse();
  showFleetView({ navigation: false });
  if (push) window.history.pushState({ tab: 'overview' }, '', api('/'));
  return Promise.allSettled([refreshAll(), refreshObserverStatus({ quiet: true })]);
}

function initFleetMode() {
  // Intercept self-tile clicks: switch to the agent dashboard instead of a
  // full navigation that would just reload the wall. External tiles navigate
  // normally to /fleet/<name>/.
  const root = $('#agent-fleet-root');
  if (root) {
    root.addEventListener('click', (e) => {
      const tile = e.target.closest('.agent-tile');
      if (!tile) return;
      if (tile.dataset.self === 'true') {
        e.preventDefault();
        showAgentDetail();
        return;
      }
      if (tile.dataset.agent) {
        e.preventDefault();
        enterRemoteAgent(tile.dataset.agent);
      }
    });
  }
  const backBtn = $('#back-to-fleet');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      if (state.remoteAgent) {
        exitRemoteAgent();
        return;
      }
      if (REMOTE_AGENT) {
        window.location.href = PARENT_DASHBOARD_PATH;
        return;
      }
      showFleetView();
    });
  }
}

function initLocaleToggle() {
  $('#locale-toggle').addEventListener('click', async () => {
    await initI18n(getLocale() === 'zh' ? 'en' : 'zh');
    if (actionsModal) { actionsModal.remove(); actionsModal = null; }
    if (settingsModal) { settingsModal.remove(); settingsModal = null; }
    renderAll();
    refreshCharts();
  });
}

function initLogout() {
  $('#logout-btn').addEventListener('click', async () => {
    try {
      await fetch(api('/logout'), { method: 'POST' });
    } catch { /* ignore */ }
    window.location.href = api('/login');
  });
}

function initTips() {
  const tipPairs = [
    ['#confidence-tip', '#confidence-popover'],
    ['#cost-tip', '#cost-popover'],
    ['#cost-trend-tip', '#cost-trend-popover'],
    ['#projects-tip', '#projects-popover'],
    ['#context-tip', '#context-popover'],
    ['#latency-tip', '#latency-popover']
  ];
  const allPops = [];

  for (const [btnSel, popSel] of tipPairs) {
    const btn = $(btnSel);
    const srcPop = $(popSel);
    if (!btn || !srcPop) continue;

    const pop = srcPop.cloneNode(true);
    pop.removeAttribute('id');
    pop.hidden = true;
    document.body.appendChild(pop);
    srcPop.remove();
    allPops.push(pop);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const wasHidden = pop.hidden;
      allPops.forEach((p) => { p.hidden = true; });
      if (wasHidden) {
        const rect = btn.getBoundingClientRect();
        pop.style.top = `${rect.bottom + 6}px`;
        const left = Math.max(8, rect.left - 120);
        const maxLeft = window.innerWidth - 280 - 8;
        pop.style.left = `${Math.min(left, Math.max(8, maxLeft))}px`;
        pop.hidden = false;
      }
    });
  }

  document.addEventListener('click', () => { allPops.forEach((p) => { p.hidden = true; }); });
}

// ─── Charts ───
const CHART_COLORS = {
  accent: '#0d9488',
  accentBg: 'rgba(13, 148, 136, 0.35)',
  purple: '#6366f1',
  purpleBg: 'rgba(99, 102, 241, 0.35)',
  green: '#059669',
  greenBg: 'rgba(5, 150, 105, 0.35)',
  orange: '#ea580c',
  orangeBg: 'rgba(234, 88, 12, 0.35)',
  blue: '#3b82f6',
  blueBg: 'rgba(59, 130, 246, 0.35)',
  pink: '#ec4899',
  pinkBg: 'rgba(236, 72, 153, 0.35)',
  grid: 'rgba(15, 118, 110, 0.06)',
  text: '#7a8794'
};

function barChartOpts(yCallback, stacked) {
  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 11 }, padding: 8 } },
      tooltip: { backgroundColor: '#101827', titleFont: { size: 11 }, bodyFont: { size: 11 }, padding: 8, cornerRadius: 6 }
    },
    scales: {
      x: {
        type: 'time',
        time: { tooltipFormat: 'MMM d HH:mm', displayFormats: { hour: 'HH:mm', day: 'MMM d' } },
        grid: { display: false },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text, maxTicksLimit: 8 },
        stacked: !!stacked
      },
      y: {
        min: 0,
        grid: { color: CHART_COLORS.grid },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text, callback: yCallback || undefined },
        border: { display: false },
        stacked: !!stacked
      }
    }
  };
}

function horizontalBarOpts() {
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: 'y',
    interaction: { mode: 'index', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#101827', titleFont: { size: 11 }, bodyFont: { size: 11 }, padding: 8, cornerRadius: 6,
        callbacks: { label: (ctx) => `${ctx.dataset.label}: ${tok(ctx.raw)}` }
      }
    },
    scales: {
      x: {
        min: 0,
        grid: { color: CHART_COLORS.grid },
        ticks: { font: { size: 10 }, color: CHART_COLORS.text, callback: (v) => tok(v) },
        border: { display: false }
      },
      y: {
        grid: { display: false },
        ticks: { font: { size: 11 }, color: CHART_COLORS.text }
      }
    }
  };
}

function initCharts() {
  if (!window.Chart) return;
  try {
    // 1. Token Usage — stacked bar (input vs output)
    const tokensCtx = document.getElementById('chart-tokens');
    if (tokensCtx) {
      state.charts.tokens = new Chart(tokensCtx, {
        type: 'bar',
        data: {
          datasets: [
            { label: t('trends.input'), data: [], backgroundColor: CHART_COLORS.accent, stack: 'tokens' },
            { label: t('trends.output'), data: [], backgroundColor: CHART_COLORS.purple, stack: 'tokens' }
          ]
        },
        options: barChartOpts((v) => tok(v), true)
      });
    }

    // 2. Cost — bar chart
    const costCtx = document.getElementById('chart-cost');
    if (costCtx) {
      state.charts.cost = new Chart(costCtx, {
        type: 'bar',
        data: {
          datasets: [{ label: t('trends.cost'), data: [], backgroundColor: CHART_COLORS.orange }]
        },
        options: barChartOpts((v) => `$${v}`)
      });
    }

    // 3. Message Throughput — stacked bar (in vs out)
    const msgCtx = document.getElementById('chart-messages');
    if (msgCtx) {
      state.charts.messages = new Chart(msgCtx, {
        type: 'bar',
        data: {
          datasets: [
            { label: t('trends.msg_in'), data: [], backgroundColor: CHART_COLORS.blue, stack: 'msgs' },
            { label: t('trends.msg_out'), data: [], backgroundColor: CHART_COLORS.pink, stack: 'msgs' }
          ]
        },
        options: barChartOpts(undefined, true)
      });
    }

    // 4. Project Distribution — horizontal bar
    const projCtx = document.getElementById('chart-projects');
    if (projCtx) {
      state.charts.projects = new Chart(projCtx, {
        type: 'bar',
        data: {
          labels: [],
          datasets: [{ label: t('trends.output_tokens'), data: [], backgroundColor: CHART_COLORS.green }]
        },
        options: horizontalBarOpts()
      });
    }
  } catch { /* chart init failed — overview still works */ }
}

function updateChartLabels() {
  if (!window.Chart) return;
  if (state.charts.tokens) {
    state.charts.tokens.data.datasets[0].label = t('trends.input');
    state.charts.tokens.data.datasets[1].label = t('trends.output');
    state.charts.tokens.update('none');
  }
  if (state.charts.cost) {
    state.charts.cost.data.datasets[0].label = t('trends.cost');
    state.charts.cost.update('none');
  }
  if (state.charts.messages) {
    state.charts.messages.data.datasets[0].label = t('trends.msg_in');
    state.charts.messages.data.datasets[1].label = t('trends.msg_out');
    state.charts.messages.update('none');
  }
  if (state.charts.projects) {
    state.charts.projects.data.datasets[0].label = t('trends.output_tokens');
    state.charts.projects.update('none');
  }
}

function getTrendRange() {
  const active = document.querySelector('.range-btn.active[data-range]');
  return active ? active.dataset.range : '24h';
}

function rangeToSince() {
  const range = getTrendRange();
  const now = Date.now();
  const ms = { '24h': 86400000, '7d': 604800000, '30d': 2592000000 };
  return new Date(now - (ms[range] || ms['24h'])).toISOString();
}

function autoBucket(sinceMs, untilMs) {
  const diffDays = (untilMs - sinceMs) / 86400000;
  if (diffDays <= 2) return 3600;
  if (diffDays <= 60) return 86400;
  return 604800;
}

async function refreshCharts() {
  if (!window.Chart) return;

  let since, until, bucket;
  const customStart = $('#trend-start')?.value;
  const customEnd = $('#trend-end')?.value;
  const isCustom = customStart && customEnd;

  if (isCustom) {
    since = new Date(customStart + 'T00:00:00').toISOString();
    until = new Date(customEnd + 'T23:59:59').toISOString();
    bucket = autoBucket(new Date(since).getTime(), new Date(until).getTime());
  } else {
    since = rangeToSince();
    until = new Date().toISOString();
    const range = getTrendRange();
    bucket = { '24h': 3600, '7d': 86400, '30d': 86400 }[range] || 3600;
  }

  const qp = `since=${since}&until=${until}&bucket=${bucket}`;

  const [tokensData, costData, msgData, projData] = await Promise.allSettled([
    fetchJson(`/api/metrics/series?metric=tokens&${qp}`),
    fetchJson(`/api/metrics/series?metric=cost&${qp}`),
    fetchJson(`/api/metrics/series?metric=messages&${qp}`),
    fetchJson(`/api/metrics/series?metric=projects&since=${since}&until=${until}`)
  ]);

  // 1. Token Usage — stacked bar
  if (state.charts.tokens && tokensData.status === 'fulfilled') {
    const pts = tokensData.value.points || [];
    state.charts.tokens.data.datasets[0].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.input_sum }));
    state.charts.tokens.data.datasets[1].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.output_sum }));
    state.charts.tokens.update('none');
    const totalInput = pts.reduce((s, p) => s + (p.input_sum || 0), 0);
    const totalOutput = pts.reduce((s, p) => s + (p.output_sum || 0), 0);
    const tokensTotalEl = $('#chart-tokens-total');
    if (tokensTotalEl) tokensTotalEl.textContent = t('metric.total_tokens', { total: tok(totalInput + totalOutput), input: tok(totalInput), output: tok(totalOutput) });
  }

  // 2. Cost — bar
  if (state.charts.cost && costData.status === 'fulfilled') {
    const pts = costData.value.points || [];
    state.charts.cost.data.datasets[0].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.cost_sum }));
    state.charts.cost.update('none');
    const totalCost = pts.reduce((s, p) => s + (p.cost_sum || 0), 0);
    const costTotalEl = $('#chart-cost-total');
    if (costTotalEl) costTotalEl.textContent = t('metric.total_cost', { total: usd(totalCost) });
  }

  // 3. Message Throughput — stacked bar
  if (state.charts.messages && msgData.status === 'fulfilled') {
    const pts = msgData.value.points || [];
    state.charts.messages.data.datasets[0].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.msg_in }));
    state.charts.messages.data.datasets[1].data = pts.map((p) => ({ x: p.bucket_start * 1000, y: p.msg_out }));
    state.charts.messages.update('none');
  }

  // 4. Project Distribution — horizontal bar
  if (state.charts.projects && projData.status === 'fulfilled') {
    const items = projData.value.items || [];
    items.sort((a, b) => (b.outputTokens || 0) - (a.outputTokens || 0));
    state.charts.projects.data.labels = items.map((i) => i.name);
    state.charts.projects.data.datasets[0].data = items.map((i) => i.outputTokens || 0);
    state.charts.projects.update('none');
  }
}

function initTrendControls() {
  // Range buttons
  document.querySelectorAll('.range-btn[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.range-btn[data-range]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      // Clear custom date inputs when a preset is selected
      const startEl = $('#trend-start');
      const endEl = $('#trend-end');
      if (startEl) startEl.value = '';
      if (endEl) endEl.value = '';
      refreshCharts();
    });
  });

  // Custom date range
  const customBtn = $('#trend-custom');
  if (customBtn) {
    customBtn.addEventListener('click', () => {
      const startEl = $('#trend-start');
      const endEl = $('#trend-end');
      if (startEl?.value && endEl?.value) {
        // Deactivate preset buttons
        document.querySelectorAll('.range-btn[data-range]').forEach((b) => b.classList.remove('active'));
        refreshCharts();
      }
    });
  }
}

// ─── Settings Modal ───
let fleetManageModal = null;

function createFleetManageModal() {
  if (fleetManageModal) return fleetManageModal;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'fleet-manage-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
<div class="modal manage-modal">
  <div class="modal-head">
    <h2>${esc(t('fleet_manage.title'))}</h2>
    <button class="modal-close" type="button" aria-label="Close">&times;</button>
  </div>
  <div class="modal-tabs" role="tablist">
    <button class="modal-tab active" type="button" data-tab="fleet">${esc(t('fleet_manage.tab_fleet'))}</button>
    <button class="modal-tab" type="button" data-tab="keys">${esc(t('fleet_manage.tab_keys'))}</button>
  </div>
  <div class="modal-body">
    <div class="manage-panel" data-panel="fleet">
      <section class="manage-section">
        <span class="action-group-label">${esc(t('fleet_manage.local_agent'))}</span>
        <div class="fleet-self-row">
          <input class="action-input" id="fleet-self-name" type="text" autocomplete="off" />
          <button class="action-btn action-btn-sm" id="fleet-rename-save" type="button">${esc(t('btn.save'))}</button>
        </div>
        <small class="fleet-help">${esc(t('fleet_manage.rename_hint'))}</small>
      </section>
      <section class="manage-section">
        <span class="action-group-label">${esc(t('fleet_manage.remote_agents'))}</span>
        <div class="fleet-agent-list" id="fleet-agent-list"></div>
      </section>
      <section class="manage-section">
        <span class="action-group-label">${esc(t('fleet_manage.add_agent'))}</span>
        <small class="fleet-help">${esc(t('fleet_manage.add_key_hint'))}</small>
        <div class="action-field">
          <label class="action-field-label" for="fleet-add-name">${esc(t('fleet_manage.name'))}</label>
          <input class="action-input" id="fleet-add-name" type="text" autocomplete="off" placeholder="zylos01" />
        </div>
        <div class="action-field">
          <label class="action-field-label" for="fleet-add-url">${esc(t('fleet_manage.base_url'))}</label>
          <input class="action-input" id="fleet-add-url" type="url" autocomplete="off" placeholder="https://agent.example/dashboard" />
        </div>
        <div class="action-field">
          <label class="action-field-label" for="fleet-add-key">${esc(t('fleet_manage.read_key'))}</label>
          <input class="action-input" id="fleet-add-key" type="password" autocomplete="off" />
        </div>
        <div class="action-row">
          <button class="action-btn" id="fleet-test" type="button">${esc(t('fleet_manage.test'))}</button>
          <button class="action-btn action-btn-primary" id="fleet-add-save" type="button">${esc(t('fleet_manage.save_agent'))}</button>
        </div>
      </section>
    </div>
    <div class="manage-panel" data-panel="keys" hidden>
      <section class="manage-section">
        <span class="action-group-label">${esc(t('fleet_manage.api_keys'))}</span>
        <small class="fleet-help">${esc(t('fleet_manage.keys_hint'))}</small>
        <div class="action-field">
          <label class="action-field-label" for="api-base-url">${esc(t('fleet_manage.base_url'))}</label>
          <div class="api-key-copy-row">
            <input class="action-input api-base-url" id="api-base-url" type="text" readonly value="${esc(dashboardBaseUrl())}" />
            <button class="action-btn action-btn-sm" id="api-base-url-copy" type="button">${esc(t('fleet_manage.copy_key'))}</button>
          </div>
        </div>
        <small class="fleet-help">${esc(t('fleet_manage.base_url_hint'))}</small>
        <div class="action-row">
          <button class="action-btn action-btn-sm" id="api-key-purge-revoked" type="button" hidden>${esc(t('fleet_manage.purge_revoked'))}</button>
        </div>
        <div class="fleet-agent-list" id="api-key-list"></div>
      </section>
      <section class="manage-section">
        <span class="action-group-label">${esc(t('fleet_manage.create_key'))}</span>
        <div class="action-field">
          <label class="action-field-label" for="api-key-name">${esc(t('fleet_manage.name'))}</label>
          <input class="action-input" id="api-key-name" type="text" autocomplete="off" placeholder="producer-read" />
        </div>
        <div class="action-field">
          <label class="action-field-label" for="api-key-scope">${esc(t('fleet_manage.scope'))}</label>
          <select class="action-select" id="api-key-scope">
            <option value="read">${esc(t('fleet_manage.scope_read'))}</option>
            <option value="admin">${esc(t('fleet_manage.scope_admin'))}</option>
          </select>
        </div>
        <small class="fleet-help api-key-admin-warning" id="api-key-admin-warning" hidden>${esc(t('fleet_manage.admin_key_warning'))}</small>
        <div class="api-key-created" id="api-key-created" hidden></div>
        <div class="action-row">
          <button class="action-btn action-btn-primary" id="api-key-create" type="button">${esc(t('fleet_manage.create_key_button'))}</button>
        </div>
      </section>
    </div>
  </div>
  <div class="modal-status" id="fleet-manage-status" hidden></div>
</div>`;
  document.body.appendChild(overlay);
  fleetManageModal = overlay;
  overlay.querySelector('.modal-close').addEventListener('click', closeFleetManageModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeFleetManageModal(); });
  overlay.querySelectorAll('.modal-tab').forEach(tab => {
    tab.addEventListener('click', () => switchFleetManageTab(tab.dataset.tab));
  });
  overlay.querySelector('#fleet-rename-save').addEventListener('click', saveFleetSelfName);
  overlay.querySelector('#fleet-test').addEventListener('click', testFleetAgent);
  overlay.querySelector('#fleet-add-save').addEventListener('click', saveFleetAgent);
  overlay.querySelector('#api-key-create').addEventListener('click', createApiKey);
  overlay.querySelector('#api-key-scope').addEventListener('change', updateApiKeyScopeWarning);
  overlay.querySelector('#api-base-url-copy').addEventListener('click', copyDashboardBaseUrl);
  overlay.querySelector('#api-key-purge-revoked').addEventListener('click', purgeRevokedApiKeys);
  return overlay;
}

function dashboardBaseUrl() {
  return `${window.location.origin}${BASE_PATH}`;
}

async function copyDashboardBaseUrl() {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(dashboardBaseUrl());
    fleetManageStatus(t('fleet_manage.base_url_copied'), 'success');
  } catch {
    fleetManageModal?.querySelector('#api-base-url')?.select();
    fleetManageStatus(t('fleet_manage.copy_failed'), 'error');
  }
}

let fleetManageStatusTimer = null;

function fleetManageStatus(message, kind = '') {
  const status = fleetManageModal?.querySelector('#fleet-manage-status');
  if (!status) return;
  clearTimeout(fleetManageStatusTimer);
  fleetManageStatusTimer = null;
  status.textContent = message;
  status.className = `modal-status ${kind}`.trim();
  status.hidden = !message;
  // #242: success feedback auto-dismisses; errors stay until the next action.
  if (message && kind === 'success') {
    fleetManageStatusTimer = setTimeout(() => fleetManageStatus(''), 5000);
  }
}

function setFleetAddBusy(isBusy) {
  fleetManageModal?.querySelector('#fleet-test')?.toggleAttribute('disabled', isBusy);
  fleetManageModal?.querySelector('#fleet-add-save')?.toggleAttribute('disabled', isBusy);
}

function setApiKeyBusy(isBusy) {
  fleetManageModal?.querySelector('#api-key-create')?.toggleAttribute('disabled', isBusy);
  fleetManageModal?.querySelector('#api-key-purge-revoked')?.toggleAttribute('disabled', isBusy);
  fleetManageModal?.querySelectorAll('.api-key-revoke').forEach(btn => btn.toggleAttribute('disabled', isBusy));
  fleetManageModal?.querySelectorAll('.api-key-rotate').forEach(btn => btn.toggleAttribute('disabled', isBusy));
  fleetManageModal?.querySelectorAll('.api-key-delete').forEach(btn => btn.toggleAttribute('disabled', isBusy));
}

function fleetFormValues() {
  return {
    name: fleetManageModal.querySelector('#fleet-add-name').value.trim(),
    base_url: fleetManageModal.querySelector('#fleet-add-url').value.trim(),
    read_api_key: fleetManageModal.querySelector('#fleet-add-key').value.trim()
  };
}

function apiKeyFormValues() {
  return {
    name: fleetManageModal.querySelector('#api-key-name').value.trim(),
    scope: fleetManageModal.querySelector('#api-key-scope').value
  };
}

function fleetManageError(code, fallback) {
  if (!code) return fallback || t('fleet_manage.save_failed');
  const key = `fleet_manage.${code}`;
  const translated = t(key);
  return translated === key ? (fallback || code) : translated;
}

function switchFleetManageTab(tabName) {
  const target = tabName === 'keys' ? 'keys' : 'fleet';
  fleetManageModal.querySelectorAll('.modal-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.tab === target);
  });
  fleetManageModal.querySelectorAll('.manage-panel').forEach(panel => {
    panel.hidden = panel.dataset.panel !== target;
  });
  if (target === 'keys') loadApiKeys();
}

function updateApiKeyScopeWarning() {
  const warning = fleetManageModal?.querySelector('#api-key-admin-warning');
  const scope = fleetManageModal?.querySelector('#api-key-scope')?.value;
  if (warning) warning.hidden = scope !== 'admin';
}

function renderFleetManage(data, draft = null) {
  const selfInput = fleetManageModal.querySelector('#fleet-self-name');
  if (!draft) selfInput.value = data?.self?.name || viewedAgentName();
  const list = fleetManageModal.querySelector('#fleet-agent-list');
  const agents = data?.agents || [];
  if (!agents.length) {
    list.innerHTML = `<p class="empty-state">${esc(t('fleet_manage.empty'))}</p>`;
    return;
  }
  list.replaceChildren(...agents.map((agent) => {
    const row = document.createElement('div');
    row.className = 'fleet-agent-row';
    row.innerHTML = `
      <div class="fleet-agent-meta">
        <strong>${esc(agent.name)}</strong>
        <span>${esc(agent.base_url || '')}</span>
        <small>${esc(agent.key_masked || '')} · ${esc(agent.access || 'read')}</small>
      </div>
      <button class="settings-remove-btn fleet-agent-remove" type="button" title="${esc(t('btn.remove'))}">&times;</button>`;
    row.querySelector('.fleet-agent-remove').addEventListener('click', () => removeFleetAgent(agent.name));
    return row;
  }));
}

function renderApiKeys(data) {
  const list = fleetManageModal.querySelector('#api-key-list');
  const keys = data?.keys || [];
  const hasRevoked = keys.some(key => (key.status || (key.revoked_at ? 'revoked' : 'active')) === 'revoked');
  const purgeBtn = fleetManageModal.querySelector('#api-key-purge-revoked');
  if (purgeBtn) purgeBtn.hidden = !hasRevoked;
  if (!keys.length) {
    list.innerHTML = `<p class="empty-state">${esc(t('fleet_manage.keys_empty'))}</p>`;
    return;
  }
  list.replaceChildren(...keys.map((key) => {
    const row = document.createElement('div');
    row.className = `fleet-agent-row api-key-row ${key.status === 'revoked' ? 'revoked' : ''}`.trim();
    const status = key.status || (key.revoked_at ? 'revoked' : 'active');
    const rotateLabel = esc(t('fleet_manage.rotate_key'));
    const revokeLabel = esc(t('fleet_manage.revoke_key'));
    const deleteLabel = esc(t('fleet_manage.delete_key'));
    row.innerHTML = `
      <div class="fleet-agent-meta">
        <strong>${esc(key.name)}</strong>
        <span>${esc(key.scope || 'read')} · ${esc(t(`fleet_manage.key_${status}`))}</span>
        <small>${esc(t('fleet_manage.key_created', { date: key.created_at || '-' }))} · ${esc(t('fleet_manage.key_last_used', { date: key.last_used_at || t('value.none') }))}</small>
      </div>
      <div class="api-key-actions">
        ${status === 'active' ? `<button class="action-btn api-key-icon-btn api-key-rotate" type="button" title="${rotateLabel}" aria-label="${rotateLabel}">${API_KEY_ROTATE_ICON}</button>` : ''}
        ${status === 'active' ? `<button class="action-btn api-key-icon-btn api-key-revoke" type="button" title="${revokeLabel}" aria-label="${revokeLabel}">${API_KEY_REVOKE_ICON}</button>` : ''}
        ${status === 'revoked' ? `<button class="action-btn api-key-icon-btn api-key-delete" type="button" title="${deleteLabel}" aria-label="${deleteLabel}">${API_KEY_DELETE_ICON}</button>` : ''}
      </div>`;
    row.querySelector('.api-key-rotate')?.addEventListener('click', () => rotateApiKey(key.name));
    row.querySelector('.api-key-revoke')?.addEventListener('click', () => revokeApiKey(key.name));
    row.querySelector('.api-key-delete')?.addEventListener('click', () => hardDeleteApiKey(key.name));
    return row;
  }));
}

function renderCreatedApiKey(createdKey) {
  const panel = fleetManageModal.querySelector('#api-key-created');
  fleetManageModal._createdKey = createdKey || null;
  if (!createdKey) {
    panel.hidden = true;
    panel.replaceChildren();
    return;
  }
  panel.hidden = false;
  panel.innerHTML = `
    <strong>${esc(t('fleet_manage.key_created_once'))}</strong>
    <div class="api-key-copy-row">
      <input class="action-input api-key-plaintext" type="text" readonly value="${esc(createdKey.plaintext_key || '')}" />
      <button class="action-btn action-btn-sm api-key-copy" type="button">${esc(t('fleet_manage.copy_key'))}</button>
      <button class="settings-remove-btn api-key-dismiss" type="button" title="${esc(t('btn.remove'))}">&times;</button>
    </div>
    <small class="fleet-help">${esc(t('fleet_manage.key_once_hint'))}</small>`;
  panel.querySelector('.api-key-copy').addEventListener('click', copyCreatedApiKey);
  panel.querySelector('.api-key-dismiss').addEventListener('click', () => renderCreatedApiKey(null));
  panel.scrollIntoView({ block: 'nearest' });
}

async function copyCreatedApiKey() {
  const key = fleetManageModal?._createdKey?.plaintext_key || '';
  if (!key) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(key);
    fleetManageStatus(t('fleet_manage.key_copied'), 'success');
  } catch {
    fleetManageModal.querySelector('.api-key-plaintext')?.select();
    fleetManageStatus(t('fleet_manage.copy_failed'), 'error');
  }
}

async function loadApiKeys() {
  try {
    const resp = await fetch(api('/api/keys'), { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.keys_load_failed')));
    renderApiKeys(data);
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  }
}

async function openFleetManageModal(draft = null) {
  if (REMOTE_AGENT) return;
  const modal = createFleetManageModal();
  modal.hidden = false;
  if (draft) {
    modal.querySelector('#fleet-self-name').value = draft.selfName || '';
    modal.querySelector('#fleet-add-name').value = draft.name || '';
    modal.querySelector('#fleet-add-url').value = draft.baseUrl || '';
    modal.querySelector('#fleet-add-key').value = draft.readKey || '';
    modal.querySelector('#api-key-name').value = draft.keyName || '';
    modal.querySelector('#api-key-scope').value = draft.keyScope || 'read';
    renderCreatedApiKey(draft.createdKey || null);
  }
  updateApiKeyScopeWarning();
  fleetManageStatus(t('status.loading'), 'running');
  try {
    const resp = await fetch(api('/api/fleet/agents'), { cache: 'no-store' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || t('fleet_manage.load_failed'));
    renderFleetManage(data, draft);
    if (draft?.activeTab === 'keys') switchFleetManageTab('keys');
    fleetManageStatus('', '');
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  }
}

function closeFleetManageModal() {
  if (!fleetManageModal) return;
  fleetManageModal.hidden = true;
  // #242: never carry a stale status into the next open.
  fleetManageStatus('');
}

async function testFleetAgent() {
  const body = fleetFormValues();
  setFleetAddBusy(true);
  fleetManageStatus(t('fleet_manage.testing'), 'running');
  try {
    const resp = await fetch(api('/api/fleet/agents/test'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ base_url: body.base_url, read_api_key: body.read_api_key })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || t('fleet_manage.test_failed'));
    if (data.reachable) {
      fleetManageStatus(t('fleet_manage.test_ok', { scope: data.scope || 'read' }), 'success');
    } else {
      fleetManageStatus(fleetManageError(data.error || 'unreachable', data.error || t('fleet_manage.test_failed')), 'error');
    }
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  } finally {
    setFleetAddBusy(false);
  }
}

async function saveFleetAgent() {
  const body = fleetFormValues();
  setFleetAddBusy(true);
  fleetManageStatus(t('fleet_manage.saving'), 'running');
  try {
    const resp = await fetch(api('/api/fleet/agents'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.save_failed')));
    fleetManageModal.querySelector('#fleet-add-name').value = '';
    fleetManageModal.querySelector('#fleet-add-url').value = '';
    fleetManageModal.querySelector('#fleet-add-key').value = '';
    renderFleetManage(data.agents ? data : await (await fetch(api('/api/fleet/agents'), { cache: 'no-store' })).json());
    fleetManageStatus(t('fleet_manage.saved'), 'success');
    await refreshFleet();
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  } finally {
    setFleetAddBusy(false);
  }
}

async function removeFleetAgent(name) {
  if (!window.confirm(t('fleet_manage.remove_confirm', { name }))) return;
  fleetManageStatus(t('fleet_manage.removing'), 'running');
  try {
    const resp = await fetch(api(`/api/fleet/agents/${encodeURIComponent(name)}`), { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || t('fleet_manage.remove_failed'));
    renderFleetManage(data);
    fleetManageStatus(t('fleet_manage.removed'), 'success');
    await refreshFleet();
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  }
}

async function createApiKey() {
  const body = apiKeyFormValues();
  const pendingKeyName = fleetManageModal?._createdKey?.name;
  if (pendingKeyName && !window.confirm(t('fleet_manage.replace_created_key_confirm', { name: pendingKeyName }))) return;
  setApiKeyBusy(true);
  fleetManageStatus(t('fleet_manage.creating_key'), 'running');
  try {
    const resp = await fetch(api('/api/keys'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.key_save_failed')));
    fleetManageModal.querySelector('#api-key-name').value = '';
    renderApiKeys(data);
    renderCreatedApiKey({ name: data.key?.name || body.name, plaintext_key: data.plaintext_key });
    fleetManageStatus(t('fleet_manage.key_created_status'), 'success');
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  } finally {
    setApiKeyBusy(false);
  }
}

async function rotateApiKey(name) {
  const pendingKeyName = fleetManageModal?._createdKey?.name;
  if (pendingKeyName && !window.confirm(t('fleet_manage.replace_created_key_confirm', { name: pendingKeyName }))) return;
  if (!window.confirm(t('fleet_manage.rotate_confirm', { name }))) return;
  setApiKeyBusy(true);
  fleetManageStatus(t('fleet_manage.rotating_key'), 'running');
  try {
    const resp = await fetch(api(`/api/keys/${encodeURIComponent(name)}/rotate`), { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.rotate_failed')));
    renderApiKeys(data);
    renderCreatedApiKey({ name: data.key?.name || name, plaintext_key: data.plaintext_key });
    fleetManageStatus(t('fleet_manage.key_rotated_status'), 'success');
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  } finally {
    setApiKeyBusy(false);
  }
}

async function revokeApiKey(name) {
  if (!window.confirm(t('fleet_manage.revoke_confirm', { name }))) return;
  setApiKeyBusy(true);
  fleetManageStatus(t('fleet_manage.revoking_key'), 'running');
  try {
    const resp = await fetch(api(`/api/keys/${encodeURIComponent(name)}`), { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.revoke_failed')));
    renderApiKeys(data);
    if (fleetManageModal?._createdKey?.name === name) renderCreatedApiKey(null);
    fleetManageStatus(t('fleet_manage.key_revoked_status'), 'success');
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  } finally {
    setApiKeyBusy(false);
  }
}

async function hardDeleteApiKey(name) {
  if (!window.confirm(t('fleet_manage.delete_confirm', { name }))) return;
  setApiKeyBusy(true);
  fleetManageStatus(t('fleet_manage.deleting_key'), 'running');
  try {
    const resp = await fetch(api(`/api/keys/${encodeURIComponent(name)}?permanent=1`), { method: 'DELETE' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.delete_failed')));
    renderApiKeys(data);
    if (fleetManageModal?._createdKey?.name === name) renderCreatedApiKey(null);
    fleetManageStatus(t('fleet_manage.key_deleted_status'), 'success');
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  } finally {
    setApiKeyBusy(false);
  }
}

async function purgeRevokedApiKeys() {
  if (!window.confirm(t('fleet_manage.purge_revoked_confirm'))) return;
  setApiKeyBusy(true);
  fleetManageStatus(t('fleet_manage.purging_revoked'), 'running');
  try {
    const resp = await fetch(api('/api/keys/purge-revoked'), { method: 'POST' });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.purge_revoked_failed')));
    renderApiKeys(data);
    if (fleetManageModal?._createdKey?.name && !data.keys?.some(key => key.name === fleetManageModal._createdKey.name)) {
      renderCreatedApiKey(null);
    }
    fleetManageStatus(t('fleet_manage.purge_revoked_status', { count: data.purged ?? 0 }), 'success');
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  } finally {
    setApiKeyBusy(false);
  }
}

async function saveFleetSelfName() {
  const name = fleetManageModal.querySelector('#fleet-self-name').value.trim();
  fleetManageStatus(t('fleet_manage.saving'), 'running');
  try {
    const resp = await fetch(api('/api/agent/name'), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name })
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(fleetManageError(data.error, t('fleet_manage.save_failed')));
    fleetManageStatus(t('fleet_manage.saved'), 'success');
    await refreshState();
    await refreshFleet();
  } catch (err) {
    fleetManageStatus(err.message, 'error');
  }
}

let settingsModal = null;
let settingsBuiltInModels = new Set();
let settingsBuiltInPriorityModels = new Set();

function createSettingsModal() {
  if (settingsModal) return settingsModal;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'settings-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
<div class="modal">
  <div class="modal-head">
    <h2>${esc(t('settings.title'))}</h2>
    <button class="modal-close" type="button" aria-label="Close">&times;</button>
  </div>
  <div class="modal-body">
    <div class="action-group" id="settings-model-pricing-group">
      <span class="action-group-label" id="settings-pricing-label">${esc(t('settings.model_pricing'))}
        <button class="tip-btn tip-btn-inline" id="pricing-tip" type="button" aria-label="Pricing info">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <div class="tip-popover" id="pricing-popover" hidden>
          <p>${t('tip.pricing')}</p>
          <p>${esc(t('settings.base_rates_note'))}</p>
        </div>
      </span>
      <div class="settings-table-scroll">
      <table class="settings-price-table" id="settings-price-table">
        <thead>
          <tr><th>${esc(t('settings.col_prefix'))}</th><th>${esc(t('settings.col_input'))}</th><th>${esc(t('settings.col_output'))}</th><th>${esc(t('settings.col_cache_read'))}</th><th>${esc(t('settings.col_cache_write'))}</th><th></th></tr>
        </thead>
        <tbody id="settings-price-rows"></tbody>
      </table>
      </div>
      <button class="action-btn action-btn-sm" id="settings-add-model" type="button">${esc(t('btn.add_model'))}</button>
    </div>
    <div class="action-group" id="settings-priority-pricing-group" hidden>
      <span class="action-group-label">${esc(t('settings.priority_model_pricing'))}</span>
      <div class="settings-table-scroll">
      <table class="settings-price-table" id="settings-priority-price-table">
        <thead>
          <tr><th>${esc(t('settings.col_prefix'))}</th><th>${esc(t('settings.col_input'))}</th><th>${esc(t('settings.col_output'))}</th><th>${esc(t('settings.col_cache_read'))}</th><th>${esc(t('settings.col_cache_write'))}</th><th></th></tr>
        </thead>
        <tbody id="settings-priority-price-rows"></tbody>
      </table>
      </div>
      <button class="action-btn action-btn-sm" id="settings-add-priority-model" type="button">${esc(t('btn.add_model'))}</button>
    </div>
    <div class="action-group" id="settings-fast-mode-group">
      <span class="action-group-label">${esc(t('settings.fast_mode'))}</span>
      <div class="action-field">
        <label class="action-field-label">${esc(t('settings.fast_override'))}</label>
        <div class="action-threshold-wrap">
          <input id="settings-fast-multiplier" class="action-input action-threshold-input" type="number" min="0.1" step="0.1" />
          <span class="action-threshold-unit">x</span>
        </div>
      </div>
      <p class="modal-status">${esc(t('settings.fast_defaults_note'))}</p>
    </div>
    <div class="action-group observer-settings" id="observer-settings-group">
      <span class="action-group-label">${esc(t('observer.settings_title'))}</span>
      <p class="fleet-help">${esc(t('observer.settings_help'))}</p>
      <div class="observer-settings-state">
        <strong id="observer-settings-state">${esc(t('status.loading'))}</strong>
        <span id="observer-settings-platform"></span>
      </div>
      <p class="modal-status" id="observer-settings-recovery" hidden></p>
      <div class="action-row observer-settings-actions">
        <button class="action-btn action-btn-primary" id="observer-install" type="button">${esc(t('observer.install_enable'))}</button>
        <button class="action-btn" id="observer-enable" type="button">${esc(t('observer.enable'))}</button>
        <button class="action-btn" id="observer-disable" type="button">${esc(t('observer.disable'))}</button>
        <button class="action-btn" id="observer-uninstall" type="button">${esc(t('observer.uninstall'))}</button>
      </div>
      <p class="modal-status" id="observer-settings-status" hidden></p>
    </div>
  </div>
  <div class="modal-status" id="settings-readonly-note" hidden></div>
  <div class="modal-status" id="settings-status" hidden></div>
  <div class="settings-footer">
    <button class="action-btn" id="settings-cancel" type="button">${esc(t('btn.cancel'))}</button>
    <button class="action-btn action-btn-primary" id="settings-save" type="button">${esc(t('btn.save'))}</button>
  </div>
</div>`;
  document.body.appendChild(overlay);
  settingsModal = overlay;

  overlay.querySelector('.modal-close').addEventListener('click', closeSettingsModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSettingsModal(); });
  overlay.querySelector('#settings-cancel').addEventListener('click', closeSettingsModal);
  overlay.querySelector('#settings-save').addEventListener('click', saveSettings);
  overlay.querySelector('#settings-add-model').addEventListener('click', () => addPriceRow('', { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, false));
  overlay.querySelector('#settings-add-priority-model').addEventListener('click', () => addPriceRow('', { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, false, 'settings-priority-price-rows'));
  overlay.querySelector('#observer-install').addEventListener('click', () => runObserverLifecycle('install'));
  overlay.querySelector('#observer-enable').addEventListener('click', () => runObserverLifecycle('enable'));
  overlay.querySelector('#observer-disable').addEventListener('click', () => runObserverLifecycle('disable'));
  overlay.querySelector('#observer-uninstall').addEventListener('click', () => runObserverLifecycle('uninstall'));

  const pricingTip = overlay.querySelector('#pricing-tip');
  const pricingPop = overlay.querySelector('#pricing-popover');
  if (pricingTip && pricingPop) {
    pricingTip.addEventListener('click', (e) => { e.stopPropagation(); pricingPop.hidden = !pricingPop.hidden; });
    document.addEventListener('click', () => { pricingPop.hidden = true; });
  }

  return overlay;
}

function applySettingsReadOnly(readOnly) {
  if (!settingsModal) return;
  const note = settingsModal.querySelector('#settings-readonly-note');
  if (note) {
    note.textContent = t('settings.read_only_note');
    note.hidden = !readOnly;
  }
  settingsModal.querySelector('#settings-save').disabled = readOnly;
  settingsModal.querySelector('#settings-add-model').disabled = readOnly;
  settingsModal.querySelector('#settings-add-priority-model').disabled = readOnly;
  settingsModal.querySelectorAll('.settings-input, .settings-remove-btn').forEach((el) => {
    el.disabled = readOnly;
  });
  settingsModal.querySelectorAll('.observer-settings-actions button').forEach((el) => {
    el.disabled = readOnly || Boolean(state.observer.lifecyclePending);
  });
}

function observerStatusLabel(status) {
  if (!status) return t('value.unknown');
  if (observerRecoveryReason(status)) return t('observer.state_recovery');
  if (status.state === 'installed' && status.desired?.enabled) return t('observer.state_enabled');
  if (status.state === 'installed') return t('observer.state_disabled');
  if (status.state === 'not_installed') return t('observer.state_not_installed');
  if (status.state === 'unsupported' && status.artifactAvailable) return t('observer.state_unvalidated');
  if (status.state === 'unsupported') return t('observer.state_unsupported');
  if (status.state === 'failed') return t('observer.state_failed');
  return status.state || t('value.unknown');
}

function observerRecoveryReason(status) {
  return (status?.runtime?.state === 'blocked' ? status.runtime.error || 'teardown_failed' : null) || status?.startupError || status?.desired?.lastError || status?.desired?.removalState ||
    (status?.desired?.enabled && status?.desired?.teardownFence ? 'teardown_fenced' : null);
}

function renderObserverStatus(status = state.observer.status) {
  const recoveryReason = observerRecoveryReason(status);
  const tab = $('#observer-tab');
  const available = status?.state === 'installed' && status.desired?.enabled === true && !recoveryReason && !remoteIsReadOnly();
  if (tab) tab.hidden = !available;
  renderObserverSizeForm(status);
  const stateEl = settingsModal?.querySelector('#observer-settings-state');
  const platformEl = settingsModal?.querySelector('#observer-settings-platform');
  if (stateEl) stateEl.textContent = observerStatusLabel(status);
  const recoveryEl = settingsModal?.querySelector('#observer-settings-recovery');
  if (recoveryEl) {
    recoveryEl.hidden = !recoveryReason;
    recoveryEl.textContent = recoveryReason ? `${t(status?.desired?.removalState ? 'observer.removal_recovery_hint' : 'observer.recovery_hint')} (${recoveryReason})` : '';
  }
  if (platformEl) {
    const version = status?.version ? ` · Zellij ${status.version}` : '';
    platformEl.textContent = status?.platform ? `${status.platform}${version}` : '';
  }
  const readOnly = remoteIsReadOnly();
  const install = settingsModal?.querySelector('#observer-install');
  const enable = settingsModal?.querySelector('#observer-enable');
  const disable = settingsModal?.querySelector('#observer-disable');
  const uninstall = settingsModal?.querySelector('#observer-uninstall');
  if (install) install.hidden = Boolean(recoveryReason) || status?.state !== 'not_installed';
  if (enable) enable.hidden = Boolean(recoveryReason) || status?.state !== 'installed' || status?.desired?.enabled === true;
  if (disable) {
    disable.hidden = Boolean(status?.desired?.removalState) || (!recoveryReason && (status?.state !== 'installed' || status?.desired?.enabled !== true));
    disable.textContent = t(recoveryReason ? 'observer.retry_cleanup' : 'observer.disable');
  }
  if (uninstall) {
    uninstall.hidden = !recoveryReason && status?.state !== 'installed' && status?.state !== 'failed';
    uninstall.textContent = t(status?.desired?.removalState ? 'observer.retry_uninstall' : 'observer.uninstall');
  }
  for (const button of [install, enable, disable, uninstall]) {
    if (button) button.disabled = readOnly || Boolean(state.observer.lifecyclePending);
  }
}

async function refreshObserverStatus({ quiet = false, signal } = {}) {
  const targetKey = observerTargetKey();
  const requestGeneration = state.observer.statusGeneration =
    (Number.isInteger(state.observer.statusGeneration) ? state.observer.statusGeneration : 0) + 1;
  const endpoint = observerEndpoint('/api/observer/status');
  const request = { targetKey, promise: null };
  state.observer.statusRequest = request;
  request.promise = (async () => {
    try {
      const resp = await fetch(endpoint, { cache: 'no-store', signal });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw observerRequestError(data, resp.status);
      if (state.observer.statusGeneration !== requestGeneration || observerTargetKey() !== targetKey) return null;
      state.observer.status = data;
      renderObserverStatus(data);
      if (data && state.observer.intent && (data.desired?.enabled !== true || observerRecoveryReason(data))) {
        await closeObserver({ preserveNotice: true });
        setObserverNotice(t(observerRecoveryReason(data) ? 'observer.recovery_hint' : 'observer.not_available'), 'error');
      }
      return data;
    } catch (error) {
      if (state.observer.statusGeneration !== requestGeneration || observerTargetKey() !== targetKey) return null;
      state.observer.status = null;
      renderObserverStatus(null);
      throw error;
    }
  })();
  try { return await request.promise; }
  catch (error) { if (!quiet) throw error; return null; }
}

async function runObserverLifecycle(action) {
  if (remoteIsReadOnly()) return;
  if (['install', 'enable'].includes(action) && observerRecoveryReason(state.observer.status)) return;
  const targetKey = observerTargetKey();
  const generation = state.observer.lifecycleGeneration = (state.observer.lifecycleGeneration || 0) + 1;
  state.observer.lifecyclePending = generation;
  const current = () => state.observer.lifecycleGeneration === generation && observerTargetKey() === targetKey;
  const method = action === 'uninstall' ? 'DELETE' : 'POST';
  const path = action === 'install' || action === 'uninstall'
    ? '/api/observer/install'
    : `/api/observer/${action}`;
  const endpoint = observerEndpoint(path);
  const statusEl = settingsModal?.querySelector('#observer-settings-status');
  const buttons = settingsModal?.querySelectorAll('.observer-settings-actions button') || [];
  buttons.forEach((button) => { button.disabled = true; });
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = 'modal-status';
    statusEl.textContent = t('observer.working');
  }
  try {
    if (action === 'disable' || action === 'uninstall') await closeObserver({ release: true });
    if (!current()) return;
    const resp = await fetch(endpoint, { method, headers: { 'Content-Type': 'application/json' } });
    const data = await resp.json().catch(() => ({}));
    if (!current()) return;
    if (!resp.ok) throw new Error(data.error || t('observer.action_failed'));
    const refreshGeneration = state.observer.statusGeneration + 1;
    const refreshed = await refreshObserverStatus({ quiet: true });
    if (!current()) return;
    if (!refreshed && state.observer.statusGeneration === refreshGeneration) {
      state.observer.status = data;
      renderObserverStatus(data);
    }
    if (statusEl) {
      statusEl.className = 'modal-status settings-status-ok';
      statusEl.textContent = t('observer.action_done');
    }
  } catch (error) {
    if (!current()) return;
    if (statusEl) statusEl.textContent = error.message;
    await refreshObserverStatus({ quiet: true });
  } finally {
    if (state.observer.lifecyclePending === generation) state.observer.lifecyclePending = null;
    renderObserverStatus();
  }
}

function addPriceRow(prefix, prices, builtIn, rowsId = 'settings-price-rows') {
  const tbody = document.getElementById(rowsId);
  const tr = document.createElement('tr');
  tr._originalPrice = prices;
  tr.innerHTML = `
    <td><input class="settings-input settings-prefix" type="text" value="${esc(prefix)}" ${builtIn ? 'readonly' : ''} /></td>
    <td><input class="settings-input settings-num" type="number" step="0.01" min="0" value="${prices.input}" /></td>
    <td><input class="settings-input settings-num" type="number" step="0.01" min="0" value="${prices.output}" /></td>
    <td><input class="settings-input settings-num" type="number" step="0.01" min="0" value="${prices.cacheRead}" /></td>
    <td><input class="settings-input settings-num" type="number" step="0.01" min="0" value="${prices.cacheCreation}" /></td>
    <td>${builtIn ? '' : `<button class="settings-remove-btn" type="button" title="${esc(t('btn.remove'))}">&times;</button>`}</td>`;
  if (!builtIn) {
    tr.querySelector('.settings-remove-btn').addEventListener('click', () => tr.remove());
  }
  tbody.appendChild(tr);
}

async function openSettingsModal() {
  const modal = createSettingsModal();
  const status = modal.querySelector('#settings-status');
  const readOnly = remoteIsReadOnly();
  status.hidden = true;
  applySettingsReadOnly(readOnly);

  refreshObserverStatus({ quiet: true }).catch(() => {});

  try {
    const resp = await fetch(api(agentPath('/api/settings')));
    if (!resp.ok) throw new Error('Failed to load settings');
    const data = await resp.json();
    const runtimeLabel = data.runtime === 'codex' ? 'Codex' : 'Claude';
    settingsBuiltInModels = new Set(data.builtInModels || []);
    settingsBuiltInPriorityModels = new Set(data.builtInPriorityModels || []);
    const pricingLabel = document.getElementById('settings-pricing-label');
    if (pricingLabel) {
      pricingLabel.firstChild.textContent = t('settings.model_pricing_runtime', { runtime: runtimeLabel });
    }

    const tbody = document.getElementById('settings-price-rows');
    tbody.innerHTML = '';
    for (const [prefix, prices] of Object.entries(data.modelPrices || {})) {
      addPriceRow(prefix, prices, settingsBuiltInModels.has(prefix));
    }

    const priorityGroup = document.getElementById('settings-priority-pricing-group');
    if (priorityGroup) priorityGroup.hidden = data.runtime !== 'codex';
    const priorityTbody = document.getElementById('settings-priority-price-rows');
    if (priorityTbody) {
      priorityTbody.innerHTML = '';
      for (const [prefix, prices] of Object.entries(data.priorityModelPrices || {})) {
        addPriceRow(prefix, prices, settingsBuiltInPriorityModels.has(prefix), 'settings-priority-price-rows');
      }
    }

    const fastModeGroup = document.getElementById('settings-fast-mode-group');
    if (fastModeGroup) fastModeGroup.hidden = data.fastMode?.mode !== 'multiplier';
    const fastInput = document.getElementById('settings-fast-multiplier');
    if (fastInput) {
      const configured = data.fastMode?.configuredMultiplier;
      fastInput.value = configured === null ? '' : configured ?? data.fastMode?.multiplier ?? data.fastModeMultiplier ?? 6;
      fastInput.dataset.initialValue = fastInput.value;
      fastInput.placeholder = t('settings.model_defaults');
      fastInput.disabled = readOnly;
    }
    applySettingsReadOnly(readOnly);
  } catch (err) {
    status.textContent = err.message;
    status.hidden = false;
  }

  modal.hidden = false;
}

function closeSettingsModal() {
  if (settingsModal) settingsModal.hidden = true;
}

async function saveSettings() {
  if (remoteIsReadOnly()) return;
  const status = settingsModal.querySelector('#settings-status');
  status.hidden = true;

  const modelPrices = {};
  const rows = document.querySelectorAll('#settings-price-rows tr');
  for (const row of rows) {
    const inputs = row.querySelectorAll('input');
    const prefix = inputs[0].value.trim();
    if (!prefix) continue;
    modelPrices[prefix] = priceWithEditedBaseRates(row._originalPrice, [...inputs].slice(1, 5).map(input => input.value));
  }

  const fastModeGroup = document.getElementById('settings-fast-mode-group');
  const body = { modelPrices };
  const priorityGroup = document.getElementById('settings-priority-pricing-group');
  if (priorityGroup && !priorityGroup.hidden) {
    const priorityModelPrices = {};
    const priorityRows = document.querySelectorAll('#settings-priority-price-rows tr');
    for (const row of priorityRows) {
      const inputs = row.querySelectorAll('input');
      const prefix = inputs[0].value.trim();
      if (!prefix) continue;
      priorityModelPrices[prefix] = priceWithEditedBaseRates(row._originalPrice, [...inputs].slice(1, 5).map(input => input.value));
    }
    body.priorityModelPrices = priorityModelPrices;
  }
  if (!fastModeGroup?.hidden) {
    const fastInput = document.getElementById('settings-fast-multiplier');
    if (fastInput.value !== fastInput.dataset.initialValue) {
      body.fastModeMultiplier = fastInput.value === '' ? null : Number(fastInput.value);
    }
  }

  try {
    const resp = await fetch(api(agentPath('/api/settings')), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || t('settings.save_failed'));
    status.textContent = t('settings.saved');
    status.className = 'modal-status settings-status-ok';
    status.hidden = false;
    setTimeout(() => closeSettingsModal(), 1200);
  } catch (err) {
    status.textContent = err.message;
    status.className = 'modal-status';
    status.hidden = false;
  }
}

// ─── Actions Modal ───
let actionsModal = null;
let modeStatusTimer = null;
let pendingManualRestart = null;

function createActionsModal() {
  if (actionsModal) return actionsModal;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'actions-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
<div class="modal">
  <div class="modal-head">
    <h2>${esc(t('actions.title'))}</h2>
    <button class="modal-close" type="button" aria-label="Close">&times;</button>
  </div>
  <div class="modal-body">
    <div class="action-group">
      <span class="action-group-label">${esc(t('actions.agent_control'))}</span>
      <div class="action-row">
        <button class="action-btn" data-action="chop-chop" type="button">${esc(t('actions.chop_chop'))}</button>
        <button class="action-btn action-warn" data-action="restart-session" type="button">${esc(t('actions.restart'))}</button>
      </div>
    </div>
    <div class="action-group">
      <span class="action-group-label">${esc(t('actions.configuration'))}</span>
      <div class="action-field"><label class="action-field-label">${esc(t('actions.session_mode'))}</label><select id="action-mode" class="action-select"><option value="single">single</option><option value="multi">multi</option></select></div>
      <p id="action-mode-status" class="modal-status" style="overflow-wrap:anywhere"></p>
      <p id="action-instance-status" class="modal-status" style="overflow-wrap:anywhere"></p>
      <p id="action-restart-status" class="modal-status" style="overflow-wrap:anywhere"></p>
      <div class="action-field">
        <label class="action-field-label">${esc(t('actions.runtime'))}</label>
        <select id="action-runtime" class="action-select">
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </div>
      <div class="action-field" id="action-model-field">
        <label class="action-field-label">${esc(t('actions.model'))}</label>
        <div class="action-model-wrap">
          <select id="action-model" class="action-select"></select>
          <input id="action-model-custom" class="action-input" type="text" placeholder="${esc(t('actions.model_placeholder'))}" hidden />
          <button id="action-model-apply" class="action-btn action-btn-sm" type="button" hidden>${esc(t('btn.apply'))}</button>
        </div>
      </div>
      <div class="action-field" id="action-effort-field">
        <label class="action-field-label">${esc(t('actions.effort'))}</label>
        <select id="action-effort" class="action-select"></select>
      </div>
      <div class="action-field">
        <label class="action-field-label">${esc(t('actions.threshold'))}</label>
        <button class="tip-btn tip-btn-inline" id="threshold-tip" type="button" aria-label="Threshold info">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="7" stroke="currentColor" stroke-width="1.5"/><path d="M8 7v4M8 5.5v0" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
        <div class="tip-popover" id="threshold-popover" hidden>
          <p>${t('tip.threshold')}</p>
        </div>
        <div class="action-threshold-wrap">
          <input id="action-threshold" class="action-input action-threshold-input" type="number" min="10" max="95" step="5" />
          <span class="action-threshold-unit">%</span>
          <button class="action-btn action-btn-sm" id="action-threshold-apply" type="button">${esc(t('btn.apply'))}</button>
        </div>
      </div>
    </div>
    <div class="action-group">
      <span class="action-group-label">${esc(t('actions.upgrade'))}</span>
      <div class="action-row">
        <button class="action-btn" data-action="upgrade-cc" type="button">
          <span id="action-cli-label">${esc(t('actions.upgrade_cc'))}</span><span class="action-ver" id="action-cc-ver"></span>
        </button>
      </div>
    </div>
  </div>
  <div class="modal-status" id="action-status" hidden></div>
  <div class="modal-confirm" id="action-confirm" hidden>
    <p id="action-confirm-text"></p>
    <div class="modal-confirm-buttons">
      <button class="action-btn" id="action-confirm-cancel" type="button">${esc(t('btn.cancel'))}</button>
      <button class="action-btn danger" id="action-confirm-ok" type="button">${esc(t('btn.confirm'))}</button>
    </div>
  </div>
</div>`;
  document.body.appendChild(overlay);
  actionsModal = overlay;

  overlay.querySelector('.modal-close').addEventListener('click', closeActionsModal);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeActionsModal(); });

  overlay.querySelectorAll('.action-btn[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => execAction(btn.dataset.action));
  });

  overlay.querySelector('#action-mode').addEventListener('change', async event => { await execAction('switch-mode', { mode: event.target.value }); await refreshModeStatus(); });
  async function selectAction(sel, action, key) {
    const accepted = await submitSelectAction(sel, action, key, execAction);
    if (accepted !== false && action === 'switch-effort') sel._currentEffort = sel.value;
    return accepted;
  }

  const modelSel = overlay.querySelector('#action-model');
  const modelCustom = overlay.querySelector('#action-model-custom');
  const modelApply = overlay.querySelector('#action-model-apply');
  function setCustomModelMode(on) {
    modelCustom.hidden = !on;
    modelApply.hidden = !on;
    modelSel.classList.toggle('action-select-narrow', on);
  }
  modelSel.addEventListener('change', async () => {
    if (modelSel.value === '__custom__') {
      setCustomModelMode(true);
      modelCustom.focus();
    } else {
      const wasCustom = modelSel._prevValue === '__custom__';
      setCustomModelMode(false);
      if (actionsModal?._renderEffortOptions) actionsModal._renderEffortOptions(modelSel.value);
      await selectAction(modelSel, 'switch-model', 'model');
      if (actionsModal?._renderEffortOptions) {
        actionsModal._renderEffortOptions(modelSel.value === '__custom__' ? modelCustom.value.trim() : modelSel.value);
      }
      if (wasCustom && modelSel.value === '__custom__') setCustomModelMode(true);
    }
  });
  async function submitCustomModel() {
    const val = modelCustom.value.trim();
    if (!val) return;
    const ok = await execAction('switch-model', { model: val });
    if (ok !== false) {
      modelSel._prevValue = '__custom__';
      if (actionsModal?._renderEffortOptions) actionsModal._renderEffortOptions(val);
    }
  }
  modelCustom.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitCustomModel();
  });
  modelApply.addEventListener('click', submitCustomModel);

  const runtimeSel = overlay.querySelector('#action-runtime');
  runtimeSel.addEventListener('change', () => {
    selectAction(runtimeSel, 'switch-runtime', 'runtime');
  });

  const effortSel = overlay.querySelector('#action-effort');
  effortSel.addEventListener('change', () => {
    selectAction(effortSel, 'switch-effort', 'effort');
  });

  const thresholdApply = overlay.querySelector('#action-threshold-apply');
  const thresholdInput = overlay.querySelector('#action-threshold');
  thresholdApply.addEventListener('click', async () => {
    const val = parseInt(thresholdInput.value, 10);
    if (!val || val < 10 || val > 95) return;
    const result = await execAction('set-threshold', { value: val });
    if (result !== false) {
      state.newSessionThreshold = val;
      renderMetrics();
    }
  });
  thresholdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') thresholdApply.click();
  });

  const thresholdTipBtn = overlay.querySelector('#threshold-tip');
  const thresholdPop = overlay.querySelector('#threshold-popover');
  if (thresholdTipBtn && thresholdPop) {
    const pop = thresholdPop.cloneNode(true);
    pop.removeAttribute('id');
    pop.hidden = true;
    document.body.appendChild(pop);
    thresholdPop.remove();
    thresholdTipBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (pop.hidden) {
        const rect = thresholdTipBtn.getBoundingClientRect();
        pop.style.top = `${rect.bottom + 6}px`;
        const left = Math.max(8, rect.left - 120);
        const maxLeft = window.innerWidth - 280 - 8;
        pop.style.left = `${Math.min(left, Math.max(8, maxLeft))}px`;
        pop.hidden = false;
      } else {
        pop.hidden = true;
      }
    });
    document.addEventListener('click', () => { pop.hidden = true; });
  }

  return overlay;
}

async function refreshModeStatus() {
  if (pendingManualRestart) {
    try {
      const result = await fetchJson(`/api/restart-status?requestId=${encodeURIComponent(pendingManualRestart.requestId)}`);
      const text = actionsModal?.querySelector('#action-restart-status');
      const ready = result.origin?.ready && result.origin.runId !== pendingManualRestart.runId;
      if (text) text.textContent = t('actions.restart_progress', { submission: pendingManualRestart.submission, completion: result.completion === 'deadline_exceeded' ? 'unknown' : result.completion, ready: ready ? t('actions.ready') : t('value.unknown') });
      if (result.completion === 'done' || ready) pendingManualRestart = null;
    } catch {}
  }
  const text = actionsModal?.querySelector('#action-mode-status');
  try {
    const result = await fetchJson('/api/session-mode');
    if (!result?.ok) throw new Error(result?.error?.message || 'Unknown');
    const data = result.data;
    const mode = ['single', 'multi'].includes(data.sessionMode) ? data.sessionMode : null;
    if (mode) actionsModal.querySelector('#action-mode').value = mode;
    text.textContent = [mode || t('value.unknown'), data.transition?.phase, data.transition?.reason, data.supervisor === 'unreachable' ? t('actions.supervisor_unreachable') : '', data.blocked?.since ? t('actions.blocked_since', { time: data.blocked.since }) : ''].filter(Boolean).join(' · ');
  } catch (error) { if (text) text.textContent = error.message; }
  const instanceText = actionsModal?.querySelector('#action-instance-status');
  try {
    const result = await fetchJson('/api/instance-status');
    if (!result?.ok) throw new Error(result?.error?.message || 'Unknown');
    const data = result.data || {};
    const originState = data.origin?.status?.state || data.origin?.presence || t('value.unknown');
    if (instanceText) instanceText.textContent = t('actions.instance_status', { view: data.view || t('value.unknown'), mode: data.sessionMode || t('value.unknown'), origin: originState });
  } catch (error) { if (instanceText) instanceText.textContent = error.message; }
}

async function openActionsModal() {
  if (remoteIsReadOnly()) return;
  const modal = createActionsModal();
  modal.hidden = false;
  refreshModeStatus();
  clearInterval(modeStatusTimer);
  modeStatusTimer = setInterval(refreshModeStatus, 2000);

  const statusEl = modal.querySelector('#action-status');
  statusEl.hidden = true;
  updateRestartDot();
  try {
    const meta = await fetchJson('/api/actions/meta');
    const runtimeSel = modal.querySelector('#action-runtime');
    runtimeSel.value = meta.runtime;

    const modelField = modal.querySelector('#action-model-field');
    const modelSel = modal.querySelector('#action-model');
    const effortField = modal.querySelector('#action-effort-field');
    const effortSel = modal.querySelector('#action-effort');

    if (modelField) modelField.hidden = false;
    if (effortField) effortField.hidden = false;

    const modelState = modelOptionState(meta);
    modelSel.innerHTML = '';
    for (const option of modelState.options) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.labelKey ? t(option.labelKey) : option.label;
      opt.disabled = Boolean(option.disabled);
      opt.selected = Boolean(option.selected);
      modelSel.appendChild(opt);
    }
    const modelCustomEl = modal.querySelector('#action-model-custom');
    const modelApplyEl = modal.querySelector('#action-model-apply');
    if (modelState.custom) {
      modelSel.value = '__custom__';
      modelCustomEl.value = modelState.customValue;
      modelCustomEl.hidden = false;
      modelApplyEl.hidden = false;
      modelSel.classList.add('action-select-narrow');
    } else {
      modelCustomEl.hidden = true;
      modelApplyEl.hidden = true;
      modelSel.classList.remove('action-select-narrow');
    }

    effortSel._currentEffort = meta.current_effort;
    modal._renderEffortOptions = (modelId) => {
      const effortState = effortOptionState(meta, modelId, effortSel._currentEffort, effortLabel);
      effortSel.innerHTML = '';
      effortSel.disabled = effortState.disabled;
      effortField.hidden = effortState.hidden;
      for (const option of effortState.options) {
        const opt = document.createElement('option');
        opt.value = option.value;
        opt.textContent = option.labelKey
          ? t(option.labelKey, option.labelParams)
          : effortLabel(option.value);
        opt.disabled = Boolean(option.disabled);
        opt.selected = Boolean(option.selected);
        effortSel.appendChild(opt);
      }
      effortSel._prevValue = effortSel.value;
    };
    modal._renderEffortOptions(modelSel.value === '__custom__' ? meta.current_model : modelSel.value);

    const ri = state.dashboardState?.runtime_info;
    const ccVer = modal.querySelector('#action-cc-ver');
    const cliLabel = modal.querySelector('#action-cli-label');
    if (cliLabel) cliLabel.textContent = meta.runtime_cli === 'codex' ? t('actions.upgrade_codex') : t('actions.upgrade_cc');
    ccVer.textContent = meta.cc_version ? ` v${meta.cc_version}` : '';
    const cliUpdate = meta.runtime_cli === 'codex' ? ri?.codex_restart || ri?.codex_update : ri?.cc_update;
    ccVer.classList.toggle('action-ver-dot', !!cliUpdate);
    ccVer.title = cliUpdate ? t('info.version_available', { version: cliUpdate }) : '';

    runtimeSel._prevValue = runtimeSel.value;
    modelSel._prevValue = modelSel.value;
    effortSel._prevValue = effortSel.value;

    const thresholdInput = modal.querySelector('#action-threshold');
    if (thresholdInput) thresholdInput.value = meta.new_session_threshold || state.newSessionThreshold || 70;
  } catch { /* meta unavailable, modal still usable */ }
}

function closeActionsModal() {
  clearInterval(modeStatusTimer);
  modeStatusTimer = null;
  if (!actionsModal) return;
  if (pendingConfirmCancel) { pendingConfirmCancel(); pendingConfirmCancel = null; }
  actionsModal.hidden = true;
  const confirm = actionsModal.querySelector('#action-confirm');
  if (confirm) confirm.hidden = true;
  const status = actionsModal.querySelector('#action-status');
  if (status) status.hidden = true;
  setModalBodyDisabled(false);
}

function updateRestartDot() {
  const btn = actionsModal?.querySelector('.action-btn[data-action="restart-session"]');
  if (!btn) return;
  const pending = !!state.dashboardState?.runtime_info?.pending_restart;
  btn.classList.toggle('action-btn-pending', pending);
  btn.title = pending ? t('info.pending_restart') : '';
}

const CONFIRM_ACTIONS = new Set(['switch-mode', 'interrupt', 'chop-chop', 'restart-session', 'switch-runtime', 'switch-model', 'switch-effort', 'upgrade-zylos', 'upgrade-cc']);

let countdownTimer = null;
let pendingConfirmCancel = null;

function startCountdownAndReload(seconds, statusEl, healthPath = '/api/health', prefix = '') {
  if (countdownTimer) clearInterval(countdownTimer);
  let remaining = seconds;

  const btns = actionsModal?.querySelectorAll('button, select, input');
  btns?.forEach(el => { if (!el.classList.contains('modal-close')) el.disabled = true; });

  const tick = () => {
    if (!statusEl) return;
    statusEl.hidden = false;
    statusEl.className = 'modal-status running';
    statusEl.textContent = [prefix, t('status.countdown', { seconds: remaining })].filter(Boolean).join('\n');
  };
  tick();

  countdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(countdownTimer);
      countdownTimer = null;
      if (statusEl) statusEl.textContent = t('status.reloading');
      pollAndReload(healthPath);
      return;
    }
    tick();
  }, 1000);
}

async function pollAndReload(healthPath = '/api/health') {
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const r = await fetch(api(healthPath), { cache: 'no-store' });
      if (r.ok) { window.location.reload(); return; }
    } catch {}
  }
  window.location.reload();
}

function setModalBodyDisabled(disabled) {
  const body = actionsModal?.querySelector('.modal-body');
  if (!body) return;
  body.classList.toggle('modal-body-disabled', disabled);
  body.querySelectorAll('button, select, input').forEach(el => { el.disabled = disabled; });
}

function showConfirm(text) {
  return new Promise((resolve) => {
    const box = actionsModal?.querySelector('#action-confirm');
    const msg = actionsModal?.querySelector('#action-confirm-text');
    const okBtn = actionsModal?.querySelector('#action-confirm-ok');
    const cancelBtn = actionsModal?.querySelector('#action-confirm-cancel');
    if (!box || !msg || !okBtn || !cancelBtn) { resolve(false); return; }

    msg.textContent = text;
    box.hidden = false;
    setModalBodyDisabled(true);

    function cleanup() {
      pendingConfirmCancel = null;
      box.hidden = true;
      setModalBodyDisabled(false);
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
    }
    function onOk() { cleanup(); resolve(true); }
    function onCancel() { cleanup(); resolve(false); }
    pendingConfirmCancel = onCancel;
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
  });
}

async function execAction(action, body) {
  if (remoteIsReadOnly()) return false;
  if (['interrupt', 'chop-chop', 'restart-session'].includes(action)) {
    const shown = state.dashboardState;
    body = { ...body, sessionGroup: shown?.sessionGroup, runId: shown?.runId, sessionId: shown?.sessionId };
  }
  const actionPath = agentPath(`/api/actions/${action}`);
  const healthPath = agentPath('/api/health');
  if (CONFIRM_ACTIONS.has(action)) {
    const labels = {
      'switch-mode': t('confirm.switch_mode', { mode: body?.mode }),
      'interrupt': t('confirm.interrupt'),
      'chop-chop': t('confirm.chop_chop'),
      'restart-session': t('confirm.restart'),
      'switch-runtime': body?.runtime === 'codex'
        ? t('confirm.switch_runtime_codex')
        : t('confirm.switch_runtime', { value: body?.runtime }),
      'switch-model': t('confirm.switch_model', { value: body?.model }),
      'switch-effort': t('confirm.switch_effort', { value: effortLabel(body?.effort) }),
      'upgrade-zylos': t('confirm.upgrade_zylos'),
      'upgrade-cc': state.dashboardState?.runtime_info?.runtime === 'codex'
        ? t('confirm.upgrade_codex')
        : t('confirm.upgrade_cc')
    };
    let message = labels[action] || t('confirm.fallback', { action });
    if (state.remoteAgent || REMOTE_AGENT) {
      message = `${message}\n${t('confirm.remote_target', { agent: viewedAgentName() })}`;
    }
    if (!(await showConfirm(message))) return false;
  }

  const statusEl = actionsModal?.querySelector('#action-status');
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = 'modal-status running';
    statusEl.textContent = t('status.executing');
  }

  try {
    const r = await fetch(api(actionPath), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    const result = await r.json();
    if (action === 'restart-session' && result.requestId) {
      pendingManualRestart = result.submission === 'unknown' ? { requestId: result.requestId, submission: result.submission, runId: body?.runId } : null;
      if (pendingManualRestart) refreshModeStatus();
    }
    if (result.ok && result.detached) {
      const summary = formatActionResult(result, t) || t('status.done');
      if (statusEl) {
        statusEl.className = 'modal-status success';
        statusEl.style.whiteSpace = 'pre-line';
        statusEl.textContent = summary;
      }
      startCountdownAndReload(15, statusEl, healthPath, summary);
      return true;
    }
    if (statusEl) {
      const isInfo = !result.ok && (result.error === 'already_up_to_date' || result.error === 'already_set');
      statusEl.className = result.ok ? 'modal-status success' : isInfo ? 'modal-status success' : 'modal-status error';
      statusEl.style.whiteSpace = 'pre-line';
      statusEl.textContent = formatActionResult(result, t) || (result.ok ? t('status.done') : result.error);
      if (result.ok || isInfo) setTimeout(() => { statusEl.hidden = true; }, 5000);
    }
    if (result.refreshState) await refreshState();
    if (result.ok && result.requires_restart) {
      await new Promise(r => setTimeout(r, 1500));
      if (statusEl) statusEl.hidden = true;
      await execAction('restart-session');
    }
    return result.ok;
  } catch (err) {
    if (statusEl) {
      statusEl.className = 'modal-status error';
      statusEl.textContent = t('status.failed', { error: err.message });
    }
    return false;
  }
}

// zylos-core upgrades are done by the agent itself (it can recover from a failed
// upgrade); the dashboard only tells the user what to ask their agent.
let zylosHintPopover = null;
function toggleZylosUpdateHint(anchor) {
  if (!zylosHintPopover) {
    zylosHintPopover = document.createElement('div');
    zylosHintPopover.className = 'tip-popover';
    zylosHintPopover.hidden = true;
    document.body.appendChild(zylosHintPopover);
  }
  const pop = zylosHintPopover;
  if (!anchor || !pop.hidden) { pop.hidden = true; return; }
  const p = document.createElement('p');
  p.textContent = anchor.getAttribute('title') || '';
  pop.replaceChildren(p);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 288))}px`;
  pop.hidden = false;
}

function initInfoBarButtons() {
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.closest?.('#zylos-update-hint')) {
      e.preventDefault();
      toggleZylosUpdateHint(e.target.closest('#zylos-update-hint'));
    } else if (e.key === 'Escape') {
      toggleZylosUpdateHint(null);
    }
  });
  document.addEventListener('click', (e) => {
    const hint = e.target.closest('#zylos-update-hint');
    if (hint) { e.preventDefault(); toggleZylosUpdateHint(hint); return; }
    toggleZylosUpdateHint(null);
    if (e.target.closest('#fleet-manage-btn')) { e.preventDefault(); openFleetManageModal(); return; }
    if (e.target.closest('#settings-btn')) { e.preventDefault(); openSettingsModal(); return; }
    if (e.target.closest('#actions-btn, .info-bar-update')) {
      e.preventDefault();
      if (!remoteIsReadOnly()) openActionsModal();
    }
  });
}

function initFleetManageButton() {
  const btn = $('#fleet-manage-btn');
  if (!btn) return;
  btn.hidden = !!REMOTE_AGENT;
  btn.setAttribute('aria-label', t('fleet_manage.open'));
}

// ─── Timers ───
function startTimers() {
  state.timer = setInterval(() => { renderState(); renderMetrics(); renderHealth(); }, 1000);
  state.pollTimer = setInterval(refreshAll, 30_000);
  syncFleetSubscription();
}

window.addEventListener('beforeunload', () => {
  clearInterval(state.timer);
  clearInterval(state.pollTimer);
  clearFleetFallback();
  clearTimeout(state.sseReconnectTimer);
  state.eventSource?.close();
  closeObserver({ release: true }).catch(() => {});
});
window.addEventListener('pagehide', () => { closeObserver({ release: true }).catch(() => {}); });

// ─── Init ───
initTheme();
await initI18n();
await refreshObserverStatus({ quiet: true });
initTabs();
initFleetMode();
initLocaleToggle();
initLogout();
initTips();
initInfoBarButtons();
initFleetManageButton();
initMemoryControls();
initObserverControls();
initFleetHoverPause();
initFleetSounds();
renderAll();
initCharts();
initTrendControls();
connectSse();
// Fetch the fleet early to choose the landing view (Agent Fleet vs single agent).
try {
  const fleet = await refreshFleet();
  applyFleetMode(fleet);
} catch {
  // Fleet unavailable — fall back to single-agent dashboard.
  applyFleetMode(null);
}
await refreshAll();
startTimers();
