import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick, visibleText } from './helpers/conversation-dom.js';
import { activityPlacement, createActivityArea, formatDuration, stepCount, stepText } from '../public/js/wb/conversation-activity.js';
import { createScrollGesture } from '../public/js/wb/scroll-gesture.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');

// Injected DOM and fetch only: no browser, sockets, databases, storage or subprocesses.
const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.zh.json', import.meta.url), 'utf8'));
const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url), 'utf8'));
const t = key => zh[key] ?? key;
const T = 1_800_000_000_000;
const s = seconds => T + seconds * 1000;
const tool = (start, end, status = 'done', label = { key: 'read', arg: 'memory/state.md' }) => ({ kind: 'tool', label, status, start: s(start), end: end === null ? null : s(end) });
const round = (key, { messageIds = [Number(key)], state = 'done', start = 0, end = 60, segments }) =>
  ({ key, messageIds, start: s(start), end: end === null ? null : s(end), state, segments });
const activity = (items, rounds) => ({ items: new Map(items.map(item => [item.id, item])), rounds: new Map(rounds.map(r => [r.key, r])), offset: 0 });
const msg = (id, direction) => ({ id, direction });

test('durations read <1 s, seconds, minutes and hours in both languages', () => {
  assert.deepEqual([400, 59_999, 125_000, 3_725_000].map(ms => formatDuration(ms, t)), ['<1 秒', '59 秒', '2 分 5 秒', '1 小时 2 分']);
  assert.deepEqual([0, 5_000, 61_000].map(ms => formatDuration(ms, key => en[key])), ['<1 s', '5 s', '1 min 1 s']);
});

test('step text uses plain words and the agent description, never a tool name', () => {
  assert.equal(stepText(tool(0, 1), t), '查看 memory/state.md');
  assert.equal(stepText({ label: { key: 'described', arg: '检查磁盘' } }, t), '检查磁盘');
  assert.equal(stepText({ label: { key: 'runCommand' } }, t), '运行命令');
  assert.equal(stepText({ label: { key: 'subagent', arg: '查锁文件' } }, t), '子任务：查锁文件');
  assert.equal(stepText({ label: { key: 'subagent' } }, t), '子任务');
  assert.equal(stepText({ label: { key: 'tool' } }, key => en[key]), 'Use a tool');
  assert.equal(stepCount({ steps: [tool(0, 1), { kind: 'say', text: 'x' }, { kind: 'subagent', label: { key: 'subagent' } }] }), 2);
});

test('while a round runs its activity stays open under the latest message; the final reply folds it above itself', () => {
  const running = activity([{ id: 1, state: 'round', round: '1' }],
    [round('1', { state: 'running', end: null, segments: [{ replyId: null, start: s(0), end: null, steps: [tool(1, 2)] }] })]);
  let placed = activityPlacement([msg(1, 'in')], running);
  assert.equal(placed.trailing.length, 1); assert.equal(placed.trailing[0].live, true); assert.equal(placed.trailing[0].anchor, 1);
  assert.equal(placed.folded.size, 0);
  const done = activity([{ id: 1, state: 'round', round: '1' }],
    [round('1', { segments: [{ replyId: 2, start: s(0), end: s(59), steps: [tool(1, 2)] }, { replyId: null, start: s(59), end: s(60), steps: [] }] })]);
  placed = activityPlacement([msg(1, 'in'), msg(2, 'out')], done);
  assert.equal(placed.trailing.length, 0);
  assert.deepEqual([...placed.folded.keys()], [2]);
  assert.equal(placed.folded.get(2)[0].live, false);
});

test('a reply without steps gets no activity area', () => {
  const quiet = activity([{ id: 1, state: 'round', round: '1' }],
    [round('1', { segments: [{ replyId: 2, start: s(0), end: s(3), steps: [{ kind: 'say', text: 'ok', at: s(1) }] }, { replyId: null, start: s(3), end: s(4), steps: [] }] })]);
  const placed = activityPlacement([msg(1, 'in'), msg(2, 'out')], quiet);
  assert.equal(placed.folded.size, 0); assert.equal(placed.trailing.length, 0);
  assert.equal(activityPlacement([msg(5, 'in')], activity([{ id: 5, state: 'none' }], [])).trailing.length, 0);
  assert.equal(activityPlacement([msg(5, 'in')], activity([{ id: 5, state: 'pending' }], [])).trailing.length, 0);
});

