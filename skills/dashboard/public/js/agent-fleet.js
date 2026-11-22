import { accountUsedPercent, accountRuntimes, remainingQuotaPercent, quotaColor, quotaFillColor, quotaRecordedTime } from './wb/instance-strip.js';
import { fleetMood, isOffline, stateMood } from './fleet-status.js';
import { counted } from './count-label.js';
import { recoveryTime } from './wb/cooldown.js';
import { formatZoned, instanceZoneReady } from './wb/instance-zone.js';

import { fallbackName, platformOf } from './wb/plain-text.js';

const REASON_BADGE_REASONS = new Set(['unreachable', 'auth_failed', 'version_unsupported', 'timeout', 'conn_refused', 'bad_payload', 'offline']);
const LINK_CHIP_QUALITIES = new Set(['slow', 'degraded', 'stale']);

export function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Input is always a 0-100 percentage (rate_limit_pct, cpu/mem/
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

function labelText(value, fallback = '--') {
  const text = String(value || '').trim();
  return text || fallback;
}

function reasonLabel(reason, labels) {
  const key = String(reason || '').toLowerCase();
  return labels.reasonLabels?.[key] || labelText(reason, labels.unreachable);
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
  if (mood === 'stuck') return labels.stuck;
  if (mood === 'offline') return labels.offline;
  if (mood === 'unknown') return labels.unknown;
  return labels.idle;
}

function colorForAgent(agent) {
  return agent?.color || '#64748b';
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
    title: 'Agent Fleet',
    subtitle: 'Every machine you can view; the ones with a problem come first.',
    busy: 'Working',
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
    fixAuth: 'Ask the other side for a new key and add it again under Settings · Other machines.',
    fixDown: 'The other Dashboard may be off or its address changed.',
    fixVersion: 'The other Dashboard needs an upgrade.',
    lastSeen: 'last reachable {time}',
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
    self: 'This machine',
    modeMulti: 'Multi-session',
    modeSingle: 'Single session',
    modeUnknown: 'Mode unknown',
    machine: 'Machine',
    running: 'Running',
    condition: 'Condition',
    quota: 'Quota',
    listGroups: '{count} groups',
    listGroupsOne: '{count} group',
    listWorking: '{count} working',
    listLastSeen: 'last reachable {time}',
    listProblemCount: '{count} problems',
    listProblemCountOne: '{count} problem',
    listQuota: 'Quota {value}',
    listToday: 'Today {value}',
    moreUnlisted: '{count} additional problems',
    pageRange: '{start}–{end} / {total} machines',
    pagination: 'Machine pages',
    previousPage: 'Previous page',
    nextPage: 'Next page',
    refresh: 'Refresh status',
    readOnly: 'Read-only',
    admin: 'Admin',
    runningGroups: 'Running {count} groups',
    runningGroupsOne: 'Running {count} group',
    allNormal: 'All normal',
    summaryUnavailable: 'Group statistics unavailable',
    moreProblems: '{count} more problems →',
    moreProblemsOne: '{count} more problem →',
    autoRestarts: '{count} automatic restarts in the last hour →',
    autoRestartsOne: '{count} automatic restart in the last hour →',
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
  const agents = fleet?.items ?? [];
  const tiles = agents.map((agent) => {
    const offline = isOffline(agent);
    const mood = fleetMood(agent);
    const isSelf = agent.self === true;
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
      linkQuality: String(link?.quality || 'ok').toLowerCase(),
      linkChip,
      latencyLabel: latencyLabel(link?.latency_ms),
      rate7dPct: pctValue(agent.rate_limit_7d_pct),
      rate7dRecord: { recordedAt: agent.rate_limit_7d_recorded_at, live: agent.rate_limit_7d_live },
      dailyCostLabel: money(agent.daily_cost),
      weeklyCostLabel: money(agent.weekly_cost),
      cpuPct: agent.cpu_pct,
      memPct: agent.mem_pct,
      diskPct: agent.disk_pct,
      reason: agent.health_reason || '',
      showReason: REASON_BADGE_REASONS.has(String(agent.health_reason || '').toLowerCase()),
      baseUrl: agent.base_url || '',
      access: agent.access === 'admin' ? 'admin' : 'read',
      lastSeen: agent.last_seen || null,
      lastSeenText: agent.last_seen && Number.isFinite(Date.parse(agent.last_seen)) ? ageText(agent.last_seen) : null,
      self: isSelf ? self : null,
      sessionMode: ['single', 'multi'].includes(agent.session_mode) ? agent.session_mode : isSelf ? self?.mode : null,
      groupSummary: agent.group_summary ?? null,
      supervisorPaused: isSelf ? self?.supervisorPaused ?? agent.supervisor_paused : agent.supervisor_paused,
      href: isSelf ? `${basePath}/` : `${basePath}/fleet/${encodeURIComponent(String(agent.name || ''))}/`
    };
  });
  const page = options.page ?? 1;
  const total = fleet?.summary?.count ?? 0;
  return {
    labels,
    layout: options.layout === 'list' ? 'list' : 'cards',
    page,
    nextCursor: fleet?.nextCursor ?? null,
    total,
    offset: (page - 1) * 8,
    tiles,
    t: options.t || (key => ({ 'wb.term.origin': 'Origin', 'chat.unnamed': 'Untitled conversation' }[key] || key.replace('wb.platform.', ''))),
    counts: fleet?.summary?.counts ?? { busy: 0, idle: 0, stuck: 0, offline: 0 },
    costTotals: { daily: money(fleet?.summary?.daily_cost), weekly: money(fleet?.summary?.weekly_cost) },
    updatedAt: fleet?.updated_at || null
  };
}

