import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { subtaskKey } from '../../src/lib/chat/activity.js';
import { GROUP as SAMPLE_GROUP, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const GROUP = 'dashboard:live-browser';
const ID = 'g:' + Buffer.from(GROUP).toString('hex').toUpperCase();
const at = (h, m, s = 0) => Date.UTC(2026, 10, 13, h, m, s);
const iso = value => new Date(value).toISOString();
const KEY = subtaskKey('memory-sync-agent');

const message = (id, direction, time, content) => ({ id, direction, channel: 'dashboard', content, timestamp: iso(time), status: 'delivered' });
const ask = message(1, 'in', at(22, 57), '请给 Dashboard 里还没有名字的会话组起个名字，做完列出你起的名字。');
const followUp = message(2, 'in', at(22, 58), '私聊的组用对方的名字就行，不用加「私聊」两个字。');
const firstReply = message(3, 'out', at(22, 58, 40), '收到，私聊组直接用对方名字。目前已经找到 8 个没有名字的组，正在逐个查群名。');
const finalReply = message(4, 'out', at(22, 59, 30), '起好了，共 8 个：产品周会、Zylos-Core多session、Eva、Jinglever……完整列表见下。');
const noReplyNeeded = message(5, 'in', at(23, 5), '刚才那个列表收到了，不用回。');

const tool = (label, start, end = null) => ({ kind: 'tool', label, status: end === null ? 'running' : 'done', start, end });
const described = arg => ({ key: 'described', arg });
const step = {
  a: () => tool({ key: 'read', arg: 'dashboard/SKILL.md' }, at(22, 57, 14), at(22, 57, 14) + 400),
  b: () => tool(described('列出最近 3 天没有名字的组'), at(22, 57, 15), at(22, 57, 16)),
  c: done => tool(described('查 Telegram 群名：-1004376886243'), at(22, 57, 17), done ? at(22, 57, 19) : null),
  d: done => tool(described('查 Telegram 群名：-1003921047710'), at(22, 58, 2), done ? at(22, 58, 3) : null),
  e: () => tool(described('查飞书群名：oc_5f2e…'), at(22, 58, 11)),
  f: () => tool(described('设置组名：产品周会'), at(22, 58, 42)),
};
const markMessage = { kind: 'mark', mark: 'message', at: at(22, 58, 1) };
const markSubtask = { kind: 'mark', mark: 'subtask', label: { key: 'memorySync' }, at: at(22, 58, 10) };
const subtask = steps => ({ id: KEY, label: { key: 'memorySync' }, start: at(22, 58, 10), steps });
const detail = [tool({ key: 'read', arg: 'zylos-memory/SKILL.md' }, at(22, 58, 11), at(22, 58, 11) + 300),
  tool(described('读取同步步骤说明'), at(22, 58, 12), at(22, 58, 12) + 500), tool(described('获取记忆整理锁'), at(22, 58, 13), at(22, 58, 14)),
  tool(described('导出本组新对话'), at(22, 58, 15))];
const main = since => ({ on: true, since, main: { since, lastActivityAt: since }, tools: 0, subagents: null });
const LONG_TEXT = '查 Telegram 群名并核对每个群最近 3 天的消息、成员和置顶说明，确认它不是测试群也不是已归档的群，再按对方习惯的叫法起一个不超过十个字的名字：'
  + '-1004376886243-1003921047710-1002210984321';
const withSubtask = working => ({ ...working, subagents: { count: 1, since: at(22, 58, 10), lastActivityAt: at(22, 58, 15) } });
const idle = { on: false, since: null, main: null, tools: 0, subagents: null };

/**
 * The prototype's ten scenes in order: what the API answers (messages, the header's group row, the activity read) and
 * what the page must show (anchor message, header, area head, step rows, subtask row, handled line).
 */
export const SCENES = [
  { name: 'waking', now: at(22, 57, 12), messages: [{ ...ask, status: 'pending' }], presence: 'not_running', wait: { kind: 'starting' }, working: null,
    activity: { steps: [], subtasks: [], awaiting: { id: 1, state: 'queued', since: at(22, 57) } },
    expect: { anchor: 1, header: '正在唤醒', headerState: 'busy', head: '正在唤醒会话 · 12 秒', rows: [['wait', '会话启动中']] } },
  { name: 'thinking', now: at(22, 57, 20), messages: [ask], working: main(at(22, 57, 13)),
    activity: { steps: [], subtasks: [], awaiting: { id: 1, state: 'thinking', since: at(22, 57) } },
    expect: { anchor: 1, header: '正在工作', headerState: 'busy', head: '正在工作 · 20 秒', rows: [['wait', '正在思考']] } },
  { name: 'steps', now: at(22, 57, 30), messages: [ask], working: main(at(22, 57, 13)),
    activity: { steps: [step.a(), step.b(), step.c(false)], subtasks: [], awaiting: { id: 1, state: 'thinking', since: at(22, 57) } },
    expect: { anchor: 1, header: '正在工作', head: '正在工作 · 30 秒', rows: [['done', '查看 dashboard/SKILL.md', '<1 秒'],
      ['done', '列出最近 3 天没有名字的组', '1 秒'], ['running', '查 Telegram 群名：-1004376886243', '进行中']] } },
  { name: 'second-message', now: at(22, 58, 8), messages: [ask, followUp], working: main(at(22, 57, 13)),
    activity: { steps: [step.a(), step.b(), step.c(true), markMessage, step.d(false)], subtasks: [], awaiting: { id: 2, state: 'thinking', since: at(22, 58) } },
    expect: { anchor: 2, header: '正在工作', head: '正在工作 · 1 分 8 秒', rows: [['done', '查看 dashboard/SKILL.md', '<1 秒'],
      ['done', '列出最近 3 天没有名字的组', '1 秒'], ['done', '查 Telegram 群名：-1004376886243', '2 秒'], ['mark', '收到你的新消息 · 22:58'],
      ['running', '查 Telegram 群名：-1003921047710', '进行中']] } },
  { name: 'subtask', now: at(22, 58, 16), messages: [ask, followUp], working: withSubtask(main(at(22, 57, 13))),
    activity: { steps: [step.a(), step.b(), step.c(true), markMessage, step.d(true), markSubtask, step.e()], subtasks: [subtask(2)],
      awaiting: { id: 2, state: 'thinking', since: at(22, 58) } },
    expect: { anchor: 2, header: '正在工作', children: '后台子任务 1 个', head: '正在工作 · 1 分 16 秒', rows: [['done', '查看 dashboard/SKILL.md', '<1 秒'],
      ['done', '列出最近 3 天没有名字的组', '1 秒'], ['done', '查 Telegram 群名：-1004376886243', '2 秒'], ['mark', '收到你的新消息 · 22:58'],
      ['done', '查 Telegram 群名：-1003921047710', '1 秒'], ['mark', '开始记忆整理（后台） · 22:58'], ['running', '查飞书群名：oc_5f2e…', '进行中']],
    subtask: '后台：记忆整理 · 进行中 6 秒 · 已 2 步' } },
  { name: 'subtask-open', now: at(22, 58, 24), messages: [ask, followUp], working: withSubtask(main(at(22, 57, 13))), open: true,
    activity: { steps: [step.a(), step.b(), step.c(true), markMessage, step.d(true), markSubtask, step.e()], subtasks: [subtask(4)],
      awaiting: { id: 2, state: 'thinking', since: at(22, 58) } },
    expect: { anchor: 2, header: '正在工作', children: '后台子任务 1 个', head: '正在工作 · 1 分 24 秒', rows: [['done', '查看 dashboard/SKILL.md', '<1 秒'],
      ['done', '列出最近 3 天没有名字的组', '1 秒'], ['done', '查 Telegram 群名：-1004376886243', '2 秒'], ['mark', '收到你的新消息 · 22:58'],
      ['done', '查 Telegram 群名：-1003921047710', '1 秒'], ['mark', '开始记忆整理（后台） · 22:58'], ['running', '查飞书群名：oc_5f2e…', '进行中']],
    subtask: '后台：记忆整理 · 进行中 14 秒 · 已 4 步', detail: [['done', '查看 zylos-memory/SKILL.md', '<1 秒'], ['done', '读取同步步骤说明', '<1 秒'],
      ['done', '获取记忆整理锁', '1 秒'], ['running', '导出本组新对话', '进行中']] } },
  { name: 'reply', now: at(22, 58, 45), messages: [ask, followUp, firstReply], working: withSubtask(main(at(22, 57, 13))),
    activity: { steps: [step.f()], subtasks: [subtask(5)], awaiting: null },
    expect: { anchor: 3, header: '正在工作', children: '后台子任务 1 个', head: '正在工作', rows: [['running', '设置组名：产品周会', '进行中']],
      subtask: '后台：记忆整理 · 进行中 35 秒 · 已 5 步' } },
  { name: 'subtask-only', now: at(22, 59, 35), messages: [ask, followUp, firstReply, finalReply],
    working: { on: true, since: at(22, 58, 10), main: null, tools: 0, subagents: { count: 1, since: at(22, 58, 10), lastActivityAt: at(22, 59, 30) } },
    activity: { steps: [], subtasks: [subtask(9)], awaiting: null },
    expect: { anchor: 4, header: '后台子任务 1 个', head: null, rows: [], subtask: '后台：记忆整理 · 进行中 1 分 25 秒 · 已 9 步' } },
  { name: 'done', now: at(22, 59, 50), messages: [ask, followUp, firstReply, finalReply], working: idle,
    activity: { steps: [], subtasks: [], awaiting: null },
    expect: { anchor: null, header: '空闲' } },
  { name: 'handled', now: at(23, 5, 40), messages: [ask, followUp, firstReply, finalReply, noReplyNeeded], working: idle,
    activity: { steps: [], subtasks: [], awaiting: { id: 5, state: 'handled', since: at(23, 5), delivered: at(23, 5, 1) } },
    expect: { anchor: 5, header: '空闲', handled: '已处理，没有回复·在组详情查看过程' } },
];

async function startApi(sandbox) {
  let index = 0;
  const counts = { activity: 0, subtask: 0 }, missing = new Set(), streams = new Set();
  // A scene of the prototype by its index, or one more scene given as is (the long step).
  const scene = () => typeof index === 'number' ? SCENES[index] : index;
  const snapshot = url => {
    const value = workbenchAnswer(url, scene().now);
    const row = value.rows.find(item => item.sessionGroup === SAMPLE_GROUP);
    Object.assign(row, { sessionGroup: GROUP, origin: false, presence: scene().presence ?? 'running', processing: null, name: { displayName: '起名示例' },
      state: { kind: 'idle' }, duration: 75, tools: [], queue: { known: true, pending: { count: 0 }, running: { count: 0 }, fence: null },
      working: scene().working, wait: scene().wait ?? null, preview: { text: scene().messages.at(-1).content, timestamp: scene().messages.at(-1).timestamp, channel: 'dashboard' } });
    value.rows = [row]; value.counts = { busy: 0, idle: 1, waiting: 0, unknown: 0, error: 0, not_running: 0 };
    value.instance.runtimeHealth = { claude: { health: 'ok' } };
    return value;
  };
  const conversation = { id: ID, localId: 'live-browser', sessionGroup: GROUP, channel: 'dashboard', state: 'active', origin: false, displayName: '起名示例' };
  const answer = url => {
    const p = url.pathname;
    if (p === '/api/workbench/groups') return snapshot(url);
    if (p === '/api/chat/conversations') {
      if (url.searchParams.get('tab') === 'external') return { items: [], nextCursor: null, tz: 'UTC' };
      return { items: [{ ...conversation, session_group: GROUP, display_name: '起名示例' }], nextCursor: null, tz: 'UTC' };
    }
    if (p === `/api/chat/conversations/${encodeURIComponent(ID)}` || p === `/api/chat/conversations/${ID}`) return { conversation, stored: true, conversationId: ID, deliveryState: null, error: null };
    if (p.startsWith('/api/chat/conversations/')) {
      const items = scene().messages;
      if (p.endsWith('/messages')) return { items, nextCursor: null, afterCursor: 'after-' + items.at(-1).id, tz: 'UTC' };
      if (p.endsWith('/activity')) {
        const { now, working, activity } = scene();
        if (url.searchParams.has('subtask')) {
          counts.subtask++;
          return url.searchParams.get('subtask') === KEY && activity.subtasks.length
            ? { now, subtask: { id: KEY, start: at(22, 58, 10), end: null }, steps: detail } : { now, subtask: null, steps: [] };
        }
        counts.activity++;
        return { now, from: at(22, 56, 50), working: working && working.subagents ? { ...working } : working, presence: scene().presence ?? 'running',
          ...activity, seenId: items.at(-1).id };
      }
      if (p.endsWith('/status') || p.endsWith('/questions')) return { items: [], nextCursor: null };
      return undefined;
    }
    return workbenchAnswer(url, scene().now);
  };
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const data = { version: 1, tab: url.searchParams.get('chat_tab') || 'mine', conversationId: url.searchParams.get('chat_conversation'), ids: [] };
        res.write(`event: chat_ready\ndata: ${JSON.stringify(data)}\n\n`);
        streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname.startsWith('/api/')) {
        const value = req.method === 'GET' ? answer(url) : undefined;
        // Attachments are not part of this page state; their settings read may go unanswered.
        if (value === undefined && missing.size < 10 && !url.pathname.endsWith('/uploads/config')) missing.add(`${req.method} ${url.pathname}`);
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (['/', '/chat'].includes(url.pathname)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return;
      }
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.message }); }
  });
  sandbox.addCleanup(() => { for (const stream of streams) stream.end(); });
  // A chat change hint makes every open page read the conversation and its activity at once.
  const push = () => {
    for (const stream of streams) stream.write(`event: chat_messages_changed\ndata: ${JSON.stringify({ version: 1, tab: 'mine', conversationId: ID, ids: [] })}\n\n`);
  };
  return { base: await sandbox.startHttp(server), counts, missing, push, set(value) { index = value; } };
}

