import { catchUpConversation } from './helpers/conversation-stream-catchup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick, visibleText } from './helpers/conversation-dom.js';
import { createLiveArea, formatDuration, livePresentation, markText, stepText, subtaskName } from '../public/js/wb/conversation-activity.js';
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

const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.zh.json', import.meta.url), 'utf8'));
const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url), 'utf8'));
const t = key => zh[key] ?? key;
const T = 1_800_000_000_000;
const s = seconds => T + seconds * 1000;
const tool = (start, end, status = 'done', label = { key: 'read', arg: 'memory/state.md' }) => ({ kind: 'tool', label, status, start: s(start), end: end === null ? null : s(end) });
const mark = (kind, at, extra = {}) => ({ kind: 'mark', mark: kind, at: s(at), ...extra });
const MAIN = { on: true, since: s(0), main: { since: s(0), lastActivityAt: s(1) }, tools: 0, subagents: null };
const IDLE = { on: false, since: null, main: null, tools: 0, subagents: null };
const SUBTASK = { id: 'k'.repeat(22), label: { key: 'memorySync' }, start: s(40), steps: 2 };
// An activity read as the server answers it.
const body = ({ now = s(10), working = MAIN, steps = [], subtasks = [], awaiting = null, seenId = 1, presence = 'running', truncated } = {}) =>
  ({ now, from: s(0), working, presence, steps, subtasks, awaiting, seenId, ...(truncated ? { truncated } : {}) });
const idleBody = () => body({ working: IDLE });
const msg = (id, direction, at = null) => ({ id, direction, at });

test('durations read <1 s, seconds, minutes and hours in both languages', () => {
  assert.deepEqual([400, 59_999, 125_000, 3_725_000].map(ms => formatDuration(ms, t)), ['<1 秒', '59 秒', '2 分 5 秒', '1 小时 2 分']);
  assert.deepEqual([0, 5_000, 61_000].map(ms => formatDuration(ms, key => en[key])), ['<1 s', '5 s', '1 min 1 s']);
});

test('steps, marks and subtasks read as plain words, never a tool or agent name', () => {
  assert.equal(stepText(tool(0, 1), t), '查看 memory/state.md');
  assert.equal(stepText({ label: { key: 'described', arg: '检查磁盘' } }, t), '检查磁盘');
  assert.equal(stepText({ label: { key: 'runCommand' } }, t), '运行命令');
  assert.equal(stepText({ label: { key: 'tool' } }, key => en[key]), 'Use a tool');
  assert.deepEqual(['message', 'scheduled', 'control', 'other', 'unknown'].map(kind => markText({ mark: kind }, t)),
    ['收到你的新消息', '收到定时任务', '收到系统指令', '收到其他消息', '收到其他消息']);
  assert.equal(markText({ mark: 'subtask', label: { key: 'memorySync' } }, t), '开始记忆整理（后台）');
  assert.equal(subtaskName({ key: 'named', arg: '查锁文件' }, t), '查锁文件');
  assert.equal(subtaskName({ key: 'plain' }, t), '子任务');
  assert.equal(subtaskName({ key: 'memorySync' }, key => en[key]), en['chat.activity.subtask.memorySync']);
});

test('before the session takes a message the area wakes the session or delivers it, timed from the message', () => {
  const messages = [msg(1, 'in', s(0))];
  const queued = { id: 1, state: 'queued', since: s(0) };
  assert.deepEqual(livePresentation(messages, body({ working: null, presence: 'stopped', awaiting: queued }), { presence: 'stopped' }),
    { anchor: 1, under: 'in', subtasks: [], truncated: false, head: 'waking', since: s(0), steps: [], waiting: 'starting' });
  const sending = livePresentation(messages, body({ working: IDLE, awaiting: queued }), { presence: 'running' });
  assert.deepEqual([sending.head, sending.waiting], ['sending', 'queued']);
  // A message sent after the last read looked: still on its way, whatever that read said.
  const sent = livePresentation([...messages, msg(2, 'in', s(5))], body({ working: IDLE, seenId: 1 }), { presence: 'stopped' });
  assert.deepEqual([sent.anchor, sent.head, sent.since], [2, 'waking', s(0)], 'timed from the first unanswered message');
  // A message the group already handled before it was last quiet does not count.
  const later = livePresentation([msg(1, 'in', s(0)), msg(2, 'in', s(500))], { ...body({ working: IDLE, seenId: 1 }), from: s(100) });
  assert.equal(later.since, s(500));
  // Taken during a start-up turn that ended before the work began: from the window's start.
  const cold = livePresentation(messages, { ...body({ steps: [tool(7, null, 'running')] }), from: s(6) });
  assert.equal(cold.since, s(6));
});