// This machine keeps its account quota metadata from the Workbench snapshot; group totals come from the Fleet API.
export function fleetSelfFromSnapshot(snapshot) {
  return {
    mode: ['multi', 'single'].includes(snapshot?.mode) ? snapshot.mode : null,
    supervisorPaused: snapshot?.instance?.supervisorPaused ?? null,
    runtimes: accountRuntimes(snapshot ?? {}),
    accountRecords: snapshot?.instance?.accounts ?? {},
    accounts: Object.fromEntries(['claude', 'codex'].map((runtime) => [runtime, accountUsedPercent(snapshot?.instance?.accounts?.[runtime])]))
  };
}

// Card state pills share the board's colours: working, idle, waiting.
const pillKind = { busy: 'busy', idle: 'idle', stuck: 'waiting' };
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
const groupStateOrder = ['busy', 'idle', 'waiting', 'unknown', 'no_response', 'error'];

function groupBar(summary, title) {
  if (!summary.running) return '';
  const segments = groupStateOrder.filter(kind => summary.counts?.[kind] > 0)
    .map(kind => `<i class="wb-gbar-${kind}" style="flex:${Number(summary.counts[kind])}"></i>`).join('');
  return `<div class="wb-gbar" title="${escapeHtml(title)}">${segments}</div>`;
}

function problemLabel(row, labels, t) {
  const duration = Number.isFinite(row.durationSeconds) ? ' ' + fill(labels.groupDuration, { count: Math.floor(row.durationSeconds / 60) }) : '';
  return {
    name: problemName(row, labels, t),
    reason: (labels.problemReasons[row.reason] || labels.groupStates.error) + duration
  };
}