test('the live area moves under a message just sent before the server ties it to the running round', () => {
  const live = round('1', { state: 'running', end: null, segments: [{ replyId: null, start: 0, end: null, steps: [tool(1, null, 'running')] }] });
  for (const later of [undefined, { id: 3, state: 'pending' }]) {
    const items = [{ id: 1, state: 'round', round: '1' }, ...(later ? [later] : [])];
    const placed = activityPlacement([msg(1, 'in'), msg(3, 'in')], activity(items, [live]));
    assert.equal(placed.trailing.length, 1);
    assert.equal(placed.trailing[0].anchor, 3, 'it sits under the latest user message right away');
  }
  const ended = round('1', { state: 'done', end: 9, segments: [{ replyId: null, start: 0, end: 9, steps: [tool(1, 9, 'done')] }] });
  const placed = activityPlacement([msg(1, 'in'), msg(3, 'in')], activity([{ id: 1, state: 'round', round: '1' }, { id: 3, state: 'pending' }], [ended]));
  assert.equal(placed.trailing[0].anchor, 1, 'a finished round stays with its own messages');
  const other = activityPlacement([msg(1, 'in'), msg(3, 'in')], activity([{ id: 1, state: 'round', round: '1' }, { id: 3, state: 'none' }], [live]));
  assert.equal(other.trailing[0].anchor, 1, 'a message known to start no round does not take the live area');
});

test('a message sent while the agent works moves the one activity under it with the steps so far', () => {
  const steps = [tool(1, 2), tool(3, null, 'running')];
  const shared = round('1', { messageIds: [1, 3], state: 'running', end: null, segments: [{ replyId: null, start: s(0), end: null, steps }] });
  const placed = activityPlacement([msg(1, 'in'), msg(3, 'in')], activity([{ id: 1, state: 'round', round: '1' }, { id: 3, state: 'round', round: '1' }], [shared]));
  assert.equal(placed.trailing.length, 1, 'only one activity area on the page');
  assert.equal(placed.trailing[0].anchor, 3, 'it sits under the latest user message');
  assert.equal(placed.trailing[0].segment.steps, steps, 'earlier steps come along');
});

test('a split reply folds the part up to it and the later steps start a new live part after it', () => {
  const parts = [{ replyId: 2, start: s(0), end: s(25), steps: [tool(1, 2), tool(3, 4)] }, { replyId: null, start: s(25), end: null, steps: [] }];
  const items = [{ id: 1, state: 'round', round: '1' }];
  let placed = activityPlacement([msg(1, 'in'), msg(2, 'out')], activity(items, [round('1', { state: 'running', end: null, segments: parts })]));
  assert.equal(placed.folded.get(2).length, 1);
  assert.equal(placed.trailing.length, 0, 'right after a reply nothing new is shown until the agent does something');
  parts[1].steps = [tool(30, null, 'running')];
  placed = activityPlacement([msg(1, 'in'), msg(2, 'out')], activity(items, [round('1', { state: 'running', end: null, segments: parts })]));
  assert.equal(placed.trailing.length, 1); assert.equal(placed.trailing[0].anchor, 2); assert.equal(placed.trailing[0].live, true);
});

test('the live head shows elapsed round time and steps; thinking shows only when no tool runs', () => {
  const document = createDocument();
  const area = createActivityArea({ document, t });
  const segment = { replyId: null, start: s(0), end: null, steps: [tool(0, 5), tool(4, 8), { kind: 'say', text: '找到了', at: s(9) }] };
  const entry = { key: '1:tail', live: true, round: { state: 'running' }, segment };
  area.update(entry, { open: false, now: s(72) });
  assert.equal(area.node.querySelector('.conversation-activity-head').textContent, '已用时 1 分 12 秒 · 2 步', 'round clock, not the sum of overlapping steps');
  assert.ok(area.node.querySelector('.conversation-activity-thinking'), 'thinking while no tool runs');
  assert.equal(area.node.querySelector('button'), null, 'the live head is not a toggle');
  segment.steps.push(tool(70, null, 'running'));
  area.update(entry, { open: false, now: s(72) });
  assert.equal(area.node.querySelector('.conversation-activity-thinking'), null, 'no thinking while a tool runs');
  assert.equal(area.node.querySelectorAll('.conversation-activity-step').at(-1).dataset.status, 'running');
  assert.equal(area.node.querySelectorAll('.conversation-activity-time').at(-1).textContent, '2 秒');
});

