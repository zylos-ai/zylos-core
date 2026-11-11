import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, allNodes, deferred, tick } from './fixtures/workbench-dom.js';
import { OBSERVER_ACCESS_SELECTOR, lockObserverButtons } from '../public/js/origin-lock.js';
import { createGroupDetail, resolveDetailRow, groupActionButtons, groupActionText, formatStartedAt } from '../public/js/wb/detail.js';
import { rawKey, renderOverview, detailNumbers, activeSubagents, detailEvidence, sampleAge, toolEventLabel, configStatus, configText, groupEventCount } from '../public/js/wb/detail-overview.js';
import { createTimelineLoader, attributeMessages, renderTimeline } from '../public/js/wb/detail-timeline.js';
import { createGroupConfig, fetchJson, runningText, validConfigChange, renderGroupConfig, modelChoices, effortChoices, startingPair } from '../public/js/wb/group-config.js';
import { saveGroupName, renderNameEditor } from '../public/js/wb/name-edit.js';
import { NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH, namePromptText, renderAutoName } from '../public/js/wb/auto-name.js';
import { displayTime, endReasonLabel, eventLabel } from '../public/js/wb/event-labels.js';
import { recentWindow } from '../public/js/wb/timeline-rows.js';
import { setInstanceZone } from '../public/js/wb/instance-zone.js?v=100';
import { INSTANCE_TEST_ZONE } from './helpers/instance-test-zone.js';
// Times are expected in the instance zone; INSTANCE_TEST_ZONE differs from the process zone (see the helper).
const ZONE = INSTANCE_TEST_ZONE;
setInstanceZone(ZONE);

// Direct product imports with injected DOM, fetch, clock, timers, clipboard and
// confirmation. Run for detail rendering, request ownership or form changes;
// skip unrelated collectors/runtime changes. Official runner isolates HOME,
// ZYLOS_DIR/PM2_HOME/short TMPDIR/private tmux namespace. No external I/O,
// independent loops or child processes; controllers are destroyed per case.
const t = (key, params) => key + (params ? ' ' + JSON.stringify(params) : '');
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => value });
const run = (id, start = 1000, end = 2000) => ({ runId: id, startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), n: 2, endReason: 'ttl' });
const row = (sessionGroup = 'telegram:a', extra = {}) => ({ sessionGroup, presence: 'running', state: { kind: 'busy' },
  live: { runId: 'run-a', sessionId: 'session-a' }, tools: [], queue: { pending: { count: 1 }, running: { count: 0 } },
  contextPct: 42, createdAt: 1000, launchConfig: { runtime: 'claude', mode: 'default' }, ...extra });
const emptyRuns = { runs: [], totalEvents: 17, totalRuns: 5, unattributed: 0 };
function detailFixture(fetch, options = {}) {
  const document = createDocument(), root = document.createElement('aside'), timers = [];
  const controller = createGroupDetail({ root, document, fetch, t,
    schedule: callback => { timers.push(callback); return timers.length; }, cancel: id => { timers[id - 1] = null; }, ...options });
  return { controller, root, timers, document };
}
function defaultRead(path) {
  if (path.includes('types=subagent_start')) return { events: [] };
  if (path.startsWith('/api/timeline')) return { events: [{ event_type: 'stop', timestamp: 'recent' }] };
  if (path.includes('/backlog')) return { count: 3, firstAt: 100, syncing: false };
  if (path.includes('/messages')) return { messages: [] };
  return emptyRuns;
}

test('historical detail resolves board rows, named search and key-only jumps without a search roundtrip', async () => {
  const historical = row('telegram:older', { presence: 'not_running', live: null, queue: null, contextPct: null });
  const snapshot = { rows: [], listKnown: true };
  assert.equal(resolveDetailRow(historical, snapshot).row, historical);
  assert.equal(resolveDetailRow({ sessionGroup: 'telegram:older', name: 'Old <script>' }, snapshot).row.name.displayName, 'Old <script>');
  const calls = [], f = detailFixture(async path => { calls.push(path); return response(defaultRead(path)); }, { detail: () => 'technical' });
  await f.controller.open({ sessionGroup: 'telegram:older', name: 'Old <script>' }, snapshot);
  assert.equal(f.controller.state.row.queue, null);
  assert.equal(f.controller.state.row.contextPct, null);
  assert.match(f.root.textContent, /Old <script>/);
  assert.match(f.root.textContent, /—/);
  assert.match(f.root.textContent, /wb.unknown/);
  assert.equal(allNodes(f.root).some(node => node.tagName === 'SCRIPT'), false);
  assert.equal(calls.some(path => path.includes('/search') || (path.startsWith('/api/timeline') && path.includes('run_id='))), false);
  const recent = calls.find(path => path.startsWith('/api/timeline'));
  assert.equal(new URL(recent, 'http://fixture').searchParams.get('limit'), String(recentWindow), 'recent activity reads a window, not only the rows it shows');
  assert.equal(new URL(recent, 'http://fixture').searchParams.has('run_id'), false);
  assert.equal(f.controller.state.totalEvents, 17);
  assert.equal(f.controller.state.totalRuns, 5);
  f.controller.updateSnapshot({ rows: [row('telegram:older')], listKnown: true });
  assert.equal(f.controller.state.row.queue, null, 'historical selection remains its bounded original row');
  f.controller.destroy();
});

test('overview keeps safe text, section order, technical-only numbers and current-run subagents', () => {
  const document = createDocument(), root = document.createElement('div');
  const events = [
    { run_id: 'old', event_type: 'subagent_start', agent_id: 'old' },
    { run_id: 'r', event_type: 'subagent_start', agent_id: '<img>', event_seq: 1 },
    { run_id: 'r', event_type: 'subagent_start', agent_id: 'finished', event_seq: 2 },
    { run_id: 'r', event_type: 'subagent_stop', agent_id: 'finished', event_seq: 3 },
  ];
  assert.deepEqual(activeSubagents(events, 'r').map(agent => agent.id), ['<img>']);
  const current = row('a', { live: { runId: 'r' }, queue: null, contextPct: null, tools: [{ name: 'Bash', detail: '<script>' }],
    wait: { kind: 'unknown', reasonCode: '<script>unknown' }, desired: { runtime: 'codex', mode: 'default' } });
  renderOverview(root, current, { recent: [{ timestamp: 'now', event_type: 'stop' }], currentEvents: events,
    totalEvents: 99, totalRuns: 5, backlog: { count: 3 } }, { document, t, level: 'technical', snapshot: { readAt: 42 } });
  assert.deepEqual(root.children.filter(node => node.tagName === 'SECTION').map(node => node.children[0].textContent), ['wb.detail.now', 'wb.detail.recent', 'wb.detail.memory', 'wb.detail.config']);
  assert.equal(root.children.at(-1).className, 'wb-detail-numbers', 'technical numbers close the overview');
  assert.match(root.textContent, /wb.detail.fullTimeline.*99.*5/);
  assert.match(root.textContent, /wb.detail.memoryLink.*3/);
  assert.match(root.textContent, /wb.pending/);
  assert.match(root.textContent, /wb.config.running/);
  assert.equal(allNodes(root).find(node => node.tagName === 'DETAILS').open, false);
  assert.equal(allNodes(root).some(node => ['SCRIPT', 'IMG'].includes(node.tagName)), false);
  assert.equal(detailNumbers(current, { now: 1060000 }, t)[2].value, 'wb.detail.runDuration {"minutes":1}');
  renderOverview(root, current, {}, { document, t, level: 'plain' });
  assert.equal(allNodes(root).some(node => node.className === 'wb-detail-numbers'), false);
});

test('timeline pages current events, loads three older runs lazily, filters expanded runs and preserves global totals', async () => {
  const calls = [], currentEvents = Array.from({ length: 1001 }, (_, index) => ({ run_id: 'cur', event_seq: index + 1, event_type: 'post_tool_use' }));
  const runs = [run('cur', 5000, 6000), run('r2', 3000, 4000), run('r3', 1000, 2000)];
  const loader = createTimelineLoader({ request: async path => {
    calls.push(path); const url = new URL(path, 'http://fixture');
    if (url.pathname.endsWith('/runs')) return { runs: url.searchParams.has('before') ? [run('r4', -1000, 0), run('r5', -3000, -2000)] : runs,
      totalEvents: 1009, totalRuns: 5, unattributed: 10 };
    if (url.pathname.endsWith('/messages')) return { messages: [] };
    return { events: url.searchParams.get('run_id') === 'cur'
      ? currentEvents.slice(url.searchParams.has('after_seq') ? 1000 : 0, url.searchParams.has('after_seq') ? 1001 : 1000)
      : [{ event_seq: 2, event_type: 'stop' }] };
  } });
  await loader.open('a', 'cur');
  assert.equal(loader.state.events.get('cur').length, 1001);
  assert.equal(calls.some(path => path.includes('after_seq=1000')), true);
  assert.equal(loader.state.events.has('r2'), false);
  await loader.expand('r2');
  assert.equal(loader.state.events.has('r2'), true);
  const before = calls.length; await loader.setFilter('tools');
  assert.equal(calls.slice(before).filter(path => path.includes('/api/timeline')).length, 3, 'current paginates twice, expanded older once');
  assert.equal(calls.slice(before).every(path => new URL(path, 'http://fixture').searchParams.get('types').includes('post_tool_failure')), true);
  await loader.loadEarlier();
  assert.equal(loader.state.runs.length, 5);
  assert.equal(loader.state.totalEvents, 1009);
  assert.equal(loader.state.totalRuns, 5);
  assert.equal(new URL(calls.find(path => path.includes('before=')), 'http://fixture').searchParams.get('before'), runs[2].startAt);
  loader.close();
});

test('event, end reason and time labels are plain words in plain view and raw values in technical detail', () => {
  assert.equal(eventLabel({ event_type: 'reclaim_done' }, 'plain', t), 'wb.event.reclaim_done');
  assert.equal(eventLabel({ event_type: 'wait_health' }, 'plain', t), 'wb.event.wait_health');
  assert.equal(eventLabel({ event_type: 'assistant_message', category: 'assistant' }, 'plain', t), 'wb.event.assistant_message');
  assert.equal(eventLabel({ event_type: 'runtime_health:recovered', category: 'runtime_health' }, 'plain', t), 'wb.event.category.runtime_health');
  assert.equal(eventLabel({ event_type: 'pool_sample', category: 'diagnostic' }, 'plain', t), 'wb.event.category.diagnostic');
  assert.equal(eventLabel({ event_type: 'custom_code', category: 'made_up' }, 'plain', t), 'wb.event.other');
  assert.equal(eventLabel({ event_type: 'reclaim_done' }, 'technical', t), 'reclaim_done');
  assert.equal(endReasonLabel('manual_restart', 'plain', t), 'wb.endReason.manual_restart');
  assert.equal(endReasonLabel('ttl', 'plain', t), 'wb.endReason.ttl');
  assert.equal(endReasonLabel('surprise', 'plain', t), 'wb.endReason.ended');
  assert.equal(endReasonLabel('ttl', 'technical', t), 'ttl');
  const iso = '2026-11-06T10:20:30.000Z';
  assert.equal(displayTime(iso, 'technical'), iso);
  assert.equal(displayTime(iso, 'plain', 'en-US'), new Date(iso).toLocaleString('en-US', { timeZone: ZONE }));
  assert.equal(displayTime('2026-11-06 10:20:30', 'plain', 'en-US'), new Date(iso).toLocaleString('en-US', { timeZone: ZONE }));
});

test('a labelled last message offers its stored text, folded, only in technical detail', () => {
  const document = createDocument(), root = document.createElement('div');
  const stored = '[Multica follow-up] Review ready for 01a1c33d-7d4e-7a1b-9c2d-0123456789ab\nRequested by: howard · Task ID: 01a1c33d-7d4e-7a1b-9c2d-0123456789ab';
  const current = row('a', { state: { kind: 'idle' }, preview: { text: 'Review ready', channel: 'multica', timestamp: 1, source: { kind: 'channel' } } });
  const opened = [];
  const fold = () => allNodes(root).find(node => node.classList?.contains('wb-now-raw'));
  renderOverview(root, current, {}, { document, t, level: 'plain', onRaw: open => opened.push(open) });
  assert.match(root.textContent, /Review ready/);
  assert.equal(fold(), undefined);
  renderOverview(root, current, {}, { document, t, level: 'technical', onRaw: open => opened.push(open) });
  assert.equal(fold().tagName.toLowerCase(), 'details');
  assert.equal(fold().open, false, 'folded until asked for');
  assert.equal(allNodes(fold()).find(node => node.tagName?.toLowerCase() === 'summary').textContent, 'wb.detail.rawMessage');
  assert.equal(allNodes(fold()).some(node => node.tagName?.toLowerCase() === 'pre'), false, 'nothing read yet');
  fold().open = true; fold().dispatch('toggle');
  assert.deepEqual(opened, [true]);
  const key = rawKey(current), draw = raw => renderOverview(root, current, { raw }, { document, t, level: 'technical' });
  draw({ key, open: true, status: 'loading', text: null });
  assert.equal(fold().open, true); assert.match(fold().textContent, /wb.detail.rawLoading/);
  draw({ key, open: true, status: 'ok', text: stored });
  assert.equal(allNodes(fold()).find(node => node.tagName?.toLowerCase() === 'pre').textContent, stored, 'the whole stored text, line breaks kept');
  for (const raw of [{ key, open: true, status: 'error', text: null }, { key, open: true, status: 'ok', text: null }]) {
    draw(raw); assert.match(fold().textContent, /wb.detail.rawUnavailable/);
  }
  draw({ key: rawKey({ ...current, preview: { ...current.preview, timestamp: 2 } }), open: true, status: 'ok', text: stored });
  assert.equal(fold().open, false, 'a read for an earlier message is not shown');
  renderOverview(root, { ...current, preview: { text: 'hi', channel: 'telegram', timestamp: 1 } }, {}, { document, t, level: 'technical' });
  assert.equal(fold(), undefined, 'a person\'s own words have no fold');
});