/** What a page shows now, in the shape of a scene's `expect`. */
async function observe(page) {
  return page.evaluate(() => {
    const area = document.querySelector('#wb-chat .conversation-activity-message');
    const indicator = document.querySelector('#wb-chat .conversation-running');
    const visible = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
    const header = indicator && !indicator.hidden ? [...indicator.querySelectorAll('.wi-ind-text')].filter(visible).map(node => node.textContent).join('') : null;
    const rowsOf = list => [...(list?.children ?? [])].map(row => row.classList.contains('conversation-activity-step')
      ? [row.dataset.status, row.querySelector('.conversation-activity-label').textContent, row.querySelector('.conversation-activity-time').textContent]
      : row.classList.contains('conversation-activity-mark') ? ['mark', row.textContent]
        : row.classList.contains('conversation-activity-thinking') ? ['wait', row.firstElementChild.textContent] : ['other', row.className]);
    const live = area?.querySelector('.conversation-activity-live');
    const head = live?.querySelector(':scope > .conversation-activity-head');
    const subtask = live?.querySelector('.conversation-activity-subtask');
    const handled = live?.querySelector('.conversation-activity-handled');
    return {
      anchor: area ? Number(area.previousElementSibling?.dataset.messageId) : null,
      header, headerState: indicator && !indicator.hidden ? indicator.dataset.state : null,
      children: indicator?.querySelector('.wi-ind-sub')?.textContent ?? null,
      head: head ? head.textContent : null,
      rows: rowsOf(live?.querySelector(':scope > .conversation-activity-steps')),
      subtask: subtask && visible(subtask) ? subtask.querySelector('.conversation-activity-subtask-title').textContent : null,
      open: subtask ? subtask.hasAttribute('data-open') : null,
      detail: subtask && subtask.hasAttribute('data-open') ? rowsOf(subtask.querySelector('.conversation-activity-steps')) : null,
      handled: handled ? handled.textContent : null,
      articles: document.querySelectorAll('#wb-chat article.conversation-message').length,
    };
  });
}