test('a folded part is a toggle with its own time; failed and stopped steps say so', () => {
  const document = createDocument();
  const toggled = [];
  const area = createActivityArea({ document, t, onToggle: key => toggled.push(key) });
  const segment = { replyId: 2, start: s(10), end: s(135), steps: [tool(11, 41, 'failed'), tool(50, 60, 'stopped'), tool(61, 62, 'incomplete')] };
  const entry = { key: '1:2', live: false, round: { state: 'done' }, segment };
  area.update(entry, { open: false, now: s(500) });
  const head = area.node.querySelector('button');
  assert.equal(head.textContent, '已处理 2 分 5 秒 · 3 步');
  assert.equal(head.getAttribute('aria-expanded'), 'false');
  assert.equal(area.node.querySelector('.conversation-activity-steps').hidden, true);
  head.dispatch('click');
  assert.deepEqual(toggled, ['1:2']);
  area.update(entry, { open: true, now: s(500) });
  assert.equal(area.node.dataset.open, '');
  assert.deepEqual(area.node.querySelectorAll('.conversation-activity-time').map(node => node.textContent),
    ['没有完成 · 30 秒', '已停止 · 10 秒', '没有完成 · 1 秒']);
});

test('a step still running in a folded part never shows more time than the part itself', () => {
  const document = createDocument();
  const area = createActivityArea({ document, t, onToggle() {} });
  // The round ended at 27 s and is settling: the collectors have not reported this step's end yet.
  const segment = { replyId: 2, start: s(0), end: s(27), steps: [tool(5, null, 'running')] };
  const entry = { key: '1:2', live: false, round: { state: 'done', settling: true }, segment };
  area.update(entry, { open: true, now: s(45) });
  assert.match(area.node.querySelector('button').textContent, /已处理 27 秒/);
  assert.equal(area.node.querySelector('.conversation-activity-time').textContent, '22 秒', 'counted to the end of its part, not to now');
  area.update({ ...entry, live: true, segment: { ...segment, end: null } }, { open: true, now: s(45) });
  assert.equal(area.node.querySelector('.conversation-activity-time').textContent, '40 秒', 'a live part keeps counting');
});

function pageFixture(context, { rows, activityBody, activityStatus = () => 200 }) {
  const document = createDocument(), root = document.createElement('div');
  const timers = [];
  document.defaultView = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval: () => 9, clearInterval() {}, innerWidth: 1280 };
  const reads = [];
  const page = mountConversationPage({ root, document, t, fetch: async path => {
    if (path.includes('/activity?')) reads.push(new URLSearchParams(path.split('?')[1]).get('ids'));
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.startsWith('/api/chat/conversations?') ? { items: [{ id: 'g:AA', sessionGroup: 'dashboard:a', displayName: 'A' }], nextCursor: null }
      : path.includes('/messages?') ? { items: rows(), nextCursor: null, afterCursor: 'after' }
      : path.includes('/activity?') ? (activityStatus() === 200 ? activityBody() : { error: 'not_found' })
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', sessionGroup: 'dashboard:a', state: 'active' } }
      : { items: [], nextCursor: null };
    const status = path.includes('/activity?') ? activityStatus() : 200;
    return { ok: status === 200, status, json: async () => body };
  } });
  context.after(() => page.destroy());
  return { document, root, page, timers, reads, async open() {
    await page.open();
    allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click');
    for (let i = 0; i < 6; i++) await tick();
  } };
}
const doneBody = (now = s(600)) => ({ now, items: [{ id: 1, state: 'round', round: '1' }], rounds: [round('1', {
  segments: [{ replyId: 2, start: s(0), end: s(59), steps: [tool(1, 2), tool(3, 4)] }, { replyId: null, start: s(59), end: s(60), steps: [] }] })] });

test('history activity is folded above its reply, outside the reply content, and a manual open survives redraws', async t => {
  const rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }, { id: 2, direction: 'out', content: 'done', status: 'delivered' }];
  const f = pageFixture(t, { rows: () => rows, activityBody: () => doneBody() });
  await f.open();
  const reply = f.root.querySelector('[data-message-id="2"]');
  const area = reply.querySelector('.conversation-activity');
  assert.ok(area, 'folded activity on the reply');
  assert.equal(area.closest('.chat-message-content'), null, 'activity is never part of the reply content');
  assert.equal(reply.querySelector('.chat-message-content').textContent.includes('已处理'), false);
  assert.equal(area.querySelector('.conversation-activity-steps').hidden, true, 'history is folded by default');
  area.querySelector('button').dispatch('click');
  assert.equal(area.querySelector('.conversation-activity-steps').hidden, false);
  f.page.redraw();
  const again = f.root.querySelector('[data-message-id="2"]').querySelector('.conversation-activity');
  assert.equal(again.querySelector('.conversation-activity-steps').hidden, false, 'manual open is kept across redraws');
  f.root.querySelector('[data-action="refreshMessages"]').dispatch('click');
  for (let i = 0; i < 6; i++) await tick();
  assert.equal(f.root.querySelector('[data-message-id="2"]').querySelector('.conversation-activity-steps').hidden, false,
    'a later update does not fold it back');
  assert.deepEqual(f.reads, ['1'], 'a finished round is not read again');
});