test('the stored message is read once when its fold opens and stays with that preview', async () => {
  const calls = [], stored = '[Bot] line one\nline two';
  const preview = timestamp => ({ text: 'line one', channel: 'review-bot', timestamp, source: { kind: 'channel' } });
  const current = row('review-bot:a', { state: { kind: 'idle' }, preview: preview(1) });
  const f = detailFixture(async path => {
    calls.push(path);
    return path.endsWith('/raw') ? response({ raw: stored }) : response(defaultRead(path));
  }, { detail: () => 'technical' });
  await f.controller.open(current, { rows: [current], listKnown: true });
  const fold = () => allNodes(f.root).find(node => node.classList?.contains('wb-now-raw'));
  const reads = () => calls.filter(path => path.endsWith('/raw'));
  assert.deepEqual(reads(), [], 'opening the detail reads no stored message');
  fold().open = true; fold().dispatch('toggle');
  await tick(); await tick();
  assert.deepEqual(reads(), ['/api/workbench/groups/review-bot%3Aa/raw']);
  assert.equal(allNodes(fold()).find(node => node.tagName?.toLowerCase() === 'pre').textContent, stored);
  fold().dispatch('toggle');
  await f.controller.updateSnapshot({ rows: [current], listKnown: true });
  assert.equal(fold().open, true, 'a poll keeps the fold open');
  assert.equal(allNodes(fold()).find(node => node.tagName?.toLowerCase() === 'pre').textContent, stored);
  fold().open = false; fold().dispatch('toggle');
  fold().open = true; fold().dispatch('toggle');
  await tick();
  assert.equal(reads().length, 1, 'reopening shows what was read');
  const newer = { ...current, preview: preview(2) };
  await f.controller.updateSnapshot({ rows: [newer], listKnown: true });
  assert.equal(fold().open, false, 'a new message folds again');
  f.controller.destroy();
});

test('a stored message that could not be read is read again when its fold reopens', async () => {
  const calls = [], stored = '[Bot] line one\nline two';
  const current = row('review-bot:a', { state: { kind: 'idle' }, preview: { text: 'line one', channel: 'review-bot', timestamp: 1, source: { kind: 'channel' } } });
  const f = detailFixture(async path => {
    if (!path.endsWith('/raw')) return response(defaultRead(path));
    calls.push(path);
    return calls.length === 1 ? response({ error: 'group_raw_failed' }, 502) : response({ raw: stored });
  }, { detail: () => 'technical' });
  await f.controller.open(current, { rows: [current], listKnown: true });
  const fold = () => allNodes(f.root).find(node => node.classList?.contains('wb-now-raw'));
  const pre = () => allNodes(fold()).find(node => node.tagName?.toLowerCase() === 'pre');
  fold().open = true; fold().dispatch('toggle');
  await tick(); await tick();
  assert.equal(calls.length, 1);
  assert.match(fold().textContent, /wb.detail.rawUnavailable/);
  assert.equal(pre(), undefined);
  fold().open = false; fold().dispatch('toggle');
  fold().open = true; fold().dispatch('toggle');
  await tick(); await tick();
  assert.equal(calls.length, 2, 'the failed read is tried again');
  assert.equal(pre().textContent, stored);
  f.controller.destroy();
});

test('overview recent activity and evidence are plain in plain view and raw only in technical detail', () => {
  const document = createDocument(), root = document.createElement('div');
  const iso = '2026-11-06T10:20:30.000Z';
  const data = { recent: [{ timestamp: iso, event_type: 'wait_health' }, { timestamp: iso, event_type: 'reclaim_done' }] };
  const current = row('a', { state: { kind: 'idle' } });
  renderOverview(root, current, data, { document, t, level: 'plain', currentTime: Date.parse(iso) });
  const recent = root.children[1].textContent;
  assert.match(recent, /wb\.event\.wait_health/); assert.match(recent, /wb\.event\.reclaim_done/);
  assert.doesNotMatch(recent, /wait_health ·|reclaim_done$|T10:20:30/);
  const times = allNodes(root.children[1]).filter(node => node.tagName === 'TIME');
  assert.equal(times[0].textContent, new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: ZONE }));
  assert.equal(times[0].title, new Date(iso).toLocaleString(undefined, { timeZone: ZONE }));
  assert.equal(allNodes(root).some(node => node.tagName === 'DETAILS'), false);
  assert.doesNotMatch(root.textContent, /no_rule|wb\.detail\.evidence/);
  assert.equal(allNodes(root).some(node => node.classList?.contains('wb-ev-code')), false, 'plain view shows no event codes');
  renderOverview(root, current, data, { document, t, level: 'technical' });
  // Technical view keeps the readable label and adds the recorded code after it.
  const codes = allNodes(root.children[1]).filter(node => node.classList?.contains('wb-ev-code')).map(node => node.textContent);
  assert.deepEqual(codes, ['wait_health', 'reclaim_done']);
  assert.match(root.children[1].textContent, /wb\.event\.wait_healthwait_health/);
  assert.match(root.children[1].textContent, /wb\.event\.reclaim_donereclaim_done/);
  assert.equal(allNodes(root.children[1]).find(node => node.tagName === 'TIME').title, iso);
  assert.match(root.textContent, /wb\.detail\.evidence · wb\.detail\.evidenceNoRuleno_rule/, 'the evidence names the reason in words, then its code');
});

test('recent activity lists newest first, dates events from another day, and counts the same events as the timeline', () => {
  const document = createDocument(), root = document.createElement('div');
  const now = Date.parse('2026-11-08T03:00:00.000Z');
  const at = hoursAgo => new Date(now - hoursAgo * 3600e3).toISOString();
  // Read in the order the server sent them; one event belongs to no run.
  const data = { recent: [{ timestamp: at(30), event_type: 'session_start' }, { timestamp: at(1), event_type: 'user_prompt_submit' }, { timestamp: at(2), event_type: 'stop', run_id: null }],
    totalEvents: 2, totalRuns: 1, unattributed: 1 };
  renderOverview(root, row('a', { state: { kind: 'idle' } }), data, { document, t, level: 'plain', currentTime: now });
  const times = allNodes(root.children[1]).filter(node => node.tagName === 'TIME');
  assert.deepEqual(times.map(node => node.title), [at(1), at(2), at(30)].map(value => new Date(value).toLocaleString(undefined, { timeZone: ZONE })), 'newest first');
  assert.equal(times[0].textContent, new Date(at(1)).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: ZONE }), 'today shows the time');
  assert.equal(times[2].textContent, new Date(at(30)).toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: ZONE }), 'another day shows the date too');
  assert.match(root.children[1].textContent, /wb\.detail\.fullTimeline \{"events":3,"runs":1\}/, 'the count includes events outside a run');
  assert.equal(groupEventCount({ totalEvents: 17, unattributed: 4 }), 21);
  assert.equal(groupEventCount({}), 0);
});

test('the timeline tab counts events outside a run too, like the full-timeline link', async () => {
  const runs = { runs: [], totalEvents: 17, totalRuns: 5, unattributed: 4 };
  const f = detailFixture(async path => response(path.startsWith('/api/workbench/groups/') && path.includes('/runs') ? runs : defaultRead(path)));
  await f.controller.open(row('telegram:a'), { rows: [row('telegram:a')], listKnown: true });
  const tab = allNodes(f.root).find(node => node.attributes?.role === 'tab' && /wb\.detail\.timeline/.test(node.textContent));
  assert.match(tab.textContent, / 21$/);
  assert.match(f.root.textContent, /wb\.detail\.fullTimeline \{"events":21,"runs":5\}/);
  f.controller.destroy();
});

test('timeline run rows, events and messages hide run ids and raw codes in plain view', () => {
  const start = '2026-11-06T10:00:00.000Z', end = '2026-11-06T11:00:00.000Z', at = '2026-11-06T10:30:00.000Z';
  const loader = { state: { runs: [{ runId: 'run-0123456789abcdef', startAt: start, endAt: end, endReason: 'manual_restart', n: 2 }],
    expanded: new Set(['run-0123456789abcdef']), events: new Map([['run-0123456789abcdef', [{ timestamp: at, event_type: 'reclaim_done' }]]]),
    messages: new Map([['run-0123456789abcdef', [{ timestamp: at, direction: 'in' }]]]), between: [{ timestamp: at, direction: 'out' }],
    filter: 'all', totalRuns: 1 }, setFilter() {}, collapse() {} };
  const document = createDocument(), root = document.createElement('div');
  renderTimeline(root, loader, { document, t, level: 'plain' });
  const short = value => new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', timeZone: ZONE });
  const toggle = allNodes(root).find(node => node.attributes?.['aria-expanded'] != null);
  assert.equal(toggle.textContent, `${short(start)} – ${short(end)}wb.endReason.manual_restartwb.timeline.count {"count":2}`);
  assert.ok(allNodes(toggle).some(node => node.title === `${new Date(start).toLocaleString(undefined, { timeZone: ZONE })} – ${new Date(end).toLocaleString(undefined, { timeZone: ZONE })}`), 'the full times stay in the tooltip');
  const event = allNodes(root).find(node => node.classList.contains('wb-timeline-event'));
  assert.equal(event.textContent, short(at) + 'wb.event.reclaim_done');
  assert.equal(allNodes(event).find(node => node.tagName === 'TIME').title, new Date(at).toLocaleString(undefined, { timeZone: ZONE }));
  assert.doesNotMatch(root.textContent, /run-0123456789abcdef|reclaim_done$|T10:30:00|manual_restart(?!wb)/);
  assert.equal(allNodes(root).find(node => node.classList.contains('wb-timeline-message')).textContent, short(at) + 'wb.timeline.received');
  renderTimeline(root, loader, { document, t, level: 'technical' });
  const technical = allNodes(root).find(node => node.attributes?.['aria-expanded'] != null);
  assert.match(technical.textContent, /^run-0123456789abcdef.*manual_restart/);
  assert.ok(allNodes(technical).some(node => node.title === `${start} – ${end}`), 'technical tooltips keep raw times');
  assert.match(root.textContent, /reclaim_done/);
  assert.equal(allNodes(allNodes(root).find(node => node.classList.contains('wb-timeline-event'))).find(node => node.tagName === 'TIME').title, at);
  assert.match(root.textContent, /wb.timeline.received/);
  assert.match(root.textContent, /wb.timeline.noEarlier/, 'all runs loaded ends the list explicitly');
});

test('message attribution projects only direction metadata and leaves gaps between runs', () => {
  const messages = [
    { id: 1, timestamp: '1970-01-01 00:00:01', direction: 'in', channel: 'telegram', content: 'SECRET' },
    { id: 2, timestamp: '1970-01-01 00:00:02', direction: 'out', channel: 'telegram', content: 'SECRET' },
    { id: 3, timestamp: '1970-01-01 00:00:03', direction: 'in', channel: 'telegram', content: 'SECRET' },
  ];
  const value = attributeMessages(messages, [run('r', 1000, 2000), run('s', 4000, 5000)]);
  assert.deepEqual(value.attributed.get('r').map(message => message.id), [1, 2]);
  assert.deepEqual(value.between.map(message => message.id), [3]);
  assert.equal(JSON.stringify([...value.attributed, value.between]).includes('SECRET'), false);
  const loader = { state: { runs: [run('r', 1000, 2000)], expanded: new Set(['r']), events: new Map(), messages: value.attributed,
    between: value.between, filter: 'messages', totalRuns: 1 }, setFilter() {}, collapse() {} };
  const document = createDocument(), root = document.createElement('div');
  renderTimeline(root, loader, { document, t });
  assert.match(root.textContent, /wb.timeline.received/); assert.match(root.textContent, /wb.timeline.replied/);
  assert.match(root.textContent, /wb.timeline.between/); assert.doesNotMatch(root.textContent, /SECRET/);
});

test('timeline aborts previous group, ignores late results and does not fetch current events without a current run', async () => {
  const late = deferred(), signals = [], calls = [];
  const loader = createTimelineLoader({ request: async (path, { signal }) => {
    calls.push(path); signals.push(signal);
    if (path.includes('/groups/a/')) return late.promise;
    if (path.includes('run_id=old')) return late.promise;
    return emptyRuns;
  } });
  const old = loader.open('a', 'old');
  await loader.open('b', null);
  assert.equal(signals[0].aborted, true);
  late.resolve({ runs: [run('late')], events: [{ event_seq: 1 }], totalEvents: 999 }); await old;
  assert.equal(loader.state.key, 'b'); assert.equal(loader.state.runs.length, 0); assert.equal(loader.state.events.size, 0);
  assert.equal(calls.some(path => path.includes('session_group=b')), false);
  loader.close();
});