function groupStates(tile, labels, t) {
  const summary = tile.groupSummary;
  const status = tile.mood === 'unknown' ? `<span class="wb-pill wb-unknown" data-mood="unknown"><span class="wb-dot"></span>${escapeHtml(tile.stateLabel)}</span>` : '';
  if (!summary || !summary.listKnown) return `<div class="wb-f-act">${status}<span>${escapeHtml(labels.summaryUnavailable)}</span></div>`;
  const counts = summary.counts || {};
  const active = groupStateOrder.filter(kind => counts[kind] > 0);
  const text = [fill(counted(labels, 'runningGroups', summary.running), { count: summary.running }), ...active.map(kind => `${counts[kind]} ${labels.groupStates[kind]}`)].join(' · ');
  const bar = groupBar(summary, text);
  const problems = (summary.problems || []).slice(0, 2);
  const rows = problems.map(row => {
    const { name, reason } = problemLabel(row, labels, t);
    return `<button type="button" class="wb-f-problem" data-fleet-group="${escapeHtml(row.sessionGroup)}"><i class="wb-dot wb-f-dot-${escapeHtml(row.reason)}"></i><b class="wb-f-problem-name" title="${escapeHtml(name)}">${escapeHtml(name)}</b><span class="wb-f-problem-reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span></button>`;
  }).join('');
  const target = escapeHtml(problems[0]?.sessionGroup ?? '');
  const more = summary.problemCount > 2 ? `<button type="button" class="wb-f-more" data-fleet-problems data-group="${target}">${escapeHtml(fill(counted(labels, 'moreProblems', summary.problemCount - 2), { count: summary.problemCount - 2 }))}</button>` : '';
  const restart = summary.autoRestarts?.count > 0 ? `<button type="button" class="wb-f-more" data-fleet-problems data-group="${target}">${escapeHtml(fill(counted(labels, 'autoRestarts', summary.autoRestarts.count), { count: summary.autoRestarts.count }))}</button>` : '';
  return `${status ? `<div class="wb-f-act">${status}</div>` : ''}<div class="wb-f-act wb-f-running" title="${escapeHtml(text)}">${escapeHtml(text)}</div>${bar}<div class="wb-f-problems">${summary.problemCount ? rows + more : summary.attention?.length ? '' : `<span class="wb-f-normal">${escapeHtml(counts.unknown ? labels.summaryUnavailable : labels.allNormal)}</span>`}${restart}</div>`;
}

function machineData(tile) {
  return `data-agent="${escapeHtml(tile.name)}"${tile.isSelf ? ' data-self="true"' : ''}`;
}

function machineName(tile) {
  const name = escapeHtml(tile.name);
  return tile.offline ? `<b title="${name}">${name}</b>`
    : `<a class="agent-open" href="${escapeHtml(tile.href)}" ${machineData(tile)} title="${name}">${name}</a>`;
}

function machineStatePill(tile) {
  return `<span class="wb-pill wb-${escapeHtml(pillKind[tile.mood] ?? 'unknown')}" data-mood="${escapeHtml(tile.mood)}"><span class="wb-dot"></span>${escapeHtml(tile.stateLabel)}</span>`;
}

function poolText(tile) {
  const pool = tile.groupSummary?.pool;
  return pool?.used == null ? '--' : String(pool.used) + (pool.capacity == null ? '' : '/' + pool.capacity);
}