test('once taken the area works and thinks until a step runs; under a reply it shows no elapsed time', () => {
  const messages = [msg(1, 'in', s(0))];
  const taken = { id: 1, state: 'thinking', since: s(0), delivered: s(1) };
  const thinking = livePresentation(messages, body({ awaiting: taken }));
  assert.deepEqual([thinking.head, thinking.waiting, thinking.since, thinking.steps], ['working', 'thinking', s(0), []]);
  assert.equal(livePresentation(messages, body({ working: IDLE, awaiting: taken })), null,
    'the area works exactly when the header says the main AI works');
  const steps = [tool(2, 3), tool(4, null, 'running')];
  const busy = livePresentation(messages, body({ steps }));
  assert.deepEqual([busy.head, busy.waiting, busy.steps], ['working', null, steps]);
  assert.equal(livePresentation(messages, body({ steps: [tool(2, 3)] })).waiting, 'thinking', 'between steps it thinks');
  const commands = livePresentation(messages, body({ working: { ...IDLE, on: true, tools: 1 } }));
  assert.equal(commands.head, 'working', 'a command still running is work');
  const afterReply = livePresentation([...messages, msg(2, 'out', s(20))], body({ steps: [tool(21, null, 'running')], seenId: 2 }));
  assert.deepEqual([afterReply.anchor, afterReply.under, afterReply.head, afterReply.since], [2, 'out', 'working', null]);
});

test('a reply the read has not seen yet clears the steps before it at once', () => {
  const messages = [msg(1, 'in', s(0)), msg(2, 'out', s(20))];
  const steps = [tool(2, 3), tool(4, null, 'running')];
  const unseen = livePresentation(messages, body({ steps, seenId: 1 }));
  assert.deepEqual([unseen.anchor, unseen.under, unseen.head, unseen.steps], [2, 'out', 'working', []]);
  const seen = livePresentation(messages, body({ steps: [tool(21, null, 'running')], seenId: 2 }));
  assert.equal(seen.steps.length, 1, 'once the read saw the reply, its steps are the work after it');
  const user = livePresentation([...messages, msg(3, 'in', s(30))], body({ steps, seenId: 2 }));
  assert.equal(user.steps.length, 2, 'a newer user message keeps the steps so far');
});

test('subtasks keep a row when the main AI is idle; done work leaves nothing or, at once, a handled line under a user message', () => {
  const messages = [msg(1, 'in', s(0))];
  const working = { ...IDLE, on: true, subagents: { count: 1, since: s(40), lastActivityAt: s(45) } };
  assert.deepEqual(livePresentation(messages, body({ working, subtasks: [SUBTASK] })),
    { anchor: 1, under: 'in', subtasks: [SUBTASK], truncated: false, head: null, since: null, steps: [], waiting: null });
  const withMain = livePresentation(messages, body({ working: { ...MAIN, subagents: working.subagents }, subtasks: [SUBTASK], steps: [tool(1, null, 'running')] }));
  assert.deepEqual([withMain.head, withMain.subtasks], ['working', [SUBTASK]]);
  const handled = { id: 1, state: 'handled', since: s(0), delivered: s(1) };
  assert.deepEqual(livePresentation(messages, body({ working: IDLE, awaiting: handled })),
    { anchor: 1, under: 'in', subtasks: [], truncated: false, head: null, since: null, steps: [], waiting: null, handled: true });
  assert.equal(livePresentation([...messages, msg(2, 'out')], body({ working: IDLE, seenId: 2 })), null, 'replied and done: nothing');
  assert.equal(livePresentation(messages, body({ working: IDLE })), null, 'done without a pending message: nothing');
  assert.deepEqual(livePresentation(messages, body({ working: IDLE, awaiting: { ...handled, state: 'settling' } })),
    livePresentation(messages, body({ working: IDLE, awaiting: handled })), 'stopped moments ago: the handled line already, no blank');
  assert.equal(livePresentation([], body()), null); assert.equal(livePresentation(messages, null), null);
});

