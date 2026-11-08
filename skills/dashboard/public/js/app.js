import { createMarkdownRenderer, markdownHtml } from './markdown-config.js?v=1';
import { composeSettings, createSettingsLoader, resetSettingsDrafts } from './wb/settings.js?v=98';
import { createPricingPanel } from './wb/settings-pricing.js?v=98';
import { mountLanguageControl, mountThemeControl, renderLatency } from './wb/settings-ui.js?v=98';
import { keyCounts, renderCreatedKey, renderRemoteAgents } from './wb/settings-access.js?v=99';
import { wireSettingsConfirmations } from './wb/settings-wiring.js?v=1';
import { renderVersion } from './wb/settings-version.js?v=98';
import { mountConversationPage } from './wb/conversation-page.js?v=101';
import { mountChatSettings } from './wb/chat-settings.js?v=98';
import { mountWorkbench } from './wb/shell.js?v=100';
import { watchHeader } from './wb/header-fit.js?v=94';
import { createMemoryScope, leaveMemoryConflict, memoryFileScope, memoryGroupLabel, memoryUpkeepNotice, memoryWriteMessage, saveMemoryOnce, captureMemorySave, memorySaveCurrent, memorySaveOwnerCurrent, memorySaveAppliedCurrent, applyMemorySave, applyMemoryWriteAccess, renderMemoryPreservingEditor } from './wb/memory-scope.js?v=96';
import { instanceStatusText, observeTheme, tabForPath, wbWritable } from './wb/view-mode.js?v=99';
import { observerPageUsable, observerRecoveryReason } from './wb/observer-page.js?v=1';
import { mountSchedule } from './wb/schedule.js?v=96';
import { createUsagePage } from './wb/usage.js?v=97';
import { ObserverHistory } from './observer-history.js?v=2';
import { validAgentSize, validObserverSize } from './observer-size.js?v=2';
import { setAssetRoot, getLocale, initI18n, t, renderI18n } from './i18n.js?v=87';
import { fleetSelfFromSnapshot, handleFleetClick, renderFleetPage } from './agent-fleet.js?v=100';
import { createFleetSounds } from './fleet-sounds.js?v=100';
import { refreshDashboardState } from './state-refresh.js?v=98';
import { formatActionResult } from './action-result.js';
import { originSessionUnavailable } from './state-presentation.js?v=98';
import { ORIGIN_LOCK_SELECTOR, lockOriginButtons } from './origin-lock.js?v=99';
import { mergeRuntimeInfo } from './runtime-ui.js?v=98';

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

const THEMES = ['light', 'dark', 'system'];
const THEME_KEY = 'zylos-dashboard-theme';
function effortLabel(level) { return t(`effort.${level}`) || level?.charAt(0).toUpperCase() + level?.slice(1) || ''; }