test('the live activity follows the latest message and folds onto the final reply when it arrives', async t => {
  let rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }];
  let body = { now: s(30), items: [{ id: 1, state: 'round', round: '1' }], rounds: [round('1', { state: 'running', end: null,
    segments: [{ replyId: null, start: s(0), end: null, steps: [tool(1, 2), tool(3, null, 'running')] }] })] };
  const f = pageFixture(t, { rows: () => rows, activityBody: () => body });
  await f.open();
  const list = f.root.querySelector('.conversation-message-list');
  const live = list.querySelectorAll('.conversation-activity-message');
  assert.equal(live.length, 1);
  assert.equal(list.children.indexOf(live[0]), list.children.indexOf(f.root.querySelector('[data-message-id="1"]')) + 1);
  assert.match(visibleText(live[0]), /已用时 30 秒 · 2 步/);
  assert.equal(live[0].dataset.messageId, undefined, 'the live area is not a message');
  rows = [...rows, { id: 2, direction: 'out', content: 'done', status: 'delivered' }];
  body = doneBody(s(61));
  f.root.querySelector('[data-action="refreshMessages"]').dispatch('click');
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(list.querySelectorAll('.conversation-activity-message').length, 0, 'no live area once the round is done');
  const folded = f.root.querySelector('[data-message-id="2"]').querySelector('.conversation-activity');
  assert.equal(folded.querySelector('.conversation-activity-steps').hidden, true, 'the final reply folds the activity');
});

test('scroll position is never written while the user drags; afterwards it follows only a user who stayed at the bottom', async t => {
  const rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }];
  const f = pageFixture(t, { rows: () => rows, activityBody: () => doneBody() });
  await f.open();
  const stream = f.root.querySelector('.conversation-stream');
  let writes = 0, top = 0, heights = [1000];
  Object.defineProperty(stream, 'scrollTop', { get: () => top, set: value => { writes++; top = value; }, configurable: true });
  // The first read is the height before the redraw; later reads see the content it added.
  Object.defineProperty(stream, 'scrollHeight', { get: () => heights.length > 1 ? heights.shift() : heights[0], set() {}, configurable: true });
  stream.clientHeight = 500; top = 500;
  stream.dispatch('touchstart', {});
  heights = [1000, 1200];
  f.page.redraw();
  assert.equal(writes, 0, 'no write during the touch');
  stream.dispatch('touchend', {});
  const settle = f.timers.filter(timer => timer.fn && timer.ms === 180).at(-1);
  settle.fn();
  assert.equal(top, 1200, 'still at the old bottom after the gesture: follow the new content');
  writes = 0;
  stream.dispatch('wheel', {});
  top = 300; heights = [1200, 1400];
  f.page.redraw();
  assert.equal(writes, 0);
  f.timers.filter(timer => timer.fn && timer.ms === 180).at(-1).fn();
  assert.equal(writes, 0, 'a user who scrolled away is not pulled back');
});