test('the live area draws the head, steps, marks, thinking and subtask rows like the prototype', () => {
  const document = createDocument(), toggles = [];
  const area = createLiveArea({ document, t, locale: 'zh-CN', onToggle: id => toggles.push(id) });
  const steps = [tool(1, 2), tool(3, 4, 'failed', { key: 'runCommand' }), mark('message', 5, { messageId: 2 }),
    mark('subtask', 7, { label: { key: 'memorySync' } }), tool(8, null, 'running', { key: 'described', arg: '查群名' })];
  area.update({ anchor: 2, under: 'in', head: 'working', since: s(0), steps, waiting: null, subtasks: [SUBTASK], truncated: false },
    { now: s(46), open: new Set(), details: new Map() });
  const root = area.node;
  assert.equal(root.dataset.state, 'working'); assert.equal(root.dataset.under, 'in');
  assert.equal(root.querySelector('.conversation-activity-head').textContent, '正在工作 · 46 秒');
  assert.deepEqual(root.querySelectorAll('.conversation-activity-step').map(row => [row.dataset.status, visibleText(row)]),
    [['done', '查看 memory/state.md1 秒'], ['failed', '运行命令出错 · 1 秒'], ['running', '查群名进行中']]);
  assert.deepEqual(root.querySelectorAll('.conversation-activity-step').map(row => row.children[0].className),
    ['wb-ico wb-ico-tick', 'wb-ico wb-ico-alert', 'wb-ico wb-ico-loader'], 'a done step is a plain tick, as in the prototype');
  const marks = root.querySelectorAll('.conversation-activity-mark');
  assert.deepEqual(marks.map(node => node.dataset.mark), ['message', 'subtask']);
  assert.match(visibleText(marks[0]), /^收到你的新消息 · \d\d:\d\d$/);
  assert.match(visibleText(marks[1]), /^开始记忆整理（后台） · \d\d:\d\d$/);
  assert.equal(root.querySelectorAll('.conversation-activity-thinking').length, 0, 'a step runs: no thinking row');
  const row = root.querySelector('.conversation-activity-subtask-row');
  assert.equal(visibleText(row), '后台：记忆整理 · 进行中 6 秒 · 已 2 步');
  assert.equal(row.getAttribute('aria-expanded'), 'false');
  assert.equal(root.querySelector('.conversation-activity-subtask .conversation-activity-steps').hidden, true, 'folded: no steps');
  row.dispatch('click');
  assert.deepEqual(toggles, [SUBTASK.id]);
  // Open: loading until its steps are read, then its steps; folded again they are hidden.
  area.update(area.view, { now: s(47), open: new Set([SUBTASK.id]), details: new Map() });
  const box = root.querySelector('.conversation-activity-subtask');
  assert.equal(row.getAttribute('aria-expanded'), 'true'); assert.equal(box.dataset.open, '');
  assert.equal(visibleText(box.querySelector('.conversation-activity-steps')), '正在读取步骤');
  area.update(area.view, { now: s(48), open: new Set([SUBTASK.id]), details: new Map([[SUBTASK.id, { steps: [tool(41, 42), tool(43, null, 'running')] }]]) });
  assert.deepEqual(box.querySelectorAll('.conversation-activity-step').map(node => node.dataset.status), ['done', 'running']);
  assert.equal(visibleText(row), '后台：记忆整理 · 进行中 8 秒 · 已 2 步', 'the row keeps ticking');
  area.update(area.view, { now: s(49), open: new Set(), details: new Map() });
  assert.equal(box.querySelector('.conversation-activity-steps').hidden, true);
  // Waiting rows: the session starting, then thinking.
  area.update({ anchor: 1, under: 'in', head: 'waking', since: s(0), steps: [], waiting: 'starting', subtasks: [], truncated: false }, { now: s(12) });
  assert.equal(root.querySelector('.conversation-activity-head').textContent, '正在唤醒会话 · 12 秒');
  assert.equal(visibleText(root.querySelector('.conversation-activity-thinking')), '会话启动中');
  assert.equal(root.querySelectorAll('.conversation-activity-subtask').length, 0, 'the ended subtask row is gone');
  area.update({ anchor: 1, under: 'out', head: 'working', since: null, steps: [], waiting: 'thinking', subtasks: [], truncated: true }, { now: s(13) });
  assert.equal(root.querySelector('.conversation-activity-head').textContent, '正在工作', 'under a reply: no elapsed time');
  assert.equal(visibleText(root.querySelector('.conversation-activity-thinking')), '正在思考');
  assert.equal(root.querySelector('.conversation-activity-more').textContent, '更早的步骤未显示');
});