/** Layout of the area: inside the message column, nothing cut off sideways, no page-wide horizontal scroll. */
async function measure(page) {
  return page.evaluate(() => {
    const area = document.querySelector('#wb-chat .conversation-activity-message');
    const rect = node => { if (!node) return null; const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, height: r.height }; };
    // The area itself and the bubble of the message it sits under.
    const live = area?.querySelector('.conversation-activity-live');
    const bubble = area?.previousElementSibling?.querySelector('.conversation-message-body');
    const stream = area?.closest('.conversation-stream') ?? document.querySelector('#wb-chat .conversation-stream');
    const box = area?.getBoundingClientRect(), outer = stream?.getBoundingClientRect();
    const clipped = area ? [...area.querySelectorAll('.conversation-activity-head, .conversation-activity-step, .conversation-activity-mark, .conversation-activity-subtask-row, .conversation-activity-handled')]
      .filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className) : [];
    return { overflow: document.documentElement.scrollWidth > innerWidth, inside: !area || !outer || (box.left >= outer.left - 1 && box.right <= outer.right + 1),
      clipped, width: box ? Math.round(box.width) : null, under: area?.dataset.under ?? null, live: rect(live), bubble: rect(bubble),
      times: live ? [...live.querySelectorAll(':scope > .conversation-activity-steps > .conversation-activity-step > .conversation-activity-time')].map(rect) : [],
      labels: live ? [...live.querySelectorAll(':scope > .conversation-activity-steps > .conversation-activity-step > .conversation-activity-label')].map(rect) : [] };
  });
}

