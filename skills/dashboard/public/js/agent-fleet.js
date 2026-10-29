export const MASCOT_BY_MOOD = {
  busy: 'busy.png',
  thinking: 'thinking.png',
  idle: 'idle.png',
  stuck: 'stuck.png',
  offline: 'offline.png'
};

const REASON_BADGE_REASONS = new Set(['unreachable', 'auth_failed', 'version_unsupported', 'timeout', 'conn_refused', 'bad_payload', 'offline', 'stuck']);
const LINK_CHIP_QUALITIES = new Set(['slow', 'degraded', 'stale']);

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Input is always a 0-100 percentage (context_pct, rate_limit_pct, cpu/mem/
// disk). Never infer fractions: a remote agent's genuine 1% weekly usage must
// render as 1%, not a full red bar (#251).
function pctValue(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}

function money(value) {
  if (value == null || value === '') return '--';
  const n = Number(value);
  if (!Number.isFinite(n)) return '--';
  if (n < 1) return `$${n.toFixed(4)}`;
  return `$${n.toFixed(2)}`;
}

function compactText(value, fallback) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || fallback;
}

function labelText(value, fallback = '--') {
  const text = String(value || '').trim();
  return text || fallback;
}

function reasonLabel(reason, labels) {
  const key = String(reason || '').toLowerCase();
  return labels.reasonLabels?.[key] || labelText(reason, labels.unreachable);
}

export function stateMood(agent) {
  const state = String(agent?.state || 'UNKNOWN').toUpperCase();
  const reason = String(agent?.health_reason || '').toLowerCase();
  const activity = String(agent?.activity || '').toLowerCase();
  if (state === 'OFFLINE' || reason === 'offline' || reason === 'unreachable' || reason === 'version_unsupported' || reason === 'auth_failed') return 'offline';
  if (state === 'STUCK' || state === 'POSSIBLY_STUCK' || reason.includes('stuck')) return 'stuck';
  if (state === 'IDLE') return 'idle';
  if (state === 'BUSY' && (activity.includes('thinking') || activity.includes('思考'))) return 'thinking';
  if (state === 'THINKING') return 'thinking';
  if (state === 'BUSY') return 'busy';
  return 'idle';
}

// Single-agent detail page equivalent of the fleet feed's thinking signal
// (#186): busy with no visible running tool means the model is thinking.
export function liveStateMood(payload) {
  const mood = stateMood(payload);
  const tools = Array.isArray(payload?.running_tools) ? payload.running_tools : [];
  return mood === 'busy' && tools.length === 0 ? 'thinking' : mood;
}

function isOffline(agent) {
  return stateMood(agent) === 'offline' || Number(agent?.pulse_rate) === 0;
}

function stateLabel(agent, labels, mood = stateMood(agent)) {
  const reason = String(agent?.health_reason || '').toLowerCase();
  if (reason === 'version_unsupported') return labels.versionUnsupported;
  if (reason === 'unreachable') return labels.unreachable;
  if (reason === 'auth_failed') return labels.authFailed;
  if (labels.reasonLabels?.[reason]) return labels.reasonLabels[reason];
  if (mood === 'busy') return labels.busy;
  if (mood === 'thinking') return labels.thinking;
  if (mood === 'stuck') return labels.stuck;
  if (mood === 'offline') return labels.offline;
  return labels.idle;
}

function colorForAgent(agent) {
  return agent?.color || '#64748b';
}

// 24s is a common multiple of every mascot animation cycle (0.8s/2s/3s), so a
// negative delay of (now mod 24s) resumes the same phase after a tile rebuild.
function mascotPhaseDelayMs(now = Date.now()) {
  return -(now % 24000);
}

function mascotSrc(mood, root) {
  const cleanRoot = String(root || './img/mascot').replace(/\/+$/, '');
  return `${cleanRoot}/${MASCOT_BY_MOOD[mood]}`;
}

function sortAgents(agents) {
  const list = Array.isArray(agents) ? [...agents] : [];
  const self = list.filter((agent) => agent?.self === true);
  const others = list
    .filter((agent) => agent?.self !== true)
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return [...self, ...others];
}

function ringLevel(pct) {
  if (pct == null) return 'ok';
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warning';
  return 'ok';
}

// Mirrors the single-agent metric bars (barColor in app.js), used for the
// context ring and the 5h/7d rate rows: <50 ok, 50–75 warning, >75 danger.
function barLevel(pct) {
  if (pct == null) return 'ok';
  if (pct > 75) return 'danger';
  if (pct >= 50) return 'warning';
  return 'ok';
}