test('subtasks alone are just their rows; work done without a reply is one line leading to the group details', () => {
  const document = createDocument(), opened = [];
  const area = createLiveArea({ document, t, onDetails: () => opened.push(true) });
  area.update({ anchor: 1, under: 'in', head: null, since: null, steps: [], waiting: null, subtasks: [SUBTASK], truncated: false }, { now: s(60) });
  assert.equal(area.node.dataset.state, 'subtasks');
  assert.deepEqual(area.node.children.map(node => node.className), ['conversation-activity-subtasks']);
  area.update({ anchor: 1, under: 'in', head: null, since: null, steps: [], waiting: null, subtasks: [], truncated: false, handled: true }, { now: s(61) });
  assert.equal(area.node.dataset.state, 'handled');
  assert.equal(visibleText(area.node), '已处理，没有回复·在组详情查看过程');
  area.node.querySelector('[data-action="openGroupDetails"]').dispatch('click');
  assert.equal(opened.length, 1);
  const plain = createLiveArea({ document, t: key => en[key] ?? key });
  plain.update({ anchor: 1, under: 'in', handled: true, subtasks: [], steps: [] }, { now: s(1) });
  assert.equal(visibleText(plain.node), en['chat.activity.handled'], 'without group details there is no link');
});

// Injected DOM and fetch only: no browser, sockets, databases, storage or subprocesses.
function pageFixture(context, { rows, activityBody, activityStatus = () => 200, subtaskBody = () => ({ subtask: null, steps: [] }) }) {
  const document = createDocument(), root = document.createElement('div');
  const timers = [], intervals = [];
  document.defaultView = { addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout: id => { if (timers[id - 1]) timers[id - 1].fn = null; },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    clearInterval: id => { if (intervals[id - 1]) intervals[id - 1].fn = null; }, innerWidth: 1280 };
  const reads = [];
  const page = mountConversationPage({ root, document, t, fetch: async path => {
    const activity = path.includes('/activity?') ? new URLSearchParams(path.split('?')[1]) : null;
    if (activity) reads.push(activity.get('subtask') ?? 'live');
    const body = path === '/api/session-mode' ? { data: { sessionMode: 'multi' } }
      : path.startsWith('/api/chat/conversations?') ? { items: [{ id: 'g:AA', sessionGroup: 'dashboard:a', displayName: 'A' }], nextCursor: null }
      : path.includes('/messages?') ? { items: rows(), nextCursor: null, afterCursor: 'after' }
      : activity ? (activityStatus() !== 200 ? { error: 'not_found' } : activity.has('subtask') ? subtaskBody(activity.get('subtask')) : activityBody())
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: { id: 'g:AA', sessionGroup: 'dashboard:a', state: 'active' } }
      : { items: [], nextCursor: null };
    const status = activity ? activityStatus() : 200;
    return { ok: status === 200, status, json: async () => body };
  } });
  context.after(() => page.destroy());
  return { document, root, page, timers, intervals, reads, async open() {
    await page.open();
    allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click');
    for (let i = 0; i < 6; i++) await tick();
  } };
}
const refresh = async f => {
  await catchUpConversation(f.page);
  for (let i = 0; i < 8; i++) await tick();
};
const userRow = (id, seconds) => ({ id, direction: 'in', channel: 'dashboard', content: `message ${id}`, status: 'delivered',
  timestamp: new Date(s(seconds)).toISOString() });