test('scroll gesture covers touch, pointer, wheel and momentum and cleans up its timer', () => {
  const listeners = new Map(), docListeners = new Map(), timers = new Map();
  let next = 0, settled = 0;
  const target = { ownerDocument: { addEventListener: (type, fn) => docListeners.set(type, fn), removeEventListener: type => docListeners.delete(type) },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const gesture = createScrollGesture(target, { setTimeout: fn => { timers.set(++next, fn); return next; },
    clearTimeout: id => timers.delete(id), onSettle: () => settled++ });
  const runLast = () => { const [id, fn] = [...timers].at(-1); timers.delete(id); fn(); };
  listeners.get('pointerdown')({ pointerType: 'mouse', button: 0 });
  assert.equal(gesture.active, false, 'a mouse press alone is a click, not yet a gesture');
  listeners.get('scroll')();
  assert.equal(gesture.active, true, 'the list moving under the held button makes it a gesture');
  assert.equal(timers.size, 0, 'no settling while the pointer is held');
  docListeners.get('pointerup')();
  assert.equal(timers.size, 1, 'release starts the quiet period');
  const [released] = timers.keys();
  listeners.get('scroll')();
  assert.equal(timers.has(released), false, 'momentum cancels the running quiet period');
  assert.equal(timers.size, 1, 'and starts a new one');
  assert.equal(gesture.active, true); assert.equal(settled, 0, 'still moving: not settled');
  runLast();
  assert.equal(gesture.active, false); assert.equal(settled, 1);
  listeners.get('pointerdown')({ pointerType: 'mouse', button: 2 });
  assert.equal(gesture.active, false, 'a right click is not a scroll');
  listeners.get('wheel')();
  assert.equal(gesture.active, true);
  gesture.destroy();
  assert.equal(timers.size, 0); assert.equal(listeners.size, 0); assert.equal(docListeners.size, 0);
});

test('a press on a control is a click: only a list that moves under it, a touch elsewhere or the wheel is a gesture', () => {
  const listeners = new Map(), docListeners = new Map(), timers = new Map();
  let next = 0, settled = 0;
  const target = { ownerDocument: { addEventListener: (type, fn) => docListeners.set(type, fn), removeEventListener: type => docListeners.delete(type) },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const gesture = createScrollGesture(target, { setTimeout: fn => { timers.set(++next, fn); return next; },
    clearTimeout: id => timers.delete(id), onSettle: () => settled++ });
  const control = selector => ({ closest: wanted => wanted.split(',').map(part => part.trim()).includes(selector) ? {} : null });
  for (const selector of ['button', 'a', 'input', 'textarea', 'select', 'label', 'summary', '[role="button"]', '[contenteditable]']) {
    listeners.get('pointerdown')({ pointerType: 'mouse', button: 0, target: control(selector) });
    docListeners.get('pointerup')();
    listeners.get('touchstart')({ target: control(selector) });
    listeners.get('touchend')();
    assert.equal(gesture.active, false, `a click or tap on ${selector} is not a gesture`);
  }
  assert.equal(timers.size, 0, 'a click leaves nothing to settle');
  assert.equal(settled, 0);
  listeners.get('touchstart')({ target: control('button') });
  listeners.get('scroll')();
  assert.equal(gesture.active, true, 'a swipe that starts on a button and moves the list is a gesture');
  listeners.get('touchend')();
  [...timers.values()].at(-1)();
  assert.equal(gesture.active, false); assert.equal(settled, 1);
  listeners.get('touchstart')({ target: control('div') });
  assert.equal(gesture.active, true, 'a touch on the list itself is a gesture at once');
  gesture.destroy();
});

test('a click right after the wheel still lets the wheel settle, even when its quiet period ends while the button is held', () => {
  const listeners = new Map(), docListeners = new Map(), timers = new Map();
  let next = 0, settled = 0;
  const target = { ownerDocument: { addEventListener: (type, fn) => docListeners.set(type, fn), removeEventListener: type => docListeners.delete(type) },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type) };
  const gesture = createScrollGesture(target, { setTimeout: fn => { timers.set(++next, fn); return next; },
    clearTimeout: id => timers.delete(id), onSettle: () => settled++ });
  const button = { closest: wanted => wanted.split(',').map(part => part.trim()).includes('button') ? {} : null };
  const runAll = () => { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } };
  for (const [kind, down, up] of [['mouse', () => listeners.get('pointerdown')({ pointerType: 'mouse', button: 0, target: button }), () => docListeners.get('pointerup')()],
    ['touch', () => listeners.get('touchstart')({ target: button }), () => listeners.get('touchend')()]]) {
    const before = settled;
    listeners.get('wheel')();
    assert.equal(gesture.active, true, `${kind}: the wheel is a gesture`);
    down();
    runAll();
    assert.equal(gesture.active, true, `${kind}: the quiet period ends while the button is still held`);
    up();
    assert.equal(timers.size, 1, `${kind}: releasing the click starts a new quiet period for the wheel`);
    runAll();
    assert.equal(gesture.active, false, `${kind}: the gesture ends after the click`);
    assert.equal(settled, before + 1, `${kind}: the page catches up once`);
  }
  listeners.get('pointerdown')({ pointerType: 'mouse', button: 0, target: button });
  docListeners.get('pointerup')();
  assert.equal(timers.size, 0, 'a click with no gesture before it still leaves nothing to settle');
  gesture.destroy();
});

/**
 * A page whose message rows are `rowHeight()` px tall (100 by default), in list order, inside a 500 px tall stream;
 * `older` is one more page. Animation frames and window listeners are kept so a test can run them.
 */