test('config rejects a partial pair, preserves exact Core reasons and queries once after timeout or missing envelope', async () => {
  for (const failure of ['timeout', 'no_envelope', 'http_error']) {
    const calls = [], controller = createGroupConfig({ key: 'a', t, request: async (path, options) => {
      calls.push(options?.method ?? 'GET');
      if (!options?.method) return { runtime: { ok: true, data: { resolved: { runtime: 'codex' } } }, model: null };
      if (failure === 'timeout') throw Error('timed out');
      if (failure === 'http_error') throw Object.assign(Error('internal_error'), { body: { error: 'internal_error' } });
      return { error: 'missing_envelope' };
    } });
    await controller.save({ kind: 'model', runtime: 'codex', model: 'model' });
    assert.equal(calls.length, 0);
    await controller.save({ kind: 'model', runtime: 'codex', model: 'model', effort: 'high' });
    assert.deepEqual(calls, ['POST', 'GET']);
    assert.equal(controller.state.result, 'wb.config.resultUnknown');
  }
  const controller = createGroupConfig({ key: 'a', t, request: async () => ({ ok: false, error: { code: 'SESSION_GROUP_INVALID', message: '<text>' } }) });
  await controller.save({ kind: 'runtime', value: 'inherit' });
  assert.equal(controller.state.error, 'SESSION_GROUP_INVALID · <text>');
  assert.equal(validConfigChange({ kind: 'model', runtime: 'claude', reset: true }), true);
  assert.equal(runningText({ running: { status: 'pending' } }, 'runtime', t), 'wb.config.pending');
  assert.equal(runningText({ running: { status: 'unknown', reason: 'snapshot_unavailable' } }, 'runtime', t), 'wb.config.unknown {"reason":"snapshot_unavailable"}');
  assert.equal(runningText({ running: null, sessionMode: 'single' }, 'model', t), 'wb.config.single');
  assert.equal(runningText({ running: null, runtime: 'claude', resolved: { runtime: 'codex' } }, 'model', t), 'wb.config.otherRuntime');
});

test('name edits use DELETE for blank names and show business or HTTP body errors as text', async () => {
  const calls = [];
  await saveGroupName('a', ' ', { request: async (path, options) => { calls.push([path, options]); return { ok: true, data: { displayName: null } }; } });
  assert.equal(calls[0][1].method, 'DELETE');
  for (const body of [{ ok: false, error: { code: 'NAME_INVALID', message: 'bad <script>' } }, { error: 'invalid_json' }, { error: 'payload_too_large' }, { error: 'internal_error' }]) {
    await assert.rejects(fetchJson(async () => response(body, 400), '/name'), new RegExp(typeof body.error === 'string' ? body.error : body.error.code));
  }
  const document = createDocument(), root = document.createElement('div');
  const editor = renderNameEditor(root, { key: 'a', name: '<script>', document, t,
    request: async () => { throw Error('NAME_INVALID · <script>'); } });
  editor.save.dispatch('click'); await tick();
  assert.match(editor.error.textContent, /NAME_INVALID/); assert.equal(allNodes(root).some(node => node.tagName === 'SCRIPT'), false);
});

test('auto naming preserves supplied words, substitutes only CLI path and copies without POST', async () => {
  const path = '/tmp/fixture/.claude/skills/dashboard/scripts/group-name.js';
  const text = namePromptText(path, NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH);
  assert.equal(text.replace(path, ORIGINAL_GROUP_NAME_PATH), NAME_PROMPT);
  assert.equal(namePromptText('/tmp/$&/group-name.js', ORIGINAL_GROUP_NAME_PATH + ' · ' + ORIGINAL_GROUP_NAME_PATH, ORIGINAL_GROUP_NAME_PATH),
    '/tmp/$&/group-name.js · ' + ORIGINAL_GROUP_NAME_PATH, 'substitute exactly the first CLI path and retain literal replacement characters');
  assert.match(text, /group-name.js set <组键> "名字"/);
  const copied = [], document = createDocument(), root = document.createElement('div');
  const controls = renderAutoName(root, { text, todo: ['<script>'] }, { document, t, clipboard: { writeText: async value => copied.push(value) } });
  controls.copy.dispatch('click'); await tick();
  assert.deepEqual(copied, [text]); assert.equal(controls.prompt.readOnly, true);
  assert.equal(controls.prompt.value, text); assert.equal(controls.todo.textContent, '<script>');
  assert.equal(allNodes(root).some(node => node.tagName === 'SCRIPT'), false);
});

test('snapshot-driven detail refresh skips hidden pages, retains data on failure and recovers without a timer', async () => {
  let visible = true, failing = false, version = 1;
  const calls = [], f = detailFixture(async path => {
    calls.push(path);
    if (failing) throw Error('offline');
    return response(path.includes('types=subagent_start') ? { events: [] } : path.startsWith('/api/timeline') ? { events: [{ event_type: 'stop', timestamp: String(version) }] } : defaultRead(path));
  }, { isVisible: () => visible });
  await f.controller.open('a', { rows: [], listKnown: true });
  const count = calls.length;
  assert.equal(f.timers.length, 0, 'detail does not create an independent poll timer');
  visible = false; await f.controller.updateSnapshot({ rows: [], listKnown: true }); assert.equal(calls.length, count);
  visible = true; failing = true; await f.controller.refresh();
  assert.equal(f.controller.state.recent[0].timestamp, '1'); assert.equal(f.controller.state.error, 'offline');
  failing = false; version = 2; await f.controller.refresh();
  assert.equal(f.controller.state.recent[0].timestamp, '2'); assert.equal(f.controller.state.error, null);
  assert.equal(calls.some(path => path.includes('/config')), false);
  f.controller.destroy(); assert.equal(f.timers.length, 0);
});

test('detail cancels on group and agent changes, resets tabs and ignores old responses even when abort is ignored', async () => {
  let owner = 'one'; const late = deferred(), signals = [];
  const f = detailFixture(async (path, options) => {
    signals.push(options.signal);
    if (path.includes('session_group=a')) return late.promise;
    return response(defaultRead(path));
  }, { identity: () => owner });
  const old = f.controller.open('a', { rows: [], listKnown: true });
  f.controller.state.tab = 'timeline';
  await f.controller.open('b', { rows: [], listKnown: true });
  assert.equal(signals[0].aborted, true); assert.equal(f.controller.state.tab, 'overview');
  late.resolve(response({ events: [{ event_type: 'OLD' }] })); await old;
  assert.doesNotMatch(f.root.textContent, /OLD/);
  owner = 'two'; await f.controller.refresh();
  assert.equal(f.root.hidden, true); assert.equal(f.controller.state.row, null);
  f.controller.destroy();
});

test('every group has bound action buttons and Origin translated wake replies preserve their evidence', async () => {
  for (const key of ['origin', 'a']) assert.deepEqual(groupActionButtons(row(key)).map(item => item.action), ['interrupt', 'chop-chop', 'restart']);
  assert.equal(groupActionButtons(row('a', { live: null, presence: 'not_running' })).every(item => item.disabled), true);
  assert.equal(groupActionButtons(row('a'), false).every(item => item.reason === 'wb.readOnly'), true);
  assert.equal(groupActionText({ result: 'already_stopped', messageKey: 'result.restart_wake_requested', messageParams: { count: 1 } }, t), 'result.restart_wake_requested {"count":1}');
  assert.match(groupActionText({ result: 'stale_target', currentRunId: '<new>' }, t), /<new>/);
  const actions = [], f = detailFixture(async (path, options) => {
    if (options?.method === 'POST') { actions.push([path, JSON.parse(options.body)]); return response({ ok: true, result: 'accepted' }); }
    return response(defaultRead(path));
  }, { confirm: () => true });
  await f.controller.open(row('a'), { rows: [row('a')], listKnown: true });
  await f.controller.act('interrupt'); await f.controller.act('chop-chop'); await f.controller.act('restart');
  assert.deepEqual(actions.map(item => item[1]), Array.from({ length: 3 }, () => ({ sessionGroup: 'a', runId: 'run-a', sessionId: 'session-a' })));
  assert.equal(actions.every(item => item[0].includes('/groups/a/actions/')), true);
  f.controller.destroy();
});

test('single detail filters NULL events but sends actions through the Origin route', async () => {
  const calls = [], f = detailFixture(async (path, options) => { calls.push([path, options]); return response(defaultRead(path)); });
  const single = row(null);
  await f.controller.open(single, { rows: [single], view: 'single', listKnown: true });
  const recent = new URL(calls.find(([path]) => path.startsWith('/api/timeline') && !path.includes('run_id'))[0], 'http://fixture');
  assert.equal(recent.searchParams.get('session_group'), '');
  await f.controller.act('interrupt');
  assert.equal(calls.some(([path]) => path === '/api/workbench/groups/origin/actions/interrupt'), true);
  f.controller.destroy();
});


test('technical detail header names an unreadable launch configuration instead of hiding the model', async () => {
  const current = row('telegram:a', { launchConfig: null, target: { runtime: 'codex', model: null, reason: 'launch_config_unreadable' } });
  const f = detailFixture(async path => response(defaultRead(path)), { detail: () => 'technical' });
  await f.controller.open(current, { rows: [current], listKnown: true });
  const meta = allNodes(f.root).find(node => node.classList.contains('wb-detail-meta'));
  assert.match(meta.textContent, / · Codex · wb\.detail\.launchConfigUnreadable$/);
  assert.equal(meta.children[0].textContent, 'telegram:a'); assert.equal(meta.children[0].classList.contains('wb-mono'), true, 'the group key is monospace');
  const config = allNodes(f.root).find(node => node.classList.contains('wb-detail-config'));
  assert.match(config.textContent, /Codex · wb\.unknown/);
  f.controller.destroy();
  const readable = row('telegram:b');
  const g = detailFixture(async path => response(defaultRead(path)), { detail: () => 'technical' });
  await g.controller.open(readable, { rows: [readable], listKnown: true });
  const readableMeta = allNodes(g.root).find(node => node.classList.contains('wb-detail-meta')).textContent;
  assert.match(readableMeta, / · Claude$/); assert.doesNotMatch(readableMeta, /launchConfigUnreadable/);
  g.controller.destroy();
});

test('plain detail header names the engine and when the session started; the group key stays technical', async () => {
  const startedSec = 1000, sameDay = startedSec * 1000 + 120000, nextDay = startedSec * 1000 + 2 * 86400e3;
  const at = (options, locale) => new Date(startedSec * 1000).toLocaleString(locale, { ...options, timeZone: ZONE });
  for (const [key, now, options] of [['telegram:dm-1001', sameDay, { hour: '2-digit', minute: '2-digit' }],
    ['telegram:product-team', nextDay, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }]]) {
    const current = row(key, { createdAt: startedSec, duration: 5 });
    const f = detailFixture(async path => response(defaultRead(path)), { now: () => now });
    await f.controller.open(current, { rows: [current], listKnown: true });
    const meta = allNodes(f.root).find(node => node.classList.contains('wb-detail-meta'));
    // Today shows the time only; another day adds the date.
    assert.equal(meta.textContent, `Claude · wb.detail.startedAt ${JSON.stringify({ time: at(options) })}`);
    assert.doesNotMatch(meta.textContent, new RegExp(key + '|wb\\.platform|wb\\.detail\\.continuous'));
    f.controller.destroy();
  }
});

test('overview restores a current subagent whose start predates the five recent events', async () => {
  const current = row('a'), calls = [];
  const f = detailFixture(async path => {
    calls.push(path); const url = new URL(path, 'http://fixture');
    if (url.pathname === '/api/timeline') {
      if (url.searchParams.get('types') === 'subagent_start,subagent_stop') return response({ events: [
        { run_id: 'run-a', event_type: 'subagent_start', metadata: { agent_id: 'worker' }, event_seq: 1 },
      ] });
      return response({ events: Array.from({ length: 5 }, (_, index) => ({ run_id: 'run-a', event_type: 'post_tool_use', event_seq: 96 + index })) });
    }
    return response(defaultRead(path));
  });
  await f.controller.open(current, { rows: [current], listKnown: true });
  assert.match(f.root.textContent, /wb.detail.subagent · worker/);
  const subagentRead = new URL(calls.find(path => path.includes('types=subagent_start')), 'http://fixture');
  assert.equal(subagentRead.searchParams.get('run_id'), 'run-a');
  assert.equal(subagentRead.searchParams.get('order'), 'asc');
  assert.equal(f.controller.timeline.state.open, false);
  assert.equal(calls.length, 4);
  f.controller.destroy();
});