const replyRow = (id, seconds) => ({ id, direction: 'out', channel: 'dashboard', content: `reply ${id}`, status: 'delivered',
  timestamp: new Date(s(seconds)).toISOString() });
const liveOf = f => f.root.querySelector('.conversation-message-list').querySelectorAll('.conversation-activity-message');
const placedAfter = (f, id) => {
  const list = f.root.querySelector('.conversation-message-list'), [live] = liveOf(f);
  return list.children.indexOf(live) === list.children.indexOf(list.querySelector(`[data-message-id="${id}"]`)) + 1;
};

test('a first message: waking the session, thinking, its steps, a reply that clears them, then nothing once all is done', async t => {
  let rows = [userRow(1, 0)];
  let answer = body({ now: s(3), working: null, presence: 'stopped', awaiting: { id: 1, state: 'queued', since: s(0) } });
  const f = pageFixture(t, { rows: () => rows, activityBody: () => answer });
  await f.open();
  assert.equal(liveOf(f).length, 1); assert.ok(placedAfter(f, 1), 'right below the message');
  const live = liveOf(f)[0];
  assert.equal(live.dataset.messageId, undefined, 'the live area is not a message');
  assert.match(visibleText(live), /^正在唤醒会话 · \d+ 秒会话启动中$/);
  answer = body({ now: s(8), awaiting: { id: 1, state: 'thinking', since: s(0), delivered: s(6) } });
  await refresh(f);
  assert.match(visibleText(liveOf(f)[0]), /^正在工作 · \d+ 秒正在思考$/);
  answer = body({ now: s(12), steps: [tool(9, 10), tool(11, null, 'running')], awaiting: { id: 1, state: 'thinking', since: s(0), delivered: s(6) } });
  await refresh(f);
  assert.equal(liveOf(f)[0], live, 'one area all along');
  assert.deepEqual(live.querySelectorAll('.conversation-activity-step').map(row => row.dataset.status), ['done', 'running']);
  assert.equal(live.querySelectorAll('.conversation-activity-thinking').length, 0);
  // A reply arrives and the AI goes on: the area moves under the reply with only the steps after it.
  rows = [...rows, replyRow(2, 20)];
  answer = body({ now: s(25), steps: [tool(22, null, 'running', { key: 'runCommand' })], seenId: 2 });
  await refresh(f);
  assert.ok(placedAfter(f, 2), 'under the reply');
  assert.equal(live.querySelector('.conversation-activity-head').textContent, '正在工作');
  assert.deepEqual(live.querySelectorAll('.conversation-activity-step').map(row => visibleText(row)), ['运行命令进行中']);
  assert.equal(f.root.querySelector('[data-message-id="2"]').querySelector('.conversation-activity'), null, 'never inside the reply');
  answer = body({ now: s(60), working: IDLE, seenId: 2 });
  await refresh(f);
  assert.equal(liveOf(f).length, 0, 'all done: only the reply stays');
});

