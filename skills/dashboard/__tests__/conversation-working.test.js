import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick } from './helpers/conversation-dom.js';
const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { createConversationState } = await import('../public/js/wb/conversation-state.js');
const { createGroupDetail } = await import('../public/js/wb/detail.js');
const { createGroupSide } = await import('../public/js/wb/group-side.js');
// Pure controllers and injected DOM: no browser, socket, database, storage, PM2 or tmux.
const flush = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
function fixture(t) {
  let time = 1000000, token = 0, fail = false, statusRow = null;
  let working = { on: true, since: time - 60000, turn: { since: time - 60000 }, tools: 0, subagents: null };
  const tasks = new Map(), reads = [], listeners = new Set();
  const document = { hidden: false, visibilityState: 'visible',
    addEventListener(name, fn) { if (name === 'visibilitychange') listeners.add(fn); },
    removeEventListener(name, fn) { listeners.delete(fn); } };
  const state = createConversationState({ document, now: () => time,
    setTimeout(fn, ms) { const id = ++token; tasks.set(id, { fn, at: time + ms }); return id; },
    clearTimeout(id) { tasks.delete(id); },
    request: async path => {
      assert.ok(reads.length < 300, 'request capture is bounded'); reads.push({ path, at: time });
      const u = new URL(path, 'http://fixture');
      if (path === '/api/session-mode') return { data: { sessionMode: 'multi' } };
      if (u.pathname === '/api/workbench/groups') {
        if (fail) throw new Error('offline');
        return { listKnown: true, sources: { status: { ok: true, readAt: time } },
          instance: { runtimeHealth: { claude: { health: 'ok' } } },
          rows: [{ sessionGroup: 'dashboard:a', presence: 'running', target: { runtime: 'claude' }, working, ...statusRow }] };
      }
      if (u.pathname.endsWith('/send')) return { stored: true, conversationId: 'g:A' };
      if (u.pathname === '/api/chat/conversations') return { items: [{ id: 'g:A', session_group: 'dashboard:a', stamp: 1 }], nextCursor: null };
      if (u.pathname.endsWith('/messages')) return { items: [], nextCursor: null, afterCursor: 'a' };
      if (u.pathname.endsWith('/questions') || u.pathname.endsWith('/status')) return { items: [], nextCursor: null };
      if (u.pathname.endsWith('/activity')) return { items: [], rounds: [] };
      return { conversation: { id: 'g:A', sessionGroup: 'dashboard:a', state: 'active' }, stored: false };
    } });
  t.after(() => { state.destroy(); assert.equal(tasks.size, 0); });
  return { state, reads, tasks, document, groupReads: () => reads.filter(row => row.path === '/api/workbench/groups'),
    setStatusRow: value => { statusRow = value; }, setWorking: value => { working = value; }, setFailure: value => { fail = value; },
    async start() { await state.open(); await state.select('g:A'); await flush(); },
    async visibility(visible) { document.hidden = !visible; document.visibilityState = visible ? 'visible' : 'hidden'; for (const fn of listeners) fn(); await flush(); },
    async advance(ms) {
      const until = time + ms; let steps = 0;
      for (;;) {
        const next = [...tasks].filter(([, task]) => task.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++steps < 300, 'clock advancement is bounded'); tasks.delete(next[0]); time = next[1].at; next[1].fn(); await flush();
      }
      time = until; await flush();
    } };
}

test('working status has an independent busy and idle request cadence and fails closed', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.state.snapshot().groupWorking?.on, true);
  await f.advance(4999); assert.equal(f.groupReads().length, 1);
  f.setWorking({ on: false, since: null, turn: null, tools: 0, subagents: null });
  await f.advance(1); assert.equal(f.groupReads().length, 2);
  assert.equal(f.state.snapshot().groupWorking?.on, false);
  await f.advance(29999); assert.equal(f.groupReads().length, 2);
  f.setFailure(true); await f.advance(1);
  assert.equal(f.groupReads().length, 3); assert.equal(f.state.snapshot().groupWorking, null);
});