test('overview consumes a subagent stop followed by more than five unrelated events using an independent cursor', async () => {
  const current = row('a'), calls = [];
  let stopped = false;
  const f = detailFixture(async path => {
    calls.push(path); const url = new URL(path, 'http://fixture');
    if (url.pathname === '/api/timeline') {
      if (url.searchParams.get('types') === 'subagent_start,subagent_stop') return response({ events: [
        { run_id: 'run-a', event_type: stopped ? 'subagent_stop' : 'subagent_start', metadata: { agent_id: 'worker' }, event_seq: stopped ? 2 : 1 },
      ] });
      if (url.searchParams.has('run_id')) return response({ events: [] });
      return response({ events: Array.from({ length: 5 }, (_, index) => ({ run_id: 'run-a', event_type: 'post_tool_use', event_seq: 96 + index })) });
    }
    return response(defaultRead(path));
  });
  const snapshot = { rows: [current], listKnown: true };
  await f.controller.open(current, snapshot);
  assert.match(f.root.textContent, /wb.detail.subagent · worker/);
  await f.controller.selectTab('timeline');
  await f.controller.timeline.setFilter('tools');
  await f.controller.selectTab('overview');
  stopped = true; calls.length = 0;
  await f.controller.updateSnapshot(snapshot);
  assert.doesNotMatch(f.root.textContent, /wb.detail.subagent · worker/);
  const subagentRead = new URL(calls.find(path => path.includes('types=subagent_start')), 'http://fixture');
  assert.equal(subagentRead.searchParams.get('after_seq'), '1');
  assert.equal(f.controller.timeline.state.filter, 'tools');
  assert.equal(calls.length, 4);
  f.controller.destroy();
});

test('timeline back-to-latest tracks repeated scrolls and keeps its mounted body across updates', async () => {
  const document = createDocument(), root = document.createElement('div');
  const loader = { state: { runs: [], expanded: new Set(), events: new Map(), messages: new Map(),
    between: [], filter: 'all', totalRuns: 0 }, setFilter() {} };
  renderTimeline(root, loader, { document, t });
  const latest = allNodes(root).find(node => node.classList.contains('wb-timeline-latest'));
  root.scrollTop = 0; root.dispatch('scroll'); assert.equal(latest.hidden, true);
  root.scrollTop = 120; root.dispatch('scroll'); assert.equal(latest.hidden, false);
  root.scrollTop = 0; root.dispatch('scroll'); assert.equal(latest.hidden, true);

  const f = detailFixture(async path => response(defaultRead(path)));
  f.root.querySelector = selector => allNodes(f.root).find(node => node.classList.contains(selector.slice(1)));
  await f.controller.open('a', { rows: [], listKnown: true });
  f.controller.state.tab = 'timeline'; f.controller.setViewDetail();
  const mountedBody = f.root.querySelector('.wb-detail-timeline');
  mountedBody.scrollTop = 175;
  f.controller.setViewDetail();
  assert.equal(f.root.querySelector('.wb-detail-timeline'), mountedBody);
  assert.equal(mountedBody.scrollTop, 175);
  f.controller.destroy();
});


test('restart confirmation retains Origin wording and uses the approved immediate-restart wording for ordinary groups', async () => {
  const prompts = [];
  for (const key of ['origin', null, 'a']) {
    const current = row(key);
    const f = detailFixture(async path => response(defaultRead(path)), {
      confirm: text => { prompts.push(text); return false; },
    });
    await f.controller.open(current, { rows: [current], listKnown: true });
    await f.controller.act('restart');
    f.controller.destroy();
  }
  assert.deepEqual(prompts, ['confirm.restart', 'confirm.restart', 'wb.actions.restartConfirm']);
});


test('current message range advances with the clock while ended runs keep exact attribution bounds', async () => {
  let at = 2000;
  const calls = [], messages = [
    { id: 1, direction: 'in', channel: 'telegram', timestamp: new Date(400).toISOString(), content: 'SECRET' },
    { id: 2, direction: 'out', channel: 'telegram', timestamp: new Date(750).toISOString(), content: 'SECRET' },
    { id: 3, direction: 'in', channel: 'telegram', timestamp: new Date(2500).toISOString(), content: 'SECRET' },
  ];
  const request = async path => {
    const url = new URL(path, 'http://fixture'); calls.push(url);
    if (url.pathname.endsWith('/runs')) return { runs: [run('current', 1000, 1100), run('ended', 100, 500)], totalRuns: 2, totalEvents: 4 };
    if (url.pathname.endsWith('/messages')) return { messages: messages.filter(message => Date.parse(message.timestamp) <= Date.parse(url.searchParams.get('until'))) };
    return { events: [] };
  };
  const loader = createTimelineLoader({ request, now: () => at });
  await loader.open('a', 'current');
  assert.equal(loader.state.messages.get('current').length, 0);
  at = 3000; await loader.refresh();
  assert.equal(calls.filter(url => url.pathname.endsWith('/messages')).at(-1).searchParams.get('until'), new Date(3000).toISOString());
  assert.deepEqual(loader.state.messages.get('current').map(message => message.id), [3]);
  assert.deepEqual(loader.state.messages.get('ended').map(message => message.id), [1]);
  assert.deepEqual(loader.state.between.map(message => message.id), [2]);
  assert.equal(JSON.stringify([...loader.state.messages, loader.state.between]).includes('SECRET'), false);
  assert.equal(loader.state.runs[0].endAt, new Date(1100).toISOString(), 'do not rewrite recorded run metadata');
  loader.close();
  calls.length = 0;
  await loader.open('a', null); await loader.refresh();
  assert.equal(calls.filter(url => url.pathname.endsWith('/messages')).every(url => url.searchParams.get('until') === new Date(1100).toISOString()), true);
  assert.equal(calls.some(url => url.pathname === '/api/timeline'), false, 'ended-only groups do not fetch current events');
  loader.close();
});


test('stopped Origin and single keep restart available with bound scope while ordinary groups do not', async () => {
  const sent = [];
  for (const key of ['origin', null]) {
    const current = row(key, { presence: 'not_running', live: null });
    const buttons = groupActionButtons(current);
    assert.equal(buttons.find(button => button.action === 'restart').disabled, false);
    assert.equal(buttons.filter(button => button.action !== 'restart').every(button => button.disabled), true);
    assert.equal(groupActionButtons(current, false).every(button => button.disabled), true);
    const f = detailFixture(async (path, options) => {
      if (options?.method === 'POST') { sent.push(JSON.parse(options.body)); return response({ result: 'accepted' }); }
      return response(defaultRead(path));
    }, { confirm: () => true });
    await f.controller.open(current, { rows: [current], listKnown: true });
    await f.controller.act('restart'); f.controller.destroy();
  }
  assert.equal(sent.length, 2);
  assert.equal(sent[0].sessionGroup, 'origin');
  assert.equal(sent[1].sessionGroup, null);
  assert.equal(groupActionButtons(row('a', { presence: 'not_running', live: null })).every(button => button.disabled), true);
});

test('group action successes are translated, known non-submission keeps its reason and start time is formatted', () => {
  assert.equal(groupActionText({ result: 'accepted' }, t), 'wb.actions.accepted');
  assert.equal(groupActionText({ steps: [{ submission: 'submitted' }, { submission: 'submitted' }] }, t),
    '1: wb.actions.submitted · 2: wb.actions.submitted');
  assert.equal(groupActionText({ submission: 'not_submitted', reason: 'zylos_dir_mismatch', unknown: true }, t),
    'wb.actions.notSubmitted · zylos_dir_mismatch');
  assert.equal(groupActionText({ submission: 'not_submitted', error: { code: 'INSTANCE_ROOT_MISMATCH', message: 'different instance' } }, t),
    'wb.actions.notSubmitted · INSTANCE_ROOT_MISMATCH · different instance');
  assert.equal(formatStartedAt(1000, 'en'), new Date(1000000).toLocaleString('en', { timeZone: ZONE }));
  assert.notEqual(formatStartedAt(1000, 'en'), '1000');
  assert.equal(formatStartedAt(null, 'en'), null);
});

test('snapshot rounds stay bounded with 5000 history events and append only one current page without overlap', async () => {
  const events = Array.from({ length: 5000 }, (_, index) => ({ run_id: 'run-a', event_seq: index + 1, event_type: 'post_tool_use' }));
  const current = row('a'), calls = [];
  let holdRecent = null;
  const f = detailFixture(async path => {
    calls.push(path); const url = new URL(path, 'http://fixture');
    if (url.pathname === '/api/timeline') {
      if (url.searchParams.get('types') === 'subagent_start,subagent_stop') return response({ events: [] });
      if (!url.searchParams.has('run_id')) {
        if (holdRecent) return holdRecent.promise;
        return response({ events: [] });
      }
      const after = Number(url.searchParams.get('after_seq') ?? 0);
      return response({ events: events.slice(after, after + 1000) });
    }
    if (url.pathname.endsWith('/runs')) return response({ runs: [run('run-a')], totalEvents: events.length, totalRuns: 1, unattributed: 0 });
    if (url.pathname.endsWith('/messages')) return response({ messages: [] });
    return response(defaultRead(path));
  });
  const snapshot = { rows: [current], listKnown: true };
  await f.controller.open(current, snapshot);
  assert.equal(calls.length, 4);
  assert.equal(calls.some(path => path.includes('run_id=') && !path.includes('types=subagent_start')), false);
  calls.length = 0; await f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 4, 'overview round is independent of current event history');
  calls.length = 0; await f.controller.selectTab('timeline');
  assert.equal(f.controller.timeline.state.events.get('run-a').length, 5000);
  assert.equal(calls.filter(path => path.includes('run_id=')).length, 6, 'initial explicit opening paginates the entire run');
  events.push(...Array.from({ length: 1500 }, (_, index) => ({ run_id: 'run-a', event_seq: 5001 + index, event_type: 'post_tool_use' })));
  calls.length = 0;
  holdRecent = deferred();
  const one = f.controller.updateSnapshot(snapshot), two = f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 4, 'concurrent board updates share the same bounded refresh');
  holdRecent.resolve(response({ events: [] })); holdRecent = null;
  await Promise.all([one, two]);
  assert.equal(calls.length, 6, 'timeline round adds one event page and one metadata-only message read');
  assert.equal(f.controller.timeline.state.events.get('run-a').length, 6000);
  const eventRead = new URL(calls.find(path => path.includes('run_id=') && !path.includes('types=subagent_start')), 'http://fixture');
  assert.equal(eventRead.searchParams.get('after_seq'), '5000');
  calls.length = 0; await f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 6);
  assert.equal(f.controller.timeline.state.events.get('run-a').length, 6500);
  assert.equal(new URL(calls.find(path => path.includes('run_id=') && !path.includes('types=subagent_start')), 'http://fixture').searchParams.get('after_seq'), '6000');
  await f.controller.selectTab('overview');
  calls.length = 0; await f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 4);
  assert.equal(calls.some(path => path.includes('run_id=') && !path.includes('types=subagent_start')), false, 'overview never refreshes hidden full-current history');
  f.controller.destroy();
});

test('subagent initial read paginates its typed stream and later snapshots consume only one page', async () => {
  const stream = Array.from({ length: 1001 }, (_, index) => ({ run_id: 'run-a', event_seq: index + 1,
    event_type: index === 1000 ? 'subagent_stop' : 'subagent_start', metadata: { agent_id: 'worker' } }));
  const current = row('a'), calls = [];
  const f = detailFixture(async path => {
    const url = new URL(path, 'http://fixture');
    if (url.searchParams.get('types') === 'subagent_start,subagent_stop') {
      calls.push(url);
      const after = Number(url.searchParams.get('after_seq') ?? 0);
      return response({ events: stream.slice(after, after + 1000) });
    }
    return response(defaultRead(path));
  });
  const snapshot = { rows: [current], listKnown: true };
  await f.controller.open(current, snapshot);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].searchParams.get('after_seq'), '1000');
  assert.doesNotMatch(f.root.textContent, /wb.detail.subagent · worker/);
  stream.push(...Array.from({ length: 1500 }, (_, index) => ({ run_id: 'run-a', event_seq: 1002 + index,
    event_type: 'subagent_start', metadata: { agent_id: 'worker' } })));
  calls.length = 0; await f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('after_seq'), '1001');
  calls.length = 0; await f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('after_seq'), '2001');
  f.controller.destroy();
});

// The filter-race cases below read in technical detail, where the unfiltered view asks for every event type
// (no types parameter), so a read without types is the old unfiltered array.
test('filter reload excludes refresh append until the new filtered array is authoritative', async () => {
  const oldPage = deferred(), toolsPage = deferred(), calls = [];
  let phase = 'initial';
  const loader = createTimelineLoader({ detail: () => 'technical', request: async path => {
    const url = new URL(path, 'http://fixture'); calls.push(url);
    if (url.pathname.endsWith('/runs')) return { runs: [run('r')], totalRuns: 1, totalEvents: 4 };
    if (url.pathname.endsWith('/messages')) return { messages: [] };
    if (phase === 'initial') return { events: [{ run_id: 'r', event_seq: 1, event_type: 'pre_tool_use' },
      { run_id: 'r', event_seq: 2, event_type: 'stop' }] };
    if (phase === 'racing') return url.searchParams.has('types') ? toolsPage.promise : oldPage.promise;
    return { events: [{ run_id: 'r', event_seq: 4, event_type: 'post_tool_use' }] };
  } });
  await loader.open('a', 'r');
  phase = 'racing';
  const oldRefresh = loader.refresh();
  const filterReload = loader.setFilter('tools');
  oldPage.resolve({ events: [{ run_id: 'r', event_seq: 3, event_type: 'stop' }] });
  await oldRefresh;
  assert.equal(loader.state.loading, true, 'finishing the old refresh cannot unlock a pending filter reload');
  const count = calls.length;
  await loader.refresh();
  assert.equal(calls.length, count, 'a second snapshot cannot append an old array while the new filter is loading');
  toolsPage.resolve({ events: [{ run_id: 'r', event_seq: 1, event_type: 'pre_tool_use' }] });
  await filterReload;
  phase = 'ready';
  await loader.refresh();
  assert.equal(loader.state.events.get('r').length, 2);
  assert.equal(loader.state.events.get('r').every(event => ['pre_tool_use', 'post_tool_use', 'post_tool_failure'].includes(event.event_type)), true);
  assert.equal(loader.state.loading, false);
  loader.close();
});

