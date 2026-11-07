import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { renderBoard, renderRow, modelCell, pendingModel, boardController, renderDistribution } from '../public/js/wb/board.js';
import { createBoardSearch } from '../public/js/wb/board-search.js';
import { activityStrip } from '../public/js/wb/activity-strip.js';
import { instanceStrip } from '../public/js/wb/instance-strip.js';
import { renderAttention } from '../public/js/wb/attention-bar.js';
import { showSidePanel } from '../public/js/wb/side-panel.js';
import { createDocument, allNodes, deferred, tick } from './fixtures/workbench-dom.js';
const t = (key, values = {}) => key + Object.values(values).join(':');
const nameOf = node => allNodes(node).find(item => item.classList.contains('wb-nm')).textContent;
const row = (key, kind = 'idle') => ({ sessionGroup: key, name: { displayName: key }, fallbackName: key,
  state: { kind }, presence: 'running', duration: 32, tools: [], queue: { pending: { count: 2 }, running: { count: 1 } }, contextPct: 42,
  target: { runtime: 'claude', model: 'default' }, launchConfig: { runtime: 'claude', mode: 'default' }, desired: { runtime: 'claude', mode: 'default' } });

test('board renders snapshot order, text-safe names and technical columns', () => {
  const document = createDocument(), root = document.createElement('div');
  const rows = Array.from({ length: 6 }, (_, index) => row('group' + index)); rows[1].name.displayName = '<img onerror=alert(1)>';
  renderBoard(root, { rows, counts: { idle: 6 } }, { document, t });
  assert.equal(root.children.length, 6); assert.equal(nameOf(root.children[0]), 'group0');
  assert.equal(nameOf(root.children[1]), '<img onerror=alert(1)>');
  assert.equal(allNodes(root).some(node => node.tagName === 'IMG'), false);
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-model')).length, 0);
  renderBoard(root, { rows }, { document, t, level: 'technical' });
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-model')).length, 6);
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-queue')).length, 6);
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-context-ring')).length, 6);
  assert.match(root.children[0].textContent, /32s/);
});
test('unknown reason and free failure reason remain text, tool title preserves raw name', () => {
  const document = createDocument(); const value = row('group'); value.state = { kind: 'unknown', reason: '<script>bad</script>', sampledAt: 123 };
  value.wait = { kind: 'start_failed', reasonCode: '<img onerror=bad>' };
  const root = renderRow(value, { document, t, level: 'technical' });
  assert.equal(root.children[1].classList.contains('wb-unknown'), true); assert.match(root.children[1].title, /<script>/);
  assert.match(root.textContent, /<img onerror=bad>/); assert.equal(allNodes(root).some(node => node.tagName === 'IMG'), false);
  value.tools = [{ name: 'unrecognized', detail: 'raw' }];
  const plain = renderRow(value, { document, t }); assert.equal(plain.children[2].title, 'unrecognized'); assert.equal(plain.children[2].textContent, 'wb.tool.unknown');
});
test('single view uses only-session name and historical groups have unknown live fields', () => {
  const document = createDocument(), root = document.createElement('div');
  renderBoard(root, { view: 'single', rows: [row('origin')] }, { document, t, level: 'technical' });
  assert.equal(nameOf(root.children[0]), 'wb.single');
  const old = renderRow({ sessionGroup: 'old', state: { kind: 'not_running' }, queue: null, target: null }, { document, t, level: 'technical' });
  assert.equal(old.children[4].textContent, '—'); assert.equal(old.children[6].textContent, '—');
});
test('older hint appears only for strict true without an active query and focuses search', () => {
  const document = createDocument(), root = document.createElement('div'); let focus = 0;
  for (const hasOlder of [true, false, null]) {
    renderBoard(root, { rows: [row('a')], hasOlder }, { document, t, onSearch: () => focus++ });
    assert.equal(root.children.length, hasOlder === true ? 2 : 1);
    if (hasOlder) root.children[1].dispatch('click');
  }
  assert.equal(focus, 1); renderBoard(root, { rows: [], hasOlder: true }, { document, t, query: 'oc' });
  assert.equal(root.children.length, 1); assert.equal(root.textContent, 'wb.noMatch');
});
test('model text and pending comparison use launch identity, desired config and fence', () => {
  const value = row('a'); assert.equal(modelCell(value), 'claude · default'); assert.equal(pendingModel(value), false);
  value.launchConfig = { runtime: 'claude', mode: 'override', model: 'opus', effort: 'high' };
  value.desired = { ...value.launchConfig }; assert.equal(pendingModel(value), false);
  for (const key of ['runtime', 'model', 'effort']) { value.desired = { ...value.launchConfig, [key]: 'different' }; assert.equal(pendingModel(value), true); }
  value.desired = null; assert.equal(pendingModel(value), false); value.fence = { reason: 'model_config' }; assert.equal(pendingModel(value), true);
  value.target.onlyMulti = true; assert.equal(pendingModel(value), false);
  assert.equal(modelCell({ presence: 'not_running', target: null }), '—');
});
test('running group without a readable launch configuration shows an unknown model, not the default', () => {
  const unreadable = { ...row('a'), launchConfig: null, desired: { runtime: 'claude', mode: 'default' },
    target: { runtime: 'claude', model: null, reason: 'launch_config_unreadable' } };
  assert.equal(modelCell(unreadable, t), 'claude · wb.unknown');
  assert.equal(modelCell({ ...unreadable, presence: 'starting' }, t), 'claude · wb.unknown');
  assert.equal(modelCell({ ...unreadable, target: { ...unreadable.target, runtime: 'unknown' } }, t), 'unknown · wb.unknown');
  assert.equal(modelCell(row('b'), t), 'claude · default');
  assert.equal(modelCell({ ...row('c'), presence: 'not_running', launchConfig: null, target: { runtime: 'codex', model: { model: 'gpt', effort: 'low' } } }, t), 'codex · gpt · low');
  assert.equal(pendingModel(unreadable), false); assert.equal(pendingModel({ ...unreadable, fence: { reason: 'model_config' } }), true);
  const document = createDocument();
  const cell = allNodes(renderRow(unreadable, { document, level: 'technical', t })).find(node => node.classList.contains('wb-model'));
  assert.equal(cell.textContent, 'claude · wb.unknown');
});
test('activity renders real string cells and timestamps, with unknown inbound distinguished', () => {
  const document = createDocument();
  for (const [size, seconds] of [[60, 60], [72, 300]]) {
    const data = { cells: Array(size).fill('none'), inbound: [1000], start: 0, cellSeconds: seconds }; data.cells[1] = 'busy';
    const root = activityStrip(document, data, { t }); assert.equal(root.children.length, size);
    assert.equal(root.children[0].classList.contains('wb-none'), true); assert.equal(root.children[0].classList.contains('wb-inbound'), true);
    assert.match(root.children[1].title, /wb.state.busy/);
    const unknown = activityStrip(document, data, { inboundUnknown: true, t }); assert.equal(unknown.dataset.inbound, 'unknown');
    assert.equal(unknown.children[0].classList.contains('wb-inbound'), false);
  }
});
// Board/activity integration: run for activity-to-row wiring changes; skip unrelated
// work. Injected DOM only, no live I/O or timers; runner uses temporary HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR and private tmux namespace with cleanup.
test('board wires activity to each matching group', () => {
  const document = createDocument(), root = document.createElement('div');
  renderBoard(root, { rows: [row('a'), row('b')] }, { document, t, activity: { start: 0, cellSeconds: 60,
    groups: { a: { cells: ['busy'], inbound: [] }, b: { cells: ['none'], inbound: [] } } } });
  assert.equal(root.children[0].children[3].children[0].className, 'wb-bucket wb-busy');
  assert.equal(root.children[1].children[3].children[0].className, 'wb-bucket wb-none');
  renderBoard(root, { rows: [row('a')] }, { document, t, activity: { start: 0, cellSeconds: 60,
    inboundError: 'inbound_unreadable', groups: { a: { cells: ['busy'], inbound: [1000] } } } });
  const strip = root.children[0].children[3];
  assert.equal(strip.dataset.inbound, 'unknown');
  assert.equal(strip.children[0].classList.contains('wb-inbound'), false);
  assert.equal(strip.children[0].classList.contains('wb-busy'), true);
});
test('snapshot controller rejects old responses and retains rows after failure', async () => {
  const first = deferred(), second = deferred(); let calls = 0, shown = null, failure = null;
  const controller = boardController({ fetchSnapshot: () => (++calls === 1 ? first.promise : calls === 2 ? second.promise : Promise.reject(Error('offline'))),
    onSnapshot: value => { shown = value; }, onError: (_, at) => { failure = at; }, now: () => 100 });
  const a = controller.refresh(), b = controller.refresh(); second.resolve('new'); await b; first.resolve('old'); await a;
  assert.equal(shown, 'new'); await controller.refresh(); assert.equal(shown, 'new'); assert.equal(failure, 100); controller.stop();
});
test('snapshot lifecycle polls only while visible and cancels late responses on stop', async () => {
  let visible = false, calls = 0, timer, cleared; const pending = deferred();
  const controller = boardController({ visible: () => visible, fetchSnapshot: () => { calls++; return pending.promise; },
    onSnapshot: () => assert.fail('stopped result'), onError: () => {}, setTimer: (fn, ms) => { timer = fn; assert.equal(ms, 5000); return 7; }, clearTimer: id => { cleared = id; } });
  controller.start(); assert.equal(calls, 0); visible = true; const work = timer(); assert.equal(calls, 1); controller.stop(); pending.resolve({}); await work; assert.equal(cleared, 7);
});
test('search debounces, clears and rejects stale results independently from snapshots', async () => {
  const first = deferred(), second = deferred(); const timers = []; let shown, clears = 0, calls = 0;
  const search = createBoardSearch({ fetchRows: query => { calls++; return query === 'oc' ? first.promise : second.promise; },
    onRows: rows => { shown = rows; }, onClear: () => clears++, onError: assert.fail,
    setTimer: (fn, delay) => { timers.push({ fn, delay }); return timers.length; }, clearTimer: id => { if (id) timers[id - 1].cancelled = true; } });
  search.input('o'); search.input('oc'); assert.equal(timers[0].cancelled, true); assert.equal(timers[1].delay, 300); assert.equal(calls, 0);
  const one = timers[1].fn(); search.input('new'); const two = timers[2].fn(); second.resolve({ rows: ['new'] }); await two; first.resolve({ rows: ['old'] }); await one;
  assert.equal(shown[0], 'new'); search.input(''); assert.equal(clears, 1); assert.equal(search.query(), ''); search.destroy();
});
test('instance strip renders pool unknown or used slots, runtime union, quota and same-sample services', () => {
  const document = createDocument(), root = document.createElement('div');
  instanceStrip(root, { mode: 'unreadable', baselineRuntime: 'claude', rows: [{ launchConfig: { runtime: 'codex' } }],
    instance: { pool: { used: 3, waiting: 1 }, runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'auth_failed' } },
      accounts: { claude: { used_percentage: 23 }, codex: null }, services: { online: 4, total: 5 } } }, { document, t, cost: 0.25, level: 'technical' });
  const chip = allNodes(root).find(node => node.classList.contains('wb-mode-chip'));
  assert.equal(chip.textContent, 'wb.unknown'); assert.equal(chip.title, 'wb.mode');
  assert.match(root.textContent, /wb.inst.pool3wb.inst.inUse/, 'an unknown capacity shows only the used count'); assert.match(root.textContent, /23%/);
  assert.match(root.textContent, /wb.inst.authFailedTech/); assert.match(root.textContent, /4 \/ 5/);
  assert.match(root.textContent, /wb.inst.queuedTech1/);
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-slot')).length, 3);
  instanceStrip(root, { mode: 'multi', instance: { pool: { used: 2, capacity: 4 } } }, { document, t, level: 'technical' });
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-slot')).length, 4, 'a known capacity draws free slots too');
  assert.match(root.textContent, /2 \/ 4/);
  instanceStrip(root, { mode: 'multi', instance: { pool: { used: null } } }, { document, t });
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-mode-chip')).length, 0, 'the mode is technical only');
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-slot')).length, 0); assert.match(root.textContent, /wb.poolwb.unknown/);
  assert.equal(root.children.at(-1).id, 'wb-host-open', 'host status stays at the right end');
});
test('attention shows both problems and recovery reminders with text-safe technical reasons', () => {
  const document = createDocument(), root = document.createElement('div');
  renderAttention(root, { attention: { problems: [{ kind: 'auth_failed', runtime: 'claude', groups: ['a', 'b'], extraUnknown: 1 },
    { kind: 'data_unreadable', source: '<img onerror=x>' }], reminders: [{ kind: 'rate_limited', runtime: 'codex', until: 1000 }] } },
  { document, t, level: 'technical', error: true, lastSuccess: 1000, now: 4000 });
  assert.equal(root.children.length, 4); assert.match(root.textContent, /wb.attention.rate_limited/); assert.match(root.textContent, /<img onerror=x>/);
  assert.equal(allNodes(root).some(node => node.tagName === 'IMG'), false);
});
test('attention renders problems and reminders as distinct item classes', () => {
  const document = createDocument(), root = document.createElement('div'), selected = [];
  renderAttention(root, { attention: { problems: [{ kind: 'auth_failed', runtime: 'claude', groups: ['a'] }],
    reminders: [{ kind: 'rate_limited', runtime: 'codex', until: 0 }] } }, { document, t, now: 4000, onSelect: key => selected.push(key) });
  assert.deepEqual(root.children.map(node => node.className.split(' ').sort()),
    [['wb-attention-item', 'wb-attention-problem'], ['wb-attention-item', 'wb-attention-reminder']]);
  assert.match(root.children[0].textContent, /^wb\.attention\.auth_failed/);
  assert.match(root.children[1].textContent, /^wb\.attention\.rate_limited/);
  const icons = node => allNodes(node).filter(item => item.classList.contains('wb-ico')).map(item => item.className);
  assert.equal(icons(root.children[0])[0], 'wb-ico wb-ico-alert', 'problems carry an alert icon');
  assert.deepEqual(icons(root.children[1]), ['wb-ico wb-ico-clock'], 'reminders carry a clock icon');
  assert.equal(root.children[0].tagName, 'BUTTON', 'a problem affecting one group opens it');
  assert.equal(root.children[1].tagName, 'DIV', 'an instance-level reminder is static');
  root.children[0].dispatch('click'); assert.deepEqual(selected, ['a']);
});
// Selection/detail boundary: run for side-panel rendering changes; skip unrelated
// work. Injected DOM only, no live I/O or timers; runner uses temporary HOME,
// ZYLOS_DIR, PM2_HOME, short TMPDIR and private tmux namespace with cleanup.
test('side panel opens only the selected name and state and closes with back', () => {
  const document = createDocument(), root = document.createElement('aside');
  root.hidden = true;
  showSidePanel(root, row('<img onerror=bad>', 'busy'), { document, t });
  assert.equal(root.hidden, false);
  assert.equal(root.children.length, 3);
  assert.equal(root.children[0].tagName, 'BUTTON');
  assert.equal(root.children[0].textContent, 'wb.back');
  assert.equal(root.children[1].tagName, 'H2');
  assert.equal(root.children[1].textContent, '<img onerror=bad>');
  assert.equal(root.children[2].textContent, 'wb.state.busy');
  assert.equal(allNodes(root).some(node => node.tagName === 'IMG'), false);
  assert.equal(allNodes(root).filter(node => node.tagName === 'BUTTON').length, 1);
  root.children[0].dispatch('click');
  assert.equal(root.hidden, true);
});
test('unnamed snapshot rows use localized platform and key fallback rather than the single label', () => {
  const document = createDocument();
  const origin = renderRow({ sessionGroup: 'origin', name: null, state: { kind: 'idle' } }, { document, t });
  assert.equal(nameOf(origin), 'wb.term.origin');
  const group = renderRow({ sessionGroup: 'telegram:1001', c4: { componentName: 'telegram' }, name: null, state: { kind: 'idle' } }, { document, t });
  assert.equal(nameOf(group), 'wb.platform.telegram · 1001');
  const plugin = renderRow({ sessionGroup: 'custom:a:b', c4: null, name: null, state: { kind: 'idle' } }, { document, t });
  assert.equal(nameOf(plugin), 'custom · a:b');
});
test('first read failure never invents a last-success timestamp', () => {
  const document = createDocument(), root = document.createElement('div');
  renderAttention(root, null, { document, t, error: true, lastSuccess: null });
  assert.equal(root.textContent, 'wb.readFailed');
});
test('board header counts listed groups by state; plain view names each state', () => {
  const document = createDocument(), root = document.createElement('div');
  renderDistribution(root, { rows: [row('a'), row('b'), row('c')], counts: { busy: 2, idle: 1, waiting: 0 } }, { document, t });
  assert.equal(root.children[0].textContent, 'wb.board.groups3');
  assert.deepEqual(root.children.slice(1).map(node => node.textContent), ['2 wb.state.busy', '1 wb.state.idle']);
  renderDistribution(root, { rows: [row('a')], counts: { busy: 1 } }, { document, t, level: 'technical' });
  assert.equal(root.children[1].textContent, '1'); assert.equal(root.children[1].title, 'wb.state.busy 1');
});
test('attention shows an all-clear line, with sample age only in technical detail', () => {
  const document = createDocument(), root = document.createElement('div');
  const snapshot = { readAt: 1000, attention: { problems: [], reminders: [], sampledAt: 1000 } };
  renderAttention(root, snapshot, { document, t, now: 6000 });
  assert.equal(root.textContent, 'wb.attention.allOk');
  renderAttention(root, snapshot, { document, t, now: 6000, level: 'technical' });
  assert.equal(root.textContent, 'wb.attention.allOk · wb.attention.sampled5');
  renderAttention(root, snapshot, { document, t, now: 6000, error: true, lastSuccess: null });
  assert.equal(root.textContent, 'wb.readFailed', 'a read failure replaces the all-clear line');
});
test('selected rows are marked and the origin row keeps its own style', () => {
  const document = createDocument(), root = document.createElement('div');
  renderBoard(root, { rows: [row('origin'), row('a')] }, { document, t, selected: 'a' });
  assert.equal(root.children[0].classList.contains('wb-row-origin'), true);
  assert.equal(root.children[1].classList.contains('wb-sel'), true); assert.equal(root.children[1].attributes['aria-current'], 'true');
  assert.equal(root.children[0].classList.contains('wb-sel'), false);
});