test('working reads stop while hidden or on another tab and resume on visibility', async t => {
  const f = fixture(t); await f.start();
  assert.equal(f.state.snapshot().groupWorking?.on, true);
  await f.visibility(false); await f.advance(40000); assert.equal(f.groupReads().length, 1);
  await f.visibility(true); assert.equal(f.groupReads().length, 2);
  await f.state.setTab('external'); await f.advance(40000); assert.equal(f.groupReads().length, 2);
});

test('working is refreshed two seconds after a stored send even with healthy runtime', async t => {
  const f = fixture(t); await f.start(); f.state.setInput('hello');
  await f.state.send(); await flush();
  assert.equal(f.groupReads().length, 1);
  await f.advance(1999); assert.equal(f.groupReads().length, 1);
  await f.advance(1); assert.equal(f.groupReads().length, 2);
});

test('working state opens detail on timeline before its first draw and leaves the board row unchanged', async t => {
  const document = createDocument(), root = document.createElement('div');
  const working = { on: true, since: 1000, turn: null, tools: 0, subagents: { count: 2, since: 1000, lastActivityAt: 2000 } };
  const row = { sessionGroup: 'dashboard:a', presence: 'running', live: { runId: 'run' }, state: { kind: 'idle' }, working };
  const detail = createGroupDetail({ root, document, fetch: async path => ({ ok: true, json: async () => path.includes('/runs')
    ? { runs: [], totalRuns: 0, totalEvents: 0 } : path.includes('/messages') ? { messages: [] } : { events: [] } }) });
  t.after(() => detail.destroy());
  const opening = detail.open('dashboard:a', { rows: [row], listKnown: true }, { tab: 'timeline' });
  assert.equal(detail.state.tab, 'timeline');
  assert.equal(allNodes(root).some(node => node.classList.contains('wb-detail-timeline')), true);
  assert.equal(allNodes(root).some(node => node.classList.contains('wb-busy')), true);
  assert.equal(allNodes(root).some(node => node.classList.contains('wi-now')), true);
  assert.equal(row.state.kind, 'idle');
  await opening;
});

test('working timeline selection survives the side panel placeholder and reuses an open panel', async t => {
  const document = createDocument(), parent = document.createElement('div');
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  let timers = 0;
  const row = { sessionGroup: 'dashboard:a', presence: 'running', live: { runId: 'run' }, state: { kind: 'idle' },
    working: { on: false, since: null, turn: null, tools: 0, subagents: null } };
  const side = createGroupSide({ document, setTimer: () => ++timers, clearTimer: () => {}, fetch: async path => ({ ok: true,
    json: async () => path === '/api/workbench/groups' ? { rows: [row], listKnown: true }
      : path.includes('/runs') ? { runs: [], totalRuns: 0, totalEvents: 0 } : path.includes('/messages') ? { messages: [] } : { events: [] } }) });
  parent.append(side.element); t.after(() => side.destroy());
  await side.show('dashboard:a', { tab: 'timeline' });
  assert.match(allNodes(parent).filter(node => node.attributes.role === 'tab' && node.attributes['aria-selected'] === 'true')[0]?.textContent ?? '', /^wb\.detail\.timeline/);
  assert.equal(timers, 1);
  await side.show('dashboard:a', { tab: 'timeline' });
  assert.equal(timers, 1, 'open panel did not restart its refresh timer');
  await tick();
});

