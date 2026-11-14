import { accountUsedPercent, accountRuntimes, remainingQuotaPercent, quotaColor, quotaFillColor, quotaRecordedTime } from './wb/instance-strip.js?v=196';

import { fallbackName, platformOf } from './wb/plain-text.js?v=106';

const REASON_BADGE_REASONS = new Set(['unreachable', 'auth_failed', 'version_unsupported', 'timeout', 'conn_refused', 'bad_payload', 'offline']);
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
  if (state === 'AUTH_WAIT' || state === 'WAKE_OVERDUE') return 'stuck';
  if (state === 'IDLE') return 'idle';
  if (state === 'BUSY' && (activity.includes('thinking') || activity.includes('思考'))) return 'thinking';
  if (state === 'THINKING') return 'thinking';
  if (state === 'BUSY') return 'busy';
  if (state === 'UNKNOWN') return 'unknown';
  return 'idle';
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
  const state = String(agent?.state || 'UNKNOWN').toUpperCase();
  if (['SLEEPING', 'WAKING', 'WAKE_OVERDUE', 'AUTH_WAIT', 'RATE_WAIT', 'RECLAIMING', 'SWITCHING'].includes(state)) return labels[state.toLowerCase()];
  if (mood === 'busy') return labels.busy;
  if (mood === 'thinking') return labels.thinking;
  if (mood === 'stuck') return labels.stuck;
  if (mood === 'offline') return labels.offline;
  if (mood === 'unknown') return labels.unknown;
  return labels.idle;
}

function colorForAgent(agent) {
  return agent?.color || '#64748b';
}

// This machine first, then machines with a problem, then the rest by name.
function sortAgents(agents) {
  const list = Array.isArray(agents) ? [...agents] : [];
  const self = list.filter((agent) => agent?.self === true);
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''));
  const others = list.filter((agent) => agent?.self !== true).sort(byName);
  return [...self, ...others.filter(isOffline), ...others.filter((agent) => !isOffline(agent))];
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
  if (value == null || value === '') return null;
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

export function defaultAgentFleetLabels() {
  return {
    title: 'Machines',
    subtitle: 'Every machine you can view; the ones with a problem come first.',
    manage: 'Manage',
    busy: 'Working',
    thinking: 'Thinking',
    idle: 'Idle',
    unknown: 'Unknown',
    sleeping: 'Sleeping', waking: 'Waking up', wake_overdue: 'Wake unsuccessful',
    auth_wait: 'Waiting for authentication', rate_wait: 'Waiting for rate limit',
    reclaiming: 'Reclaiming', switching: 'Switching',
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
    shortAuth: 'Key no longer valid',
    shortDown: 'Cannot connect',
    shortVersion: 'Version too old',
    fixAuth: 'Ask the other side for a new key and add it again under Settings · This machine and others.',
    fixDown: 'The other Dashboard may be off or its address changed.',
    fixVersion: 'The other Dashboard needs an upgrade.',
    lastSeen: 'last reachable {time}',
    noActivity: 'Standing by',
    context: 'Context',
    model: 'Model',
    sessionCost: 'Session',
    dailyCost: 'Today',
    weeklyCost: '7 days',
    todayWeek: 'Today / 7 days',
    groups: 'Groups',
    host: 'CPU · Memory · Disk',
    rate7d: '7d left',
    quotaRemaining: '7-day quota remaining {pct}%',
    quotaUnknown: 'No data',
    quotaRecorded: 'Recorded {time}',
    quotaRecordedHint: 'No session is currently running; showing the most recent recorded quota.',
    subagent: 'Subagent',
    self: 'This machine',
    modeMulti: 'Multi-session',
    modeSingle: 'Single session',
    modeUnknown: 'Mode unknown',
    open: 'Open',
    toSettings: 'Settings',
    refresh: 'Refresh status',
    readOnly: 'Read-only',
    admin: 'Admin',
    runningGroups: 'Running {count} groups',
    allNormal: 'All normal',
    summaryUnavailable: 'Group statistics unavailable',
    moreProblems: '{count} more problems →',
    autoRestarts: '{count} automatic restarts in the last hour →',
    problemReasons: { auth_failed: 'Authentication failed', start_failed: 'Start failed', no_response: 'No response' },
    groupDuration: '{count} min',
    pool: 'Pool',
    groupStates: { busy: 'working', waiting: 'waiting', error: 'error', idle: 'idle', unknown: 'unknown', no_response: 'no response' },
    machines: '{count} machines',
    empty: 'No other machines yet'
  };
}