function renderTile(tile, labels, t) {
  const data = machineData(tile);
  const linkChip = tile.linkChip
    ? `<span class="agent-link-chip link-${escapeHtml(tile.linkChip.quality)}" title="${escapeHtml(tile.linkChip.title)}">${escapeHtml(tile.linkChip.label)}</span>`
    : '';
  const multi = tile.sessionMode === 'multi';
  const mode = multi ? labels.modeMulti : tile.sessionMode === 'single' ? labels.modeSingle : labels.modeUnknown;
  const sub = tile.isSelf
    ? `<div class="wb-f-sub"><span class="wb-f-seg">${escapeHtml(labels.self)}</span></div>`
    : `<div class="wb-f-sub wb-tech"><span class="wb-f-seg"><span class="wb-mono">${escapeHtml(tile.baseUrl)}</span></span>${tile.offline ? '' : `${tile.latencyLabel ? `<span class="wb-f-seg">${escapeHtml(labels.linkLatency)} ${escapeHtml(tile.latencyLabel)}</span>` : ''}`}${linkChip}</div>`;
  if (tile.offline) {
    const seen = tile.lastSeenText;
    return `<div class="wb-f-card bad" ${data} data-state="${escapeHtml(tile.mood)}">
    <div class="wb-f-top"><i class="wb-ico wb-ico-alert wb-ico-xs" aria-hidden="true"></i>${machineName(tile)}<span class="wb-grow"></span><span class="wb-mode-tag">${escapeHtml(mode)}</span></div>
    ${sub}
    <div class="wb-f-reason"><span class="wb-plain">${escapeHtml(tile.problem.short)}</span><span class="wb-tech agent-fleet-reason">${escapeHtml(tile.stateLabel)}</span><span class="wb-tech wb-mono"> · ${escapeHtml(tile.reason)}</span></div>
    <p class="wb-note">${escapeHtml(afterSentence(tile.problem.fix, seen ? fill(labels.lastSeen, { time: seen }) : ''))}</p>
    <div class="wb-f-foot"><span class="wb-grow"></span><button class="wb-btn" type="button" data-fleet-action="refresh">${escapeHtml(labels.refresh)}</button></div>
  </div>`;
  }
  const act = multi ? groupStates(tile, labels, t)
    : `<div class="wb-f-act">${machineStatePill(tile)}</div>`;
  const second = multi ? `<div>${escapeHtml(labels.pool)}<b>${escapeHtml(poolText(tile))}</b></div>` : '';
  return `<div class="wb-f-card${tile.isSelf ? ' self' : ''}" ${data} data-state="${escapeHtml(tile.mood)}"${tile.linkQuality !== 'ok' ? ` data-link-quality="${escapeHtml(tile.linkQuality)}"` : ''}>
    <div class="wb-f-top"><span class="wb-hdot"></span>${machineName(tile)}${tile.isSelf ? `<span class="wb-tag">${escapeHtml(labels.self)}</span>` : ''}<span class="wb-grow"></span><span class="wb-mode-tag">${escapeHtml(mode)}</span></div>
    ${sub}
    ${tile.supervisorPaused === true ? `<div class="wb-f-reason wb-txt-warn" data-supervisor-paused>${escapeHtml(t('wb.attention.supervisor_paused'))}</div>` : ''}
    ${act}
    ${multi ? '<div class="wb-f-attention" data-fleet-attention></div>' : ''}
    ${quotaBars(tile, labels)}
    <div class="wb-f-kv">
      <div>${escapeHtml(labels.todayWeek)}<b>${escapeHtml(tile.dailyCostLabel)} / ${escapeHtml(tile.weeklyCostLabel)}</b></div>
      ${second}
      <div>${escapeHtml(labels.host)}<b>${[tile.cpuPct, tile.memPct, tile.diskPct].map((value) => value == null ? '--' : Number(value).toFixed(0)).join(' · ')}%</b></div>
    </div>
    ${tile.isSelf ? '' : `<div class="wb-f-foot">${escapeHtml(tile.access === 'admin' ? labels.admin : labels.readOnly)}</div>`}
  </div>`;
}

function listProblems(tile, labels, t) {
  if (tile.offline) {
    const seen = tile.lastSeenText ? fill(labels.listLastSeen, { time: tile.lastSeenText }) : '';
    return { condition: afterSentence(labels.shortDown, seen), problemCount: 0, details: '' };
  }

  const summary = tile.groupSummary;
  const groupProblems = summary?.problems ?? [];
  const problems = groupProblems.map(row => {
    const { name, reason } = problemLabel(row, labels, t);
    return `${name} · ${reason}`;
  });
  const unlisted = Math.max(0, (summary?.problemCount ?? 0) - groupProblems.length);
  const attention = (summary?.attention ?? []).map(item => attentionMessage(item, t)).filter(Boolean);
  if (tile.supervisorPaused === true) problems.push(t('wb.attention.supervisor_paused'));
  if (summary?.autoRestarts?.count > 0) {
    const count = summary.autoRestarts.count;
    problems.push(fill(counted(labels, 'autoRestarts', count), { count }).replace(/ →$/, ''));
  }
  if (tile.mood === 'stuck' && !problems.length && !attention.length) problems.push(tile.stateLabel);
  const messages = [...problems, ...attention];
  const problemCount = messages.length + unlisted;
  const detail = unlisted ? [...messages, fill(labels.moreUnlisted, { count: unlisted })] : messages;
  const normal = (tile.sessionMode === 'multi' && (!summary?.listKnown || summary.counts?.unknown)) || tile.mood === 'unknown'
    ? labels.summaryUnavailable : labels.allNormal;
  return { condition: messages[0] ?? normal, problemCount, details: detail.join('\n') };
}

