import { element } from './plain-text.js?v=85';
import { modelCell, pendingModel } from './board.js?v=89';
import { techOnly, toolLabel, waitText } from './view-mode.js?v=89';
import { displayTime, eventLabel, timeValue } from './event-labels.js?v=89';

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
  if (runtime && health) samples.push({ source: `${runtime} health`, value: health.health, at: health.updatedAt });
  if (row.queue) samples.push({ source: 'queue', value: row.queue.known === false ? row.queue.reason : row.queue.pending?.count, at: snapshot.readAt });
  if (row.live?.status) samples.push({ source: 'status', value: row.live.status.reason ?? row.live.status.state, at: row.live.status.sampledAt });
  for (const [source, value] of Object.entries(snapshot.sources ?? {})) {
    samples.push({ source, value: value.reason ?? (value.ok ? 'ok' : 'unknown'), at: value.readAt });
  }
  return { headline, samples };
}

export function detailNumbers(row, { backlog, now = Date.now() } = {}, t = key => key) {
  return [
    { key: 'wb.detail.queue', value: row.queue == null ? '—' : row.queue.known === false ? t('wb.unknown') : `${row.queue.pending?.count ?? 0} · ${row.queue.running?.count ?? 0}` },
    { key: 'wb.detail.context', value: row.contextPct == null ? t('wb.unknown') : `${Math.round(row.contextPct)}%` },
    { key: 'wb.detail.thisRun', value: row.createdAt == null ? t('wb.unknown') : t('wb.detail.runDuration', { minutes: Math.max(0, Math.floor((now - row.createdAt * 1000) / 60000)) }) },
    { key: 'wb.term.unsummarized', value: backlog?.count == null ? t('wb.unknown') : backlog.count },
  ];
}

export function renderOverview(root, row, data = {}, { document = root.ownerDocument, t = key => key,
  level = 'plain', snapshot = {}, onTimeline = () => {}, onMemory = () => {}, onConfig = () => {} } = {}) {
  root.replaceChildren();
  const section = (key, className) => {
    const node = element(document, 'section', undefined, 'wb-detail-section ' + className);
    node.append(element(document, 'h3', t(key))); root.append(node); return node;
  };
  const now = section('wb.detail.now', 'wb-detail-now');
  for (const tool of row.tools ?? []) now.append(element(document, 'p', toolLabel(tool.name, level, t) +
    (level === 'technical' && tool.detail ? ' · ' + tool.detail : ''), 'wb-detail-tool'));
  if (row.wait) now.append(element(document, 'p', waitText({ ...row.wait, pendingCount: row.queue?.pending?.count }, level, t)));
  if (!(row.tools?.length) && !row.wait) now.append(element(document, 'p', t('wb.state.' + (row.state?.kind ?? 'unknown'))));
  if (level === 'technical' && techOnly('evidence')) {
    const evidence = detailEvidence(row, snapshot);
    const details = element(document, 'details', undefined, 'wb-detail-evidence');
    details.open = false;
    details.append(element(document, 'summary', t('wb.detail.evidence') + ' · ' + evidence.headline));
    for (const item of evidence.samples) details.append(element(document, 'p', [item.source, item.value, item.at].filter(value => value != null).join(' · ')));
    now.append(details);
  }
  const runId = row.live?.runId;
  for (const agent of activeSubagents(data.currentEvents ?? [], runId)) now.append(element(document, 'p', t('wb.detail.subagent') + ' · ' + agent.name));
  if (level === 'technical') {
    const numbers = element(document, 'div', undefined, 'wb-detail-numbers');
    for (const number of detailNumbers(row, data, t)) numbers.append(element(document, 'div', `${t(number.key)} · ${number.value}`));
    now.append(numbers);
  }
  const recent = section('wb.detail.recent', 'wb-detail-recent');
  for (const event of data.recent ?? []) recent.append(element(document, 'p', [displayTime(event.timestamp, level), eventLabel(event, level, t)].filter(Boolean).join(' · ')));
  const timeline = element(document, 'button', t('wb.detail.fullTimeline', { events: data.totalEvents ?? 0, runs: data.totalRuns ?? 0 }));
  timeline.type = 'button'; timeline.addEventListener('click', onTimeline); recent.append(timeline);
  const memory = section('wb.detail.memory', 'wb-detail-memory');
  const link = element(document, 'button', t('wb.detail.memoryLink', { count: data.backlog?.count == null ? t('wb.unknown') : data.backlog.count }));
  link.type = 'button'; link.addEventListener('click', onMemory); memory.append(link);
  if (data.backlog?.syncing === true) memory.append(element(document, 'p', t('wb.detail.syncing')));
  const config = section('wb.detail.config', 'wb-detail-config');
  config.append(element(document, 'p', modelCell(row, t)));
  if (pendingModel(row)) {
    const desired = row.desired;
    config.append(element(document, 'p', t('wb.pending') + ' · ' + [desired?.runtime, desired?.model, desired?.effort].filter(Boolean).join(' · '), 'wb-config-pending'),
      element(document, 'p', t('wb.config.running') + ' · ' + modelCell(row, t)));
  }
  const edit = element(document, 'button', t('wb.detail.modify')); edit.type = 'button'; edit.addEventListener('click', onConfig); config.append(edit);
  return { config, now, recent, memory };
}