const fill = (text, values = {}) => String(text ?? '').replace(/\{(\w+)\}/g, (_, key) => values[key] ?? '');
// A sentence that already ends with a full stop is followed directly by the next one, not by a separator.
export function afterSentence(text, next) {
  if (!next) return text;
  if (/[。！？]$/.test(text)) return text + next;
  if (/[.!?]$/.test(text)) return text + ' ' + next.charAt(0).toUpperCase() + next.slice(1);
  return text + ' · ' + next;
}
// How long ago a machine was last reachable; the page passes its own localized wording.
function ageLabel(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
// Plain view gives the short reason; the technical view keeps the precise one.
function problemOf(agent, labels) {
  const reason = String(agent?.health_reason || '').toLowerCase();
  if (reason === 'auth_failed') return { short: labels.shortAuth, fix: labels.fixAuth };
  if (reason === 'version_unsupported') return { short: labels.shortVersion, fix: labels.fixVersion };
  return { short: labels.shortDown, fix: labels.fixDown };
}

export function buildAgentFleetView(fleet, options = {}) {
  const labels = { ...defaultAgentFleetLabels(), ...(options.labels || {}) };
  const basePath = options.basePath || '';
  const self = options.self || null;
  const ageText = options.ageText || ageLabel;
  const tiles = sortAgents(fleet?.agents).map((agent) => {
    const activityFeed = Array.isArray(agent.activity_feed) ? agent.activity_feed : [];
    const baseMood = stateMood(agent);
    // The legacy `activity` string never says "thinking" (it falls back to the
    // last prompt summary), so use the structured feed signal for the state.
    const mood = baseMood === 'busy' && activityFeed.some((entry) => entry?.kind === 'thinking')
      ? 'thinking'
      : baseMood;
    const offline = isOffline(agent);
    const isSelf = agent.self === true;
    const contextPct = pctValue(agent.context_pct);
    const threshold = pctValue(agent.new_session_threshold);
    const running = activityFeed.find((entry) => entry?.kind !== 'thinking' && entry?.label)?.label;
    const activity = compactText(running || agent.activity, labels.noActivity);
    const link = agent.link && typeof agent.link === 'object' ? agent.link : null;
    const linkChip = buildLinkChip(link, labels);
    return {
      name: String(agent.name || ''),
      mood,
      offline,
      isSelf,
      color: colorForAgent(agent),
      hue: Number.isFinite(Number(agent.hue)) ? Number(agent.hue) : 0,
      stateLabel: stateLabel(agent, labels, mood),
      problem: offline ? problemOf(agent, labels) : null,
      activity,
      contextPct,
      contextLevel: barLevel(contextPct),
      threshold,
      overThreshold: contextPct != null && threshold != null && contextPct >= threshold,
      linkQuality: String(link?.quality || 'ok').toLowerCase(),
      linkChip,
      latencyLabel: latencyLabel(link?.latency_ms),
      model: labelText(agent.model),
      effort: labelText(agent.effort),
      activityFeed,
      rate7dPct: pctValue(agent.rate_limit_7d_pct),
      rate7dRecord: { recordedAt: agent.rate_limit_7d_recorded_at, live: agent.rate_limit_7d_live },
      sessionCostLabel: money(agent.session_cost ?? agent.cost),
      dailyCostLabel: money(agent.daily_cost),
      weeklyCostLabel: money(agent.weekly_cost),
      cpuPct: agent.cpu_pct,
      memPct: agent.mem_pct,
      diskPct: agent.disk_pct,
      hasSubagent: agent.has_subagent === true,
      subagentCount: Number.isFinite(agent.subagent_count) ? agent.subagent_count : 0,
      reason: agent.health_reason || '',
      showReason: REASON_BADGE_REASONS.has(String(agent.health_reason || '').toLowerCase()),
      baseUrl: agent.base_url || '',
      access: agent.access === 'admin' ? 'admin' : 'read',
      lastSeen: agent.last_seen || null,
      lastSeenText: agent.last_seen && Number.isFinite(Date.parse(agent.last_seen)) ? ageText(agent.last_seen) : null,
      self: isSelf ? self : null,
      sessionMode: ['single', 'multi'].includes(agent.session_mode) ? agent.session_mode : isSelf ? self?.mode : null,
      groupSummary: agent.group_summary ?? null,
      href: isSelf ? `${basePath}/` : `${basePath}/fleet/${encodeURIComponent(String(agent.name || ''))}/`
    };
  });

  const counts = tiles.reduce((acc, tile) => {
    acc[tile.mood] = (acc[tile.mood] || 0) + 1;
    return acc;
  }, { busy: 0, thinking: 0, idle: 0, stuck: 0, offline: 0 });

  // Fleet-wide totals of the same three cost tiers shown on each card.
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
    t: options.t || (key => ({ 'wb.term.origin': 'Origin', 'chat.unnamed': 'Untitled conversation' }[key] || key.replace('wb.platform.', ''))),
    tiles,
    counts,
    costTotals,
    updatedAt: fleet?.updated_at || null
  };
}