function compactQuota(tile) {
  const accounts = tile.self?.accounts;
  const runtimes = tile.self?.runtimes ?? [];
  const amounts = runtimes.length ? runtimes.map(runtime => accounts?.[runtime]) : [tile.rate7dPct];
  const remaining = amounts.map(amount => remainingQuotaPercent(amount));
  if (remaining.every(pct => pct == null)) return '';
  return remaining.map(pctText).join(' / ');
}

function renderListRow(tile, labels, t) {
  const summary = tile.groupSummary;
  const running = summary?.listKnown ? fill(counted(labels, 'listGroups', summary.running), { count: summary.running }) : '';
  const working = running ? `${running} · ${fill(labels.listWorking, { count: summary.counts?.busy ?? 0 })}` : '';
  const { condition, problemCount, details } = listProblems(tile, labels, t);
  const problemTone = problemCount ? (tile.mood === 'stuck' || summary?.problems?.[0]?.reason === 'no_response' ? ' warn' : ' err') : '';
  const situation = escapeHtml(condition) + (problemCount > 1 ? ` <small>+${problemCount - 1}</small>` : '');
  const modeTag = tile.sessionMode === 'single' ? `<span class="wb-mode-tag">${escapeHtml(labels.modeSingle)}</span>` : '';
  const access = tile.isSelf ? labels.self : tile.access === 'read' ? labels.readOnly : '';
  const accessTag = access ? `<span class="wb-tag">${escapeHtml(access)}</span>` : '';
  const dot = tile.offline ? '<i class="wb-ico wb-ico-alert wb-ico-xs" aria-hidden="true"></i>'
    : `<span class="wb-hdot${problemTone || (tile.mood === 'idle' ? ' idle' : '')}"></span>`;
  const cost = `${tile.dailyCostLabel} / ${tile.weeklyCostLabel}`;
  const host = [tile.cpuPct, tile.memPct, tile.diskPct].map(value => pctText(pctValue(value))).join(' · ');
  const quota = compactQuota(tile);
  const mobileCondition = problemCount ? fill(counted(labels, 'listProblemCount', problemCount), { count: problemCount }) : condition;
  const mobile = tile.offline ? escapeHtml(condition) : `
    ${running ? `<span>${escapeHtml(running)} ·</span>` : ''}
    <span class="wb-f-list-mobile-condition${problemTone}">${escapeHtml(mobileCondition)}</span>
    ${quota ? `<span>· ${escapeHtml(fill(labels.listQuota, { value: quota }))}</span>` : ''}
    <span>· ${escapeHtml(fill(labels.listToday, { value: tile.dailyCostLabel }))}</span>`;
  const mood = labels[tile.mood] ?? labels.unknown;
  const title = details ? ` title="${escapeHtml(details)}"` : '';
  let activity = '<span>—</span>';
  if (!tile.offline) {
    activity = tile.sessionMode === 'single' ? machineStatePill(tile) :
      `${working ? groupBar(summary, working) : ''}<span>${escapeHtml(working || (tile.sessionMode === 'multi' ? labels.summaryUnavailable : tile.stateLabel))}</span>`;
  }
  const status = tile.offline ? '' : `<span class="wb-hdot${tile.mood === 'stuck' ? ' warn' : tile.mood === 'idle' ? ' idle' : ''}"></span>`;
  return `<div class="wb-f-list-row${tile.offline ? ' bad' : ''}${tile.isSelf ? ' self' : ''}" role="row" ${machineData(tile)} data-state="${escapeHtml(tile.mood)}">
    <div class="wb-f-list-name" role="cell">${dot}${machineName(tile)}${accessTag}${modeTag}</div>
    <div class="wb-f-list-running" role="cell">${activity}</div>
    <div class="wb-f-list-condition${problemTone}" role="cell"${title}>${situation}</div>
    <div class="wb-f-list-quota" role="cell">${tile.offline ? '—' : quotaBars(tile, labels)}</div>
    <div class="wb-f-list-cost" role="cell">${escapeHtml(tile.offline ? '—' : cost)}</div>
    <div class="wb-f-list-pool" role="cell">${escapeHtml(tile.offline || tile.sessionMode === 'single' ? '—' : poolText(tile))}</div>
    <div class="wb-f-list-host wb-tech" role="cell">${escapeHtml(tile.offline ? '—' : host)}</div>
    <div class="wb-f-list-state" role="cell">${status}${escapeHtml(mood)}${tile.offline ? '' : '<i class="wb-ico wb-ico-chev wb-ico-xs" aria-hidden="true"></i>'}</div>
    <div class="wb-f-list-mobile" role="cell"${title}>${mobile}</div>
  </div>`;
}