function latencyLabel(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}s`;
  return `${Math.round(n)}ms`;
}

function buildLinkChip(link, labels) {
  const quality = String(link?.quality || 'ok').toLowerCase();
  if (!LINK_CHIP_QUALITIES.has(quality)) return null;
  const latency = latencyLabel(link?.latency_ms);
  const p95 = latencyLabel(link?.latency_p95_ms);
  const reason = reasonLabel(link?.reason, labels);
  const label = quality === 'degraded'
    ? labels.linkDegraded
    : (latency || labels[quality] || quality);
  const titleParts = [labels.linkLatency];
  if (quality === 'slow') titleParts.push(`${labels.slow}${p95 ? ` p95 ${p95}` : ''}`);
  else if (quality === 'stale') titleParts.push(labels.stale);
  else titleParts.push(`${labels.degraded}: ${reason}`);
  if (latency && quality !== 'degraded') titleParts.push(latency);
  return { quality, label, title: titleParts.filter(Boolean).join(' · ') };
}

function miniRing(name, value, labels) {
  const pct = pctValue(value);
  const ringPct = pct == null ? 0 : pct;
  const valueLabel = pct == null ? '--' : `${ringPct.toFixed(0)}%`;
  const level = ringLevel(pct);
  return `<span class="fleet-mini-ring ring-${level}" style="--ring-pct:${ringPct};" aria-label="${escapeHtml(name)} ${escapeHtml(valueLabel)}">
    <span class="fleet-mini-ring-dial"><span>${escapeHtml(valueLabel)}</span></span>
    <small>${escapeHtml(name)}</small>
  </span>`;
}

function rateRow(name, value) {
  const pct = pctValue(value);
  const level = barLevel(pct);
  const valueLabel = pct == null ? '--' : `${pct.toFixed(0)}%`;
  const width = pct == null ? 0 : pct.toFixed(1);
  return `<span class="fleet-rate-row rate-${level}" aria-label="${escapeHtml(name)} ${escapeHtml(valueLabel)}">
    <small>${escapeHtml(name)}</small>
    <span class="fleet-rate-bar"><i style="width:${width}%"></i></span>
    <strong>${escapeHtml(valueLabel)}</strong>
  </span>`;
}

// Always rendered (with "--" when the remote doesn't report rate limits yet)
// so tiles keep the same vertical rhythm across mixed fleet versions.
function rateRows(tile, labels) {
  return `<div class="fleet-rate-rows">${rateRow(labels.rate5h, tile.rate5hPct)}${rateRow(labels.rate7d, tile.rate7dPct)}</div>`;
}

function feedAge(startedAt) {
  const ms = Date.parse(startedAt);
  if (!Number.isFinite(ms)) return '';
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

// Mirrors the single-agent Current Activity feed: one row per entry,
// single-line truncation, elapsed time on the right.
function activityFeedRows(tile, labels) {
  const entries = (tile.activityFeed || []).slice(0, 3);
  if (entries.length === 0) return '';
  return entries.map((entry) => {
    const isThinking = entry.kind === 'thinking';
    const label = isThinking ? labels.thinkingActivity : (entry.label || '');
    const age = entry.started_at ? feedAge(entry.started_at) : '';
    return `<span class="fleet-feed-row${isThinking ? ' is-thinking' : ''}">
      <span class="fleet-feed-label">${escapeHtml(label)}</span>
      ${age ? `<small class="fleet-feed-age">${escapeHtml(age)}</small>` : ''}
    </span>`;
  }).join('');
}

export function defaultAgentFleetLabels() {
  return {
    title: 'Agent Fleet',
    subtitle: 'Operational fleet status',
    busy: 'Working',
    thinking: 'Thinking',
    idle: 'Idle',
    stuck: 'Possible Stuck',
    offline: 'Offline',
    unreachable: 'Unreachable',
    versionUnsupported: 'Version unsupported',
    authFailed: 'Auth failed',
    slow: 'Slow',
    degraded: 'Degraded',
    stale: 'Stale',
    linkLatency: 'Link latency',
    linkDegraded: 'Link warning',
    reasonLabels: {
      timeout: 'Timeout',
      conn_refused: 'Connection refused',
      bad_payload: 'Bad payload',
      stale: 'Stale data'
    },
    noActivity: 'Standing by',
    context: 'Context',
    contextChipTitle: 'Context usage / auto new-session threshold',
    model: 'Model',
    sessionCost: 'Session',
    dailyCost: 'Today',
    weeklyCost: '7 days',
    cpu: 'CPU',
    memory: 'Memory',
    disk: 'Disk',
    rate5h: '5h',
    rate7d: '7d',
    thinkingActivity: 'Thinking…',
    subagent: 'Subagent',
    empty: 'No fleet agents configured'
  };
}

export function buildAgentFleetView(fleet, options = {}) {
  const labels = { ...defaultAgentFleetLabels(), ...(options.labels || {}) };
  const basePath = options.basePath || '';
  const tiles = sortAgents(fleet?.agents).map((agent) => {
    const activityFeed = Array.isArray(agent.activity_feed) ? agent.activity_feed : [];
    const baseMood = stateMood(agent);
    // The legacy `activity` string never says "thinking" (it falls back to the
    // last prompt summary), so use the structured feed signal for the mascot.
    const mood = baseMood === 'busy' && activityFeed.some((entry) => entry?.kind === 'thinking')
      ? 'thinking'
      : baseMood;
    const offline = isOffline(agent);
    const color = colorForAgent(agent);
    const isSelf = agent.self === true;
    const contextPct = pctValue(agent.context_pct);
    const threshold = pctValue(agent.new_session_threshold);
    const activity = compactText(agent.activity, labels.noActivity);
    const link = agent.link && typeof agent.link === 'object' ? agent.link : null;
    const linkChip = buildLinkChip(link, labels);
    return {
      name: String(agent.name || ''),
      mood,
      offline,
      isSelf,
      color,
      hue: Number.isFinite(Number(agent.hue)) ? Number(agent.hue) : 0,
      stateLabel: stateLabel(agent, labels, mood),
      activity,
      contextPct,
      contextLevel: barLevel(contextPct),
      threshold,
      overThreshold: contextPct != null && threshold != null && contextPct >= threshold,
      linkQuality: String(link?.quality || 'ok').toLowerCase(),
      linkChip,
      model: labelText(agent.model),
      effort: labelText(agent.effort),
      activityFeed,
      rate5hPct: pctValue(agent.rate_limit_pct),
      rate7dPct: pctValue(agent.rate_limit_7d_pct),
      sessionCostLabel: money(agent.session_cost ?? agent.cost),
      dailyCostLabel: money(agent.daily_cost),
      weeklyCostLabel: money(agent.weekly_cost),
      cpuPct: agent.cpu_pct,
      memPct: agent.mem_pct,
      diskPct: agent.disk_pct,
      hasSubagent: agent.has_subagent === true,
      subagentCount: Number.isFinite(agent.subagent_count) ? agent.subagent_count : 0,
      reason: agent.health_reason || '',
      href: isSelf ? `${basePath}/` : `${basePath}/fleet/${encodeURIComponent(String(agent.name || ''))}/`,
      mascotSrc: mascotSrc(mood, options.mascotRoot)
    };
  });

  const counts = tiles.reduce((acc, tile) => {
    acc[tile.mood] = (acc[tile.mood] || 0) + 1;
    return acc;
  }, { busy: 0, thinking: 0, idle: 0, stuck: 0, offline: 0 });

  // Fleet-wide totals of the same three cost tiers shown on each tile.
  // null (rendered '--') when no agent reports that tier at all.
  const agents = Array.isArray(fleet?.agents) ? fleet.agents : [];
  const sumTier = (pick) => {
    let total = null;
    for (const agent of agents) {
      const value = pick(agent);
      // Skip absent values before Number(): production payloads send explicit
      // null for unreported tiers (getCostTiers, offline default records) and
      // Number(null) is 0, which would fake a '$0.0000' report. A genuine
      // numeric 0 still counts as reported.
      if (value == null || value === '') continue;
      const n = Number(value);
      if (Number.isFinite(n)) total = (total ?? 0) + n;
    }
    return total;
  };
  const costTotals = {
    session: money(sumTier((a) => a.session_cost ?? a.cost)),
    daily: money(sumTier((a) => a.daily_cost)),
    weekly: money(sumTier((a) => a.weekly_cost))
  };

  return {
    labels,
    tiles,
    counts,
    costTotals,
    updatedAt: fleet?.updated_at || null
  };
}

function renderTile(tile, labels) {
  const ringPct = tile.contextPct == null ? 0 : tile.contextPct;
  const ctxLabel = tile.contextPct == null ? '--' : `${ringPct.toFixed(0)}%`;
  const thresholdLabel = tile.threshold == null ? '--' : `${tile.threshold.toFixed(0)}%`;
  const showReason = REASON_BADGE_REASONS.has(String(tile.reason || '').toLowerCase());
  const reason = showReason ? `<span class="agent-fleet-reason">${escapeHtml(tile.stateLabel)}</span>` : '';
  const linkChip = tile.linkChip
    ? `<span class="agent-link-chip link-${escapeHtml(tile.linkChip.quality)}" title="${escapeHtml(tile.linkChip.title)}">${escapeHtml(tile.linkChip.label)}</span>`
    : '';
  const subagentLabel = tile.hasSubagent ? labels.subagent : '';
  const subagentBadge = tile.subagentCount > 0
    ? `<span class="fleet-subagent-badge" title="${escapeHtml(labels.subagent)}: ${tile.subagentCount}">⚡${tile.subagentCount}</span>`
    : '';
  const feedHtml = activityFeedRows(tile, labels);
  return `<a class="agent-tile agent-tile-${escapeHtml(tile.mood)}${tile.offline ? ' is-offline' : ''}${tile.isSelf ? ' is-self' : ''} context-${escapeHtml(tile.contextLevel)}" href="${escapeHtml(tile.href)}" data-agent="${escapeHtml(tile.name)}" data-state="${escapeHtml(tile.mood)}"${tile.isSelf ? ' data-self="true"' : ''}${tile.linkQuality !== 'ok' ? ` data-link-quality="${escapeHtml(tile.linkQuality)}"` : ''} style="--agent-accent:${escapeHtml(tile.color)};--agent-hue:${tile.hue}deg;--context-pct:${ringPct};">
    <div class="agent-tile-head">
      <span class="agent-name">${escapeHtml(tile.name)}</span>
      <span class="agent-tile-badges">${linkChip}<span class="agent-state mood-${escapeHtml(tile.mood)}">${escapeHtml(tile.stateLabel)}</span></span>
    </div>
    <div class="agent-runtime-line">
      <span>${escapeHtml(labels.model)}</span>
      <strong>${escapeHtml(tile.model)} / ${escapeHtml(tile.effort)}</strong>
    </div>
    <div class="agent-mascot-wrap">
      <span class="context-ring" aria-label="${escapeHtml(labels.context)} ${ringPct.toFixed(0)}%" style="--context-pct:${ringPct};"></span>
      <img class="agent-mascot" src="${escapeHtml(tile.mascotSrc)}" alt="" loading="lazy" style="animation-delay:${mascotPhaseDelayMs()}ms">
      <span class="context-chip${tile.overThreshold ? ' is-over' : ''}" title="${escapeHtml(labels.contextChipTitle)}">${ctxLabel} <small>/ ${thresholdLabel}</small></span>
    </div>
    <div class="fleet-cost-rows">
      <span><small>${escapeHtml(labels.sessionCost)}</small><strong>${escapeHtml(tile.sessionCostLabel)}</strong></span>
      <span><small>${escapeHtml(labels.dailyCost)}</small><strong>${escapeHtml(tile.dailyCostLabel)}</strong></span>
      <span><small>${escapeHtml(labels.weeklyCost)}</small><strong>${escapeHtml(tile.weeklyCostLabel)}</strong></span>
    </div>
    <div class="fleet-system-rings">
      ${miniRing(labels.cpu, tile.cpuPct, labels)}
      ${miniRing(labels.memory, tile.memPct, labels)}
      ${miniRing(labels.disk, tile.diskPct, labels)}
    </div>
    ${rateRows(tile, labels)}
    <div class="agent-activity${feedHtml ? ' has-feed' : ''}">
      <span class="subagent-light${tile.hasSubagent ? ' is-on' : ''}" aria-label="${escapeHtml(subagentLabel)}"></span>
      ${subagentBadge}
      ${feedHtml ? `<div class="fleet-feed">${feedHtml}</div>` : `<span>${escapeHtml(tile.activity)}</span>`}
    </div>
    ${reason}
  </a>`;
}

function renderAgentFleetViewHtml(view) {
  const { labels } = view;
  if (view.tiles.length === 0) {
    return `<section class="agent-fleet"><p class="empty-state">${escapeHtml(labels.empty)}</p></section>`;
  }
  const working = view.counts.busy + view.counts.thinking;
  const seg = (count, label, dot) =>
    `<span class="sum-seg${count === 0 ? ' is-zero' : ''}"><i class="sum-dot ${dot}"></i>${count} ${escapeHtml(label)}</span>`;
  const costCell = (label, value) =>
    `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong></span>`;
  return `<section class="agent-fleet" data-fleet-count="${view.tiles.length}">
    <div class="agent-fleet-summary">
      <span class="sum-states">
        ${seg(working, labels.busy, 'dot-busy')}
        ${seg(view.counts.idle, labels.idle, 'dot-idle')}
        ${seg(view.counts.stuck, labels.stuck, 'dot-stuck')}
      </span>
      <span class="sum-costs">
        ${costCell(labels.sessionCost, view.costTotals.session)}
        ${costCell(labels.dailyCost, view.costTotals.daily)}
        ${costCell(labels.weeklyCost, view.costTotals.weekly)}
      </span>
    </div>
    <div class="agent-grid">
      ${view.tiles.map((tile) => renderTile(tile, labels)).join('')}
    </div>
  </section>`;
}

export function renderAgentFleetHtml(fleet, options = {}) {
  return renderAgentFleetViewHtml(buildAgentFleetView(fleet, options));
}

export function renderAgentFleet(container, fleet, options = {}) {
  if (!container) return null;
  const view = buildAgentFleetView(fleet, options);
  container.innerHTML = renderAgentFleetViewHtml(view);
  return view;
}