// This machine keeps its account quota metadata from the Workbench snapshot; group totals come from the Fleet API.
export function fleetSelfFromSnapshot(snapshot) {
  return {
    mode: ['multi', 'single'].includes(snapshot?.mode) ? snapshot.mode : null,
    runtimes: accountRuntimes(snapshot ?? {}),
    accountRecords: snapshot?.instance?.accounts ?? {},
    accounts: Object.fromEntries(['claude', 'codex'].map((runtime) => [runtime, accountUsedPercent(snapshot?.instance?.accounts?.[runtime])]))
  };
}

// Card state pills share the board's colours: working, idle, waiting.
const pillKind = { busy: 'busy', thinking: 'busy', idle: 'idle', stuck: 'waiting' };
const pctText = (value) => value == null ? '--' : `${Number(value).toFixed(0)}%`;
// Both views use remaining quota; remote rate_limit_7d_pct is still a used percentage.
function quotaBar(label, value, labels, record) {
  const pct = remainingQuotaPercent(value);
  const time = pct == null ? null : quotaRecordedTime(record);
  const recorded = time ? `<small class="wb-quota-recorded">${escapeHtml(fill(labels.quotaRecorded, { time }))}</small>` : '';
  const title = (pct == null ? labels.quotaUnknown : fill(labels.quotaRemaining, { pct: Math.round(pct) })) +
    (time ? ' · ' + labels.quotaRecordedHint : '');
  const color = pct == null ? '' : ` style="--wb-quota-color:${quotaColor(pct)};--wb-quota-fill:${quotaFillColor(pct)}"`;
  return `<div class="wb-qbar" title="${escapeHtml(title)}"${color}><span>${escapeHtml(label)}</span><span class="wb-qbar-tr"><i style="width:${pct == null ? 0 : pct}%"></i></span><b>${pct == null ? escapeHtml(labels.quotaUnknown) : pctText(pct)}</b>${recorded}</div>`;
}
function quotaBars(tile, labels) {
  const accounts = tile.self?.accounts;
  if (accounts) {
    const runtimes = tile.self.runtimes ?? ['claude', 'codex'].filter(runtime => accounts[runtime] != null);
    const rows = runtimes.map(runtime => quotaBar(runtime === 'codex' ? 'Codex' : 'Claude', accounts[runtime], labels, tile.self.accountRecords?.[runtime]));
    if (rows.length) return `<div class="wb-qbars">${rows.join('')}</div>`;
  }
  return `<div class="wb-qbars">${quotaBar(labels.rate7d, tile.rate7dPct, labels, tile.rate7dRecord)}</div>`;
}
// Saved names follow Dashboard naming; unnamed channels expose their platform, never their address.
function problemName(row, labels, t) {
  const saved = row.displayName ?? row.name?.displayName;
  if (saved) return saved;
  const platform = platformOf(row);
  if (row.sessionGroup === 'origin' || platform === 'dashboard') return fallbackName(row, t);
  const known = ['telegram', 'lark', 'feishu', 'web-console', 'openmax', 'wechat'];
  return known.includes(platform) ? t('wb.platform.' + platform) : labels.groups;
}
function groupStates(tile, labels, t) {
  const summary = tile.groupSummary;
  const status = tile.mood === 'unknown' ? `<span class="wb-pill wb-unknown" data-mood="unknown"><span class="wb-dot"></span>${escapeHtml(tile.stateLabel)}</span>` : '';
  if (!summary || !summary.listKnown) return `<div class="wb-f-act">${status}<span>${escapeHtml(labels.summaryUnavailable)}</span></div>`;
  const counts = summary.counts || {};
  const order = ['busy', 'idle', 'waiting', 'unknown', 'no_response', 'error'];
  const active = order.filter(kind => counts[kind] > 0);
  const text = [fill(labels.runningGroups, { count: summary.running }), ...active.map(kind => `${counts[kind]} ${labels.groupStates[kind]}`)].join(' · ');
  const bar = summary.running ? `<div class="wb-gbar" title="${escapeHtml(text)}">${active.map(kind => `<i class="wb-gbar-${kind}" style="flex:${counts[kind]}"></i>`).join('')}</div>` : '';
  const problems = (summary.problems || []).slice(0, 2);
  const rows = problems.map(row => {
    const name = problemName(row, labels, t);
    const duration = Number.isFinite(row.durationSeconds) ? ' ' + fill(labels.groupDuration, { count: Math.floor(row.durationSeconds / 60) }) : '';
    const reason = (labels.problemReasons[row.reason] || labels.groupStates.error) + duration;
    return `<button type="button" class="wb-f-problem" data-fleet-group="${escapeHtml(row.sessionGroup)}"><i class="wb-dot wb-f-dot-${escapeHtml(row.reason)}"></i><b class="wb-f-problem-name" title="${escapeHtml(name)}">${escapeHtml(name)}</b><span class="wb-f-problem-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span></button>`;
  }).join('');
  const target = escapeHtml(problems[0]?.sessionGroup ?? '');
  const more = summary.problemCount > 2 ? `<button type="button" class="wb-f-more" data-fleet-problems data-group="${target}">${escapeHtml(fill(labels.moreProblems, { count: summary.problemCount - 2 }))}</button>` : '';
  const restart = summary.autoRestarts?.count > 0 ? `<button type="button" class="wb-f-more" data-fleet-problems data-group="${target}">${escapeHtml(fill(labels.autoRestarts, { count: summary.autoRestarts.count }))}</button>` : '';
  return `${status ? `<div class="wb-f-act">${status}</div>` : ''}<div class="wb-f-act wb-f-running" title="${escapeHtml(text)}">${escapeHtml(text)}</div>${bar}<div class="wb-f-problems">${summary.problemCount ? rows + more : `<span class="wb-f-normal">${escapeHtml(counts.unknown ? labels.summaryUnavailable : labels.allNormal)}</span>`}${restart}</div>`;
}