function layoutFixture(context, { rows, older, rowHeight = () => 100 }) {
  const document = createDocument(), root = document.createElement('div');
  const create = document.createElement, docListeners = new Map(), viewListeners = new Map(), timers = [], frames = [];
  let stream = null;
  document.createElement = tag => {
    const node = create(tag);
    node.getClientRects = () => [];
    Object.defineProperty(node, 'isConnected', { get: () => { for (let at = node; at; at = at.parentNode) if (at === root) return true; return false; } });
    node.getBoundingClientRect = () => {
      if (node === stream) return { top: 0, bottom: 500 };
      const list = node.parentNode;
      if (!list?.classList.contains('conversation-message-list')) return { top: 0, bottom: 0 };
      const height = rowHeight(), top = list.children.indexOf(node) * height - (stream?.scrollTop ?? 0);
      return { top, bottom: top + height };
    };
    return node;
  };
  document.addEventListener = (type, fn) => docListeners.set(type, fn);
  document.removeEventListener = type => docListeners.delete(type);
  document.defaultView = { addEventListener: (type, fn) => viewListeners.set(type, fn), removeEventListener: type => viewListeners.delete(type),
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame: id => { if (frames[id - 1]) frames[id - 1] = null; },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval: () => 9, clearInterval() {}, innerWidth: 1280 };
  const page = mountConversationPage({ root, document, t, fetch: async path => {
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.startsWith('/api/chat/conversations?') ? { items: [{ id: 'g:AA', sessionGroup: 'dashboard:a', displayName: 'A' }], nextCursor: null }
      : path.includes('/messages?') && path.includes('cursor=older') ? { items: older, nextCursor: null }
      : path.includes('/messages?') ? { items: rows, nextCursor: 'older', afterCursor: 'after' }
      : path.includes('/activity?') ? { now: s(0), items: [], rounds: [] }
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', sessionGroup: 'dashboard:a', state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  context.after(() => page.destroy());
  const runFrames = () => { for (let i = 0; i < frames.length; i++) { const fn = frames[i]; frames[i] = null; fn?.(); } };
  return { root, page, timers, frames, runFrames, docListeners, viewListeners, view: document.defaultView, async open() {
    await page.open();
    allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click');
    for (let i = 0; i < 6; i++) await tick();
    stream = root.querySelector('.conversation-stream');
    const list = root.querySelector('.conversation-message-list');
    Object.defineProperty(stream, 'scrollHeight', { get: () => list.children.length * rowHeight(), set() {}, configurable: true });
    stream.clientHeight = 500;
    return { stream, list };
  } };
}
const reply = id => ({ id, direction: 'out', content: `reply ${id}`, status: 'delivered' });

test('clicking load older keeps the message being read where it was, even with the mouse still on the button', async t => {
  const f = layoutFixture(t, { rows: Array.from({ length: 10 }, (_, i) => reply(11 + i)), older: Array.from({ length: 10 }, (_, i) => reply(1 + i)) });
  const { stream, list } = await f.open();
  stream.scrollTop = 300;
  const reading = list.querySelector('[data-message-id="14"]');
  assert.equal(reading.getBoundingClientRect().top, 0, 'the row being read is at the top of the view');
  const older = f.root.querySelector('[data-action="loadOlder"]');
  assert.equal(older.hidden, false);
  stream.dispatch('pointerdown', { pointerType: 'mouse', button: 0, target: older });
  older.dispatch('click');
  for (let i = 0; i < 8; i++) await tick();
  assert.ok(list.querySelector('[data-message-id="1"]'), 'the older page is shown');
  assert.equal(reading.getBoundingClientRect().top, 0, 'the row being read did not move while the button was held');
  f.docListeners.get('pointerup')();
  for (const timer of f.timers.filter(timer => timer.fn && timer.ms === 180)) timer.fn();
  assert.equal(reading.getBoundingClientRect().top, 0, 'nor after the button was released');
});

test('content that moves during a drag is moved back once the drag settles, unless the user follows the bottom', async t => {
  const f = layoutFixture(t, { rows: Array.from({ length: 10 }, (_, i) => reply(11 + i)), older: Array.from({ length: 10 }, (_, i) => reply(1 + i)) });
  const { stream, list } = await f.open();
  stream.scrollTop = 300;
  const reading = list.querySelector('[data-message-id="14"]');
  stream.dispatch('touchstart', {});
  f.root.querySelector('[data-action="loadOlder"]').dispatch('click');
  for (let i = 0; i < 8; i++) await tick();
  assert.equal(reading.getBoundingClientRect().top, 1000, 'the position is not written while the finger is down');
  stream.dispatch('touchend', {});
  f.timers.filter(timer => timer.fn && timer.ms === 180).at(-1).fn();
  assert.equal(reading.getBoundingClientRect().top, 0, 'once the list is still, the older page no longer pushes the row away');
});

test('a column that changes width while the list is still scrolling keeps the message being read once it settles', async t => {
  let collapsed = null;
  // Hiding the conversation list widens the conversation, so every row wraps to 80 px instead of 100 px.
  const f = layoutFixture(t, { rows: Array.from({ length: 10 }, (_, i) => reply(11 + i)), rowHeight: () => collapsed?.classList.contains('conversation-list-collapsed') ? 80 : 100 });
  const { stream, list } = await f.open();
  collapsed = f.root.querySelector('.conversation-page') ?? f.root.firstElementChild;
  stream.scrollTop = 300;
  const reading = list.querySelector('[data-message-id="14"]');
  assert.equal(reading.getBoundingClientRect().top, 0);
  stream.dispatch('wheel', {});
  const toggle = f.root.querySelector('.conversation-list-toggle');
  stream.dispatch('pointerdown', { pointerType: 'mouse', button: 0, target: toggle });
  toggle.dispatch('click');
  f.docListeners.get('pointerup')();
  assert.ok(collapsed.classList.contains('conversation-list-collapsed'), 'the list is hidden');
  assert.equal(reading.getBoundingClientRect().top, -60, 'while the wheel is still settling the position is not written');
  for (const timer of f.timers.filter(timer => timer.fn && timer.ms === 180)) timer.fn();
  assert.equal(reading.getBoundingClientRect().top, 0, 'once it settles, the row being read is back where it was');
});

test('fitting the page while the list is still scrolling keeps the message being read once it settles', async t => {
  let fitted = null;
  // A shorter page makes the stream show its scrollbar, which narrows the column so the rows wrap to 110 px.
  const f = layoutFixture(t, { rows: Array.from({ length: 10 }, (_, i) => reply(11 + i)), rowHeight: () => parseInt(fitted?.style.height, 10) < 700 ? 110 : 100 });
  f.view.innerHeight = 800;
  const { stream, list } = await f.open();
  fitted = f.root.firstElementChild;
  fitted.getClientRects = () => [{}];
  f.viewListeners.get('resize')();
  f.runFrames();
  assert.equal(fitted.style.height, '800px');
  stream.scrollTop = 300;
  const reading = list.querySelector('[data-message-id="14"]');
  assert.equal(reading.getBoundingClientRect().top, 0);
  stream.dispatch('touchstart', {});
  f.view.innerHeight = 600;
  f.viewListeners.get('resize')();
  f.runFrames();
  assert.equal(fitted.style.height, '600px');
  assert.equal(reading.getBoundingClientRect().top, 30, 'while the finger is down the position is not written');
  stream.dispatch('touchend', {});
  f.timers.filter(timer => timer.fn && timer.ms === 180).at(-1).fn();
  assert.equal(reading.getBoundingClientRect().top, 0, 'once the list is still, the row being read is back where it was');
});

test('opening a folded part with the mouse or the keyboard keeps its head where it was on screen', async t => {
  const rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }, { id: 2, direction: 'out', content: 'done', status: 'delivered' }];
  const f = pageFixture(t, { rows: () => rows, activityBody: () => doneBody() });
  const docListeners = new Map();
  f.document.addEventListener = (type, fn) => docListeners.set(type, fn);
  await f.open();
  const stream = f.root.querySelector('.conversation-stream');
  let top = 400;
  Object.defineProperty(stream, 'scrollTop', { get: () => top, set: value => { top = value; }, configurable: true });
  const area = f.root.querySelector('[data-message-id="2"]').querySelector('.conversation-activity');
  const head = area.firstElementChild;
  assert.equal(head.tagName, 'BUTTON');
  head.isConnected = true;
  // Opening the part grows the content above the head by 60 px in this layout.
  head.getBoundingClientRect = () => ({ top: area.querySelector('.conversation-activity-steps').hidden ? 200 : 260, bottom: 0 });
  stream.dispatch('pointerdown', { pointerType: 'mouse', button: 0, target: head });
  head.dispatch('click');
  assert.equal(top, 460, 'a mouse click keeps the head in place');
  head.focus();
  head.dispatch('click');
  assert.equal(top, 400, 'so does Enter or Space on the focused head (a click without a pointer press)');
  stream.dispatch('touchstart', {});
  head.dispatch('click');
  assert.equal(top, 400, 'during a touch gesture the position is not written');
  stream.dispatch('touchend', {});
  f.timers.filter(timer => timer.fn && timer.ms === 180).at(-1).fn();
  assert.equal(top, 460, 'it is caught up once the list is still');
});

const refresh = async f => {
  f.root.querySelector('[data-action="refreshMessages"]').dispatch('click');
  for (let i = 0; i < 8; i++) await tick();
};
const running = (steps, { start = 2, now = 3 } = {}) => ({ now: s(now), items: [{ id: 1, state: 'round', round: '1' }],
  rounds: [round('1', { state: 'running', start, end: null, segments: [{ replyId: null, start: s(start), end: null, steps }] })] });

test('a message waiting for its turn has no activity; when the turn starts the live area appears under it and thinks until a tool runs', async t => {
  const rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }];
  let body = { now: s(1), items: [{ id: 1, state: 'pending' }], rounds: [] };
  const f = pageFixture(t, { rows: () => rows, activityBody: () => body });
  await f.open();
  const list = f.root.querySelector('.conversation-message-list');
  const opened = f.reads.length;
  assert.equal(list.querySelectorAll('.conversation-activity').length, 0, 'no activity before the turn starts');
  assert.equal(list.querySelectorAll('.conversation-activity-thinking').length, 0, 'and nothing is thinking yet');
  body = running([]);
  await refresh(f);
  const live = list.querySelectorAll('.conversation-activity-message');
  assert.equal(live.length, 1);
  assert.equal(list.children.indexOf(live[0]), list.children.indexOf(f.root.querySelector('[data-message-id="1"]')) + 1);
  assert.equal(live[0].querySelectorAll('.conversation-activity-thinking').length, 1, 'thinking once the turn runs without a tool');
  body = running([tool(2.5, null, 'running')], { now: 4 });
  await refresh(f);
  const area = list.querySelectorAll('.conversation-activity-message')[0];
  assert.equal(area.querySelectorAll('.conversation-activity-thinking').length, 0, 'no thinking while a tool runs');
  assert.deepEqual(area.querySelectorAll('.conversation-activity-step').map(row => row.dataset.status), ['running']);
  assert.equal(f.reads.length, opened + 2, 'a pending message and a running round are read on every refresh');
});

