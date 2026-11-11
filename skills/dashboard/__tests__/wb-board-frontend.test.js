import test from 'node:test';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { renderBoard, renderRow, modelCell, pendingModel, boardController, renderDistribution } from '../public/js/wb/board.js';
import { createBoardSearch } from '../public/js/wb/board-search.js';
import { activityStrip } from '../public/js/wb/activity-strip.js';
import { instanceStrip } from '../public/js/wb/instance-strip.js';
import { renderHostPool } from '../public/js/wb/host-panel.js';
import { renderAttention } from '../public/js/wb/attention-bar.js';
import { waitText } from '../public/js/wb/view-mode.js';
import { renderOverview } from '../public/js/wb/detail-overview.js';
import { createDocument, allNodes, deferred, tick } from './fixtures/workbench-dom.js';
import { setInstanceZone } from '../public/js/wb/instance-zone.js?v=100';
import { INSTANCE_TEST_ZONE } from './helpers/instance-test-zone.js';
// Times are expected in the instance zone; INSTANCE_TEST_ZONE differs from the process zone (see the helper).
const ZONE = INSTANCE_TEST_ZONE;
setInstanceZone(ZONE);
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
  const value = row('a'); assert.equal(modelCell(value), 'Claude · default', 'engine names are capitalised like the instance strip'); assert.equal(pendingModel(value), false);
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
  assert.equal(modelCell(unreadable, t), 'Claude · wb.unknown');
  assert.equal(modelCell({ ...unreadable, presence: 'starting' }, t), 'Claude · wb.unknown');
  assert.equal(modelCell({ ...unreadable, target: { ...unreadable.target, runtime: 'unknown' } }, t), 'Unknown · wb.unknown');
  assert.equal(modelCell(row('b'), t), 'Claude · default');
  assert.equal(modelCell({ ...row('c'), presence: 'not_running', launchConfig: null, target: { runtime: 'codex', model: { model: 'gpt', effort: 'low' } } }, t), 'Codex · gpt · low');
  assert.equal(pendingModel(unreadable), false); assert.equal(pendingModel({ ...unreadable, fence: { reason: 'model_config' } }), true);
  const document = createDocument();
  const cell = allNodes(renderRow(unreadable, { document, level: 'technical', t })).find(node => node.classList.contains('wb-model'));
  assert.equal(cell.textContent, 'Claude · wb.unknown');
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
test('instance strip renders pool unknown or occupancy, runtime union, quota and same-sample services', () => {
  const document = createDocument(), root = document.createElement('div');
  instanceStrip(root, { mode: 'unreadable', baselineRuntime: 'claude', rows: [{ launchConfig: { runtime: 'codex' } }],
    instance: { pool: { ready: 3, starting: 0, used: 3, waiting: 1 }, runtimeHealth: { claude: { health: 'ok' }, codex: { health: 'auth_failed' } },
      accounts: { claude: { used_percentage: 23 }, codex: null }, services: { online: 4, total: 5 } } }, { document, t, cost: 0.25, level: 'technical' });
  const chip = allNodes(root).find(node => node.classList.contains('wb-mode-chip'));
  assert.equal(chip.textContent, 'wb.unknown'); assert.equal(chip.title, 'wb.mode');
  assert.match(root.textContent, /wb.inst.pool3wb.inst.inUse/, 'an unknown capacity shows only the used count'); assert.match(root.textContent, /77%/);
  assert.match(root.textContent, /wb.inst.authFailedTech/); assert.match(root.textContent, /4 \/ 5/);
  assert.match(root.textContent, /wb.inst.queuedTech1/);
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-pool-meter')).length, 0);
  instanceStrip(root, { mode: 'multi', instance: { pool: { used: 2, capacity: 4 } } }, { document, t, level: 'technical' });
  const poolMeter = allNodes(root).find(node => node.classList.contains('wb-pool-meter'));
  assert.equal(poolMeter.children.length, 1); assert.equal(poolMeter.children[0].style.width, '50%');
  assert.match(root.textContent, /2 \/ 4/);
  instanceStrip(root, { mode: 'multi', instance: { pool: { used: null } } }, { document, t });
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-mode-chip')).length, 0, 'the raw mode chip is technical only');
  assert.match(root.textContent, /^wb.inst.modeMulti/, 'the plain view still names the run mode');
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-pool-meter')).length, 0); assert.match(root.textContent, /wb.poolwb.unknown/);
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
  // The state word is its own node: shown in the plain view unless the row is compact, never shown in the
  // technical view, and always part of the label's text so screen readers read it.
  const words = () => root.children.slice(1).map(node => node.children.find(child => child.classList.contains('wb-dist-word')));
  assert.deepEqual(words().map(word => word.className), ['wb-dist-word', 'wb-dist-word']);
  renderDistribution(root, { rows: [row('a')], counts: { busy: 1 } }, { document, t, level: 'technical' });
  assert.equal(root.children[1].textContent, '1 wb.state.busy'); assert.equal(root.children[1].title, 'wb.state.busy 1');
  assert.deepEqual(words().map(word => word.className), ['wb-dist-word wb-vh']);
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

test('plain names say direct or group chat from the key, model names are capitalised and idle groups stand by', () => {
  const document = createDocument(), root = document.createElement('div');
  const plainName = key => ({ ...row(key), name: null, c4: { componentName: 'telegram' } });
  const standby = { ...row('lark:team', 'not_running'), presence: 'not_running', launchConfig: null };
  renderBoard(root, { rows: [plainName('telegram:dm-1001'), plainName('telegram:team-7'), standby] }, { document, t });
  const subs = allNodes(root).filter(node => node.classList.contains('wb-key')).map(node => node.textContent);
  assert.deepEqual(subs.slice(0, 2), ['wb.platform.telegram · wb.chat.dm', 'wb.platform.telegram · wb.chat.group']);
  const now = allNodes(root).filter(node => node.classList.contains('wb-current')).map(node => node.textContent);
  assert.equal(now[2], 'wb.board.standby', 'a group that is not running says it starts on the next message');
  renderBoard(root, { rows: [standby] }, { document, t, level: 'technical' });
  assert.equal(allNodes(root).find(node => node.classList.contains('wb-current')).textContent, '');
  assert.equal(allNodes(root).find(node => node.classList.contains('wb-model')).textContent, 'Claude · default');
});
test('an unnamed Dashboard conversation shows as an untitled conversation with its time, never its id', async () => {
  const { unnamedConversation } = await import('../public/js/wb/plain-text.js');
  const document = createDocument(), id = 'dashboard:bd7d96b3-4d00-48d1-9f2e-7a51c0d2e9aa';
  const at = Date.parse('2026-11-08T06:05:00Z');
  // Core gives the session's creation time in seconds; the last activity is later and must not be used.
  const value = { ...row(id), name: null, createdAt: at / 1000, c4: { componentName: 'dashboard', lastActivityAt: at + 7200e3 }, preview: { timestamp: at + 7200e3, text: 'x' } };
  const plain = renderRow(value, { document, t });
  assert.equal(nameOf(plain), unnamedConversation(value, t));
  assert.match(nameOf(plain), /^chat\.unnamed · \S/);
  assert.doesNotMatch(plain.textContent, /bd7d96b3/, 'the conversation id is not shown in the plain view');
  assert.match(plain.textContent, /wb\.platform\.dashboard/, 'the channel line names Dashboard');
  assert.match(nameOf(renderRow(value, { document, t, level: 'technical' })), /bd7d96b3/, 'the technical view still shows the group key');
  const sameDay = unnamedConversation(value, t, { now: at + 60e3, locale: 'en-GB' });
  assert.equal(sameDay, `chat.unnamed · ${new Date(at).toLocaleString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: ZONE })}`, 'the same day shows the time');
  const later = unnamedConversation(value, t, { now: at + 3 * 86400e3, locale: 'en-GB' });
  assert.equal(later, `chat.unnamed · ${new Date(at).toLocaleString('en-GB', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: ZONE })}`, 'another day adds the date');
  const moved = { ...value, c4: { ...value.c4, lastActivityAt: at + 9 * 86400e3 }, preview: { timestamp: at + 9 * 86400e3, text: 'y' } };
  assert.equal(unnamedConversation(moved, t, { now: at + 60e3, locale: 'en-GB' }), sameDay, 'a new message does not rename it');
  assert.equal(unnamedConversation({ sessionGroup: id, c4: { componentName: 'dashboard', lastActivityAt: at } }, t), 'chat.unnamed', 'without a session time it is just untitled');
});

test('a last-received line starts with its source when the words are not a person\'s own', async () => {
  const { lastReceived } = await import('../public/js/wb/plain-text.js');
  const { packTranslator } = await import('./fixtures/schedule-env.js');
  for (const [locale, scheduled, channel, person] of [
    ['zh', '最近收到：定时任务 · watch-dispatched-cards', '最近收到：Lark · Review ready', '最近收到：看一下'],
    ['en', 'Last received: Scheduled task · watch-dispatched-cards', 'Last received: Lark · Review ready', 'Last received: 看一下'],
  ]) {
    const t = packTranslator(locale);
    assert.equal(lastReceived({ sessionGroup: 'scheduler', preview: { text: 'watch-dispatched-cards', channel: 'scheduler', source: { kind: 'scheduled_task' } } }, t), scheduled);
    assert.equal(lastReceived({ sessionGroup: 'lark:oc_1', preview: { text: 'Review ready', channel: 'lark', source: { kind: 'channel' } } }, t), channel);
    assert.equal(lastReceived({ sessionGroup: 'lark:oc_1', preview: { text: '看一下', channel: 'lark' } }, t), person);
  }
  // A channel the page has no name for is shown by its key.
  assert.equal(lastReceived({ sessionGroup: 'multica:x', preview: { text: 'Review ready', channel: 'multica', source: { kind: 'channel' } } }, (key, vars) => key === 'wb.board.sourceText' ? `${vars.source} · ${vars.text}` : vars?.text ?? key), 'multica · Review ready');
});

test('a last-received line without words names the channel, with the date when the message is not from today', async () => {
  const { lastReceived } = await import('../public/js/wb/plain-text.js');
  setInstanceZone('UTC');
  try {
    const t = (key, vars) => vars ? `${key} ${JSON.stringify(vars)}` : key;
    const now = Date.UTC(2026, 10, 9, 18, 0);
    const row = at => ({ preview: { text: null, channel: 'openmax', timestamp: at } });
    const today = lastReceived(row(Date.UTC(2026, 10, 9, 8, 5)), t, { now, locale: 'en-US' });
    const earlier = lastReceived(row(Date.UTC(2026, 10, 7, 8, 5)), t, { now, locale: 'en-US' });
    assert.match(today, /^wb\.board\.lastReceivedAt \{"channel":"wb\.platform\.openmax","time":"08:05 AM"\}$/);
    assert.match(earlier, /^wb\.board\.lastReceivedAt \{"channel":"wb\.platform\.openmax","time":"11\/7, 08:05 AM"\}$/);
    assert.equal(lastReceived({ preview: { text: null, channel: 'openmax', timestamp: null } }, t), 'wb.board.lastReceivedFrom {"channel":"wb.platform.openmax"}');
  } finally { setInstanceZone(undefined); }
});

const poolTranslations = Object.fromEntries(['zh', 'en'].map(locale => [locale,
  JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'))]));
const poolTranslator = locale => (key, values = {}) => (poolTranslations[locale][key] ?? key)
  .replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);

test('pool source distinguishes fresh, expired, missing, invalid and fallback records in both views and languages', () => {
  const cases = [
    { capacityRecord: { valid: true, fresh: true, source: 'auto' }, capacity: 3,
      zh: '按内存自动', en: 'Automatic, based on memory' },
    { capacityRecord: { valid: true, fresh: false, source: 'auto' }, capacity: 2,
      zh: '上限数据已过期，按 2 运行', en: 'Capacity data expired; running with a limit of 2' },
    { capacityRecord: null, capacity: 5,
      zh: '上限数据不可用，按 5 运行', en: 'Capacity data unavailable; running with a limit of 5' },
    { capacityRecord: { valid: false, fresh: false, source: 'fallback' }, capacity: 4,
      zh: '上限数据不可用，按 4 运行', en: 'Capacity data unavailable; running with a limit of 4' },
    { capacityRecord: { valid: true, fresh: true, source: 'fallback' }, capacity: 1,
      zh: '内存读数不可用，按 1 运行', en: 'Memory reading unavailable; running with a limit of 1' },
    { capacityRecord: { valid: true, fresh: true, source: 'fixed', kMemory: 3 }, capacity: 6,
      zh: '手动设定 6（按内存建议 3）', en: 'Manually set to 6 (memory recommendation: 3)' },
    { capacityRecord: { valid: true, fresh: true, source: 'fixed', kMemory: 3 }, capacity: 3,
      zh: '手动设定', en: 'Manually set' },
    { capacityRecord: { valid: true, fresh: false, source: 'fallback' }, capacity: 2,
      zh: '上限数据已过期，按 2 运行', en: 'Capacity data expired; running with a limit of 2' },
  ];
  for (const locale of ['zh', 'en']) for (const level of ['plain', 'technical']) for (const sample of cases) {
    const document = createDocument(), root = document.createElement('div');
    instanceStrip(root, { mode: 'multi', instance: { pool: { used: sample.capacity, capacity: sample.capacity,
      capacityRecord: sample.capacityRecord } } }, { document, t: poolTranslator(locale), level });
    assert.ok(root.textContent.includes(sample[locale]), `${locale}/${level}: ${sample[locale]}`);
    assert.ok(root.textContent.includes(`${sample.capacity} / ${sample.capacity}`));
    assert.ok(root.textContent.includes(locale === 'zh' ? '在用' : 'in use'));
    if (sample.capacity !== 1) assert.ok(!root.textContent.includes(poolTranslations[locale]['wb.inst.poolFallback']));
    if (sample.capacityRecord?.source === 'fixed' && sample.capacity === sample.capacityRecord.kMemory) {
      assert.doesNotMatch(root.textContent, /按内存建议|memory recommendation/);
    }
    assert.doesNotMatch(root.textContent, /wb\.inst\.pool(?:Auto|Fixed|Fallback|Expired|Unavailable)/);
  }
});

test('single and unreadable instance strips retain sampled counts without capacity or occupancy data', () => {
  const document = createDocument(), root = document.createElement('div');
  for (const mode of ['single', 'unreadable']) for (const locale of ['zh', 'en']) for (const level of ['plain', 'technical']) {
    const t = poolTranslator(locale), pool = { used: 0, capacity: 119,
      capacityRecord: { valid: false, fresh: false, source: 'fallback', reason: 'floor' } };
    instanceStrip(root, { mode, instance: { pool } }, { document, t, level });
    const empty = root.children[1];
    assert.equal(empty.textContent, t(level === 'technical' ? 'wb.inst.pool' : 'wb.pool') + t('wb.unknown'));
    assert.equal(allNodes(empty).some(node => node.classList.contains('wb-pool-meter')), false);
    instanceStrip(root, { mode, instance: { pool: { ...pool, ready: 2, starting: 1, waiting: 4 } } }, { document, t, level });
    const sampled = root.children[1];
    assert.ok(sampled.textContent.includes('3'));
    assert.ok(sampled.textContent.includes(t(level === 'technical' ? 'wb.inst.queuedTech' : 'wb.inst.queued', { count: 4 })));
    assert.equal(sampled.textContent.includes(t('wb.inst.inUse')), level === 'technical');
    assert.doesNotMatch(sampled.textContent, /119|\/|按 .*运行|running with|内存只够|Memory fits/);
    assert.equal(allNodes(sampled).filter(node => node.classList.contains('wb-pool-meter')).length, 0, 'unknown capacity has no made-up proportion');
  }
});

test('pool renders actual occupancy above capacity and preserves sampled waiting separately', () => {
  const document = createDocument(), root = document.createElement('div');
  instanceStrip(root, { mode: 'multi', instance: { pool: { used: 4, capacity: 3, waiting: 7,
    capacityRecord: { valid: true, fresh: true, source: 'auto' } } } }, { document, t: poolTranslator('zh'), level: 'technical' });
  assert.match(root.textContent, /4 \/ 3/); assert.match(root.textContent, /7 排队/);
  const meter = allNodes(root).find(node => node.classList.contains('wb-pool-meter'));
  assert.equal(meter.children.length, 1); assert.equal(meter.children[0].style.width, '100%');
  assert.equal(meter.classList.contains('wb-warn'), true);
  const pool = root.children.find(node => node.textContent.includes('4 / 3'));
  // Whole parts wrap inside the item; the item itself is not made to break inside its labels.
  assert.equal(pool.style.flexWrap, 'wrap'); assert.notEqual(pool.style.whiteSpace, 'normal');
  assert.equal(pool.classList.contains('wb-pool'), true);
  instanceStrip(root, { mode: 'multi', instance: { pool: { used: null, capacity: 3,
    capacityRecord: { valid: true, fresh: true, source: 'auto' } } } }, { document, t: poolTranslator('zh'), level: 'technical' });
  assert.match(root.textContent, /未知/);
  assert.match(root.textContent, /按内存自动/);
  assert.equal(allNodes(root).some(node => node.classList.contains('wb-pool-meter')), false);
});

for (const capacity of [2, 256]) for (const used of [0, 1, capacity]) {
  test(`technical pool meter shows ${used} of ${capacity} without growing with capacity`, () => {
    const document = createDocument(), root = document.createElement('div');
    instanceStrip(root, { mode: 'multi', baselineRuntime: 'claude', instance: {
      accounts: { claude: { used_percentage: 25 } }, pool: { used, capacity }
    } }, { document, t: poolTranslator('zh'), level: 'technical' });
    const pool = allNodes(root).find(node => node.classList.contains('wb-pool'));
    const bars = allNodes(pool).filter(node => node.classList.contains('wb-pool-meter'));
    assert.equal(bars.length, 1);
    const bar = bars[0], fill = bar.children[0];
    assert.equal(bar.classList.contains('wb-meter'), true, 'pool and account use the same meter shape');
    assert.equal(bar.children.length, 1, 'capacity does not allocate one node per slot');
    assert.equal(fill.style.width, used / capacity * 100 + '%');
    assert.equal(fill.style.minWidth, used > 0 ? '2px' : '0', 'any occupied pool stays visible while an empty one stays empty');
    assert.equal(bar.classList.contains('wb-warn'), used >= capacity);
    assert.match(pool.textContent, new RegExp(`${used} / ${capacity}在用`));
    assert.equal(allNodes(pool).some(node => node.classList.contains('wb-slot')), false);
    const account = allNodes(root).find(node => node.classList.contains('wb-account'));
    const quota = allNodes(account).find(node => node.classList.contains('wb-meter'));
    assert.equal(quota.children[0].style.width, '75%', 'pool occupancy does not alter account quota');
    instanceStrip(root, { mode: 'multi', instance: { pool: { used, capacity } } }, { document, t: poolTranslator('zh') });
    assert.equal(allNodes(root).some(node => node.classList.contains('wb-pool-meter')), false, 'the plain view keeps its existing text-only pool');
  });
}

test('pool explanations show only usable published values in the host panel, not in the strip', () => {
  const document = createDocument(), root = document.createElement('div'), GiB = 1073741824;
  const section = document.createElement('section');
  const capacityRecord = { valid: true, fresh: true, source: 'fixed', kMemory: 0, reason: 'floor',
    memory: { source: 'host', limitBytes: 4 * GiB, usedBytes: 3.7 * GiB, reserveBytes: 0.5 * GiB },
    model: { state: 'fitted', slopeBytes: 0.5 * GiB, interceptBytes: 1.3 * GiB, windowDays: 7 } };
  const snapshot = { mode: 'multi', instance: { pool: { used: 2, capacity: 6, capacityRecord } } };
  const view = { mode: snapshot.mode, pool: snapshot.instance.pool };
  const phrases = ['未设内存上限，按整机内存', '内存上限 4 GiB', '已用 3.7 GiB', '保底 0.5 GiB',
    '每会话约 0.5 GiB', '固定开销约 1.3 GiB', '近 7 天', '内存只够 Origin'];
  instanceStrip(root, snapshot, { document, t: poolTranslator('zh'), level: 'plain' });
  assert.match(root.textContent, /手动设定 6（按内存建议 0）/);
  assert.doesNotMatch(root.textContent, /内存上限|固定开销|内存只够/);
  // The strip keeps the source note in both views; the explanations stay out of it and only the title carries them.
  instanceStrip(root, snapshot, { document, t: poolTranslator('zh'), level: 'technical' });
  assert.match(root.textContent, /手动设定 6（按内存建议 0）/);
  const poolNode = root.children.find(node => node.classList.contains('wb-pool'));
  for (const phrase of phrases) assert.equal(poolNode.textContent.includes(phrase), false, phrase);
  assert.doesNotMatch(root.textContent, /内存上限|固定开销|内存只够/);
  assert.equal(allNodes(poolNode).filter(node => node.classList.contains('wb-pool-note')).length, 1);
  assert.ok(poolNode.title.startsWith(poolTranslator('zh')('wb.inst.poolHint')));
  for (const phrase of phrases) assert.ok(poolNode.title.includes(phrase), phrase);
  // The host panel's pool section shows slots, source and every explanation as a whole sentence.
  renderHostPool(section, view, { document, t: poolTranslator('zh') });
  assert.equal(section.hidden, false);
  assert.ok(section.textContent.includes('会话池'));
  assert.ok(section.textContent.includes('名额2 / 6'));
  assert.ok(section.textContent.includes('来源手动设定 6（按内存建议 0）'));
  const items = allNodes(section).filter(node => node.tagName === 'LI').map(node => node.textContent);
  assert.deepEqual(items, ['未设内存上限，按整机内存 · 内存上限 4 GiB · 已用 3.7 GiB · 保底 0.5 GiB',
    '每会话约 0.5 GiB · 固定开销约 1.3 GiB · 近 7 天', '内存只够 Origin，同时运行上限按 1 运行']);
  capacityRecord.kMemory = -2; capacityRecord.reason = null;
  capacityRecord.memory = { source: 'darwin', limitBytes: '4', usedBytes: null, reserveBytes: NaN };
  capacityRecord.model = { state: 'default', slopeBytes: 0.5 * GiB, interceptBytes: 'bad', windowDays: undefined };
  renderHostPool(section, view, { document, t: poolTranslator('en') });
  assert.match(section.textContent, /memory recommendation: -2/);
  assert.match(section.textContent, /Using host memory \(macOS\)/);
  assert.match(section.textContent, /Still gathering data/);
  assert.match(section.textContent, /about 0.5 GiB per session/);
  assert.doesNotMatch(section.textContent, /Memory limit|fixed overhead|NaN|undefined|last .* days|Memory fits/);
});

test('the host panel pool section shows slots and source only for the record a missing record file gives', () => {
  // In multi mode the server always sends a record; a missing or invalid record file gives { valid: false, fresh: false }.
  const document = createDocument(), section = document.createElement('section');
  for (const [capacity, slots, source] of [[3, '1 / 3', '上限数据不可用，按 3 运行'], [null, '1', null]]) {
    renderHostPool(section, { mode: 'multi', pool: { used: 1, capacity, capacityRecord: { valid: false, fresh: false } } },
      { document, t: poolTranslator('zh') });
    assert.equal(section.hidden, false, `capacity ${capacity}`);
    const values = allNodes(section).filter(node => node.tagName === 'B' || node.tagName === 'SPAN').map(node => node.textContent);
    assert.ok(section.textContent.includes('名额' + slots), section.textContent);
    if (capacity == null) assert.equal(values.includes('1 / 3'), false);
    if (source) assert.ok(section.textContent.includes('来源' + source), section.textContent);
    else assert.equal(section.textContent.includes('来源'), false, section.textContent);
    assert.equal(allNodes(section).some(node => node.tagName === 'UL' || node.tagName === 'LI'), false, 'no explanation list');
  }
});

test('the host panel pool section stays hidden outside multi mode and without a record', () => {
  const document = createDocument(), section = document.createElement('section'), t = poolTranslator('zh');
  const record = { valid: true, fresh: true, source: 'auto' };
  for (const view of [null, { mode: 'single', pool: { used: 1, capacity: 3, capacityRecord: record } },
    { mode: 'unreadable', pool: { used: 1, capacity: 3, capacityRecord: record } },
    { mode: 'multi', pool: { used: 1, capacity: 3 } }, { mode: 'multi', pool: { used: 1, capacity: 3, capacityRecord: null } },
    { mode: 'multi', pool: { used: 1, capacity: 3, capacityRecord: {} } }, { mode: 'multi' }]) {
    renderHostPool(section, { mode: 'multi', pool: { used: 1, capacity: 3, capacityRecord: record } }, { document, t });
    assert.equal(section.hidden, false);
    renderHostPool(section, view, { document, t });
    assert.equal(section.hidden, true, JSON.stringify(view));
    assert.equal(section.children.length, 0);
  }
});

// Pool presentation integration: run when pool fields, wait rendering or reminder
// translations change; skip unrelated features. Real renderers plus injected DOM
// and repository packs only; no sockets, timers or live state. The official runner
// supplies temporary HOME/ZYLOS_DIR/PM2_HOME/TMPDIR and a private tmux namespace.
test('board and detail share snapshot queue positions while the pool reminder uses its own waiting count', () => {
  const document = createDocument(), root = document.createElement('div');
  for (const locale of ['zh', 'en']) {
    const t = poolTranslator(locale);
    for (const level of ['plain', 'technical']) {
      const value = { ...row('b', 'waiting'), presence: 'not_running', tools: [], wait: { kind: 'pool_wait', position: 2 } };
      const expected = locale === 'zh' ? `${level === 'technical' ? '等池位' : '排队中'} · 第 2 个`
        : `${level === 'technical' ? 'Waiting for a slot' : 'Queueing'} · position 2`;
      renderBoard(root, { rows: [value] }, { document, t, level });
      assert.ok(root.textContent.includes(expected));
      const technical = locale === 'zh' ? '按当前快照估计' : 'estimated from the current snapshot';
      assert.equal(root.textContent.includes(technical), level === 'technical');
      renderOverview(root, value, {}, { document, t, level, snapshot: { rows: [value] } });
      assert.ok(root.textContent.includes(expected));
      assert.equal(root.textContent.includes(technical), level === 'technical');
      renderAttention(root, { attention: { problems: [], reminders: [{ kind: 'pool_full', waiting: 2 }] },
        instance: { pool: { waiting: 99 } } }, { document, t, level });
      assert.equal(root.children.length, 1);
      assert.equal(root.children[0].classList.contains('wb-attention-reminder'), true);
      assert.equal(root.children[0].tagName, 'DIV');
      assert.match(root.textContent, locale === 'zh' ? /同时运行已满 · 2 组在等名额/ : /Concurrent sessions full · 2 groups waiting/);
      assert.equal(allNodes(root).some(node => node.classList.contains('wb-ico-clock')), true);
      assert.doesNotMatch(root.textContent, /99|\{waiting\}/);
    }
  }
  assert.equal(waitText(null, 'plain', poolTranslator('zh')), '');
  assert.equal(waitText({ kind: 'pool_wait', position: '<img>' }, 'plain', poolTranslator('zh')), '排队中 · 第 — 个');
});