test('a message sent mid-work moves the same area under it with the steps so far and a mark', async t => {
  let rows = [userRow(1, 0)];
  let answer = body({ now: s(20), steps: [tool(1, 2), tool(3, null, 'running')], awaiting: { id: 1, state: 'thinking', since: s(0), delivered: s(1) } });
  const f = pageFixture(t, { rows: () => rows, activityBody: () => answer });
  await f.open();
  const before = liveOf(f)[0];
  rows = [...rows, userRow(2, 21)];
  await refresh(f);
  assert.ok(placedAfter(f, 2), 'moves under the new message at once');
  answer = body({ now: s(30), seenId: 2, steps: [tool(1, 2), tool(3, 22), mark('message', 22, { messageId: 2 }), tool(23, null, 'running')],
    awaiting: { id: 2, state: 'thinking', since: s(21), delivered: s(22) } });
  await refresh(f);
  const live = liveOf(f)[0];
  assert.equal(live, before, 'the area keeps its node');
  assert.ok(placedAfter(f, 2));
  assert.equal(live.querySelectorAll('.conversation-activity-step').length, 3, 'earlier steps stay');
  assert.equal(live.querySelectorAll('.conversation-activity-mark').length, 1);
  assert.match(live.querySelector('.conversation-activity-head').textContent, /^正在工作 · 30 秒$/, 'timed from the first unanswered message');
});

test('a subtask row reads its steps only while open and stops when folded', async t => {
  const rows = [userRow(1, 0), replyRow(2, 10)];
  const working = { ...IDLE, on: true, subagents: { count: 1, since: s(40), lastActivityAt: s(45) } };
  const f = pageFixture(t, { rows: () => rows, activityBody: () => body({ now: s(46), working, subtasks: [SUBTASK], seenId: 2 }),
    subtaskBody: key => ({ now: s(46), subtask: { id: key, start: s(40), end: null }, steps: [tool(41, 42), tool(43, null, 'running')] }) });
  await f.open();
  assert.ok(placedAfter(f, 2), 'the subtask row sits under the reply while the main AI is idle');
  const live = liveOf(f)[0];
  assert.equal(live.querySelectorAll('.conversation-activity-head').length, 0, 'only the subtask row');
  assert.deepEqual(f.reads.filter(read => read !== 'live'), [], 'folded: its steps are not read');
  live.querySelector('.conversation-activity-subtask-row').dispatch('click');
  for (let i = 0; i < 6; i++) await tick();
  assert.deepEqual(f.reads.filter(read => read !== 'live'), [SUBTASK.id]);
  assert.deepEqual(live.querySelectorAll('.conversation-activity-subtask .conversation-activity-step').map(row => row.dataset.status), ['done', 'running']);
  await refresh(f);
  assert.deepEqual(f.reads.filter(read => read !== 'live'), [SUBTASK.id, SUBTASK.id], 'read again with every poll while open');
  live.querySelector('.conversation-activity-subtask-row').dispatch('click');
  for (let i = 0; i < 4; i++) await tick();
  await refresh(f);
  assert.deepEqual(f.reads.filter(read => read !== 'live'), [SUBTASK.id, SUBTASK.id], 'folded: no more reads');
  assert.equal(live.querySelector('.conversation-activity-subtask .conversation-activity-steps').hidden, true);
});

test('work done without a reply leaves one line under the message and stops ticking', async t => {
  const rows = [userRow(1, 0)];
  const f = pageFixture(t, { rows: () => rows, activityBody: () => body({ now: s(60), working: IDLE,
    awaiting: { id: 1, state: 'handled', since: s(0), delivered: s(1) } }) });
  await f.open();
  assert.ok(placedAfter(f, 1));
  assert.equal(visibleText(liveOf(f)[0]), '已处理，没有回复');
  assert.equal(f.intervals.filter(timer => timer.fn).length, 0, 'nothing ticks under the handled line');
});

test('the area is read on every refresh, and an instance without the activity route is asked once', async t => {
  const rows = [userRow(1, 0)];
  const f = pageFixture(t, { rows: () => rows, activityBody: () => body({ steps: [tool(1, null, 'running')] }) });
  await f.open();
  const opened = f.reads.length;
  await refresh(f); await refresh(f);
  assert.equal(f.reads.length, opened + 2);
  const missing = pageFixture(t, { rows: () => rows, activityBody: () => assert.fail('no body for a missing route'), activityStatus: () => 404 });
  await missing.open();
  await refresh(missing); await refresh(missing);
  assert.deepEqual(missing.reads, ['live'], 'one request, no repeats after the route is missing');
  assert.equal(missing.root.querySelectorAll('.conversation-activity').length, 0);
});

