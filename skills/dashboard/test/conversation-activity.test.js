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

function pageFixture(context, { rows, activityBody }) {
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
      : path.includes('/activity?') ? activityBody()
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', sessionGroup: 'dashboard:a', state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
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
  assert.equal(gesture.active, true);
  listeners.get('scroll')();
  assert.equal(timers.size, 0, 'no settling while the pointer is held');
  docListeners.get('pointerup')();
  listeners.get('scroll')();
  assert.equal(timers.size, 1, 'momentum restarts the quiet period');
  runLast();
  assert.equal(gesture.active, false); assert.equal(settled, 1);
  listeners.get('pointerdown')({ pointerType: 'mouse', button: 2 });
  assert.equal(gesture.active, false, 'a right click is not a scroll');
  listeners.get('wheel')();
  assert.equal(gesture.active, true);
  gesture.destroy();
  assert.equal(timers.size, 0); assert.equal(listeners.size, 0); assert.equal(docListeners.size, 0);
});