test('an active timeline discards the previous run and reads the replacement run after a board snapshot changes', async () => {
  let current = row('a');
  const calls = [], signals = [];
  const f = detailFixture(async (path, options) => {
    calls.push(path); const url = new URL(path, 'http://fixture');
    if (url.pathname.endsWith('/runs')) return response({ runs: [run(current.live.runId)], totalRuns: 1, totalEvents: 1 });
    if (url.pathname === '/api/timeline' && url.searchParams.has('run_id')) {
      signals.push(options.signal);
      if (url.searchParams.has('types')) return response({ events: [] });
      return response({ events: [{ run_id: url.searchParams.get('run_id'), event_seq: 1,
        event_type: url.searchParams.get('run_id') === 'run-a' ? 'old_run_event' : 'new_run_event' }] });
    }
    return response(defaultRead(path));
  }, { detail: 'technical' });
  await f.controller.open(current, { rows: [current], listKnown: true });
  await f.controller.selectTab('timeline');
  assert.match(f.root.textContent, /old_run_event/);
  const oldSignals = [...signals]; calls.length = 0;
  current = row('a', { live: { runId: 'run-b', sessionId: 'session-b' } });
  await f.controller.updateSnapshot({ rows: [current], listKnown: true });
  assert.equal(oldSignals.every(signal => signal.aborted), true);
  assert.equal(f.controller.timeline.state.currentRunId, 'run-b');
  assert.equal(f.controller.timeline.state.events.has('run-a'), false);
  assert.equal(f.controller.timeline.state.events.get('run-b').length, 1);
  assert.match(f.root.textContent, /new_run_event/);
  assert.doesNotMatch(f.root.textContent, /old_run_event/);
  assert.equal(calls.filter(path => path.includes('run_id=')).every(path => path.includes('run_id=run-b')), true);
  f.controller.destroy();
});


test('failed initial subagent pagination resumes at one page per later snapshot', async () => {
  const stream = Array.from({ length: 2500 }, (_, index) => ({ run_id: 'run-a', event_seq: index + 1,
    event_type: 'subagent_start', metadata: { agent_id: 'worker' } }));
  const current = row('a'), calls = [];
  let fail = true;
  const f = detailFixture(async path => {
    const url = new URL(path, 'http://fixture');
    if (url.searchParams.get('types') === 'subagent_start,subagent_stop') {
      calls.push(url);
      const after = Number(url.searchParams.get('after_seq') ?? 0);
      if (fail && after === 1000) throw new Error('offline');
      return response({ events: stream.slice(after, after + 1000) });
    }
    return response(defaultRead(path));
  });
  const snapshot = { rows: [current], listKnown: true };
  await f.controller.open(current, snapshot);
  assert.equal(calls.length, 2);
  assert.equal(f.controller.state.error, 'offline');
  fail = false; calls.length = 0;
  await f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('after_seq'), '1000');
  calls.length = 0; await f.controller.updateSnapshot(snapshot);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searchParams.get('after_seq'), '2000');
  f.controller.destroy();
});

test('a failed first current-run read recovers from zero in bounded incremental pages', async () => {
  const events = Array.from({ length: 1001 }, (_, index) => ({ run_id: 'r', event_seq: index + 1, event_type: 'post_tool_use' }));
  const reads = [];
  let failFirst = true;
  const loader = createTimelineLoader({ request: async path => {
    const url = new URL(path, 'http://fixture');
    if (url.pathname.endsWith('/runs')) return { runs: [run('r')], totalRuns: 1, totalEvents: events.length };
    if (url.pathname.endsWith('/messages')) return { messages: [] };
    reads.push(url);
    if (failFirst) { failFirst = false; throw new Error('first_read_offline'); }
    const after = Number(url.searchParams.get('after_seq') ?? 0);
    return { events: events.slice(after, after + 1000) };
  } });
  await loader.open('a', 'r'); await tick();
  assert.equal(loader.state.error, 'first_read_offline');
  assert.equal(loader.state.events.has('r'), false);
  reads.length = 0; await loader.refresh();
  assert.equal(reads.length, 1, 'recovery reads a single event page');
  assert.equal(reads[0].searchParams.get('after_seq'), '0');
  assert.equal(loader.state.events.get('r').length, 1000);
  assert.equal(loader.state.error, null);
  reads.length = 0; await loader.refresh();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].searchParams.get('after_seq'), '1000');
  assert.equal(loader.state.events.get('r').length, 1001);
  loader.close();
});

test('a failed tools reload discards the old unfiltered array and recovers only tools from zero', async () => {
  const all = Array.from({ length: 10 }, (_, index) => ({ run_id: 'r', event_seq: index + 1,
    event_type: index % 2 ? 'stop' : 'post_tool_use' }));
  const tools = all.filter(event => event.event_type === 'post_tool_use'), reads = [];
  let failReload = true;
  const loader = createTimelineLoader({ detail: () => 'technical', request: async path => {
    const url = new URL(path, 'http://fixture');
    if (url.pathname.endsWith('/runs')) return { runs: [run('r'), run('old', -1000, 0)], totalRuns: 2, totalEvents: all.length * 2 };
    if (url.pathname.endsWith('/messages')) return { messages: [] };
    reads.push(url);
    if (!url.searchParams.has('types')) return { events: all.map(event => ({ ...event, run_id: url.searchParams.get('run_id') })) };
    if (failReload) { failReload = false; throw new Error('tools_read_offline'); }
    const after = Number(url.searchParams.get('after_seq') ?? 0);
    return { events: tools.filter(event => event.event_seq > after).map(event => ({ ...event, run_id: url.searchParams.get('run_id') })) };
  } });
  await loader.open('a', 'r');
  assert.equal(loader.state.events.get('r').some(event => event.event_type === 'stop'), true);
  await loader.expand('old'); loader.collapse('old');
  assert.equal(loader.state.events.get('old').some(event => event.event_type === 'stop'), true);
  await loader.setFilter('tools');
  assert.equal(loader.state.error, 'tools_read_offline');
  assert.equal(loader.state.events.has('r'), false, 'old unfiltered events cannot remain under the new tools filter');
  assert.equal(loader.state.events.has('old'), false, 'collapsed cached runs also discard the previous filter');
  reads.length = 0; await loader.refresh();
  assert.equal(reads.length, 1);
  assert.equal(reads[0].searchParams.get('after_seq'), '0');
  assert.equal(reads[0].searchParams.get('types'), 'pre_tool_use,post_tool_use,post_tool_failure');
  assert.equal(loader.state.events.get('r').length, tools.length);
  assert.equal(loader.state.events.get('r').every(event => event.event_type === 'post_tool_use'), true);
  assert.equal(loader.state.error, null);
  await loader.expand('old');
  assert.equal(loader.state.events.get('old').length, tools.length);
  assert.equal(loader.state.events.get('old').every(event => event.event_type === 'post_tool_use'), true);
  loader.close();
});

test('a completed tools reload rejects an older all-events append that arrives afterward', async () => {
  const oldAppend = deferred();
  let phase = 'initial';
  const loader = createTimelineLoader({ detail: () => 'technical', request: async path => {
    const url = new URL(path, 'http://fixture');
    if (url.pathname.endsWith('/runs')) return { runs: [run('r')], totalRuns: 1, totalEvents: 3 };
    if (url.pathname.endsWith('/messages')) return { messages: [] };
    if (url.searchParams.has('types')) return { events: [{ run_id: 'r', event_seq: 1, event_type: 'pre_tool_use' }] };
    if (phase === 'initial') return { events: [{ run_id: 'r', event_seq: 1, event_type: 'pre_tool_use' },
      { run_id: 'r', event_seq: 2, event_type: 'stop' }] };
    return oldAppend.promise;
  } });
  await loader.open('a', 'r');
  phase = 'racing';
  const oldRefresh = loader.refresh();
  await loader.setFilter('tools');
  assert.equal(loader.state.events.get('r').length, 1, 'the tools reload completes before the older append');
  assert.equal(loader.state.loading, true, 'the old append is still pending');
  oldAppend.resolve({ events: [{ run_id: 'r', event_seq: 3, event_type: 'stop' }] });
  await oldRefresh;
  assert.equal(loader.state.filter, 'tools');
  assert.equal(loader.state.events.get('r').length, 1);
  assert.equal(loader.state.events.get('r').every(event => event.event_type === 'pre_tool_use'), true);
  assert.equal(loader.state.loading, false);
  loader.close();
});

test('a stale aborted refresh cannot report a read failure on the replacement run', async () => {
  const staleSubagents = deferred();
  let current = row('a'), holdOld = false;
  const f = detailFixture(async path => {
    const url = new URL(path, 'http://fixture');
    if (url.pathname.endsWith('/runs')) return response({ runs: [run(current.live.runId)], totalRuns: 1, totalEvents: 1 });
    if (url.searchParams.get('types') === 'subagent_start,subagent_stop') {
      if (holdOld && url.searchParams.get('run_id') === 'run-a') return staleSubagents.promise;
      return response({ events: [] });
    }
    return response(defaultRead(path));
  });
  await f.controller.open(current, { rows: [current], listKnown: true });
  holdOld = true;
  const oldRefresh = f.controller.refresh();
  current = row('a', { live: { runId: 'run-b', sessionId: 'session-b' } });
  const switched = f.controller.updateSnapshot({ rows: [current], listKnown: true });
  staleSubagents.reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
  await Promise.all([oldRefresh, switched]);
  assert.equal(f.controller.state.row.live.runId, 'run-b');
  assert.equal(f.controller.state.error, null, 'the stale run refresh does not attach its aborted error to the new run');
  assert.doesNotMatch(f.root.textContent, /This operation was aborted|wb.readFailed/);
  await f.controller.updateSnapshot({ rows: [current], listKnown: true });
  assert.equal(f.controller.state.error, null);
  f.controller.destroy();
});


test('switching runs aborts a hanging subagent read so the shared refresh can finish', { timeout: 2000 }, async () => {
  let current = row('a'), holdOld = false, oldSignal, releaseOld;
  const f = detailFixture(async (path, options) => {
    const url = new URL(path, 'http://fixture');
    if (url.searchParams.get('types') === 'subagent_start,subagent_stop' && holdOld &&
        url.searchParams.get('run_id') === 'run-a') {
      oldSignal = options.signal;
      return new Promise((resolve, reject) => {
        releaseOld = resolve;
        oldSignal.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'),
          { name: 'AbortError' })), { once: true });
      });
    }
    if (url.pathname.endsWith('/runs')) return response({ runs: [run(current.live.runId)], totalRuns: 1, totalEvents: 0 });
    return response(defaultRead(path));
  });
  let pending, switching;
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    holdOld = true;
    pending = f.controller.refresh();
    assert.ok(oldSignal, 'the old run read is hanging without any server response');
    current = row('a', { live: { runId: 'run-b', sessionId: 'session-b' } });
    switching = f.controller.updateSnapshot({ rows: [current], listKnown: true });
    assert.equal(oldSignal.aborted, true, 'run selection immediately cancels the old transport');
    await Promise.all([pending, switching]);
    assert.equal(f.controller.state.row.live.runId, 'run-b');
    assert.equal(f.controller.state.error, null);
    assert.doesNotMatch(f.root.textContent, /This operation was aborted|wb.readFailed/);
    // Both refresh promises completed while the old server response remained
    // unresolved; cancellation alone must release the shared refresh.
  } finally {
    releaseOld?.(response({ events: [] }));
    f.controller.destroy();
    await Promise.allSettled([pending, switching].filter(Boolean));
  }
});

test('detail header gives the title its own row and keeps state and actions together for the second row', async () => {
  const f = detailFixture(async path => response(defaultRead(path)));
  await f.controller.open(row('a'), { rows: [], listKnown: true });
  const top = allNodes(f.root).find(node => node.classList.contains('wb-d-top'));
  assert.deepEqual(top.children.map(child => child.className.split(' ')[0]), ['wb-ch', 'wb-d-title-wrap', 'wb-d-sub', 'wb-icon-btn']);
  assert.equal(top.children.at(-1).attributes['aria-label'], 'wb.close', 'closing stays on the title row');
  const sub = top.children[2];
  assert.ok(sub.children[0].classList.contains('wb-pill'), 'the state comes first in the second row');
  assert.ok(sub.children[1].classList.contains('wb-d-acts'), 'the actions follow the state');
  assert.deepEqual(allNodes(sub.children[1]).filter(node => node.dataset?.wbAction).map(node => node.dataset.wbAction), ['interrupt', 'chop-chop', 'restart']);
  f.controller.destroy();
});