test('a running activity stays under the external message when a newer internal relay arrives', async t => {
  const rows = [{ id: 1, channel: 'dashboard', direction: 'in', content: 'work on this', status: 'delivered' }];
  const f = pageFixture(t, { rows: () => rows, activityBody: () => body({ steps: [tool(2.5, null, 'running')] }) });
  await f.open();
  const list = f.root.querySelector('.conversation-message-list');
  const external = list.querySelector('[data-message-id="1"]');
  const before = list.querySelector('.conversation-activity-message');
  assert.ok(before?.querySelector('.conversation-activity-step'), 'the real mounted page has a running tool');
  assert.equal(list.children.indexOf(before), list.children.indexOf(external) + 1);
  rows.push({ id: 2, channel: 'internal', direction: 'in', content: 'relay body', status: 'delivered',
    internal: { peerSessionGroup: 'telegram:peer', peerDisplayName: 'Peer room', peerExists: true, peerChannel: 'telegram', content: 'relay body' } });
  await refresh(f);
  const relay = list.querySelector('[data-message-id="2"]');
  assert.ok(relay?.classList.contains('conversation-internal'), 'the newer relay is rendered');
  const live = list.querySelectorAll('.conversation-activity-message');
  assert.equal(live.length, 1, 'there is still one running activity');
  assert.equal(live[0], before, 'the activity retains its mounted instance');
  assert.equal(list.children.indexOf(live[0]), list.children.indexOf(external) + 1, 'activity remains immediately below the external row');
  assert.equal(list.children.indexOf(relay), list.children.indexOf(live[0]) + 1, 'the relay follows the activity instead of taking its anchor');
  assert.equal(relay.querySelector('.conversation-activity'), null);
});

test('scroll position is never written while the user drags; afterwards it follows only a user who stayed at the bottom', async t => {
  const rows = [{ id: 1, direction: 'in', content: 'hi', status: 'delivered' }];
  const f = pageFixture(t, { rows: () => rows, activityBody: idleBody });
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
      : path.includes('/activity?') ? idleBody()
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

test('scrolling near the top keeps the message being read where it was while loading older history', async t => {
  const f = layoutFixture(t, { rows: Array.from({ length: 10 }, (_, i) => reply(11 + i)), older: Array.from({ length: 10 }, (_, i) => reply(1 + i)) });
  const { stream, list } = await f.open();
  stream.scrollTop = 200;
  const reading = list.querySelector('[data-message-id="13"]');
  assert.equal(reading.getBoundingClientRect().top, 0, 'the row being read is at the top of the view');
  assert.equal(f.root.querySelector('[data-action="loadOlder"]'), null);
  stream.dispatch('scroll');
  for (let i = 0; i < 8; i++) await tick();
  assert.ok(list.querySelector('[data-message-id="1"]'), 'the older page is shown');
  assert.equal(reading.getBoundingClientRect().top, 0, 'the row being read did not move while older history was inserted');
  for (const timer of f.timers.filter(timer => timer.fn && timer.ms === 180)) timer.fn();
  assert.equal(reading.getBoundingClientRect().top, 0, 'nor after scrolling settles');
});

test('content that moves during a drag is moved back once the drag settles, unless the user follows the bottom', async t => {
  const f = layoutFixture(t, { rows: Array.from({ length: 10 }, (_, i) => reply(11 + i)), older: Array.from({ length: 10 }, (_, i) => reply(1 + i)) });
  const { stream, list } = await f.open();
  stream.scrollTop = 200;
  const reading = list.querySelector('[data-message-id="13"]');
  stream.dispatch('touchstart', {});
  stream.dispatch('scroll');
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