function renderTile(tile, labels, t) {
  const data = `data-agent="${escapeHtml(tile.name)}"${tile.isSelf ? ' data-self="true"' : ''}`;
  const linkChip = tile.linkChip
    ? `<span class="agent-link-chip link-${escapeHtml(tile.linkChip.quality)}" title="${escapeHtml(tile.linkChip.title)}">${escapeHtml(tile.linkChip.label)}</span>`
    : '';
  const multi = tile.sessionMode === 'multi';
  const mode = multi ? labels.modeMulti : tile.sessionMode === 'single' ? labels.modeSingle : labels.modeUnknown;
  const sub = tile.isSelf
    ? `<div class="wb-f-sub"><span class="wb-f-seg">${escapeHtml(labels.self)}</span><span class="wb-f-seg wb-tech">${escapeHtml(tile.model)} / ${escapeHtml(tile.effort)}</span></div>`
    : `<div class="wb-f-sub wb-tech"><span class="wb-f-seg"><span class="wb-mono">${escapeHtml(tile.baseUrl)}</span></span>${tile.offline ? '' : `<span class="wb-f-seg">${escapeHtml(tile.model)} / ${escapeHtml(tile.effort)}</span>${tile.latencyLabel ? `<span class="wb-f-seg">${escapeHtml(labels.linkLatency)} ${escapeHtml(tile.latencyLabel)}</span>` : ''}`}${linkChip}</div>`;
  if (tile.offline) {
    const seen = tile.lastSeenText;
    return `<div class="wb-f-card bad" ${data} data-state="${escapeHtml(tile.mood)}">
    <div class="wb-f-top"><i class="wb-ico wb-ico-alert wb-ico-xs" aria-hidden="true"></i><b title="${escapeHtml(tile.name)}">${escapeHtml(tile.name)}</b><span class="wb-grow"></span><span class="wb-mode-tag">${escapeHtml(mode)}</span></div>
    ${sub}
    <div class="wb-f-reason"><span class="wb-plain">${escapeHtml(tile.problem.short)}</span><span class="wb-tech agent-fleet-reason">${escapeHtml(tile.stateLabel)}</span><span class="wb-tech wb-mono"> · ${escapeHtml(tile.reason)}</span></div>
    <p class="wb-note">${escapeHtml(afterSentence(tile.problem.fix, seen ? fill(labels.lastSeen, { time: seen }) : ''))}</p>
    <div class="wb-f-foot"><span class="wb-grow"></span><button class="wb-btn" type="button" data-fleet-action="settings">${escapeHtml(labels.toSettings)}</button><button class="wb-btn" type="button" data-fleet-action="refresh">${escapeHtml(labels.refresh)}</button></div>
  </div>`;
  }
  const subagent = tile.subagentCount > 0
    ? `<span class="fleet-subagent-badge" title="${escapeHtml(labels.subagent)}: ${tile.subagentCount}">⚡${tile.subagentCount}</span>`
    : '';
  const act = multi ? groupStates(tile, labels, t)
    : `<div class="wb-f-act"><span class="wb-pill wb-${escapeHtml(pillKind[tile.mood] ?? 'unknown')}" data-mood="${escapeHtml(tile.mood)}"><span class="wb-dot"></span>${escapeHtml(tile.stateLabel)}</span><span title="${escapeHtml(tile.activity)}">${escapeHtml(tile.activity)}</span>${subagent}</div>`;
  const pool = tile.groupSummary?.pool;
  const poolValue = pool?.used == null ? '--' : String(pool.used) + (pool.capacity == null ? '' : '/' + pool.capacity);
  const second = multi
    ? `<div>${escapeHtml(labels.pool)}<b>${escapeHtml(poolValue)}</b></div>`
    : `<div title="${escapeHtml(labels.context)}${tile.threshold == null ? '' : ` / ${pctText(tile.threshold)}`}">${escapeHtml(labels.context)}<b class="${tile.overThreshold ? 'wb-txt-warn' : ''}">${pctText(tile.contextPct)}</b></div>`;
  return `<div class="wb-f-card${tile.isSelf ? ' self' : ''}" ${data} data-state="${escapeHtml(tile.mood)}"${tile.linkQuality !== 'ok' ? ` data-link-quality="${escapeHtml(tile.linkQuality)}"` : ''}>
    <div class="wb-f-top"><span class="wb-hdot"></span><b title="${escapeHtml(tile.name)}">${escapeHtml(tile.name)}</b>${tile.isSelf ? `<span class="wb-tag">${escapeHtml(labels.self)}</span>` : ''}<span class="wb-grow"></span><span class="wb-mode-tag">${escapeHtml(mode)}</span></div>
    ${sub}
    ${act}
    ${quotaBars(tile, labels)}
    <div class="wb-f-kv">
      <div title="${escapeHtml(labels.sessionCost)} ${escapeHtml(tile.sessionCostLabel)}">${escapeHtml(labels.todayWeek)}<b>${escapeHtml(tile.dailyCostLabel)} / ${escapeHtml(tile.weeklyCostLabel)}</b></div>
      ${second}
      <div>${escapeHtml(labels.host)}<b>${[tile.cpuPct, tile.memPct, tile.diskPct].map((value) => value == null ? '--' : Number(value).toFixed(0)).join(' · ')}%</b></div>
    </div>
    <div class="wb-f-foot"><span>${tile.isSelf ? '' : escapeHtml(tile.access === 'admin' ? labels.admin : labels.readOnly)}</span><span class="wb-grow"></span><a class="wb-btn agent-open" href="${escapeHtml(tile.href)}" ${data}>${escapeHtml(labels.open)}<i class="wb-ico wb-ico-chev wb-ico-xs" aria-hidden="true"></i></a></div>
  </div>`;
}