export async function runConversationLiveBrowser(t, sandbox) {
  console.info('Live activity browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const api = await startApi(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const wait = async (predicate, description, ms = 7000) => {
    const end = Date.now() + ms;
    let last;
    while (!(last = await predicate())) {
      if (Date.now() >= end) assert.fail(typeof description === 'function' ? description() : description);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return last;
  };
  // Every page shows the same scene at once; each page's clock stays paused, so durations read exactly as the API says.
  api.set(0);
  const pages = [];
  for (const [width, theme] of [[1280, 'light'], [1280, 'dark'], [390, 'light'], [390, 'dark']]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 960 }, locale: 'zh-CN', timezoneId: 'UTC' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(api.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(theme => {
      try { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', 'zh'); } catch {}
    }, theme);
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.clock.install({ time: new Date(SCENES[0].now - 2000) });
    await page.clock.pauseAt(new Date(SCENES[0].now - 1000));
    await page.goto(api.base + '/chat');
    try {
      await page.locator(`#wb-chat [data-conversation-id="${ID}"]`).click();
      await page.locator('#wb-chat .conversation-message').first().waitFor();
    } catch (error) {
      console.error('Live activity mount failure:', JSON.stringify({ errors, missing: [...api.missing], text: (await page.locator('body').innerText()).slice(0, 2000) }));
      throw error;
    }
    pages.push({ page, width, theme, errors });
  }
  const results = [];
  for (const [index, scene] of SCENES.entries()) {
    api.set(index);
    // Let every pending poll and header read run, then hint a change so each page reads this scene once more.
    for (const { page } of pages) await page.clock.fastForward(31000);
    api.push();
    for (const { page, width, theme, errors } of pages) {
      const name = `${String(index + 1).padStart(2, '0')}-${scene.name}-${width}-${theme}`;
      if (scene.open && !(await observe(page)).open) {
        const reads = api.counts.subtask;
        await page.locator('#wb-chat .conversation-activity-subtask-row').click();
        await wait(() => api.counts.subtask > reads, `${name}: opening the subtask reads its steps`);
      }
      if (!scene.open && (await observe(page)).open) {
        await page.locator('#wb-chat .conversation-activity-subtask-row').click();
        await wait(async () => (await observe(page)).open === false, `${name}: the subtask row closes`);
      }
      const want = scene.expect;
      let last = null;
      const seen = await wait(async () => {
        const value = await observe(page);
        // On a phone too an idle header says so beside the title, as in the prototype.
        const header = value.header?.startsWith(want.header);
        const match = value.anchor === want.anchor && header && (!want.headerState || value.headerState === want.headerState)
          && (want.anchor === null || (want.head ?? null) === value.head)
          && (!want.rows || JSON.stringify(value.rows) === JSON.stringify(want.rows))
          && (want.subtask ?? null) === value.subtask && (want.handled ?? null) === value.handled
          && (!want.detail || JSON.stringify(value.detail) === JSON.stringify(want.detail));
        last = value;
        return match && value;
      }, () => `${name}: shows ${JSON.stringify(want)}; last ${JSON.stringify(last)}`).catch(async error => {
        if (evidence) await page.screenshot({ path: path.join(evidence, name + '-failure.png') });
        throw error;
      });
      if (want.children && width === 1280) assert.equal(seen.children, ' · ' + want.children, `${name}: header names the subtask`);
      assert.equal(seen.articles, scene.messages.length, `${name}: the area never adds an empty AI message`);
      const layout = await measure(page);
      assert.equal(layout.overflow, false, `${name}: no horizontal page scroll`);
      assert.equal(layout.inside, true, `${name}: the area stays inside the message column`);
      assert.deepEqual(layout.clipped, [], `${name}: no row is cut off sideways`);
      // Under a user message the area is as wide as its content and ends where the bubble ends, as in the prototype.
      if (layout.under === 'in' && layout.live) {
        assert.ok(Math.abs(layout.live.right - layout.bubble.right) <= 2, `${name}: the area ends where the bubble ends (${layout.live.right} / ${layout.bubble.right})`);
        if (['thinking', 'steps'].includes(scene.name)) {
          assert.ok(layout.live.width < 480, `${name}: short content keeps the area narrow (${layout.live.width})`);
          assert.ok(layout.live.left > layout.bubble.left + 1, `${name}: the area starts right of the bubble's start (${layout.live.left} / ${layout.bubble.left})`);
        }
      }
      assert.deepEqual(errors, [], `${name}: no page errors`);
      if (evidence) {
        await page.locator('#wb-chat .conversation-activity-message, #wb-chat article.conversation-message:last-of-type').last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
      }
      results.push({ name, ...layout });
    }
  }
  // A step whose text is longer than the area wraps within 560px: the area stays at most that wide, ends where the bubble
  // ends, and keeps the time column at its right edge.
  const steps = SCENES.find(scene => scene.name === 'steps');
  api.set({ ...steps, activity: { ...steps.activity, steps: [step.a(), step.b(), tool(described(LONG_TEXT), at(22, 57, 17))] } });
  for (const { page } of pages) await page.clock.fastForward(31000);
  api.push();
  for (const { page, width, theme } of pages) {
    const name = `long-step-${width}-${theme}`;
    await wait(async () => (await observe(page)).rows?.[2]?.[1] === LONG_TEXT, `${name}: the long step shows`);
    const layout = await measure(page);
    assert.equal(layout.overflow, false, `${name}: no horizontal page scroll`);
    assert.equal(layout.inside, true, `${name}: the area stays inside the message column`);
    assert.ok(layout.live.width <= 560, `${name}: the area is at most 560px wide (${layout.live.width})`);
    assert.ok(Math.abs(layout.live.right - layout.bubble.right) <= 2, `${name}: the area still ends where the bubble ends`);
    assert.ok(layout.labels[2].height > 30, `${name}: the long text wraps (${layout.labels[2].height})`);
    assert.ok(layout.labels[2].right <= layout.times[2].left, `${name}: the text never runs into the time column`);
    for (const time of layout.times) assert.ok(time.width > 0 && Math.abs(time.right - layout.live.right) <= 1, `${name}: every time sits at the area's right edge`);
    if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
  }
  // A closed subtask row is no longer read.
  const reads = api.counts.subtask;
  api.set(SCENES.findIndex(scene => scene.name === 'reply'));
  for (const { page } of pages) await page.clock.fastForward(31000);
  api.push();
  await wait(async () => api.counts.activity > 0, 'activity reads continue');
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(api.counts.subtask, reads, 'a closed subtask row is not read');
  assert.deepEqual([...api.missing], [], 'the page asks only for routes the fixture answers');
  console.info('Live activity browser scenes:', JSON.stringify({ scenes: SCENES.length, pages: pages.length, checks: results.length, widths: results.filter(row => row.width).map(row => row.width).slice(0, 4) }));
}