test('a just-ended round is read again while it settles, picks up its late events, then is not read again', async t => {
  const rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }, { id: 2, direction: 'out', content: 'done', status: 'delivered' }];
  const settlingBody = { ...doneBody(s(65)), rounds: [{ ...doneBody().rounds[0], settling: true, segments: [
    { replyId: 2, start: s(0), end: s(59), steps: [tool(1, 2), tool(3, null, 'running')] }, { replyId: null, start: s(59), end: s(60), steps: [] }] }] };
  let body = settlingBody;
  const f = pageFixture(t, { rows: () => rows, activityBody: () => body });
  await f.open();
  const steps = () => f.root.querySelector('[data-message-id="2"]').querySelector('.conversation-activity');
  steps().querySelector('button').dispatch('click');
  assert.deepEqual(steps().querySelectorAll('.conversation-activity-step').map(row => row.dataset.status), ['done', 'running']);
  const reads = f.reads.length;
  body = doneBody(s(90));
  await refresh(f);
  assert.deepEqual(steps().querySelectorAll('.conversation-activity-step').map(row => row.dataset.status), ['done', 'done']);
  assert.equal(f.reads.length, reads + 1, 'read again while settling');
  await refresh(f);
  assert.equal(f.reads.length, reads + 1, 'and not after it settled');
});