const state = {
  dashboardState: null,
  fleet: null,
  fleetSelf: null,
  sourceUpdatedAt: null,
  pollTimer: null,
  fleetFallbackTimer: null,
  fleetHoverPaused: false,
  pendingFleet: null,
  eventSource: null,
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
let stopTheme;
function initTheme(theme) {
  let stored;
  try { stored = localStorage.getItem(THEME_KEY); } catch {}
  const selected = THEMES.includes(theme) ? theme : THEMES.includes(stored) ? stored : 'light';
  stopTheme?.();
  stopTheme = observeTheme(selected, value => {
    document.documentElement.dataset.theme = value;
    usagePage?.setViewDetail();
    workbench?.setViewDetail();
  });
  try { localStorage.setItem(THEME_KEY, selected); } catch {}
  const button = document.querySelector('#wb-theme-toggle');
  if (button) {
    button.onclick = () => initTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  }
}

function tok(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '--';
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
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

function esc(v) {
  return String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function agentFleetLabels() {
  const fleet = key => t('wb.fleet.' + key);
  return {
    ...Object.fromEntries(['title', 'subtitle', 'manage', 'shortAuth', 'shortDown', 'shortVersion', 'fixAuth', 'fixDown', 'fixVersion', 'lastSeen',
      'todayWeek', 'groups', 'host', 'rate7d', 'quotaHead', 'self', 'modeMulti', 'modeSingle', 'modeUnknown', 'open', 'toSettings', 'refresh', 'readOnly', 'admin',
      'compareTitle', 'reachableN', 'unreachableN', 'instance', 'todayCost', 'groupCount', 'allIdle', 'pool', 'poolOf', 'empty'].map(key => [key, fleet(key)])),
    groupStates: Object.fromEntries(['busy', 'waiting', 'error', 'idle', 'not_running'].map(key => [key, t('wb.state.' + key)])),
    busy: t('agent_fleet.busy'),
    thinking: t('agent_fleet.thinking'),
    idle: t('agent_fleet.idle'),
    ...Object.fromEntries(['sleeping', 'waking', 'wake_overdue', 'auth_wait', 'rate_wait', 'reclaiming', 'switching'].map(key => [key, t(`agent_fleet.${key}`)])),
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
    model: t('agent_fleet.model'),
    sessionCost: t('cost.session'),
    dailyCost: t('cost.today'),
    weeklyCost: t('cost.7d'),
    subagent: t('label.subagents')
  };
}


// ─── Render: Info Bar ───
// Settings version + header agent name. The version is this page's own
// dashboard component version: set once from the first payload that carries
// it (the local server's /api/state, or the remote's own document in
// standalone remote mode) and never overwritten — in-page remote viewing
// swaps dashboardState to the remote agent's payload, whose version belongs
// to a different install.
let ownDashboardVersion = null;
function renderIdentityChrome() {
  ownDashboardVersion ??= state.dashboardState?.dashboard_version ?? null;
  const nameEl = $('#tab-bar-agent-name');
  if (nameEl) {
    const name = viewedAgentName();
    nameEl.textContent = name;
    nameEl.hidden = !name;
  }
}

function renderInfoBar() {
  renderIdentityChrome();
  refreshSettingsVersion();
}

// ─── Render: State ───
function renderOriginAvailability() {
  const unavailable = originSessionUnavailable(state.dashboardState);
  lockOriginButtons(document.querySelectorAll(ORIGIN_LOCK_SELECTOR), {
    unavailable, readOnly: remoteIsReadOnly(), reason: t('action.origin_not_running'),
  });
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
  // Settings shows each remote machine's connection state from the same poller records.
  if (fleetManageModal?._agents) renderFleetManage({ self: { name: fleetManageModal.querySelector('#fleet-self-label').textContent }, agents: fleetManageModal._agents }, true);
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
  renderFleetPage(container, state.fleet, { t, fmtAge, basePath: BASE_PATH, labels: agentFleetLabels(), self: state.fleetSelf });
  const updated = $('#fleet-updated');
  if (updated) updated.textContent = fmtAge(state.fleet?.updated_at);
  fleetSounds?.refreshLabels();
}

// This machine's card shows the multi-session view: groups by state, the running pool and both weekly quotas.
async function refreshFleetSelf() {
  try {
    state.fleetSelf = fleetSelfFromSnapshot(await fetchJson('/api/workbench/groups'));
  } catch { state.fleetSelf = null; }
}

function renderConnection(mode) {
  const pill = $('#connection-status');
  pill.dataset.state = mode;
  pill.dataset.i18n = `status.${mode}`;
  pill.textContent = t(pill.dataset.i18n);
}

function renderAll() {
  renderI18n();
  state.observer.history?.refreshLabels();
  initFleetManageButton();
  if (settingsPage) {
    settingsPage.relabel();
    settingsPage.detail(document.documentElement.dataset.detail);
    refreshSettingsVersion();
  }
  renderInfoBar();
  renderOriginAvailability();
  renderObserverPage();
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

const memoryScopeView = createMemoryScope({
  document, root: $('#memory-scope'), chartsRoot: $('#memory-charts'), listRoot: $('#memory-tree'),
  summaryRoot: $('#memory-summary'), t,
  request: fetchAgentJson, getTree: () => state.memory.tree, getFile: () => state.memory.file,
  identity: () => state.remoteAgent ?? REMOTE_AGENT ?? 'local',
  onChange: () => renderMemory(), onFile: path => openMemoryFile(path).catch(() => {}),
  onGroup: path => state.memory.collapsed.delete(path),
  selectedPath: () => state.memory.selectedPath,
  isCollapsed: key => state.memory.collapsed.has(key),
  toggleCollapsed: key => {
    if (state.memory.collapsed.has(key)) state.memory.collapsed.delete(key);
    else state.memory.collapsed.add(key);
    renderMemory();
  },
  fileTitle: node => [node.path, fmtBytes(node.size_bytes), fmtAge(node.mtime)].filter(Boolean).join(' · '),
  sizeText: fmtBytes,
});
window.addEventListener('pagehide', () => memoryScopeView.destroy());
// The detail level can be set after the memory page first drew (on load, or from the header switch);
// redraw so the summary line, technical charts and commit details follow it.
if (window.MutationObserver) {
  new MutationObserver(() => { if (state.memory?.tree) renderMemoryPreservingEditor(renderMemory, document); })
    .observe(document.documentElement, { attributes: true, attributeFilter: ['data-detail'] });
}
document.addEventListener('dashboard-locale-change', () => { if (state.memory?.tree) renderMemoryPreservingEditor(renderMemory, document); });

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
  const writeMessage = memoryWriteMessage(code, t);
  if (writeMessage) return writeMessage;
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

// Feather chevrons-down-up / chevrons-up-down for the fold-all toggle.

let markdownRenderer = null;

function renderMarkdown(text) {
  markdownRenderer ??= createMarkdownRenderer(window.markdownit);
  return markdownHtml(markdownRenderer, text, esc);
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
  return `<div class="wb-modal-bg memory-conflict-bg"><section class="memory-conflict wb-modal" id="memory-conflict" role="dialog" aria-modal="true">
    <div class="memory-conflict-head">
      <strong>${esc(t('memory.conflict_title'))}</strong>
      <span>${esc(t('memory.conflict_body'))}</span>
    </div>
    <div class="memory-diff">${rows}${notice}</div>
    <div class="memory-conflict-actions">
      <button class="wb-btn" type="button" data-memory-conflict="later">${esc(t('memory.conflict_later'))}</button>
      <span class="wb-grow"></span>
      <button class="wb-btn" type="button" data-memory-conflict="theirs">${esc(t('memory.take_theirs'))}</button>
      <button class="wb-btn" type="button" data-memory-conflict="manual">${esc(t('memory.manual_merge'))}</button>
      <button class="wb-btn wb-btn-danger" type="button" data-memory-conflict="mine">${esc(t('memory.use_mine'))}</button>
    </div>
  </section></div>`;
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
    const upkeep = memoryUpkeepNotice(state.memory.tree)
      ? `<div class="memory-notice warning">${esc(t('wb.memory.upkeepConflict'))}</div>`
      : '';
    content.innerHTML = `${upkeep}${notice}${live}${retry}${conflict}<textarea class="memory-editor" id="memory-editor" spellcheck="false">${esc(state.memory.draft)}</textarea>`;
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
  applyMemoryWriteAccess(editBtn, saveBtn, state.memory.tree, file?.path);
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

  const fold = $('#memory-fold');
  if (fold) {
    const dirs = memoryScopeView.sectionKeys();
    const allCollapsed = dirs.length > 0 && dirs.every(d => state.memory.collapsed.has(d));
    fold.disabled = !state.memory.tree || dirs.length === 0;
    fold.innerHTML = `<i class="wb-ico wb-ico-${allCollapsed ? 'unfold' : 'fold'}" aria-hidden="true"></i>`;
    fold.title = allCollapsed ? t('memory.expand_all') : t('memory.collapse_all');
    fold.setAttribute('aria-label', fold.title);
  }

  const file = state.memory.file;
  const scopeTag = $('#memory-scope-tag');
  if (!file) {
    title.textContent = t('memory.select_file');
    meta.textContent = '';
    if (scopeTag) scopeTag.innerHTML = '';
  } else {
    title.textContent = `memory/${file.path}`;
    // Size and age for everyone; the hash and last commit belong to technical details.
    const commit = state.memory.git?.commit;
    const technical = document.documentElement.dataset.detail === 'technical';
    meta.innerHTML = [
      esc(fmtBytes(file.size_bytes)),
      esc(t('wb.memory.modified', { time: fmtAge(file.mtime) })),
      ...(technical ? [
        file.sha256 ? `<span class="wb-mono">sha ${esc(file.sha256.slice(0, 8))}</span>` : '',
        commit ? `<span class="wb-mono">${esc(commit.short_hash)} ${esc(commit.subject)}</span>` : esc(t('memory.no_commit')),
      ] : []),
    ].filter(Boolean).map(part => `<span>${part}</span>`).join('');
    if (scopeTag) {
      const scope = memoryFileScope(state.memory.tree, file.path);
      if (scope.kind === 'group') {
        scopeTag.innerHTML = `<button type="button" class="wb-tag wb-memory-tag" title="${esc(t('wb.schedule.openGroup'))}">${esc(t('wb.memory.scopeGroup', { name: memoryGroupLabel(scope.group, t) }))}</button>`;
        scopeTag.querySelector('button')?.addEventListener('click', () => openWorkbenchGroup(scope.group.sessionGroup));
      } else {
        scopeTag.innerHTML = `<span class="wb-tag">${esc(t(scope.kind === 'invalid' ? 'wb.memory.scopeInvalid' : 'wb.memory.scopeShared'))}</span>`;
      }
    }
  }
  renderMemoryContent();
  renderMemoryActions();
  memoryScopeView.render();
}

async function loadMemoryTree({ force = false } = {}) {
  if (remoteIsReadOnly()) {
    renderMemory();
    return;
  }
  memoryScopeView.load().catch(() => {});
  if (state.memory.tree && !force) {
    renderMemory();
    return;
  }
  state.memory.loading = true;
  state.memory.error = null;
  renderMemory();
  try {
    state.memory.tree = await fetchAgentJson('/api/memory/tree');
    const selected = memoryScopeView.initialPath(state.memory.tree, state.memory.selectedPath, preferredMemoryPath);
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
  const captured = captureMemorySave(state.memory);
  if (!captured) return;
  flushMemoryDraftSave();
  state.memory.saving = true;
  state.memory.error = null;
  renderMemoryActions();
  try {
    const saved = await saveMemoryOnce({ request: requestAgentJson, readFile: fetchAgentJson,
      path: file.path, text, sha256, isCurrent: () => memorySaveCurrent(captured, state.memory) });
    if (!saved) return;
    if (!applyMemorySave(captured, state.memory, saved)) return;
    saveMemoryDraft();
    const git = await fetchAgentJson(`/api/memory/git?path=${encodeURIComponent(saved.path)}`).catch(() => ({ commit: null }));
    if (!memorySaveAppliedCurrent(captured, state.memory, saved)) return;
    state.memory.git = git;
  } catch (err) {
    if (!memorySaveCurrent(captured, state.memory)) return;
    if (err.code === 'memory_conflict') {
      const latest = await fetchAgentJson(`/api/memory/file?path=${encodeURIComponent(file.path)}`).catch(() => null);
      if (!memorySaveCurrent(captured, state.memory)) return;
      if (isCompleteMemoryFile(latest)) {
        state.memory.conflict = buildMemoryConflict(latest, state.memory.draft, state.memory.draft);
        state.memory.liveNotice = latest;
        state.memory.conflictRetryText = '';
      } else {
        state.memory.conflict = null;
        state.memory.conflictRetryText = state.memory.draft;
        state.memory.error = 'memory_conflict_latest_failed';
        renderMemoryPreservingEditor(renderMemory, document);
        return;
      }
    }
    state.memory.error = err.code || 'memory_browser_failed';
    renderMemoryPreservingEditor(renderMemory, document);
  } finally {
    if (memorySaveOwnerCurrent(captured, state.memory)) {
      state.memory.saving = false;
      renderMemoryPreservingEditor(renderMemory, document);
    }
  }
}

async function resolveMemoryConflict(action) {
  const conflict = state.memory.conflict;
  if (action === 'later') {
    leaveMemoryConflict(state.memory);
    renderMemoryPreservingEditor(renderMemory, document);
    return;
  }
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
  renderInfoBar();
  renderOriginAvailability();
  renderObserverPage();
}

function isSseOpen() {
  return !!window.EventSource && state.eventSource?.readyState === window.EventSource.OPEN;
}

async function refreshFleet() {
  try {
    const [fleet] = await Promise.all([fetchJson('/api/fleet'), state.fleetViewActive ? refreshFleetSelf() : null]);
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

// Observer page frame: empty state when the component is missing or disabled; otherwise the title row
// (Origin is the only group Core's observer attaches to), the scope note and the no-session notice.
function observerPageAvailable(status = state.observer.status) {
  return observerPageUsable(status, { readOnly: remoteIsReadOnly() });
}
function renderObserverPage() {
  const status = state.observer.status, available = observerPageAvailable(status), focus = state.observer.focus;
  const empty = $('#observer-empty'), main = $('#observer-main');
  if (!empty || !main) return;
  empty.hidden = available; main.hidden = !available;
  $('#observer-empty-title').textContent = t(observerRecoveryReason(status) ? 'wb.observer.recovery' : status?.state === 'installed' ? 'wb.observer.disabled' : 'wb.observer.notInstalled');
  $('#observer-empty-back').hidden = !focus;
  $('#observer-back').hidden = !focus;
  const shown = state.dashboardState;
  const groupName = t('wb.term.origin');
  $('#observer-title').textContent = t(focus ? 'wb.observer.focusTitle' : 'wb.observer.pageTitle', { name: groupName });
  const target = $('#observer-target');
  target.replaceChildren();
  const run = shown?.runId;
  if (run) { const id = document.createElement('span'); id.className = 'wb-mono'; id.textContent = run; target.append(t('wb.observer.run') + ' ', id, ' · '); }
  const key = document.createElement('span'); key.className = 'wb-mono'; key.textContent = shown?.sessionGroup ?? 'origin'; target.append(key);
  const idle = available && originSessionUnavailable(shown) && !state.observer.historyMode;
  $('#observer-notice-history').hidden = !idle;
  if (idle && !state.observer.lease) setObserverNotice(t('wb.observer.noSession'), 'idle');
}
function leaveObserverFocus() {
  const key = state.observer.focus;
  state.observer.focus = null;
  if (key) openWorkbenchGroup(key).catch(() => {});
}
/** From a group's detail: observe only that group, with a way back to its detail. */
function openObserverFor(key, view = 'live') {
  state.observer.focus = key;
  document.querySelector(`[data-observer-view="${view === 'history' ? 'history' : 'live'}"]`)?.click();
  document.querySelector('.tab[data-tab="observer"]')?.click();
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
    renderObserverPage();
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
  refreshChat();
  syncMemoryPinned();
  refreshFleet().catch(() => {});
  transitionView('fleet', opts);
  scheduleFleetFallback();
}

function showAgentDetail(opts = {}) {
  if (opts.navigation !== false) state.navigationGeneration += 1;
  state.fleetViewActive = false;
  transitionView('agent', opts);
  refreshChat();
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
  const fetches = state.fleetViewActive ? [refreshFleet()] : [];
  const restResults = await Promise.allSettled(fetches);
  const all = [...stateResult, ...restResults];
  const ok = all.some((r) => r.status === 'fulfilled');
  const sseOpen = isSseOpen();
  renderConnection(ok ? (sseOpen ? 'live' : 'polling') : 'degraded');
}

// ─── SSE ───
function applySse(name, data) {
  if (!data || typeof data !== 'object') return;
  // A remote agent's stream describes its own fleet; never let it clobber ours.
  if (name === 'fleet' && state.remoteAgent) return;
  if (name === 'state_change') {
    const previousState = state.dashboardState;
    const nextRuntimeInfo = mergeRuntimeInfo(previousState, data);
    // The SSE state payload carries only raw state; /api/state adds the agent identity. Keep it across updates.
    const prevAgent = state.dashboardState?.agent;
    state.dashboardState = data;
    if (nextRuntimeInfo) state.dashboardState.runtime_info = nextRuntimeInfo;
    if (!data.agent && prevAgent) state.dashboardState.agent = prevAgent;
    if (data.new_session_threshold) state.newSessionThreshold = data.new_session_threshold;
    state.sourceUpdatedAt = data.updated_at || new Date().toISOString();
    renderInfoBar(); renderOriginAvailability(); renderObserverPage();
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
let usagePage = null, workbench = null, chatPage = null;
function refreshChat() {
  if (activeTabName() === 'chat' && !state.fleetViewActive) return chatPage?.open();
  chatPage?.close();
}
function refreshUsage() {
  if (activeTabName() === 'trends' && !$('#agent-detail')?.hidden) return usagePage?.open();
  usagePage?.close();
}
function initTabs() {
  const activateTab = (name, push = false) => {
    if (name === 'usage') name = 'trends';
    if (name !== 'settings') settingsLoader?.invalidate();
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
    if (name === 'settings') refreshSettingsPage();
    refreshUsage();
    refreshChat();
    if (name === 'memory') loadMemoryTree().catch(() => {});
    if (name !== 'observer') state.observer.focus = null;
    if (name === 'observer') {
      renderObserverPage();
      if (observerPageAvailable()) openObserver().catch(() => {});
      if (state.observer.historyMode) state.observer.history?.setActive(true);
    }
    if (push) {
      const prefix = remotePrefix();
      const path = name === 'overview' ? `${prefix}/` : `${prefix}/${name === 'trends' ? 'usage' : name}`;
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
        const m = path.match(/\/fleet\/([^/]+)\/?(?:trends|usage|schedule|settings|memory|observer|chat)?$/);
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
    const tab = tabForPath(path);
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
  const initialTab = tabForPath(window.location.pathname);
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
        $('#observer-notice').parentElement.hidden = historyMode;
        document.querySelectorAll('[data-observer-view]').forEach(control => {
          control.setAttribute('aria-pressed', String(control === button));
        });
        state.observer.history.setActive(historyMode);
        renderObserverSizeForm();
        renderObserverPage();
      });
    });
  }
  $('#observer-size-form')?.addEventListener('submit', (event) => { applyObserverSize(event).catch(() => {}); });
  $('#observer-back')?.addEventListener('click', leaveObserverFocus);
  $('#observer-empty-back')?.addEventListener('click', leaveObserverFocus);
  $('#observer-empty-settings')?.addEventListener('click', () => openSettingsModal('observer'));
  $('#observer-notice-history')?.addEventListener('click', () => document.querySelector('[data-observer-view="history"]')?.click());

}

function initMemoryControls() {
  $('#memory-refresh')?.addEventListener('click', () => loadMemoryTree({ force: true }).catch(() => {}));
  $('#memory-edit-btn')?.addEventListener('click', startMemoryEdit);
  $('#memory-save-btn')?.addEventListener('click', () => saveMemoryDraftToServer().catch(() => {}));
  $('#memory-reset-btn')?.addEventListener('click', resetMemoryEdit);
  $('#memory-fold')?.addEventListener('click', () => {
    const dirs = memoryScopeView.sectionKeys();
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
  if (['settings', 'chat'].includes(tabForPath(window.location.pathname))) {
    state.fleetModeInitialized = true;
    return;
  }
  if (prefersReducedMotion()) {
    showFleetView({ animate: false });
  } else {
    setTimeout(() => {
      if (!['settings', 'chat'].includes(tabForPath(window.location.pathname))) showFleetView({ animate: true });
    }, 380);
  }
  state.fleetModeInitialized = true;
}

// Clear all per-agent data and incremental DOM so two agents' panels never
// mix while switching the detail view between self and a remote agent.
function resetAgentData() {
  chatPage?.close();
  usagePage?.close();
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
  state.sourceUpdatedAt = null;
  resetMemoryState();
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
    if (activeTabName() === 'trends') refreshUsage();
    refreshChat();
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
  $('#agent-fleet-root')?.addEventListener('click', e => handleFleetClick(e, {
    onSettings: () => openSettingsModal('fleet'), onRefresh: () => refreshFleet().catch(() => {}),
    onSelf: showAgentDetail, onRemote: enterRemoteAgent,
  }));
  $('#fleet-manage-open')?.addEventListener('click', () => openSettingsModal('fleet'));
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

async function changeLocale(locale) {
  if (locale === getLocale()) return;
  await initI18n(locale);
  renderAll();
  refreshSettingsPage();
  usagePage?.setViewDetail();
}

function initLogout() {
  $('#logout-btn').addEventListener('click', async () => {
    try {
      await fetch(api('/logout'), { method: 'POST' });
    } catch { /* ignore */ }
    window.location.href = api('/login');
  });
}

// ─── Settings Modal ───
let fleetManageModal = null;

function createFleetManageModal() {
  if (fleetManageModal) return fleetManageModal;
  const overlay = document.createElement('div');
  overlay.id = 'fleet-manage-modal';
  overlay.hidden = true;
  const head = (iconName, key, extra = '') => `<div class="wb-set-card-h"><h4><i class="wb-ico wb-ico-${iconName} wb-ico-xs" aria-hidden="true"></i><span data-i18n="${key}">${esc(t(key))}</span></h4>${extra}</div>`;
  overlay.innerHTML = `
    <div class="manage-panel" data-panel="fleet">
      <div class="wb-set-card">
        ${head('server', 'wb.settings.fleet.localName')}
        <div class="wb-set-inline" id="fleet-self-view"><b class="wb-self-name" id="fleet-self-label"></b>
          <button class="wb-btn" id="fleet-rename-open" type="button"><i class="wb-ico wb-ico-edit wb-ico-xs" aria-hidden="true"></i><span data-i18n="wb.settings.fleet.rename">${esc(t('wb.settings.fleet.rename'))}</span></button></div>
        <div class="wb-set-inline fleet-self-row" id="fleet-self-edit" hidden>
          <input class="wb-input" id="fleet-self-name" type="text" autocomplete="off" maxlength="32" />
          <button class="wb-btn wb-btn-primary" id="fleet-rename-save" type="button" data-i18n="btn.save">${esc(t('btn.save'))}</button>
          <button class="wb-btn" id="fleet-rename-cancel" type="button" data-i18n="btn.cancel">${esc(t('btn.cancel'))}</button></div>
        <p class="wb-note"><span data-i18n="wb.settings.fleetNameNote">${esc(t('wb.settings.fleetNameNote'))}</span><span class="wb-sent-gap"> </span><span data-i18n="fleet_manage.rename_hint">${esc(t('fleet_manage.rename_hint'))}</span></p>
      </div>
      <div class="wb-set-card">
        ${head('fleet', 'wb.settings.fleet.remotes', `<span class="wb-set-card-sub" id="fleet-agent-count"></span><span class="wb-set-card-acts"><button class="wb-btn" id="fleet-add-open" type="button"><i class="wb-ico wb-ico-plus wb-ico-xs" aria-hidden="true"></i><span data-i18n="wb.settings.fleet.add">${esc(t('wb.settings.fleet.add'))}</span></button></span>`)}
        <div id="fleet-agent-list"></div>
        <div class="wb-addform" id="fleet-add-form" hidden>
          <input class="wb-input" id="fleet-add-name" type="text" autocomplete="off" placeholder="${esc(t('fleet_manage.name'))}" aria-label="${esc(t('fleet_manage.name'))}" />
          <input class="wb-input" id="fleet-add-url" type="url" autocomplete="off" placeholder="${esc(t('wb.settings.fleet.urlPlaceholder'))}" aria-label="${esc(t('fleet_manage.base_url'))}" />
          <input class="wb-input" id="fleet-add-key" type="password" autocomplete="off" placeholder="${esc(t('wb.settings.fleet.keyPlaceholder'))}" aria-label="${esc(t('fleet_manage.read_key'))}" />
          <div class="wb-set-inline wb-nowrap">
            <button class="wb-btn" id="fleet-test" type="button" data-i18n="fleet_manage.test">${esc(t('fleet_manage.test'))}</button>
            <button class="wb-btn wb-btn-primary" id="fleet-add-save" type="button" data-i18n="btn.save">${esc(t('btn.save'))}</button>
            <button class="wb-btn" id="fleet-add-cancel" type="button" data-i18n="btn.cancel">${esc(t('btn.cancel'))}</button></div>
          <small class="wb-addform-hint" data-i18n="wb.settings.fleet.addHint">${esc(t('wb.settings.fleet.addHint'))}</small>
        </div>
      </div>
    </div>
    <div class="manage-panel" data-panel="keys" hidden>
      <div class="wb-set-card">
        ${head('server', 'wb.settings.keys.address')}
        <div class="wb-set-inline api-key-copy-row"><span class="wb-mono wb-addr" id="api-base-url">${esc(dashboardBaseUrl())}</span>
          <button class="wb-btn" id="api-base-url-copy" type="button"><i class="wb-ico wb-ico-copy wb-ico-xs" aria-hidden="true"></i><span data-i18n="fleet_manage.copy_key">${esc(t('fleet_manage.copy_key'))}</span></button></div>
        <p class="wb-note" data-i18n="fleet_manage.base_url_hint">${esc(t('fleet_manage.base_url_hint'))}</p>
      </div>
      <div class="wb-set-card">
        ${head('plus', 'fleet_manage.create_key')}
        <div class="wb-set-inline">
          <input class="wb-input wb-input-name" id="api-key-name" type="text" autocomplete="off" placeholder="${esc(t('wb.settings.keys.namePlaceholder'))}" aria-label="${esc(t('fleet_manage.name'))}" />
          <div class="wb-seg2" id="api-key-scope" role="group" aria-label="${esc(t('wb.settings.keys.scope'))}">
            <button type="button" data-scope="read" aria-pressed="true" data-i18n="fleet_manage.scope_read">${esc(t('fleet_manage.scope_read'))}</button><button type="button" data-scope="admin" aria-pressed="false" data-i18n="fleet_manage.scope_admin">${esc(t('fleet_manage.scope_admin'))}</button></div>
          <button class="wb-btn wb-btn-primary" id="api-key-create" type="button" data-i18n="wb.settings.keys.create">${esc(t('wb.settings.keys.create'))}</button></div>
        <p class="wb-note wb-txt-err api-key-admin-warning" id="api-key-admin-warning" hidden><i class="wb-ico wb-ico-alert wb-ico-xs" aria-hidden="true"></i> <span data-i18n="fleet_manage.admin_key_warning">${esc(t('fleet_manage.admin_key_warning'))}</span></p>
        <div class="wb-once api-key-created" id="api-key-created" hidden></div>
      </div>
      <div class="wb-set-card">
        ${head('key', 'wb.settings.keys.existing', `<span class="wb-set-card-sub" id="api-key-count"></span><span class="wb-set-card-acts"><button class="wb-btn" id="api-key-purge-revoked" type="button" hidden></button></span>`)}
        <div class="wb-tscroll" id="api-key-list"></div>
      </div>
    </div>
  <div class="wb-note" id="fleet-manage-status" role="status" hidden></div>`;
  document.body.appendChild(overlay);
  fleetManageModal = overlay;
  // Handlers look nodes up through fleetManageModal: the settings page moves them out of this overlay.
  const $m = selector => fleetManageModal.querySelector(selector);
  const selfEdit = editing => { $m('#fleet-self-view').hidden = editing; $m('#fleet-self-edit').hidden = !editing; if (editing) $m('#fleet-self-name').focus(); };
  overlay.querySelector('#fleet-rename-open').addEventListener('click', () => selfEdit(true));
  overlay.querySelector('#fleet-rename-cancel').addEventListener('click', () => { $m('#fleet-self-name').value = $m('#fleet-self-label').textContent; selfEdit(false); });
  overlay.querySelector('#fleet-rename-save').addEventListener('click', async () => { if (await saveFleetSelfName()) selfEdit(false); });
  const addForm = open => { $m('#fleet-add-form').hidden = !open; $m('#fleet-add-open').hidden = open; if (open) $m('#fleet-add-name').focus(); };
  overlay.querySelector('#fleet-add-open').addEventListener('click', () => addForm(true));
  overlay.querySelector('#fleet-add-cancel').addEventListener('click', () => addForm(false));
  overlay.querySelector('#fleet-test').addEventListener('click', testFleetAgent);
  overlay.querySelector('#fleet-add-save').addEventListener('click', async () => { if (await saveFleetAgent()) addForm(false); });
  overlay.querySelector('#api-key-create').addEventListener('click', createApiKey);
  overlay.querySelectorAll('#api-key-scope button').forEach(button => button.addEventListener('click', () => {
    fleetManageModal.querySelectorAll('#api-key-scope button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    updateApiKeyScopeWarning();
  }));
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
  status.className = `wb-note wb-status-${kind || 'plain'}`;
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

function apiKeyScope() {
  return fleetManageModal?.querySelector('#api-key-scope [aria-pressed="true"]')?.dataset.scope === 'admin' ? 'admin' : 'read';
}

function apiKeyFormValues() {
  return {
    name: fleetManageModal.querySelector('#api-key-name').value.trim(),
    scope: apiKeyScope()
  };
}

function fleetManageError(code, fallback) {
  if (!code) return fallback || t('fleet_manage.save_failed');
  const key = `fleet_manage.${code}`;
  const translated = t(key);
  return translated === key ? (fallback || code) : translated;
}

function updateApiKeyScopeWarning() {
  const warning = fleetManageModal?.querySelector('#api-key-admin-warning');
  if (warning) warning.hidden = apiKeyScope() !== 'admin';
}

function renderFleetManage(data, draft = null) {
  const selfName = data?.self?.name || viewedAgentName();
  fleetManageModal.querySelector('#fleet-self-label').textContent = selfName;
  if (!draft) fleetManageModal.querySelector('#fleet-self-name').value = selfName;
  const agents = data?.agents || [];
  fleetManageModal._agents = agents;
  fleetManageModal.querySelector('#fleet-agent-count').textContent = t('wb.settings.fleet.count', { count: agents.length });
  renderRemoteAgents(fleetManageModal.querySelector('#fleet-agent-list'), agents, { t, records: state.fleet?.agents ?? [],
    technical: document.documentElement.dataset.detail === 'technical', latency: (root, samples) => renderLatency(root, samples, { t }), onRemove: removeFleetAgent });
}

function renderApiKeys(data) {
  const keys = data?.keys || [];
  const counts = keyCounts(keys);
  const purgeBtn = fleetManageModal.querySelector('#api-key-purge-revoked');
  if (purgeBtn) { purgeBtn.hidden = !counts.revoked; purgeBtn.textContent = t('wb.settings.keys.purge', { count: counts.revoked }); }
  fleetManageModal.querySelector('#api-key-count').textContent = t('wb.settings.keys.counts', counts);
  settingsWiring().renderKeyTable(fleetManageModal.querySelector('#api-key-list'), keys);
}

function renderCreatedApiKey(createdKey) {
  const panel = fleetManageModal.querySelector('#api-key-created');
  fleetManageModal._createdKey = createdKey || null;
  renderCreatedKey(panel, createdKey, { t, onCopy: copyCreatedApiKey, onDismiss: () => renderCreatedApiKey(null) });
  if (createdKey) panel.scrollIntoView({ block: 'nearest' });
}

/** Settings confirmations share the dashboard's own dialog instead of the browser prompt. */
function settingsWiring() {
  return settingsWiring.value ??= wireSettingsConfirmations({
    document, t, run: runConfirmedAction, setBusy: setModalBodyDisabled,
    remoteTarget: () => (state.remoteAgent || REMOTE_AGENT ? viewedAgentName() : null),
    keyActions: { rotate: rotateApiKey, revoke: revokeApiKey, delete: hardDeleteApiKey },
    writable: () => !remoteIsReadOnly() && countdownTimer === null, onGroup: openWorkbenchGroup,
  });
}
function confirmSetting(body, options) {
  return settingsWiring().confirm(body, options);
}

async function copyCreatedApiKey() {
  const key = fleetManageModal?._createdKey?.plaintext_key || '';
  if (!key) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard_unavailable');
    await navigator.clipboard.writeText(key);
    fleetManageStatus(t('fleet_manage.key_copied'), 'success');
  } catch {
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
    return true;
  } catch (err) {
    fleetManageStatus(err.message, 'error');
    return false;
  } finally {
    setFleetAddBusy(false);
  }
}

async function removeFleetAgent(name) {
  if (!(await confirmSetting(t('fleet_manage.remove_confirm', { name }), { ok: t('wb.settings.fleet.remove') }))) return;
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
  if (pendingKeyName && !(await confirmSetting(t('fleet_manage.replace_created_key_confirm', { name: pendingKeyName }), { danger: false }))) return;
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

// The key table has already confirmed the action itself; rotating still asks before replacing a key shown only once.
async function rotateApiKey(name) {
  const pendingKeyName = fleetManageModal?._createdKey?.name;
  if (pendingKeyName && !(await confirmSetting(t('fleet_manage.replace_created_key_confirm', { name: pendingKeyName }), { danger: false }))) return;
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
  if (!(await confirmSetting(t('fleet_manage.purge_revoked_confirm'), { ok: t('wb.settings.keys.purgeOk') }))) return;
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
    fleetManageModal.querySelector('#fleet-self-label').textContent = name;
    return true;
  } catch (err) {
    fleetManageStatus(err.message, 'error');
    return false;
  }
}

let settingsModal = null;

function createSettingsModal() {
  if (settingsModal) return settingsModal;
  const overlay = document.createElement('div');
  overlay.id = 'settings-modal';
  overlay.hidden = true;
  const head = (iconName, key, sub = '', id = '') => `<div class="wb-set-card-h"><h4><i class="wb-ico wb-ico-${iconName} wb-ico-xs" aria-hidden="true"></i><span${id ? ` id="${id}"` : ''} data-i18n="${key}">${esc(t(key))}</span></h4>${sub}<span class="wb-set-card-acts"></span></div>`;
  const priceHead = (cost) => `<thead><tr><th data-i18n="wb.settings.colModel">${esc(t('wb.settings.colModel'))}</th><th data-i18n="settings.col_input">${esc(t('settings.col_input'))}</th><th data-i18n="settings.col_output">${esc(t('settings.col_output'))}</th><th data-i18n="settings.col_cache_read">${esc(t('settings.col_cache_read'))}</th><th data-i18n="settings.col_cache_write">${esc(t('settings.col_cache_write'))}</th>${cost ? `<th data-i18n="wb.settings.col7d">${esc(t('wb.settings.col7d'))}</th>` : ''}<th></th></tr></thead>`;
  const addButton = id => `<button class="wb-btn" id="${id}" type="button"><i class="wb-ico wb-ico-plus wb-ico-xs" aria-hidden="true"></i><span data-i18n="wb.settings.addModel">${esc(t('wb.settings.addModel'))}</span></button>`;
  overlay.innerHTML = `
    <div class="wb-set-card" id="settings-model-pricing-group">
      <div class="wb-set-card-h"><h4><span id="settings-price-title"></span></h4>
        <span class="wb-set-card-sub wb-tip-anchor"><button class="wb-link-btn wb-sub-link" id="pricing-tip" type="button" data-i18n="wb.settings.howMatch">${esc(t('wb.settings.howMatch'))}</button>
        <span class="tip-popover" id="pricing-popover" hidden><span data-i18n="tip.pricing">${t('tip.pricing')}</span> <span data-i18n="settings.base_rates_note">${esc(t('settings.base_rates_note'))}</span></span></span></div>
      <div class="settings-table-scroll"><table class="wb-ptable" id="settings-price-table">${priceHead(true)}<tbody id="settings-price-rows"></tbody></table></div>
      <div class="wb-more-row" id="settings-price-more">${addButton('settings-add-model')}</div>
    </div>
    <div class="wb-set-card" id="settings-priority-pricing-group" hidden>
      ${head('clock', 'settings.priority_model_pricing', `<span class="wb-set-card-sub" data-i18n="wb.settings.prioritySub">${esc(t('wb.settings.prioritySub'))}</span>`)}
      <div class="settings-table-scroll"><table class="wb-ptable" id="settings-priority-price-table">${priceHead(false)}<tbody id="settings-priority-price-rows"></tbody></table></div>
      <div class="wb-more-row">${addButton('settings-add-priority-model')}</div>
    </div>
    <div class="wb-set-card" id="settings-fast-mode-group">
      ${head('clock', 'settings.fast_mode', `<span class="wb-set-card-sub" data-i18n="wb.settings.fastSub">${esc(t('wb.settings.fastSub'))}</span>`)}
      <label class="wb-set-inline"><span data-i18n="settings.fast_override">${esc(t('settings.fast_override'))}</span>
        <input id="settings-fast-multiplier" class="wb-input wb-input-num" type="number" min="0.1" step="0.1" /><span>×</span></label>
      <p class="wb-note" data-i18n="settings.fast_defaults_note">${esc(t('settings.fast_defaults_note'))}</p>
    </div>
    <div class="wb-set-card" id="observer-settings-group">
      <div class="wb-obs-state"><span class="wb-hdot" id="observer-settings-dot"></span><b id="observer-settings-state">${esc(t('status.loading'))}</b><small id="observer-settings-platform"></small></div>
      <p class="wb-note" id="observer-settings-recovery" hidden></p>
      <div class="wb-set-inline observer-settings-actions">
        <button class="wb-btn wb-btn-primary" id="observer-install" type="button" data-i18n="observer.install_enable">${esc(t('observer.install_enable'))}</button>
        <button class="wb-btn wb-btn-primary" id="observer-enable" type="button" data-i18n="observer.enable">${esc(t('observer.enable'))}</button>
        <button class="wb-btn" id="observer-disable" type="button">${esc(t('observer.disable'))}</button>
        <button class="wb-btn wb-btn-danger-text" id="observer-uninstall" type="button">${esc(t('observer.uninstall'))}</button>
      </div>
      <p class="wb-note" id="observer-settings-status" role="status" hidden></p>
      <p class="wb-note" data-i18n="wb.settings.observerNote">${esc(t('wb.settings.observerNote'))}</p>
    </div>
  <div class="wb-note" id="settings-readonly-note" hidden></div>
  <div class="wb-note" id="settings-status" role="status" hidden></div>
  <div class="wb-savebar settings-footer" hidden>
    <span id="settings-dirty"></span><span class="wb-grow"></span>
    <button class="wb-btn" id="settings-cancel" type="button" data-i18n="wb.settings.revert">${esc(t('wb.settings.revert'))}</button>
    <button class="wb-btn wb-btn-primary" id="settings-save" type="button" data-i18n="btn.save">${esc(t('btn.save'))}</button>
  </div>`;
  document.body.appendChild(overlay);
  settingsModal = overlay;

  overlay.querySelector('#settings-cancel').addEventListener('click', () => refreshSettingsPage());
  overlay.querySelector('#settings-save').addEventListener('click', saveSettings);
  overlay.querySelector('#settings-add-model').addEventListener('click', () => settingsPricing?.addRow(false));
  overlay.querySelector('#settings-add-priority-model').addEventListener('click', () => settingsPricing?.addRow(true));
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
    if (!el.closest('.manage-panel')) el.disabled = readOnly;
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

function renderObserverStatus(status = state.observer.status) {
  const recoveryReason = observerRecoveryReason(status);
  const available = observerPageAvailable(status);
  renderObserverSizeForm(status);
  const stateEl = settingsModal?.querySelector('#observer-settings-state');
  const platformEl = settingsModal?.querySelector('#observer-settings-platform');
  if (stateEl) stateEl.textContent = observerStatusLabel(status);
  const dot = settingsModal?.querySelector('#observer-settings-dot');
  if (dot) dot.className = 'wb-hdot' + (available ? '' : status?.state === 'installed' && !recoveryReason ? ' warn' : ' err');
  renderObserverPage();
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

let settingsPage = null;
let settingsLoader = null;
let settingsPricing = null;
let settingsDefaults = null;
let settingsUpgrade = null;
let settingsVersionRoot = null;
let settingsChat = null;

function initSettingsPage() {
  const root = $('#tab-settings');
  const oldSettings = createSettingsModal(), oldFleet = createFleetManageModal(), oldActions = createActionsModal();
  const controls = ['#wb-detail-toggle', '#fleet-sound-toggle', '#connection-status', '#logout-btn'].map(selector => {
    const node = $(selector); return selector === '#wb-detail-toggle' ? node?.closest('label') : node;
  });
  settingsPage = composeSettings(root, { settings: oldSettings, fleet: oldFleet, actions: oldActions, controls, t });
  oldSettings.remove(); oldFleet.remove(); oldActions.remove();
  settingsModal = root; fleetManageModal = root; actionsModal = settingsPage.actionsScope;
  settingsUpgrade = root.querySelector('[data-action="upgrade-cc"]');
  settingsVersionRoot = document.createElement('div'); settingsVersionRoot.id = 'settings-version'; settingsPage.prefs.version.prepend(settingsVersionRoot);
  let theme = 'light'; try { theme = localStorage.getItem(THEME_KEY) || theme; } catch {}
  mountThemeControl(settingsPage.prefs.theme, { t, value: theme, onChange: initTheme });
  mountLanguageControl(settingsPage.prefs.lang, { t, value: getLocale(), onChange: changeLocale });
  const defaults = root.querySelector('#settings-defaults');
  settingsChat = mountChatSettings(settingsPage.sections.defaults, { t,
    local: () => !REMOTE_AGENT && !state.remoteAgent,
    read: () => requestAgentJson('/api/chat/settings'),
    write: body => requestAgentJson('/api/chat/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const read = async path => { const target = observerTargetKey(); const value = await fetchJson(path); if (target !== observerTargetKey()) throw Error('view_changed'); return value; };
  settingsLoader = createSettingsLoader({ read, onLoad(value) {
    settingsDefaults?.destroy();
    settingsDefaults = settingsWiring().renderDefaults(defaults, value, read);
    settingsPricing?.destroy(); settingsPricing = null;
    if (value.prices) {
      settingsPricing = createPricingPanel({ root: settingsPage.sections.pricing, host: root, snapshot: value.snapshot,
        data: value.prices, usage: value.usage, t, formatTokens: tok, writable: () => !remoteIsReadOnly(), onDirty: count => settingsPage.badge('pricing', count),
        write: body => requestAgentJson('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    } else { const status = root.querySelector('#settings-status'); status.hidden = false; status.textContent = t('wb.readFailed'); }
    const active = value.prices?.active ?? value.snapshot?.baselineRuntime;
    const meta = value.metadata[active] ?? value.metadata.claude ?? value.metadata.codex;
    root.querySelector('#action-threshold').value = meta?.new_session_threshold ?? state.newSessionThreshold ?? 70;
    refreshSettingsLocks(); refreshSettingsVersion();
  } });
  $('#wb-detail-toggle').addEventListener('change', () => {
    settingsPage.detail($('#wb-detail-toggle').checked ? 'technical' : 'plain');
    refreshSettingsVersion();
    if (fleetManageModal?._agents) renderFleetManage({ self: { name: fleetManageModal.querySelector('#fleet-self-label').textContent }, agents: fleetManageModal._agents }, true);
  });
  refreshSettingsVersion();
}

function refreshSettingsVersion() {
  if (!settingsVersionRoot) return;
  renderVersion(settingsVersionRoot, state.dashboardState?.runtime_info, { upgrade: settingsUpgrade, t, readOnly: remoteIsReadOnly(), onHint: toggleZylosUpdateHint,
    dashboardVersion: ownDashboardVersion });
}
function refreshSettingsLocks() {
  if (!settingsPage) return;
  applySettingsReadOnly(remoteIsReadOnly());
  if (!settingsPricing) { for (const node of settingsModal.querySelectorAll('#settings-save, #settings-add-model, #settings-add-priority-model, #settings-fast-multiplier')) node.disabled = true; }
  for (const node of settingsPage.sections.defaults.querySelectorAll('#action-mode, #action-threshold, #action-threshold-apply')) node.disabled = remoteIsReadOnly();
  syncModeSegment();
  settingsDefaults?.refreshLocks();
  refreshSettingsVersion();
}
function refreshSettingsPage() {
  closeSettingsModal();
  settingsLoader?.open();
  settingsChat?.refresh();
  refreshObserverStatus({ quiet: true }).catch(() => {});
  refreshModeStatus().catch(() => {});
  if (!REMOTE_AGENT) {
    const identity = observerTargetKey();
    fetch(api('/api/fleet/agents'), { cache: 'no-store' }).then(async response => { if (!response.ok) throw Error('read_failed'); return response.json(); }).then(value => { if (identity === observerTargetKey()) renderFleetManage(value); }).catch(error => { if (identity === observerTargetKey()) fleetManageStatus(error.message, 'error'); });
    loadApiKeys();
  }
  for (const name of ['fleet', 'keys']) { const remote = Boolean(REMOTE_AGENT); const button = document.querySelector(`[data-settings-section="${name}"]`); if (button) button.hidden = remote; if (remote) settingsPage.sections[name].hidden = true; }
}
function openSettingsModal(section = 'defaults') {
  showAgentDetail({ navigation: false });
  document.querySelectorAll('.tab').forEach(node => node.classList.remove('active'));
  document.querySelectorAll('.tab-panel').forEach(node => { const active = node.id === 'tab-settings'; node.hidden = !active; node.classList.toggle('active', active); });
  window.history.pushState({ tab: 'settings' }, '', api(`${remotePrefix()}/settings`));
  settingsPage?.select(section);
  refreshSettingsPage();
}
function closeSettingsModal() {
  settingsLoader?.invalidate();
  fleetManageStatus('');
  settingsChat?.invalidate();
  settingsDefaults?.destroy(); settingsDefaults = null;
  settingsPricing?.destroy(); settingsPricing = null;
  if (settingsModal) resetSettingsDrafts(settingsModal);
}
async function saveSettings() { return settingsPricing?.save(); }

// ─── Actions Modal ───
let actionsModal = null;
let pendingManualRestart = null;

function createActionsModal() {
  if (actionsModal) return actionsModal;
  const overlay = document.createElement('div');
  overlay.id = 'actions-modal';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="action-field wb-fld"><label class="wb-fld-l" for="action-mode" data-i18n="actions.session_mode">${esc(t('actions.session_mode'))}</label>
      <div class="wb-seg2" id="action-mode-seg" role="group" aria-label="${esc(t('actions.session_mode'))}"><button type="button" data-mode="multi">${esc(t('wb.settings.session.multi'))}</button><button type="button" data-mode="single">${esc(t('wb.settings.session.single'))}</button></div>
      <select id="action-mode" class="wb-vh" tabindex="-1" aria-hidden="true"><option value="single">single</option><option value="multi">multi</option></select></div>
    <p id="action-mode-status" class="wb-note"></p>
    <p id="action-instance-status" class="wb-note"></p>
    <p id="action-restart-status" class="wb-note"></p>
    <div class="action-field wb-fld"><label class="wb-fld-l" for="action-threshold" data-i18n="actions.threshold">${esc(t('actions.threshold'))}</label>
      <div class="wb-set-inline"><input id="action-threshold" class="wb-input wb-input-num" type="number" min="10" max="95" step="5" /><span>%</span>
        <button class="wb-btn" id="action-threshold-apply" type="button" data-i18n="btn.apply">${esc(t('btn.apply'))}</button></div>
      <small class="wb-note" data-i18n="tip.threshold">${t('tip.threshold')}</small></div>
    <button class="wb-btn" data-action="upgrade-cc" type="button"><i class="wb-ico wb-ico-up wb-ico-xs" aria-hidden="true"></i><span id="action-cli-label">${esc(t('actions.upgrade_cc'))}</span><span class="action-ver" id="action-cc-ver"></span></button>
  <div class="wb-note" id="action-status" role="status" hidden></div>`;
  document.body.appendChild(overlay);
  actionsModal = overlay;

  overlay.querySelector('[data-action="upgrade-cc"]').addEventListener('click', () => execAction('upgrade-cc'));
  const modeSelect = overlay.querySelector('#action-mode');
  // The segmented buttons drive the original select so its change listener stays the single entry point.
  overlay.querySelectorAll('#action-mode-seg button').forEach(button => button.addEventListener('click', () => {
    if (button.disabled || modeSelect.value === button.dataset.mode) return;
    modeSelect.value = button.dataset.mode; modeSelect.dispatchEvent(new Event('change'));
  }));
  modeSelect.addEventListener('change', async event => {
    const previous = modeSelect._current ?? null;
    if (await execAction('switch-mode', { mode: event.target.value }) === false && previous) modeSelect.value = previous;
    syncModeSegment(); await refreshModeStatus();
  });

  const thresholdApply = overlay.querySelector('#action-threshold-apply');
  const thresholdInput = overlay.querySelector('#action-threshold');
  thresholdApply.addEventListener('click', async () => {
    const val = parseInt(thresholdInput.value, 10);
    if (!val || val < 10 || val > 95) return;
    const result = await execAction('set-threshold', { value: val });
    if (result !== false) state.newSessionThreshold = val;
  });
  thresholdInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') thresholdApply.click();
  });
  return overlay;
}

function syncModeSegment() {
  const select = actionsModal?.querySelector('#action-mode');
  if (!select) return;
  actionsModal.querySelectorAll('#action-mode-seg button').forEach(button => {
    button.setAttribute('aria-pressed', String(button.dataset.mode === select.value));
    button.disabled = select.disabled;
  });
}

async function refreshModeStatus() {
  const targetKey = observerTargetKey();
  if (pendingManualRestart) {
    try {
      const result = await fetchJson(`/api/restart-status?requestId=${encodeURIComponent(pendingManualRestart.requestId)}`);
      if (observerTargetKey() !== targetKey) return;
      const text = actionsModal?.querySelector('#action-restart-status');
      const ready = result.origin?.ready && result.origin.runId !== pendingManualRestart.runId;
      if (text) text.textContent = t('actions.restart_progress', { submission: pendingManualRestart.submission, completion: result.completion === 'deadline_exceeded' ? 'unknown' : result.completion, ready: ready ? t('actions.ready') : t('value.unknown') });
      if (result.completion === 'done' || ready) pendingManualRestart = null;
    } catch { if (observerTargetKey() !== targetKey) return; }
  }
  const text = actionsModal?.querySelector('#action-mode-status');
  try {
    const result = await fetchJson('/api/session-mode');
    if (observerTargetKey() !== targetKey) return;
    if (!result?.ok) throw new Error(result?.error?.message || 'Unknown');
    const data = result.data;
    const mode = ['single', 'multi'].includes(data.sessionMode) ? data.sessionMode : null;
    if (mode) { const select = actionsModal.querySelector('#action-mode'); select.value = mode; select._current = mode; syncModeSegment(); }
    text.textContent = [mode ? t('wb.settings.session.' + mode) : t('value.unknown'), data.transition?.phase, data.transition?.reason, data.supervisor === 'unreachable' ? t('actions.supervisor_unreachable') : '', data.blocked?.since ? t('actions.blocked_since', { time: data.blocked.since }) : ''].filter(Boolean).join(' · ');
  } catch (error) { if (observerTargetKey() !== targetKey) return; if (text) text.textContent = error.message; }
  const instanceText = actionsModal?.querySelector('#action-instance-status');
  try {
    const result = await fetchJson('/api/instance-status');
    if (observerTargetKey() !== targetKey) return;
    if (!result?.ok) throw new Error(result?.error?.message || 'Unknown');
    const data = result.data || {};
    if (instanceText) instanceText.textContent = instanceStatusText(data, document.documentElement.dataset.detail === 'technical' ? 'technical' : 'plain', t);
  } catch (error) { if (observerTargetKey() !== targetKey) return; if (instanceText) instanceText.textContent = error.message; }
}

function closeActionsModal() {
  if (!actionsModal) return;
  const status = actionsModal.querySelector('#action-status');
  if (status) status.hidden = true;
  setModalBodyDisabled(false);
}

const CONFIRM_ACTIONS = new Set(['switch-mode', 'restart-session', 'switch-runtime', 'switch-model', 'switch-effort', 'upgrade-zylos', 'upgrade-cc']);

let countdownTimer = null;

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
  syncModeSegment();
  if (!disabled) renderOriginAvailability();
}

async function showConfirm(text) {
  setModalBodyDisabled(true);
  try { return await confirmSetting(text); }
  finally { setModalBodyDisabled(false); }
}

async function execAction(action, body, { confirmed = false } = {}) {
  if (remoteIsReadOnly()) return false;
  if (action === 'restart-session') {
    const shown = state.dashboardState;
    body = { ...body, sessionGroup: shown?.sessionGroup, runId: shown?.runId, sessionId: shown?.sessionId };
  }
  if (CONFIRM_ACTIONS.has(action) && !confirmed) {
    const labels = {
      'switch-mode': t('confirm.switch_mode', { mode: body?.mode }),
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
  return runConfirmedAction(action, body);
}

// Runs a dashboard action that has already been confirmed (or needs no confirmation); it never asks.
async function runConfirmedAction(action, body) {
  if (remoteIsReadOnly()) return false;
  const actionPath = agentPath(`/api/actions/${action}`);
  const healthPath = agentPath('/api/health');
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') toggleZylosUpdateHint(null); });
  document.addEventListener('click', e => {
    if (!e.target.closest('#settings-zylos-update')) toggleZylosUpdateHint(null);
    // With other machines configured the icon opens the fleet wall; otherwise it opens fleet settings.
    if (e.target.closest('#fleet-manage-btn')) { e.preventDefault(); if (state.multiAgent && !state.remoteAgent) showFleetView(); else openSettingsModal('fleet'); }
  });
}

function initFleetManageButton() {
  const btn = $('#fleet-manage-btn');
  if (!btn) return;
  btn.hidden = !!REMOTE_AGENT;
  btn.setAttribute('aria-label', t('fleet_manage.open'));
}

// The header switch drives the settings checkbox so every existing listener sees one change event.
function initTechButton() {
  const button = $('#wb-tech-btn'), toggle = $('#wb-detail-toggle');
  if (!button || !toggle) return;
  const sync = () => button.setAttribute('aria-pressed', String(toggle.checked));
  button.addEventListener('click', () => { toggle.checked = !toggle.checked; toggle.dispatchEvent(new Event('change', { bubbles: true })); });
  toggle.addEventListener('change', sync);
  sync();
}

// ─── Timers ───
function startTimers() {
  state.pollTimer = setInterval(refreshAll, 30_000);
  syncFleetSubscription();
}

window.addEventListener('beforeunload', () => {
  clearInterval(state.pollTimer);
  clearFleetFallback();
  clearTimeout(state.sseReconnectTimer);
  state.eventSource?.close();
  closeObserver({ release: true }).catch(() => {});
});
window.addEventListener('pagehide', () => { closeObserver({ release: true }).catch(() => {}); });

// ─── Init ───
initTheme();
document.querySelector('#wb-settings-btn')?.addEventListener('click', () => openSettingsModal());
window.addEventListener('pagehide', () => stopTheme?.());
await initI18n();
await refreshObserverStatus({ quiet: true });
initSettingsPage();
initTabs();
initFleetMode();
initLogout();
initInfoBarButtons();
initFleetManageButton();
initMemoryControls();
initObserverControls();
initFleetHoverPause();
initFleetSounds();
renderAll();
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

usagePage = createUsagePage({ root: document.querySelector('#wb-usage'), t,
  identity: () => observerTargetKey(), detail: () => document.documentElement.dataset.detail ?? 'plain',
  read: async path => { const response = await fetch(api(agentPath(path))); if (!response.ok) throw Error('read_failed'); return response.json(); },
});
workbench = mountWorkbench({
  t,
  endpoint: path => api(agentPath(path)),
  identity: () => state.remoteAgent ?? REMOTE_AGENT ?? 'local',
  writable: () => wbWritable(remoteIsReadOnly),
  onMemory: key => {
    memoryScopeView.selectGroup(key);
    document.querySelector('.tab[data-tab="memory"]')?.click();
  },
  onConversation: row => {
    document.querySelector('.tab[data-tab="chat"]')?.click();
    return chatPage?.openGroup(row.sessionGroup, { channel: row.c4?.componentName });
  },
  observerStatus: () => state.observer.status,
  observerAvailable: status => !remoteIsReadOnly() && !observerRecoveryReason(status),
  onObserve: openObserverFor,
  instanceInfo: () => ({ name: viewedAgentName(), version: state.dashboardState?.dashboard_version ? 'dashboard ' + state.dashboardState.dashboard_version : null,
    core: state.dashboardState?.runtime_info?.zylos_version ? 'core ' + state.dashboardState.runtime_info.zylos_version : null }),
});
initTechButton();
watchHeader({ header: document.querySelector('.app-header') });
export function openWorkbenchGroup(key) {
  document.querySelector('.tab[data-tab="overview"]')?.click();
  return workbench.openGroup(key);
}
settingsPage?.detail(document.documentElement.dataset.detail);
refreshSettingsVersion();
const stopSchedule = mountSchedule({
  t,
  locale: getLocale,
  endpoint: path => api(agentPath(path)),
  identity: () => state.remoteAgent ?? REMOTE_AGENT ?? 'local',
  writable: () => !remoteIsReadOnly(),
  onOpenGroup: openWorkbenchGroup,
});
window.addEventListener('pagehide', stopSchedule);
chatPage = mountConversationPage({ root: document.querySelector('#wb-chat'), t,
  endpoint: path => api(agentPath(path)),
  identity: () => state.remoteAgent ?? REMOTE_AGENT ?? 'local',
  technicalDetails: () => document.documentElement.dataset.detail === 'technical',
  onOpenGroup: conversation => openWorkbenchGroup(conversation.sessionGroup ?? conversation.session_group),
});
const chatLocaleChange = () => chatPage.redraw();
document.addEventListener('dashboard-locale-change', chatLocaleChange);
document.querySelector('#wb-detail-toggle')?.addEventListener('change', chatLocaleChange);
const usageDetailChange = () => usagePage.setViewDetail();
document.querySelector('#wb-detail-toggle')?.addEventListener('change', usageDetailChange);
document.addEventListener('dashboard-locale-change', usageDetailChange);
refreshUsage();
refreshChat();
window.addEventListener('pagehide', () => { workbench.destroy(); closeSettingsModal(); usagePage.destroy(); chatPage.destroy();
  document.removeEventListener('dashboard-locale-change', chatLocaleChange);
  document.querySelector('#wb-detail-toggle')?.removeEventListener('change', chatLocaleChange);
  document.querySelector('#wb-detail-toggle')?.removeEventListener('change', usageDetailChange);
  document.removeEventListener('dashboard-locale-change', usageDetailChange);
});
