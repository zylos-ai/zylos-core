import { element, icon, lastReceived, runtimeName } from './plain-text.js?v=106';
import { modelCell, pendingModel, shortDuration } from './board.js?v=117';
import { toolLabel, waitText } from './view-mode.js?v=116';
import { displayTime, eventLabel, timeValue } from './event-labels.js?v=91';
import { recentRows } from './timeline-rows.js?v=108';
import { formatZoned, zonedDay } from './instance-zone.js?v=100';

export function activeSubagents(events, runId) {
  const agents = new Map();
  for (const event of [...events].filter(row => !runId || row.run_id === runId)
    .sort((a, b) => (a.event_seq ?? timeValue(a.timestamp)) - (b.event_seq ?? timeValue(b.timestamp)))) {
    const id = event.agent_id ?? event.metadata?.agent_id;
    if (id == null) continue;
    if (event.event_type === 'subagent_start') agents.set(id, { id, name: event.metadata?.name ?? id });
    if (event.event_type === 'subagent_stop') agents.delete(id);
  }
  return [...agents.values()];
}

export function detailEvidence(row, snapshot = {}) {
  const wait = row.wait;
  const runtime = wait?.runtime ?? row.target?.runtime;
  const health = runtime ? snapshot.instance?.runtimeHealth?.[runtime] : null;
  const headline = health && ['rate_wait', 'auth_wait'].includes(wait?.kind)
    ? `${runtime} · ${health.health}`
    : wait?.reasonCode ?? wait?.reason ?? wait?.fenceReason ?? row.state?.reasonCode ?? row.state?.reason ?? row.reason ?? 'no_rule';
  const samples = [];
  const fromHealth = headline === `${runtime} · ${health?.health}`;
  if (runtime && health) samples.push({ source: `${runtime} health`, value: health.health, at: health.updatedAt, hit: fromHealth });
  if (row.queue) samples.push({ source: 'queue', value: row.queue.known === false ? row.queue.reason : row.queue.pending?.count, at: snapshot.readAt });
  if (row.live?.status) samples.push({ source: 'status', value: row.live.status.reason ?? row.live.status.state, at: row.live.status.sampledAt });
  for (const [source, value] of Object.entries(snapshot.sources ?? {})) {
    samples.push({ source, value: value.reason ?? (value.ok ? 'ok' : 'unknown'), at: value.readAt });
  }
  // The sample the headline came from is highlighted in the table.
  if (!fromHealth) for (const sample of samples) sample.hit = sample.value != null && String(sample.value) === headline;
  return { headline, samples };
}

export function detailNumbers(row, { backlog, now = Date.now() } = {}, t = key => key) {
  return [
    { key: 'wb.detail.queue', value: row.queue == null ? '—' : row.queue.known === false ? t('wb.unknown') : `${row.queue.pending?.count ?? 0} · ${row.queue.running?.count ?? 0}`, note: 'wb.detail.queueNote' },
    { key: 'wb.detail.context', value: row.contextPct == null ? t('wb.unknown') : `${Math.round(row.contextPct)}%`, pct: row.contextPct, note: row.contextPct == null ? null : 'wb.detail.contextNote' },
    { key: 'wb.detail.thisRun', value: row.createdAt == null ? t('wb.unknown') : t('wb.detail.runDuration', { minutes: Math.max(0, Math.floor((now - row.createdAt * 1000) / 60000)) }) },
    { key: 'wb.term.unsummarized', value: backlog?.count == null ? t('wb.unknown') : backlog.count, memory: true },
  ];
}

/** How long ago a sample was read: "12 秒前", "4m12s前"; empty when the time is unknown. */
export function sampleAge(at, now = Date.now(), t = key => key) {
  const time = timeValue(at);
  if (!Number.isFinite(time)) return '';
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  return seconds < 60 ? t('wb.detail.agoSeconds', { n: seconds }) : t('wb.detail.ago', { span: shortDuration(seconds) });
}

/**
 * Short clock time in the event column, with the date as well when the event is not from today (`now`); the full
 * or raw value stays in the tooltip.
 */