function renderFleetList(view) {
  const { labels, t, tiles } = view;
  const columns = ['machine', 'running', 'condition', 'quota', 'todayWeek', 'pool', 'host'];
  return `<div class="wb-f-list" role="table" aria-label="${escapeHtml(labels.title)}">
    <div class="wb-f-list-head" role="row">${columns.map(key => `<span role="columnheader" class="wb-f-col-${key}${key === 'host' ? ' wb-tech' : ''}">${escapeHtml(labels[key])}</span>`).join('')}</div>
    ${tiles.map(tile => renderListRow(tile, labels, t)).join('')}
  </div>`;
}

function renderFleetPagination(view) {
  if (view.page === 1 && !view.nextCursor) return '';
  const { labels, page, nextCursor, tiles, offset, total } = view;
  const range = fill(labels.pageRange, { start: offset + 1, end: offset + tiles.length, total });
  const button = (step, label, disabled) =>
    `<button class="wb-btn wb-btn-sm" type="button" data-fleet-page="${step}" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}"${disabled ? ' disabled' : ''}><i class="wb-ico wb-ico-chev wb-ico-xs" aria-hidden="true"></i></button>`;
  return `<nav class="wb-f-pagination" aria-label="${escapeHtml(labels.pagination)}"><span aria-live="polite">${escapeHtml(range)}</span>
    ${button(-1, labels.previousPage, page === 1)}${button(1, labels.nextPage, !nextCursor)}
  </nav>`;
}