test('working timeline summary retains each start time and disappears when work finishes', async t => {
  const document = createDocument(), root = document.createElement('div');
  document.documentElement = { lang: 'zh' };
  const labels = { 'chat.working.processing': '正在工作', 'chat.working.children': '后台子任务 {count} 个',
    'chat.working.now': '现在：{state}', 'chat.working.since': '{time} 起', 'chat.working.latest': '最近一步 {time}' };
  const translate = (key, args = {}) => (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => args[name]);
  const row = { sessionGroup: 'dashboard:a', presence: 'running', live: { runId: 'run' }, state: { kind: 'idle' },
    working: { on: true, since: 600000, turn: { since: 1200000 }, tools: 0,
      subagents: { count: 2, since: 600000, lastActivityAt: 1800000 } } };
  const detail = createGroupDetail({ root, document, t: translate, fetch: async path => ({ ok: true,
    json: async () => path.includes('/runs') ? { runs: [], totalRuns: 0, totalEvents: 0 } : path.includes('/messages') ? { messages: [] } : { events: [] } }) });
  t.after(() => detail.destroy());
  await detail.open('dashboard:a', { rows: [row], listKnown: true }, { tab: 'timeline' });
  const line = allNodes(root).find(node => node.classList.contains('wi-now'));
  assert.ok(line, 'busy timeline has a current-work summary');
  assert.equal(line.textContent, '现在：正在工作 · 00:20 起；后台子任务 2 个 · 00:10 起 · 最近一步 00:30');
  assert.equal(allNodes(line).some(node => node.classList.contains('wi-now-sub')), true);
  await detail.updateSnapshot({ rows: [{ ...row, working: { on: false, since: null, turn: null, tools: 0, subagents: null } }], listKnown: true });
  assert.equal(allNodes(root).some(node => node.classList.contains('wi-now')), false, 'idle timeline has no green work summary');
});

test('working detail duration starts at the earliest current work without changing the board row', async t => {
  const { createDocument: detailDocument } = await import('./fixtures/workbench-dom.js');
  const document = detailDocument(), root = document.createElement('div');
  const row = { sessionGroup: 'dashboard:a', presence: 'running', live: { runId: 'run' }, state: { kind: 'idle' }, duration: 777,
    working: { on: true, since: 120000, turn: { since: 600000 }, tools: 0,
      subagents: { count: 1, since: 120000, lastActivityAt: 800000 } } };
  const detail = createGroupDetail({ root, document, now: () => 900000, fetch: async path => ({ ok: true,
    json: async () => path.includes('/runs') ? { runs: [], totalRuns: 0, totalEvents: 0 } : path.includes('/messages') ? { messages: [] } : { events: [] } }) });
  t.after(() => detail.destroy());
  await detail.open('dashboard:a', { rows: [row], listKnown: true });
  assert.equal(allNodes(root).find(node => node.classList.contains('wb-dur'))?.textContent, '13m');
  assert.equal(row.duration, 777);
  assert.equal(row.state.kind, 'idle');
  await detail.updateSnapshot({ rows: [{ ...row, working: { on: false, since: null, turn: null, tools: 0, subagents: null } }], listKnown: true });
  const head = allNodes(root).find(node => node.classList.contains('wb-group-head'));
  assert.equal(allNodes(head).find(node => node.classList.contains('wb-dur'))?.textContent, '12m');
});

test('working captions keep singular task labels without elapsed time', async () => {
  const fs = await import('node:fs');
  const { workingText } = await import('../public/js/wb/working-display.js');
  const labels = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
  const translate = (key, args = {}) => (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => args[name]);
  const now = 10 * 3600000;
  const working = { on: true, since: now - 65 * 60000, turn: null, tools: 0,
    subagents: { count: 1, since: now - 65 * 60000, lastActivityAt: now } };
  assert.equal(workingText(working, { t: translate }), '1 background task');
  assert.equal(workingText({ ...working, turn: { since: now - 60000 }, subagents: null }, { t: translate }), 'Working');
});