function renderAgentFleetViewHtml(view) {
  const { labels, t } = view;
  const working = view.counts.busy + view.counts.thinking;
  const seg = (count, label, dot) =>
    `<span class="sum-seg${count === 0 ? ' is-zero' : ''}"><i class="sum-dot ${dot}"></i>${count} ${escapeHtml(label)}</span>`;
  const costCell = (label, value) => `<span><small>${escapeHtml(label)}</small> <strong>${escapeHtml(value)}</strong></span>`;
  const summary = `<div class="agent-fleet-summary">
      <span class="sum-states">
        ${seg(working, labels.busy, 'dot-busy')}
        ${seg(view.counts.idle, labels.idle, 'dot-idle')}
        ${seg(view.counts.stuck, labels.stuck, 'dot-stuck')}
        ${seg(view.counts.offline, labels.offline, 'dot-offline')}
      </span>
      <span class="sum-costs">
        ${costCell(labels.sessionCost, view.costTotals.session)}
        ${costCell(labels.dailyCost, view.costTotals.daily)}
        ${costCell(labels.weeklyCost, view.costTotals.weekly)}
      </span>
    </div>`;
  const empty = view.tiles.length <= 1 ? `<p class="wb-note wb-f-empty">${escapeHtml(labels.empty)}</p>` : '';
  return `<section class="agent-fleet" data-fleet-count="${view.tiles.length}">
    ${summary}
    <div class="wb-f-grid">
      ${view.tiles.map((tile) => renderTile(tile, labels, t)).join('')}
    </div>
    ${empty}
  </section>`;
}