function renderAgentFleetViewHtml(view) {
  const { labels, t } = view;
  const working = view.counts.busy;
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
        ${costCell(labels.dailyCost, view.costTotals.daily)}
        ${costCell(labels.weeklyCost, view.costTotals.weekly)}
      </span>
      ${renderFleetPagination(view)}
    </div>`;
  const empty = view.total <= 1 ? `<p class="wb-note wb-f-empty">${escapeHtml(labels.empty)}</p>` : '';
  return `<section class="agent-fleet" data-fleet-count="${view.total}">
    ${summary}
    ${view.layout === 'list' ? renderFleetList(view) : `<div class="wb-f-grid">
      ${view.tiles.map((tile) => renderTile(tile, labels, t)).join('')}
    </div>`}
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
export function fleetPageOptions({ t, fmtAge, basePath = '', labels, self = null, now = Date.now, layout, page }) {
  const ageText = ts => {
    const seconds = Math.max(0, Math.floor((now() - Date.parse(ts)) / 1000));
    return seconds >= 3600 ? t('time.hours_exact', { h: Math.floor(seconds / 3600) }) : fmtAge(ts);
  };
  return { basePath, labels, ageText, self, t, layout, page };
}

export function renderAgentFleet(container, fleet, options = {}) {
  if (!container) return null;
  const view = buildAgentFleetView(fleet, options);
  container.innerHTML = renderAgentFleetViewHtml(view);
  const cards = container.querySelectorAll?.('.wb-f-card') ?? [];
  for (const [index, card] of Array.from(cards).entries()) {
    const root = card.querySelector('[data-fleet-attention]');
    if (root) renderFleetAttention(root, view.tiles[index].groupSummary?.attention, view.t);
  }
  return view;
}

function attentionMessage(item, t) {
  const allowed = ['channel_send_failed', 'channel_restarting', 'start_failed', 'rate_limited', 'data_unreadable'];
  if (!allowed.includes(item?.kind)) return null;
  const at = item.kind === 'rate_limited' && instanceZoneReady() ? recoveryTime(item.until) : null;
  const values = { channel: item.channel ?? '', count: item.count ?? item.count30m ?? '',
    service: item.service ?? '', runtime: item.runtime ? item.runtime.charAt(0).toUpperCase() + item.runtime.slice(1) : '',
    time: at === null ? '' : formatZoned(at, undefined, { hour: '2-digit', minute: '2-digit' }),
    group: item.group ?? '', reason: item.reasonCode ?? item.source ?? '' };
  const key = 'wb.attention.' + item.kind + (item.kind === 'rate_limited' && at === null ? '_unknown' : '');
  return t(key, values);
}

/** Diagnostics are untrusted observations, so keep every value in a text node. */
export function renderFleetAttention(root, items = [], t = key => key) {
  root.replaceChildren();
  for (const item of items ?? []) {
    const message = attentionMessage(item, t);
    if (!message) continue;
    const node = root.ownerDocument.createElement(item.group === undefined ? 'div' : 'button');
    node.className = 'wb-f-attention-item' + (item.kind === 'rate_limited' ? ' wb-txt-warn' : '');
    if (item.group !== undefined) { node.type = 'button'; node.dataset.fleetGroup = item.group; }
    const label = root.ownerDocument.createElement('span');
    label.textContent = message;
    node.append(label);
    const technical = root.ownerDocument.documentElement?.dataset?.detail === 'technical';
    const details = [item.displayName ?? item.group, item.kind === 'data_unreadable'
      ? t('wb.flags.unreadable') : item.reasonCode ?? item.source].filter(Boolean);
    if (item.kind === 'data_unreadable' && technical) details.push(item.reasonCode ?? item.source ?? '');
    if (details.length) {
      const reason = root.ownerDocument.createElement('span');
      reason.className = 'wb-f-attention-detail';
      reason.textContent = details.join(' · ');
      node.append(reason);
    }
    root.append(node);
  }
}

/** Renders the Machines page with the page's own options, including "how long ago" in the page language. */
export function renderFleetPage(container, fleet, { t, fmtAge, basePath, labels, self, now, layout, page } = {}) {
  return renderAgentFleet(container, fleet, fleetPageOptions({ t, fmtAge, basePath, labels, self, now, layout, page }));
}

// What the header's machines icon does on the page being viewed: leave a machine opened in-page for the machines
// page; leave a remote machine's own page (opened from another dashboard's machines page) for that dashboard; show
// the machines page when other machines are configured; otherwise open machine settings, where they are added.
export function fleetIconAction({ remoteAgent = null, standaloneRemote = false, multiAgent = false } = {}) {
  if (remoteAgent) return 'exit-remote';
  if (standaloneRemote) return 'parent';
  return multiAgent ? 'fleet' : 'settings';
}

export function handleFleetClick(event, { onRefresh = () => {}, onSelf = () => {}, onRemote = () => {}, onGroup = () => {}, onProblems = () => {} } = {}) {
  const group = event.target?.closest?.('[data-fleet-group], [data-fleet-problems]');
  if (group) {
    event.preventDefault?.();
    const card = group.closest('[data-agent]');
    const target = { agent: card?.dataset.agent, self: card?.dataset.self === 'true', group: group.dataset.fleetGroup ?? group.dataset.group };
    if (group.hasAttribute('data-fleet-problems')) onProblems(target); else onGroup(target);
    return;
  }
  const action = event.target?.closest?.('[data-fleet-action]');
  if (action?.dataset.fleetAction === 'refresh') {
    onRefresh();
    return;
  }
  const open = event.target?.closest?.('.agent-open');
  if (!open) return;
  event.preventDefault?.();
  if (open.dataset.self === 'true') onSelf();
  else if (open.dataset.agent) onRemote(open.dataset.agent);
}