test('detail header uses icon actions whose tooltip carries any unavailable reason, and Esc leaves the name editor first', async () => {
  const f = detailFixture(async path => response(defaultRead(path)));
  await f.controller.open({ ...row('a'), live: null, presence: 'not_running' }, { rows: [], listKnown: true });
  const actions = allNodes(f.root).filter(node => node.dataset?.wbAction);
  assert.deepEqual(actions.map(node => node.dataset.wbAction), ['interrupt', 'chop-chop', 'restart']);
  assert.equal(actions[0].disabled, true);
  assert.equal(actions[0].title, 'wb.actions.interrupt · wb.actions.targetRequired');
  // The only text is the action name, which CSS shows on narrow screens; reasons stay in the tooltip.
  assert.deepEqual(actions.map(node => node.textContent), ['wb.actions.interrupt', 'wb.actions.chop-chop', 'wb.actions.restart']);
  assert.equal(allNodes(f.root).some(node => node.classList.contains('wb-action-reason')), false);
  f.controller.state.nameOpen = true; f.controller.setViewDetail();
  assert.equal(f.controller.escape(), true); assert.equal(f.controller.state.nameOpen, false); assert.equal(f.root.hidden, false);
  assert.equal(f.controller.escape(), true); assert.equal(f.root.hidden, true);
  assert.equal(f.controller.escape(), false, 'a closed drawer ignores Esc');
  f.controller.destroy();
});

test('timeline chips combine filters: one chip uses the server filter, several filter loaded events by kind', async () => {
  const loader = createTimelineLoader({ request: async path => {
    const url = new URL(path, 'http://fixture');
    if (url.pathname.endsWith('/runs')) return { runs: [run('cur', 1000, 9000)], totalEvents: 3, totalRuns: 1 };
    if (url.pathname.endsWith('/messages')) return { messages: [{ id: 1, direction: 'in', timestamp: new Date(2000).toISOString() }] };
    return { events: [{ event_seq: 1, event_type: 'session_start', timestamp: new Date(1500).toISOString() },
      { event_seq: 2, event_type: 'pre_tool_use', timestamp: new Date(3000).toISOString() }] };
  } });
  await loader.open('a', 'cur');
  const document = createDocument(), root = document.createElement('div');
  // Technical rows keep the readable label and add the recorded code after it.
  const code = node => allNodes(node).find(child => child.classList?.contains('wb-ev-code'))?.textContent ?? '';
  const labels = () => allNodes(root).filter(node => node.classList.contains('wb-ev-t')).map(node => [node.textContent.slice(0, node.textContent.length - code(node).length), code(node)].filter(Boolean).join(' | '));
  renderTimeline(root, loader, { document, t, level: 'technical' });
  assert.deepEqual(labels(), ['wb.event.pre_tool_use | pre_tool_use', 'wb.timeline.received', 'wb.event.session_start | session_start'], 'events and messages interleave by time, newest first');
  await loader.setChips(['messages', 'lifecycle']);
  assert.equal(loader.state.filter, 'all');
  renderTimeline(root, loader, { document, t, level: 'technical' });
  assert.deepEqual(labels(), ['wb.timeline.received', 'wb.event.session_start | session_start']);
  await loader.setChips(['tools']);
  assert.equal(loader.state.filter, 'tools');
  renderTimeline(root, loader, { document, t, level: 'technical' });
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-chip')).map(node => node.attributes['aria-pressed']).join(), 'false,true,false');
  loader.close();
});

test('the observer tab remains available while Origin sleeps and keeps its workbench hint', async () => {
  // The lock only targets the observer tab; drawer actions carry data-wb-action and their own availability.
  assert.equal(OBSERVER_ACCESS_SELECTOR, '#observer-tab');
  const f = detailFixture(async path => response(defaultRead(path)));
  await f.controller.open(row('telegram:a', { state: { kind: 'idle' } }), { rows: [], listKnown: true });
  const drawer = allNodes(f.root).filter(node => node.dataset?.wbAction);
  assert.deepEqual(drawer.map(node => node.dataset.wbAction).sort(), ['chop-chop', 'interrupt', 'restart']);
  for (const node of allNodes(f.root)) assert.notEqual(node.id, 'observer-tab');
  const button = (fields = {}) => Object.assign(f.document.createElement('button'), { closest: () => null }, fields);
  const observer = button({ id: 'observer-tab', title: 'wb.observerInstall' }); observer.dataset.wbHint = 'wb.observerInstall';
  const inDisabledModal = button({ id: 'observer-tab', closest: selector => selector === '.modal-body-disabled' ? {} : null });
  lockObserverButtons([observer, inDisabledModal], { unavailable: true, readOnly: false, reason: 'action.origin_not_running' });
  assert.deepEqual([observer.disabled, inDisabledModal.disabled], [false, true]);
  assert.equal(observer.title, 'wb.observerInstall');
  lockObserverButtons([observer, inDisabledModal], { unavailable: false, readOnly: false, reason: 'action.origin_not_running' });
  assert.deepEqual([observer.disabled, inDisabledModal.disabled], [false, true]);
  assert.equal(observer.title, 'wb.observerInstall', 'the same install hint remains when Origin runs');
  assert.equal(inDisabledModal.title, '');
  lockObserverButtons([observer], { unavailable: false, readOnly: true, reason: 'action.origin_not_running' });
  assert.equal(observer.disabled, true, 'a read-only remote keeps it locked');
});

test('evidence marks the sample its headline came from and says how long ago each was read', () => {
  const snapshot = { readAt: 95000, instance: { runtimeHealth: { claude: { health: 'rate_limited', updatedAt: 40000 } } }, sources: { status: { ok: true, readAt: 99000 } } };
  const waiting = row('telegram:a', { wait: { kind: 'rate_wait', runtime: 'claude' } });
  const { headline, samples } = detailEvidence(waiting, snapshot);
  assert.equal(headline, 'claude · rate_limited');
  assert.deepEqual(samples.filter(item => item.hit).map(item => item.source), ['claude health']);
  const fenced = detailEvidence(row('telegram:a', { wait: { kind: 'fenced', reasonCode: 'ok' } }), snapshot);
  assert.deepEqual(fenced.samples.filter(item => item.hit).map(item => item.source), ['status'], 'otherwise the sample with the headline value');
  const now = 1_700_000_100_000;
  assert.equal(sampleAge(now - 1000, now, t), 'wb.detail.agoSeconds {"n":1}');
  assert.equal(sampleAge(new Date(now - 60000).toISOString(), now, t), 'wb.detail.ago {"span":"1m00s"}');
  assert.equal(sampleAge(null, now, t), '');
});

test('tool events name the tool: plain action words, or the tool name with its monospace argument', () => {
  const document = createDocument();
  const event = { event_type: 'pre_tool_use', metadata: { tool_name: 'Bash', tool_detail: 'npm test' } };
  assert.equal(toolEventLabel(document, event, { t }).textContent, 'wb.tool.Bash');
  assert.equal(toolEventLabel(document, { ...event, event_type: 'post_tool_failure' }, { t }).textContent, 'wb.tool.Bash · wb.event.toolFailed');
  const technical = toolEventLabel(document, event, { t, level: 'technical' });
  assert.equal(technical.children[0].textContent, 'Bash'); assert.equal(technical.children[1].textContent, 'npm test');
  assert.equal(technical.children[1].classList.contains('wb-mono'), true); assert.equal(technical.title, 'pre_tool_use');
  assert.equal(toolEventLabel(document, { event_type: 'pre_tool_use' }, { t }), null, 'without a tool name the generic label stays');
  assert.equal(toolEventLabel(document, { event_type: 'stop', metadata: { tool_name: 'Bash' } }, { t }), null);
});

test('the configuration line says whether it is applied and where it comes from', () => {
  const running = row('telegram:a', { launchConfig: { runtime: 'claude', mode: 'override', model: 'opus', effort: 'high' },
    desired: { runtime: 'claude', mode: 'override', model: 'opus', effort: 'high' } });
  assert.equal(configStatus(running), 'applied');
  assert.equal(configText(running, 'plain', t), 'Claude · opus · wb.term.effort high');
  assert.equal(configText(running, 'technical', t), 'Claude · opus · high');
  assert.equal(configStatus({ ...running, desired: { ...running.desired, effort: 'xhigh' } }), 'pending');
  assert.equal(configStatus({ ...running, presence: 'not_running', launchConfig: null }), 'not_running');
  const document = createDocument(), root = document.createElement('div');
  renderOverview(root, running, {}, { document, t });
  const line = allNodes(root).find(node => node.classList.contains('wb-cfg-line'));
  assert.match(line.textContent, /wb\.config\.state\.applied/); assert.match(line.textContent, /wb\.config\.source\.override/);
});

test('a group on the default settings starts from nothing chosen, never the machine\'s model', async () => {
  const meta = { current_model: 'fable[1m]', current_effort: 'low', models: [{ id: 'fable[1m]' }, { id: 'opus' }, { id: 'sonnet' }], efforts_by_model: { '*': ['low', 'medium', 'high'] } };
  const open = async model => {
    const requests = [];
    const controller = createGroupConfig({ key: 'a', t, request: async (path, options) => { requests.push([path, options?.method ?? 'GET', options?.body]);
      if (path.startsWith('/api/actions/meta')) return meta;
      if (options?.method) return { ok: true, data: { running: { status: 'pending' } } };
      return { runtime: { ok: true, data: { desired: { mode: 'inherit' }, resolved: { runtime: 'claude' } } }, model: { ok: true, data: model } }; } });
    await controller.load(); await controller.loadMeta('claude');
    const document = createDocument(), root = document.createElement('div');
    renderGroupConfig(root, controller, { document, t });
    const [, select, effort, save] = allNodes(root).find(node => node.classList.contains('wb-cfg-controls')).children;
    return { select, effort, save, requests };
  };
  // Core reports a default-settings launch as { runtime, mode: 'default' } with no model or effort.
  const running = await open({ runtime: 'claude', desired: { runtime: 'claude', mode: 'default' },
    running: { status: 'applied', launchConfig: { runtime: 'claude', mode: 'default' } }, resolved: { runtime: 'claude', mode: 'default' } });
  assert.deepEqual([running.select.value, running.effort.value, running.save.disabled], ['', '', true], 'a running default group has no pair of its own to preselect');
  const idle = await open({ runtime: 'claude', desired: { runtime: 'claude', mode: 'default' }, running: { status: 'not_running', launchConfig: null }, resolved: { runtime: 'claude', mode: 'default' } });
  assert.equal(idle.select.children[0].value, ''); assert.equal(idle.select.children[0].textContent, 'wb.config.pickModel');
  assert.deepEqual([idle.select.value, idle.effort.value], ['', ''], 'nothing is preselected from the machine-wide model');
  assert.equal(idle.save.disabled, true, 'saving needs a chosen pair');
  idle.select.value = 'opus'; idle.select.dispatch('change');
  assert.equal(idle.save.disabled, true, 'a model alone is not enough');
  idle.effort.value = 'high'; idle.effort.dispatch('change');
  assert.equal(idle.save.disabled, false);
  idle.save.dispatch('click'); await tick();
  assert.deepEqual(JSON.parse(idle.requests.at(-1)[2]), { kind: 'model', runtime: 'claude', model: 'opus', effort: 'high' });
  assert.deepEqual(startingPair({ model: { data: { desired: { runtime: 'codex', mode: 'override', model: 'gpt', effort: 'high' } } } }, 'claude'), { model: '', effort: '' },
    'another engine\'s pair is not reused');
});

test('the configuration editor offers engine, model and effort as dropdowns with save and cancel, and keeps the engine switch and reset', async () => {
  const requests = [];
  const meta = { models: [{ id: 'opus', display_name: 'Opus' }, { id: 'sonnet' }], efforts_by_model: { opus: ['low', 'high', 'xhigh'], '*': ['low', 'medium', 'high'] } };
  const controller = createGroupConfig({ key: 'a', t, request: async (path, options) => { requests.push([path, options?.method ?? 'GET']);
    if (path.startsWith('/api/actions/meta')) return meta;
    if (options?.method) return { ok: true, data: { running: { status: 'pending' } } };
    return { runtime: { ok: true, data: { desired: { runtime: 'inherit' }, resolved: { runtime: 'claude' } } }, model: { ok: true, data: { desired: { runtime: 'claude', mode: 'override', model: 'opus', effort: 'high' } } } }; } });
  await controller.load(); await controller.loadMeta('claude'); await controller.loadMeta('claude');
  assert.equal(requests.filter(([path]) => path.startsWith('/api/actions/meta')).length, 1, 'the catalog is read once per engine');
  const document = createDocument(), root = document.createElement('div'); let cancelled = 0;
  renderGroupConfig(root, controller, { document, t, onCancel: () => cancelled++ });
  const pair = allNodes(root).find(node => node.classList.contains('wb-cfg-controls'));
  assert.deepEqual(pair.children.map(node => node.tagName), ['SELECT', 'SELECT', 'SELECT', 'BUTTON', 'BUTTON']);
  const [, model, effort, save, cancel] = pair.children;
  assert.deepEqual(model.children.map(node => node.value), ['', 'opus', 'sonnet']); assert.equal(model.value, 'opus', 'the group\'s own pair is preselected');
  assert.deepEqual(effort.children.map(node => node.value), ['', 'low', 'high', 'xhigh']); assert.equal(effort.value, 'high');
  assert.equal(save.disabled, false);
  model.value = 'sonnet'; model.dispatch('change');
  assert.deepEqual(effort.children.map(node => node.value), ['', 'low', 'medium', 'high'], 'efforts follow the chosen model');
  assert.equal(effort.value, 'high', 'an effort the new model also offers is kept');
  cancel.dispatch('click'); assert.equal(cancelled, 1);
  save.dispatch('click'); await tick();
  assert.deepEqual(requests.at(-1), ['/api/workbench/groups/a/config', 'POST']);
  const more = allNodes(root).find(node => node.classList.contains('wb-cfg-more'));
  assert.match(more.textContent, /wb\.config\.saveRuntime/); assert.match(more.textContent, /wb\.config\.resetModel/);
  assert.deepEqual(modelChoices(meta, 'custom-model').map(item => item.value), ['custom-model', 'opus', 'sonnet'], 'a saved model missing from the catalog stays selectable');
  assert.deepEqual(effortChoices(null, 'x', 'max'), ['low', 'medium', 'high', 'max']);
  assert.equal(modelChoices(null, 'x'), null, 'without a catalog the model is typed');
});