export function renderAgentFleetHtml(fleet, options = {}) {
  return renderAgentFleetViewHtml(buildAgentFleetView(fleet, options));
}

/**
 * Options the Machines page renders with: the page's labels, and "how long ago" in the page language
 * (whole hours from an hour on, the page's own short wording below that).
 */
export function fleetPageOptions({ t, fmtAge, basePath = '', labels, self = null, now = Date.now }) {
  const ageText = ts => {
    const seconds = Math.max(0, Math.floor((now() - Date.parse(ts)) / 1000));
    return seconds >= 3600 ? t('time.hours_exact', { h: Math.floor(seconds / 3600) }) : fmtAge(ts);
  };
  return { basePath, labels, ageText, self, t };
}

export function renderAgentFleet(container, fleet, options = {}) {
  if (!container) return null;
  const view = buildAgentFleetView(fleet, options);
  container.innerHTML = renderAgentFleetViewHtml(view);
  return view;
}

/** Renders the Machines page with the page's own options, including "how long ago" in the page language. */
export function renderFleetPage(container, fleet, { t, fmtAge, basePath, labels, self, now } = {}) {
  return renderAgentFleet(container, fleet, fleetPageOptions({ t, fmtAge, basePath, labels, self, now }));
}

/**
 * Clicks on the Machines page: a problem card's buttons open settings or re-read the fleet; "Open" opens this
 * machine's own workbench in place, or another machine through the in-page fleet proxy.
 */
// What the header's machines icon does on the page being viewed: leave a machine opened in-page for the machines
// page; leave a remote machine's own page (opened from another dashboard's machines page) for that dashboard; show
// the machines page when other machines are configured; otherwise open machine settings, where they are added.
export function fleetIconAction({ remoteAgent = null, standaloneRemote = false, multiAgent = false } = {}) {
  if (remoteAgent) return 'exit-remote';
  if (standaloneRemote) return 'parent';
  return multiAgent ? 'fleet' : 'settings';
}

export function handleFleetClick(event, { onSettings = () => {}, onRefresh = () => {}, onSelf = () => {}, onRemote = () => {}, onGroup = () => {}, onProblems = () => {} } = {}) {
  const group = event.target?.closest?.('[data-fleet-group], [data-fleet-problems]');
  if (group) {
    event.preventDefault?.();
    const card = group.closest('[data-agent]');
    const target = { agent: card?.dataset.agent, self: card?.dataset.self === 'true', group: group.dataset.fleetGroup ?? group.dataset.group };
    if (group.hasAttribute('data-fleet-problems')) onProblems(target); else onGroup(target);
    return;
  }
  const action = event.target?.closest?.('[data-fleet-action]');
  if (action?.dataset.fleetAction) {
    if (action.dataset.fleetAction === 'settings') onSettings(); else onRefresh();
    return;
  }
  const open = event.target?.closest?.('.agent-open');
  if (!open) return;
  event.preventDefault?.();
  if (open.dataset.self === 'true') onSelf();
  else if (open.dataset.agent) onRemote(open.dataset.agent);
}