test('an instance without the activity route is asked once, then the page stops asking', async t => {
  const rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }];
  const f = pageFixture(t, { rows: () => rows, activityBody: () => assert.fail('no body for a missing route'), activityStatus: () => 404 });
  await f.open();
  await refresh(f); await refresh(f);
  assert.deepEqual(f.reads, ['1'], 'one request, no repeats after the route is missing');
  assert.equal(f.root.querySelectorAll('.conversation-activity').length, 0);
});

test('a part that lost its oldest steps counts them as N+ and says older steps are not shown', () => {
  const document = createDocument();
  const area = createActivityArea({ document, t });
  const segment = { replyId: 2, start: s(0), end: s(70), truncated: true, steps: [tool(1, 2), tool(3, 4)] };
  area.update({ key: '1:2', live: false, round: { state: 'done' }, segment }, { open: false, now: s(100) });
  assert.equal(area.node.querySelector('button').textContent, '已处理 1 分 10 秒 · 2+ 步');
  assert.equal(area.node.querySelectorAll('.conversation-activity-more').length, 0, 'folded: no list');
  area.update({ key: '1:2', live: false, round: { state: 'done' }, segment }, { open: true, now: s(100) });
  const list = area.node.querySelector('.conversation-activity-steps');
  assert.equal(list.children[0].className, 'conversation-activity-more');
  assert.equal(list.children[0].textContent, '更早的步骤未显示');
  const english = createActivityArea({ document, t: key => en[key] ?? key });
  english.update({ key: '1:2', live: false, round: { state: 'done' }, segment: { ...segment, steps: [tool(1, 2)] } }, { open: true, now: s(100) });
  assert.match(english.node.querySelector('button').textContent, /1\+ steps/);
  assert.equal(english.node.querySelector('.conversation-activity-more').textContent, 'Earlier steps are not shown');
});