// Navigation is a callback only: no chat write or runtime action is launched.
test('group details expose conversation navigation for real groups and omit origin', async () => {
  const selected = [];
  const f = detailFixture(async path => response(defaultRead(path)), { onConversation: value => selected.push(value) });
  const current = row('dash-owned:example');
  await f.controller.open(current, { rows: [current], listKnown: true });
  const button = allNodes(f.root).find(node => node.dataset.action === 'viewConversation');
  assert.ok(button);
  button.dispatch('click');
  assert.equal(selected.length, 1);
  assert.equal(selected[0].sessionGroup, current.sessionGroup);
  await f.controller.open(row('origin'), { rows: [], listKnown: true });
  assert.equal(allNodes(f.root).some(node => node.dataset.action === 'viewConversation'), false);
  f.controller.destroy();
});

test('the conversation button leads the action row, as the primary action beside the group actions', async () => {
  const f = detailFixture(async path => response(defaultRead(path)), { onConversation: () => {} });
  const current = row('telegram:a', { state: { kind: 'idle' } });
  await f.controller.open(current, { rows: [current], listKnown: true });
  const actions = allNodes(f.root).find(node => node.classList.contains('wb-d-acts'));
  const order = actions.children.map(node => node.dataset.action ?? node.dataset.wbAction);
  assert.deepEqual(order, ['viewConversation', 'interrupt', 'chop-chop', 'restart']);
  assert.equal(actions.children[0].classList.contains('wb-btn-primary'), true);
  assert.equal(allNodes(f.root).find(node => node.classList.contains('wb-group-head')).tagName, 'HEADER');
  f.controller.destroy();
});

test('the now card says what the state means instead of repeating the header state, and holds its observe button', () => {
  const document = createDocument(), seen = [];
  const said = row('telegram:a', { state: { kind: 'idle' }, duration: 75, preview: { text: 'please check the layout', channel: 'telegram', timestamp: 1000 } });
  let root = document.createElement('div');
  renderOverview(root, said, {}, { document, t, onObserve: view => seen.push(view) });
  const card = allNodes(root).find(node => node.classList.contains('wb-now-card'));
  assert.equal(card.textContent.includes('wb.state.idle'), false, 'the header pill already shows the state and its duration');
  assert.match(card.textContent, /wb\.board\.lastReceived \{"text":"please check the layout"\}/);
  const observe = allNodes(card).find(node => node.tagName === 'BUTTON' && node.textContent === 'wb.detail.observe');
  assert.ok(observe, 'the observe button sits inside the card it belongs to');
  // A message whose text cannot be shown names its channel and time instead of the raw protocol text.
  const hidden = row('openmax:x', { state: { kind: 'idle' }, preview: { text: null, channel: 'openmax', timestamp: Date.parse('2026-11-09T08:05:00Z') } });
  root = document.createElement('div');
  renderOverview(root, hidden, {}, { document, t, currentTime: Date.parse('2026-11-09T09:00:00Z') });
  const fallback = allNodes(root).find(node => node.classList.contains('wb-now-card')).textContent;
  assert.match(fallback, /^wb\.board\.lastReceivedAt \{"channel":"wb\.platform\.openmax","time":"[^"]+"\}$/);
  // Without anything received the card falls back to the state itself.
  root = document.createElement('div');
  renderOverview(root, row('telegram:b', { state: { kind: 'idle' }, duration: 30 }), {}, { document, t });
  assert.match(allNodes(root).find(node => node.classList.contains('wb-now-card')).textContent, /^wb\.state\.idle/);
});

test('an error or unknown state keeps its word in the now card, with the last message under it', () => {
  const document = createDocument();
  const preview = { text: 'please check the layout', channel: 'telegram', timestamp: 1000 };
  for (const kind of ['error', 'unknown']) {
    const root = document.createElement('div');
    renderOverview(root, row('telegram:a', { state: { kind }, duration: 40, preview }), {}, { document, t });
    const card = allNodes(root).find(node => node.classList.contains('wb-now-card'));
    const title = allNodes(card).find(node => node.classList.contains('wb-now-title'));
    assert.match(title.textContent, new RegExp('^wb\\.state\\.' + kind), kind + ': the state word leads the card');
    assert.equal(title.classList.contains('wb-now-said'), false);
    const sub = allNodes(card).find(node => node.classList.contains('wb-now-sub'));
    assert.match(sub?.textContent ?? '', /wb\.board\.lastReceived \{"text":"please check the layout"\}/, kind + ': the last message follows');
  }
});

test('a stopped session reads as a plain event, with its code only in technical detail', () => {
  assert.equal(eventLabel({ event_type: 'runtime_health:stop', category: 'runtime_health' }, 'plain', t), 'wb.event.runtime_health:stop');
  assert.equal(eventLabel({ event_type: 'runtime_health:stop', category: 'runtime_health' }, 'technical', t), 'runtime_health:stop');
});

test('every group detail offers observation, including sleeping groups that enter history', () => {
  const document = createDocument(), seen = [];
  const live = row('telegram:active', { live: { runId: 'r' } }), idle = row('telegram:sleeping', { presence: 'not_running', live: null });
  const findButton = root => allNodes(root).find(node => node.tagName === 'BUTTON' && node.textContent === 'wb.detail.observe');
  let root = document.createElement('div');
  renderOverview(root, live, {}, { document, t, onObserve: view => seen.push(view) });
  findButton(root).dispatch('click'); assert.deepEqual(seen, ['live']);
  root = document.createElement('div'); renderOverview(root, live, {}, { document, t }); assert.equal(findButton(root), undefined);
  root = document.createElement('div'); renderOverview(root, idle, {}, { document, t, onObserve: view => seen.push(view) });
  assert.equal(findButton(root).dataset.observerGroup, 'telegram:sleeping');
  findButton(root).dispatch('click'); assert.deepEqual(seen, ['live', 'live'], 'sleeping detail enters the page, which offers history');
  const loader = { state: { runs: [], expanded: new Set(), events: new Map(), messages: new Map(), between: [], filter: 'all', totalRuns: 0 }, setFilter() {}, collapse() {} };
  root = document.createElement('div'); renderTimeline(root, loader, { document, t, onObserve: view => seen.push(view) });
  allNodes(root).find(node => node.textContent === 'wb.detail.observeHistory').dispatch('click'); assert.deepEqual(seen, ['live', 'live', 'history']);
  root = document.createElement('div'); renderTimeline(root, loader, { document, t });
  assert.equal(allNodes(root).some(node => node.textContent === 'wb.detail.observeHistory'), false);
});


test('group model threshold is read only and follows the selected model and engine default', async () => {
  const document = createDocument(), root = document.createElement('div');
  const controller = { state: { value: { runtime: { data: { resolved: { runtime: 'claude' } } }, model: { data: { desired: { runtime: 'claude', mode: 'override', model: 'opus', effort: 'high' } } } },
    meta: { claude: { current_model: 'opus', models: [{ id: 'opus' }, { id: 'opus[1m]' }], efforts_by_model: { '*': ['high'] }, model_thresholds: { opus: 70, 'opus[1m]': 40 } } } }, save() {} };
  renderGroupConfig(root, controller, { document, t, rotationThreshold: 63 });
  const line = allNodes(root).find(node => node.classList.contains('wb-cfg-threshold'));
  const [, model] = allNodes(root).find(node => node.classList.contains('wb-cfg-controls')).children;
  assert.match(line.textContent, /"value":70/);
  model.value = 'opus[1m]'; await model.dispatch('change'); assert.match(line.textContent, /"value":40/);
  assert.equal(allNodes(root).filter(node => node.tagName === 'INPUT' && node.type === 'number').length, 0);
  controller.state.draft = { model: '', target: 'claude' }; root.replaceChildren();
  renderGroupConfig(root, controller, { document, t, rotationThreshold: 35 });
  assert.match(allNodes(root).find(node => node.classList.contains('wb-cfg-threshold')).textContent, /"value":70/, 'default metadata wins over the old running model threshold');
});

// An injected DOM starts newly created bodies at zero. Browser cases own real
// layout/clamping; this boundary requires stable mounted nodes during incremental
// snapshot/data updates and rebuilding at explicit navigation boundaries.
function detailScrollFixture(fetch, options = {}) {
  const f = detailFixture(fetch, options);
  f.root.querySelector = selector => allNodes(f.root).find(node => node.classList.contains(selector.slice(1)));
  const create = f.document.createElement;
  f.document.createElement = tag => { const node = create(tag); node.scrollTop = 0; return node; };
  return f;
}

test('overview refresh updates mounted nodes without replacing the body or evidence fold', async context => {
  for (const open of [true, false]) await context.test(open ? 'open evidence' : 'closed evidence', async () => {
    const pending = deferred(); let delayed = false;
    let current = row('a');
    const stableEvent = { event_seq: 1, event_type: 'stop', timestamp: '2026-11-11T00:00:00Z' };
    const f = detailScrollFixture(async path => {
      if (delayed && path.startsWith('/api/timeline')) return pending.promise;
      return response(path.startsWith('/api/timeline') && !path.includes('types=subagent_start') ? { events: [stableEvent] } : defaultRead(path));
    }, { detail: () => 'technical' });
    try {
      await f.controller.open(current, { rows: [current], listKnown: true });
      const body = () => f.root.querySelector('.wb-detail-body');
      const evidence = () => f.root.querySelector('.wb-detail-evidence');
      const oldBody = body(), oldEvidence = evidence(), oldHeader = f.root.children[0];
      const oldEvent = allNodes(f.root).find(node => node.classList.contains('wb-ev'));
      assert.ok(oldEvent);
      body().scrollTop = 110; evidence().open = !open;
      delayed = true; const refreshing = f.controller.refresh();
      body().scrollTop = 260; evidence().open = open;
      pending.resolve(response({ events: [stableEvent] })); await refreshing;
      assert.equal(body(), oldBody); assert.equal(evidence(), oldEvidence); assert.equal(f.root.children[0], oldHeader);
      assert.equal(allNodes(f.root).find(node => node.classList.contains('wb-ev')), oldEvent, 'activity rows retain their keyed DOM nodes');
      assert.equal(body().scrollTop, 260, 'the mounted body keeps the in-flight user scroll');
      assert.equal(evidence().open, open);
      body().scrollTop = 310; evidence().open = !open;
      current = { ...current, contextPct: 73 };
      await f.controller.updateSnapshot({ rows: [current], listKnown: true });
      assert.equal(body(), oldBody); assert.equal(evidence(), oldEvidence); assert.equal(f.root.children[0], oldHeader);
      assert.ok(f.root.textContent.includes('73'), 'updated snapshot numbers reach existing elements');
      assert.equal(body().scrollTop, 310, 'snapshot and data updates keep the mounted body');
      assert.equal(evidence().open, !open, 'closed folds remain closed too');
    } finally { f.controller.destroy(); }
  });
});

test('explicit detail tabs and another group start at the top without leaking evidence expansion', async () => {
  let level = 'technical';
  const f = detailScrollFixture(async path => response(defaultRead(path)), { detail: () => level });
  const first = row('a'), second = row('b');
  try {
    await f.controller.open(first, { rows: [first, second], listKnown: true });
    f.root.querySelector('.wb-detail-body').scrollTop = 175;
    f.root.querySelector('.wb-detail-evidence').open = true;
    const overviewBody = f.root.querySelector('.wb-detail-body');
    await f.controller.selectTab('timeline');
    assert.notEqual(f.root.querySelector('.wb-detail-body'), overviewBody, 'a true tab switch rebuilds');
    assert.equal(f.root.querySelector('.wb-detail-body').scrollTop, 0, 'overview to timeline resets');
    f.root.querySelector('.wb-detail-body').scrollTop = 240;
    const timelineBody = f.root.querySelector('.wb-detail-body');
    await f.controller.selectTab('timeline');
    assert.equal(f.root.querySelector('.wb-detail-body'), timelineBody, 'the active tab keeps its body');
    assert.equal(f.root.querySelector('.wb-detail-body').scrollTop, 240, 'reselecting the active timeline retains its position');
    await f.controller.selectTab('overview');
    assert.notEqual(f.root.querySelector('.wb-detail-body'), timelineBody);
    assert.equal(f.root.querySelector('.wb-detail-body').scrollTop, 0, 'timeline to overview resets');
    f.root.querySelector('.wb-detail-body').scrollTop = 210;
    f.root.querySelector('.wb-detail-evidence').open = true;
    const previousBody = f.root.querySelector('.wb-detail-body');
    await f.controller.open(second, { rows: [first, second], listKnown: true });
    assert.notEqual(f.root.querySelector('.wb-detail-body'), previousBody, 'another group rebuilds');
    assert.equal(f.root.querySelector('.wb-detail-body').scrollTop, 0, 'another group resets');
    assert.equal(f.root.querySelector('.wb-detail-evidence').open, false, 'another group has its own evidence fold');
    const technicalBody = f.root.querySelector('.wb-detail-body'); technicalBody.scrollTop = 120;
    level = 'plain'; f.controller.setViewDetail();
    assert.notEqual(f.root.querySelector('.wb-detail-body'), technicalBody, 'a detail-level change rebuilds');
    assert.equal(f.root.querySelector('.wb-detail-body').scrollTop, 0);
  } finally { f.controller.destroy(); }
});

test('evidence expansion survives a new preview while its stored-message fold keeps preview ownership', async () => {
  const preview = timestamp => ({ text: 'message', channel: 'telegram', timestamp, source: { kind: 'channel' } });
  let current = row('a', { state: { kind: 'idle' }, preview: preview(1) });
  const f = detailScrollFixture(async path => response(path.endsWith('/raw') ? { raw: 'stored message' } : defaultRead(path)),
    { detail: () => 'technical' });
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    const raw = () => f.root.querySelector('.wb-now-raw');
    const evidence = () => f.root.querySelector('.wb-detail-evidence');
    evidence().open = true; raw().open = true; raw().dispatch('toggle');
    await tick(); await tick();
    assert.equal(raw().open, true); assert.equal(evidence().open, true);
    current = { ...current, preview: preview(2) };
    await f.controller.updateSnapshot({ rows: [current], listKnown: true });
    assert.equal(evidence().open, true, 'the technical evidence fold belongs to this view');
    assert.equal(raw().open, false, 'a new preview must not inherit the old raw-message expansion');
  } finally { f.controller.destroy(); }
});


