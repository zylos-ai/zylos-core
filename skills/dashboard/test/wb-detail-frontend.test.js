import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, allNodes, deferred, tick } from './fixtures/workbench-dom.js';
import { createGroupDetail, resolveDetailRow, groupActionButtons, groupActionText, formatStartedAt } from '../public/js/wb/detail.js';
import { renderOverview, detailNumbers, activeSubagents } from '../public/js/wb/detail-overview.js';
import { createTimelineLoader, attributeMessages, renderTimeline } from '../public/js/wb/detail-timeline.js';
import { createGroupConfig, fetchJson, runningText, validConfigChange } from '../public/js/wb/group-config.js';
import { saveGroupName, renderNameEditor } from '../public/js/wb/name-edit.js';
import { NAME_PROMPT, ORIGINAL_GROUP_NAME_PATH, namePromptText, renderAutoName } from '../public/js/wb/auto-name.js';

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
  assert.equal(new URL(recent, 'http://fixture').searchParams.get('limit'), '5');
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
  assert.deepEqual(root.children.map(node => node.children[0].textContent), ['wb.detail.now', 'wb.detail.recent', 'wb.detail.memory', 'wb.detail.config']);
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


test('plain detail header reports platform and uptime from run creation rather than state duration', async () => {
  const current = row('telegram:private-id', { createdAt: 1000, duration: 5 });
  const f = detailFixture(async path => response(defaultRead(path)), { now: () => 1120000 });
  await f.controller.open(current, { rows: [current], listKnown: true });
  const meta = allNodes(f.root).find(node => node.classList.contains('wb-detail-meta'));
  assert.equal(meta.textContent, 'wb.platform.telegram · wb.detail.continuous {"minutes":2}');
  f.controller.destroy();
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

test('timeline back-to-latest tracks repeated scrolls and preserves scroll across detail redraws', async () => {
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
  const replace = f.root.replaceChildren.bind(f.root);
  f.root.replaceChildren = (...children) => {
    replace(...children);
    // Model layout clamping a detached scrolling element while it is mounted.
    const body = f.root.querySelector('.wb-detail-timeline');
    if (body) body.scrollTop = 0;
  };
  await f.controller.open('a', { rows: [], listKnown: true });
  f.controller.state.tab = 'timeline'; f.controller.setViewDetail();
  f.root.querySelector('.wb-detail-timeline').scrollTop = 175;
  f.controller.setViewDetail();
  assert.equal(f.root.querySelector('.wb-detail-timeline').scrollTop, 175);
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
  assert.equal(formatStartedAt(1000, 'en'), new Date(1000000).toLocaleString('en'));
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

test('filter reload excludes refresh append until the new filtered array is authoritative', async () => {
  const oldPage = deferred(), toolsPage = deferred(), calls = [];
  let phase = 'initial';
  const loader = createTimelineLoader({ request: async path => {
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
  });
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
  const loader = createTimelineLoader({ request: async path => {
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
  const loader = createTimelineLoader({ request: async path => {
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