export function eventTime(value, level = 'plain', locale, now = null) {
  const time = timeValue(value);
  if (!Number.isFinite(time)) return { text: value == null ? '' : String(value), title: value == null ? '' : String(value) };
  const date = new Date(time), otherDay = now != null && zonedDay(date) !== zonedDay(now);
  const text = otherDay ? formatZoned(date, locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : formatZoned(date, locale, { hour: '2-digit', minute: '2-digit' });
  return { text, title: displayTime(value, level, locale) };
}
const toolEvents = new Set(['pre_tool_use', 'post_tool_use', 'post_tool_failure', 'permission_request']);
const inEvents = new Set(['user_prompt_submit']);
const outEvents = new Set(['stop', 'assistant_message', 'turn_complete']);
const badEvents = new Set(['crash_detected', 'activate_failed', 'activate_timeout', 'post_tool_failure']);
export function eventKind(event) {
  if (event.direction) return event.direction === 'in' ? 'in' : 'out';
  const type = event.event_type;
  if (toolEvents.has(type)) return 'tool';
  if (inEvents.has(type)) return 'in';
  if (outEvents.has(type)) return 'out';
  if (String(type ?? '').startsWith('subagent')) return 'bot';
  return 'power';
}
const toolSuffix = { post_tool_use: 'wb.event.toolDone', post_tool_failure: 'wb.event.toolFailed' };
/** Tool events name the tool: "运行命令" in plain view; the tool name and its monospace argument when technical. */
export function toolEventLabel(document, event, { level = 'plain', t = key => key } = {}) {
  const type = event.event_type, name = event.metadata?.tool_name;
  if (!toolEvents.has(type) || !name) return null;
  const node = element(document, 'span', undefined, 'wb-ev-t');
  const suffix = toolSuffix[type] ? ' · ' + t(toolSuffix[type]) : '';
  if (level === 'technical') {
    node.append(element(document, 'span', name, 'wb-tool'));
    if (event.metadata.tool_detail) node.append(element(document, 'span', event.metadata.tool_detail, 'wb-ev-args wb-mono'));
    if (suffix) node.append(element(document, 'span', suffix, 'wb-sub'));
    node.title = type;
  } else {
    const tool = toolLabel(name, 'plain', t);
    node.textContent = type === 'permission_request' ? t('wb.event.permission_request') + ' · ' + tool : tool + suffix;
  }
  return node;
}
/**
 * One timeline line: time | round icon | label. Shared by recent activity and the full timeline.
 * `after` (a repeat count, for one) follows the label on the same line.
 */
export function eventRow(document, event, { level = 'plain', t = key => key, label, className = 'wb-ev', now = null, after = null } = {}) {
  const kind = eventKind(event);
  const node = element(document, 'div', undefined, `${className} wb-ev-${kind}${badEvents.has(event.event_type) ? ' wb-ev-bad' : ''}`);
  const time = eventTime(event.timestamp, level, document.documentElement?.lang, now);
  const stamp = element(document, 'time', time.text); stamp.title = time.title;
  const mark = element(document, 'span', undefined, 'wb-ev-k');
  mark.append(icon(document, kind === 'bot' ? 'bot' : kind, 'xs'));
  const tool = label == null ? toolEventLabel(document, event, { level, t }) : null;
  const text = tool ?? element(document, 'span', label ?? eventLabel(event, 'plain', t), 'wb-ev-t');
  // Technical view keeps the readable label and adds the recorded event code after it.
  if (!tool && label == null && level === 'technical' && event.event_type) text.append(element(document, 'span', eventLabel(event, level, t), 'wb-ev-code'));
  if (after) text.append(after);
  node.append(stamp, mark, text);
  return node;
}

/**
 * One row for a run of identical events: the newest one, and when it repeats, how many times and
 * from when to when ("600 次 · 09:58 – 10:08", one time when both fall in the same minute). An `open`
 * group may continue before what was read: "100+ 次 · 至 10:08". Full or raw times stay in the tooltip.
 */
export function repeatRow(document, group, { level = 'plain', t = key => key, className = 'wb-ev', now = null } = {}) {
  if (group.count < 2 && !group.open) return eventRow(document, group.newest.event, { level, t, className, now });
  const lang = document.documentElement?.lang;
  const from = eventTime(group.oldest.event.timestamp, level, lang, now), to = eventTime(group.newest.event.timestamp, level, lang, now);
  const text = group.open ? t('wb.timeline.repeatedUntil', { count: group.count, to: to.text })
    : from.text === to.text ? t('wb.timeline.repeatedAt', { count: group.count, at: to.text })
      : t('wb.timeline.repeated', { count: group.count, from: from.text, to: to.text });
  const repeat = element(document, 'span', text, 'wb-ev-rep');
  repeat.title = group.open ? to.title : from.title === to.title ? to.title : `${from.title} – ${to.title}`;
  const node = eventRow(document, group.newest.event, { level, t, className, now, after: repeat });
  node.classList.add('wb-ev-merged');
  return node;
}

/** Every recorded event of a group: those that belong to a run and those that belong to none. */
export const groupEventCount = data => (data.totalEvents ?? 0) + (data.unattributed ?? 0);

/** Whether the saved configuration is what runs: applied, pending (next safe point), not_running or unknown. */
export function configStatus(row) {
  if (pendingModel(row)) return 'pending';
  if (['running', 'starting'].includes(row.presence)) return row.launchConfig ? 'applied' : 'unknown';
  return 'not_running';
}
/** "Claude · opus · 思考强度 high" in plain view; the bare values when technical. */
export function configText(row, level = 'plain', t = key => key) {
  const running = ['running', 'starting'].includes(row.presence) && row.launchConfig;
  const value = running ? row.launchConfig : row.target?.runtime ? row.target : null;
  if (level === 'technical' || !value) return modelCell(row, t);
  const model = typeof value.model === 'object' ? value.model?.model : value.model ?? value.mode;
  const effort = value.effort ?? value.model?.effort;
  return [runtimeName(value.runtime), model, effort ? t('wb.term.effort') + ' ' + effort : null].filter(Boolean).join(' · ');
}

function nowCard(document, row, data, { level, t, snapshot }) {
  const kind = row.state?.kind ?? 'unknown';
  const card = element(document, 'div', undefined, 'wb-now-card');
  const title = element(document, 'div', undefined, 'wb-now-title');
  card.append(title);
  const tools = row.tools ?? [];
  if (tools.length) {
    card.classList.add('wb-now-work');
    for (const [index, tool] of tools.entries()) {
      const line = index === 0 ? title : element(document, 'div', undefined, 'wb-now-title');
      line.append(icon(document, 'tool'), element(document, 'span', toolLabel(tool.name, level, t), 'wb-detail-tool'));
      line.title = tool.name;
      if (index === 0 && row.duration != null) {
        const pill = element(document, 'span', undefined, 'wb-pill wb-busy wb-push');
        pill.append(element(document, 'i', undefined, 'wb-dot'), element(document, 'span', t('wb.detail.runningFor')), element(document, 'span', shortDuration(row.duration), 'wb-dur'));
        line.append(pill);
      }
      if (index > 0) card.append(line);
      if (level === 'technical' && tool.detail) card.append(element(document, 'div', tool.detail, 'wb-args'));
    }
    if (row.preview) card.append(element(document, 'p', lastReceived(row, t), 'wb-now-sub'));
  } else if (row.wait) {
    const failed = row.wait.kind === 'start_failed' || kind === 'error';
    card.classList.add(failed ? 'wb-now-err' : kind === 'unknown' ? 'wb-now-unk' : 'wb-now-wait');
    title.append(icon(document, failed ? 'alert' : kind === 'unknown' ? 'help' : 'clock'), element(document, 'span', t('wb.state.' + kind)));
    card.append(element(document, 'p', waitText({ ...row.wait, pendingCount: row.queue?.pending?.count }, level, t), 'wb-now-sub'));
  } else {
    if (kind === 'error') card.classList.add('wb-now-err');
    const glyph = icon(document, kind === 'not_running' ? 'power' : kind === 'error' ? 'alert' : kind === 'unknown' ? 'help' : 'clock');
    // The header already shows the state and for how long, so the card says what it means: the last message, or standby.
    // An error or an unknown state is the news itself: the card keeps that word and puts the last message under it.
    const sub = kind === 'not_running' ? t('wb.detail.standby') : lastReceived(row, t);
    if (sub && kind !== 'error' && kind !== 'unknown') { title.classList.add('wb-now-said'); title.append(glyph, element(document, 'span', sub)); }
    else {
      title.append(glyph, element(document, 'span', t('wb.state.' + kind)));
      if (row.duration != null && !['not_running', 'unknown'].includes(kind)) title.append(element(document, 'span', shortDuration(row.duration), 'wb-dur'));
      if (sub) card.append(element(document, 'p', sub, 'wb-now-sub'));
    }
  }
  if (level === 'technical') {
    // A preview labelled with its source keeps the stored message here, folded: headers, ids and line breaks included.
    if (row.preview?.raw) {
      const raw = element(document, 'details', undefined, 'wb-now-raw');
      raw.open = false;
      const summary = element(document, 'summary');
      summary.append(icon(document, 'chev', 'xs'), element(document, 'span', t('wb.detail.rawMessage')));
      raw.append(summary, element(document, 'pre', row.preview.raw, 'wb-mono'));
      card.append(raw);
    }
    const evidence = detailEvidence(row, snapshot);
    const details = element(document, 'details', undefined, 'wb-detail-evidence');
    details.open = false;
    const summary = element(document, 'summary');
    // The reason code stays visible (this is the technical view) after a readable phrase when there is one.
    const readable = evidence.headline === 'no_rule' ? t('wb.detail.evidenceNoRule') : null;
    summary.append(icon(document, 'chev', 'xs'), element(document, 'span', t('wb.detail.evidence') + ' · ' + (readable ?? '')),
      element(document, 'span', evidence.headline, 'wb-ev-code'));
    details.append(summary);
    const table = element(document, 'table'), body = element(document, 'tbody');
    for (const item of evidence.samples) {
      const line = element(document, 'tr', undefined, item.hit ? 'wb-hit' : undefined);
      const age = element(document, 'td', sampleAge(item.at, data.now ?? Date.now(), t));
      if (item.at != null) age.title = String(item.at);
      line.append(element(document, 'td', item.source), element(document, 'td', item.value == null ? '—' : String(item.value)), age);
      body.append(line);
    }
    table.append(body); details.append(table); card.append(details);
  }
  return card;
}

export function renderOverview(root, row, data = {}, { document = root.ownerDocument, t = key => key,
  level = 'plain', snapshot = {}, onTimeline = () => {}, onMemory = () => {}, onConfig = () => {}, onObserve = null, currentTime = Date.now() } = {}) {
  root.replaceChildren();
  const section = (key, className, glyph) => {
    const node = element(document, 'section', undefined, 'wb-detail-section ' + className);
    const head = element(document, 'h3'); head.append(icon(document, glyph, 'xs'), element(document, 'span', t(key)));
    node.append(head); root.append(node); return node;
  };
  const now = section('wb.detail.now', 'wb-detail-now', 'activity');
  const card = nowCard(document, row, data, { level, t, snapshot });
  now.append(card);
  const agents = activeSubagents(data.currentEvents ?? [], row.live?.runId);
  if (agents.length) {
    const subs = element(document, 'div', undefined, 'wb-subs');
    for (const agent of agents) {
      const tag = element(document, 'span', undefined, 'wb-tag');
      tag.append(icon(document, 'bot', 'xs'), element(document, 'span', t('wb.detail.subagent') + ' · ' + agent.name));
      subs.append(tag);
    }
    now.append(subs);
  }
  // Sleeping groups enter the observer page's no-session/history branch. The button closes the card it belongs to.
  if (onObserve) {
    const foot = element(document, 'div', undefined, 'wb-now-foot');
    const live = element(document, 'button', undefined, 'wb-btn wb-btn-sm'); live.type = 'button';
    live.dataset.observerGroup = row.sessionGroup ?? 'origin';
    live.append(icon(document, 'term', 'xs'), element(document, 'span', t('wb.detail.observe')));
    live.addEventListener('click', () => onObserve('live')); foot.append(live); card.append(foot);
  }
  // Newest first, dated when not from today. The count covers the same events: those in runs and those in none.
  const recent = section('wb.detail.recent', 'wb-detail-recent', 'clock');
  for (const group of recentRows(data.recent ?? [])) recent.append(repeatRow(document, group, { level, t, now: currentTime }));
  const timeline = element(document, 'button', t('wb.detail.fullTimeline', { events: groupEventCount(data), runs: data.totalRuns ?? 0 }), 'wb-link-btn wb-chev');
  timeline.type = 'button'; timeline.addEventListener('click', onTimeline); recent.append(timeline);
  const memory = section('wb.detail.memory', 'wb-detail-memory', 'book');
  const line = element(document, 'div', undefined, 'wb-mem-line');
  const count = data.backlog?.count;
  line.append(element(document, 'span', count == null ? t('wb.detail.memoryUnknown') : count ? t('wb.detail.memoryPending', { count }) : t('wb.detail.memorySaved')));
  if (data.backlog?.syncing === true) line.append(element(document, 'span', ' · ' + t('wb.detail.syncing'), 'wb-sub'));
  const link = element(document, 'button', t('wb.detail.memoryLink', { count: count == null ? t('wb.unknown') : count }), 'wb-link-btn wb-chev');
  link.type = 'button'; link.addEventListener('click', onMemory); line.append(link);
  memory.append(line);
  const config = section('wb.detail.config', 'wb-detail-config', 'sliders');
  const cfg = element(document, 'div', undefined, 'wb-cfg-line');
  const status = configStatus(row);
  cfg.append(element(document, 'b', configText(row, level, t)));
  if (status === 'pending') {
    const desired = row.desired;
    cfg.append(element(document, 'span', t('wb.pending') + ' · ' + [runtimeName(desired?.runtime), desired?.model, desired?.effort].filter(Boolean).join(' · '), 'wb-config-pending wb-txt-warn'),
      element(document, 'span', t('wb.config.running') + ' · ' + modelCell(row, t), 'wb-sub'));
  } else cfg.append(element(document, 'span', t('wb.config.state.' + status), status === 'unknown' ? 'wb-txt-warn' : 'wb-cfg-state'));
  if (level !== 'technical' && row.desired?.mode) cfg.append(element(document, 'span', '· ' + t(row.desired.mode === 'override' ? 'wb.config.source.override' : 'wb.config.source.default'), 'wb-sub'));
  const edit = element(document, 'button', t('wb.detail.modify'), 'wb-btn wb-btn-secondary wb-btn-sm'); edit.type = 'button'; edit.addEventListener('click', onConfig); cfg.append(edit);
  config.append(cfg);
  if (level === 'technical') {
    const numbers = element(document, 'div', undefined, 'wb-detail-numbers');
    for (const number of detailNumbers(row, data, t)) {
      const cell = element(document, 'div', t(number.key), number.pct >= 75 ? 'wb-hi' : undefined);
      cell.append(element(document, 'b', number.value));
      if (number.pct != null) {
        const bar = element(document, 'span', undefined, 'wb-meter' + (number.pct >= 75 ? ' wb-warn' : ''));
        const fill = element(document, 'i'); fill.style.width = Math.max(0, Math.min(100, number.pct)) + '%'; bar.append(fill); cell.append(bar);
      }
      if (number.note) cell.append(element(document, 'small', t(number.note)));
      if (number.memory) {
        const go = element(document, 'button', t('wb.detail.groupMemory'), 'wb-link-btn wb-chev'); go.type = 'button'; go.addEventListener('click', onMemory); cell.append(go);
      }
      numbers.append(cell);
    }
    root.append(numbers);
  }
  return { config, now, recent, memory };
}