test('timeline refresh updates keyed run and activity nodes in the mounted body', async () => {
  let version = 1;
  const current = row('a');
  const first = { event_seq: 1, event_type: 'session_start', timestamp: new Date(1200).toISOString() };
  const second = { event_seq: 2, event_type: 'stop', timestamp: new Date(1800).toISOString() };
  const f = detailScrollFixture(async path => {
    const url = new URL(path, 'http://fixture');
    if (path.includes('types=subagent_start')) return response({ events: [] });
    if (url.pathname.endsWith('/runs')) return response({ runs: [{ ...run('run-a'), n: version }], totalEvents: version, totalRuns: 1 });
    if (url.pathname === '/api/timeline') return response({ events: url.searchParams.has('after_seq') ? version === 2 ? [second] : [] : [first] });
    return response(defaultRead(path));
  }, { detail: () => 'technical' });
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    await f.controller.selectTab('timeline');
    const body = f.root.querySelector('.wb-detail-body'), section = f.root.querySelector('.wb-timeline-run');
    const event = f.root.querySelector('.wb-timeline-event'), heading = f.root.querySelector('.wb-run-h');
    assert.ok(section); assert.ok(event); body.scrollTop = 190;
    version = 2; await f.controller.updateSnapshot({ rows: [current], listKnown: true });
    assert.equal(f.root.querySelector('.wb-detail-body'), body); assert.equal(body.scrollTop, 190);
    assert.equal(f.root.querySelector('.wb-timeline-run'), section); assert.equal(f.root.querySelector('.wb-run-h'), heading);
    assert.ok(allNodes(f.root).includes(event), 'the existing event row survives insertion of a newer event');
    assert.equal(allNodes(f.root).filter(node => node.classList.contains('wb-timeline-event')).length, 2);
    assert.match(heading.textContent, /"count":2/, 'the reused run header receives its new count');
  } finally { f.controller.destroy(); }
});

// Metadata may replace a free-text model with a select while the other editor
// controls stay mounted. Subsequent edits and save must use those live controls.
test('incremental configuration metadata and refresh keep save bound to the mounted controls', async () => {
  const meta = deferred(), posts = [], current = row('a');
  const configValue = { runtime: { data: { resolved: { runtime: 'claude' } } },
    model: { data: { desired: { mode: 'override', runtime: 'claude', model: 'opus', effort: 'low' } } } };
  const f = detailScrollFixture(async (path, options) => {
    if (path.endsWith('/config') && options?.method === 'POST') {
      posts.push(JSON.parse(options.body)); return response({ ok: true, data: { running: { status: 'applied' } } });
    }
    if (path.endsWith('/config')) return response(configValue);
    if (path.startsWith('/api/actions/meta')) return meta.promise;
    return response(defaultRead(path));
  }, { detail: () => 'technical' });
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    const config = f.root.querySelector('.wb-detail-config');
    allNodes(config).find(node => node.tagName === 'BUTTON' && node.textContent === 'wb.detail.modify').dispatch('click');
    await tick(); await tick();
    const pair = () => f.root.querySelector('.wb-cfg-controls');
    assert.equal(pair().children[1].tagName, 'INPUT', 'unavailable metadata starts with free text');
    meta.resolve(response({ models: [{ id: 'opus' }, { id: 'sonnet' }], efforts_by_model: { '*': ['low', 'high'] },
      model_thresholds: { opus: 70, sonnet: 60 } }));
    await tick(); await tick();
    assert.equal(pair().children[1].tagName, 'SELECT');
    const mounted = pair();
    await f.controller.updateSnapshot({ rows: [current], listKnown: true });
    assert.equal(pair(), mounted, 'background updates keep the editor mounted');
    const [, model, effort, save] = pair().children;
    model.value = 'sonnet'; model.dispatch('change');
    effort.value = 'high'; effort.dispatch('change');
    assert.equal(save.disabled, false);
    save.dispatch('click'); await tick(); await tick();
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0], { kind: 'model', runtime: 'claude', model: 'sonnet', effort: 'high' });
  } finally { f.controller.destroy(); }
});

test('timeline keeps event and message identity separate when numeric ids match and order changes', async () => {
  let version = 1;
  const current = row('a'), eventValue = { id: 7, event_seq: 7, event_type: 'stop', timestamp: new Date(1200).toISOString() };
  const f = detailScrollFixture(async path => {
    const url = new URL(path, 'http://fixture');
    if (path.includes('types=subagent_start')) return response({ events: [] });
    if (url.pathname.endsWith('/runs')) return response({ runs: [run('run-a')], totalEvents: 1, totalRuns: 1 });
    if (url.pathname.endsWith('/messages')) return response({ messages: [{ id: 7, direction: 'in', timestamp: new Date(version === 1 ? 1800 : 1100).toISOString() }] });
    if (url.pathname === '/api/timeline') return response({ events: url.searchParams.has('after_seq') ? [] : [eventValue] });
    return response(defaultRead(path));
  }, { detail: () => 'technical' });
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    await f.controller.selectTab('timeline');
    const event = f.root.querySelector('.wb-timeline-event'), message = f.root.querySelector('.wb-timeline-message');
    const rows = () => allNodes(f.root).filter(node => node.classList.contains('wb-timeline-event') || node.classList.contains('wb-timeline-message'));
    assert.equal(rows()[0], message); assert.equal(rows()[1], event);
    version = 2; await f.controller.updateSnapshot({ rows: [current], listKnown: true });
    assert.equal(f.root.querySelector('.wb-timeline-event'), event);
    assert.equal(f.root.querySelector('.wb-timeline-message'), message);
    assert.equal(rows()[0], event); assert.equal(rows()[1], message);
  } finally { f.controller.destroy(); }
});

test('inserting a newer timeline run keeps the existing expanded run section', async () => {
  let includeNewer = false;
  const current = row('a'), existingRun = run('run-a'), newerRun = run('run-new', 3000, 4000);
  const event = { event_seq: 1, event_type: 'stop', timestamp: new Date(1800).toISOString() };
  const f = detailScrollFixture(async path => {
    const url = new URL(path, 'http://fixture');
    if (path.includes('types=subagent_start')) return response({ events: [] });
    if (url.pathname.endsWith('/runs')) return response({ runs: includeNewer ? [newerRun, existingRun] : [existingRun], totalEvents: 1, totalRuns: includeNewer ? 2 : 1 });
    if (url.pathname === '/api/timeline') return response({ events: url.searchParams.has('after_seq') ? [] : [event] });
    return response(defaultRead(path));
  }, { detail: () => 'technical' });
  const sections = () => allNodes(f.root).filter(node => node.classList.contains('wb-timeline-run'));
  const findRun = id => sections().find(node => node.dataset.runId === id && allNodes(node).some(child => child.classList.contains('wb-mono') && child.textContent === id));
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    await f.controller.selectTab('timeline');
    const existingSection = findRun('run-a');
    assert.ok(existingSection);
    const heading = allNodes(existingSection).find(node => node.classList.contains('wb-run-h'));
    assert.equal(heading.getAttribute('aria-expanded'), 'true');
    includeNewer = true;
    await f.controller.updateSnapshot({ rows: [current], listKnown: true });
    assert.ok(findRun('run-a') === existingSection, 'the existing run keeps its section rather than inheriting a positional match');
    assert.ok(sections()[0] === findRun('run-new'), 'the refreshed run is inserted above the existing run');
    assert.ok(allNodes(existingSection).includes(heading), 'the expanded run keeps its heading');
    assert.equal(heading.getAttribute('aria-expanded'), 'true');
    assert.equal(f.controller.timeline.state.expanded.has('run-a'), true);
  } finally { f.controller.destroy(); }
});

test('an open configuration form becomes writable without retaining read-only callbacks', async () => {
  let writable = false;
  const current = row('a');
  const configValue = { runtime: { data: { resolved: { runtime: 'claude' } } },
    model: { data: { desired: { mode: 'override', runtime: 'claude', model: 'opus', effort: 'low' } } } };
  const f = detailScrollFixture(async path => {
    if (path.endsWith('/config')) return response(configValue);
    if (path.startsWith('/api/actions/meta')) return response({ models: [{ id: 'opus' }, { id: 'sonnet' }],
      efforts_by_model: { '*': ['low', 'high'] }, model_thresholds: { opus: 70, sonnet: 60 } });
    return response(defaultRead(path));
  }, { detail: () => 'technical', writable: () => writable });
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    const config = f.root.querySelector('.wb-detail-config');
    allNodes(config).find(node => node.tagName === 'BUTTON' && node.textContent === 'wb.detail.modify').dispatch('click');
    await tick(); await tick();
    const readonlyForm = f.root.querySelector('.wb-cfg-edit');
    const revision = readonlyForm.dataset.updateKey.split(':')[1];
    const readonlyPair = f.root.querySelector('.wb-cfg-controls');
    assert.equal(readonlyPair.children[1].disabled, true);
    assert.equal(readonlyPair.children[3].disabled, true);
    writable = true;
    f.controller.setViewDetail();
    const writableForm = f.root.querySelector('.wb-cfg-edit');
    assert.equal(writableForm.dataset.updateKey.split(':')[1], revision, 'permission changes do not publish new configuration data');
    assert.ok(writableForm !== readonlyForm, 'the new permission gets a form with fresh callbacks');
    const [, model, effort, save] = f.root.querySelector('.wb-cfg-controls').children;
    assert.equal(model.disabled, false);
    model.value = 'sonnet'; model.dispatch('change');
    effort.value = 'high'; effort.dispatch('change');
    assert.equal(save.disabled, false, 'new model and effort can be saved with the current permission');
  } finally { f.controller.destroy(); }
});

test('an open name editor follows permission changes with fresh controls', async () => {
  let writable = true;
  const current = row('a');
  const f = detailScrollFixture(async path => response(defaultRead(path)), { writable: () => writable });
  try {
    await f.controller.open(current, { rows: [current], listKnown: true });
    allNodes(f.root).find(node => node.tagName === 'BUTTON' && node.getAttribute('aria-label') === 'wb.name.edit').dispatch('click');
    const writableEditor = f.root.querySelector('.wb-name-editor');
    writableEditor.children[0].value = 'Unsent name'; writableEditor.children[0].dispatch('input');
    assert.equal(writableEditor.children[1].disabled, false);
    writable = false; f.controller.setViewDetail();
    const readonlyEditor = f.root.querySelector('.wb-name-editor');
    assert.ok(readonlyEditor !== writableEditor, 'read-only permission replaces the editor and its callbacks');
    assert.equal(readonlyEditor.children[0].value, 'Unsent name');
    assert.equal(readonlyEditor.children[0].disabled, true); assert.equal(readonlyEditor.children[1].disabled, true);
    writable = true; f.controller.setViewDetail();
    const reopenedEditor = f.root.querySelector('.wb-name-editor');
    assert.ok(reopenedEditor !== readonlyEditor, 'writable permission creates current writable callbacks');
    assert.equal(reopenedEditor.children[0].value, 'Unsent name');
    assert.equal(reopenedEditor.children[0].disabled, false); assert.equal(reopenedEditor.children[1].disabled, false);
  } finally { f.controller.destroy(); }
});