test('the working line names a scheduled task only for a turn known to be one', async () => {
  const fs = await import('node:fs');
  const { workingText } = await import('../public/js/wb/working-display.js');
  const labels = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url)));
  const translate = (key, args = {}) => (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => args[name]);
  const now = 10 * 3600000, turn = { since: now - 60000 };
  const children = { count: 2, since: now - 120000, lastActivityAt: now };
  assert.equal(workingText({ on: true, turn, subagents: null }, { t: translate, scheduled: true }), 'Running a scheduled task');
  assert.equal(workingText({ on: true, turn, subagents: children }, { t: translate, scheduled: true }), 'Running a scheduled task · 2 background tasks');
  // Only background tasks left: the turn is over, so the scheduled wording does not apply.
  assert.equal(workingText({ on: true, turn: null, subagents: children }, { t: translate, scheduled: true }), '2 background tasks');
  assert.equal(workingText({ on: false }, { t: translate, scheduled: true }), labels['wb.state.idle']);
});

for (const locale of ['zh', 'en']) test(`working captions omit elapsed time in ${locale}`, async () => {
  const fs = await import('node:fs');
  const { workingParts, workingText } = await import('../public/js/wb/working-display.js');
  const labels = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
  const t = (key, args = {}) => (labels[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => args[name]);
  const zh = locale === 'zh', now = 10 * 3600000;
  for (const minutes of [0, 3, 65, 121]) for (const scheduled of [false, true]) {
    const since = now - minutes * 60000;
    const working = { on: true, turn: { since }, subagents: { count: 2, since } };
    const options = { t, scheduled };
    const main = scheduled ? (zh ? '正在执行定时任务' : 'Running a scheduled task') : (zh ? '正在工作' : 'Working');
    const children = zh ? '后台子任务 2 个' : '2 background tasks';
    assert.deepEqual(workingParts(working, options), { main, children });
    assert.equal(workingText(working, options), `${main} · ${children}`);
    const compactMain = scheduled ? (zh ? '定时任务' : 'Scheduled') : (zh ? '正在工作' : 'Working');
    assert.deepEqual(workingParts(working, { ...options, compact: true }), { main: compactMain, children: null });
    assert.deepEqual(workingParts({ ...working, turn: null }, { ...options, compact: true }), {
      main: zh ? '后台子任务 2 个' : '2 subtasks', children: null });
  }
});


test('conversation keeps classified sample status and clears it after a read failure', async t => {
  const f = fixture(t);
  const sample = { state: { kind: 'idle', stale: true, sampledAt: 980000 },
    live: { status: { valid: false, reason: 'stale', lastState: 'idle', sampledAt: 980000 } } };
  f.setStatusRow(sample); await f.start();
  assert.deepEqual(f.state.snapshot().groupStatusRow, sample);
  f.setFailure(true); await f.advance(5000);
  assert.equal(f.state.snapshot().groupStatusRow, null);
});

test('detail preserves stale sample classification despite contradictory working events', async t => {
  const document = createDocument(), root = document.createElement('div'), now = 900000;
  const row = { sessionGroup: 'dashboard:a', presence: 'running', live: { runId: 'run', status: {
    valid: false, reason: 'stale', sampledAt: now - 20000, lastState: 'idle' } },
    state: { kind: 'idle', stale: true, sampledAt: now - 20000 }, duration: null, working: { on: true, since: now - 1000 } };
  const detail = createGroupDetail({ root, document, now: () => now, fetch: async path => ({ ok: true,
    json: async () => path.includes('/runs') ? { runs: [], totalRuns: 0, totalEvents: 0 } : path.includes('/messages') ? { messages: [] } : { events: [] } }) });
  t.after(() => detail.destroy());
  await detail.open('dashboard:a', { rows: [row], listKnown: true });
  const head = allNodes(root).find(node => node.classList.contains('wb-group-head'));
  assert.equal(allNodes(head).some(node => node.classList.contains('wb-idle')), true);
  assert.equal(allNodes(head).some(node => node.classList.contains('wb-status-age')), true);
  assert.equal(allNodes(root).filter(node => node.classList.contains('wb-status-age')).length, 2);
});
