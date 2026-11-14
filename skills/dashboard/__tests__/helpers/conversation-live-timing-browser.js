import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP as SAMPLE_GROUP, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const GROUP = 'dashboard:live-timing';
const ID = 'g:' + Buffer.from(GROUP).toString('hex').toUpperCase();
const NOW = Date.UTC(2026, 10, 13, 20, 0);
const iso = value => new Date(value).toISOString();
const IDLE = { on: false, since: null, main: null, tools: 0, subagents: null };
const MAIN = { on: true, since: NOW, main: { since: NOW, lastActivityAt: NOW }, tools: 0, subagents: null };
const STEP = { kind: 'tool', label: { key: 'described', arg: '查群名' }, status: 'running', start: NOW, end: null };

/**
 * One group's reading, answered alike by the group list (the header's own read) and by the conversation's activity
 * read, the way both come from the same server snapshot: whether the session runs, why it waits, whether the group
 * works, and the area's steps and progress of the latest user message. Tests change it and move the page clock.
 */
async function startApi(sandbox) {
  const state = { presence: 'running', wait: null, working: IDLE, steps: [], awaiting: null,
    messages: [{ id: 1, direction: 'in', channel: 'dashboard', content: '把没有名字的组起个名字。', timestamp: iso(NOW - 600000), status: 'delivered' },
      { id: 2, direction: 'out', channel: 'dashboard', content: '起好了。', timestamp: iso(NOW - 540000), status: 'delivered' }] };
  const counts = { activity: 0, groups: 0, sends: 0 }, missing = new Set(), streams = new Set();
  const snapshot = url => {
    const value = workbenchAnswer(url, NOW);
    const row = value.rows.find(item => item.sessionGroup === SAMPLE_GROUP);
    Object.assign(row, { sessionGroup: GROUP, origin: false, presence: state.presence, processing: null, name: { displayName: '计时示例' },
      state: { kind: 'idle' }, duration: 75, tools: [], queue: { known: true, pending: { count: 0 }, running: { count: 0 }, fence: null },
      working: state.presence === 'running' ? state.working : null, wait: state.wait,
      preview: { text: state.messages.at(-1).content, timestamp: state.messages.at(-1).timestamp, channel: 'dashboard' } });
    value.rows = [row]; value.counts = { busy: 0, idle: 1, waiting: 0, unknown: 0, error: 0, not_running: 0 };
    value.instance.runtimeHealth = { claude: { health: 'ok' } };
    value.sources = { ...value.sources, status: { ok: true, readAt: Date.now() } };
    return value;
  };
  const conversation = { id: ID, localId: 'live-timing', sessionGroup: GROUP, channel: 'dashboard', state: 'active', origin: false, displayName: '计时示例' };
  const answer = url => {
    const p = url.pathname;
    if (p === '/api/workbench/groups') { counts.groups++; return snapshot(url); }
    if (p === '/api/chat/conversations') {
      if (url.searchParams.get('tab') === 'external') return { items: [], nextCursor: null, tz: 'UTC' };
      return { items: [{ ...conversation, session_group: GROUP, display_name: '计时示例' }], nextCursor: null, tz: 'UTC' };
    }
    if (p.startsWith('/api/chat/conversations/')) {
      if (p.endsWith('/messages')) return { items: state.messages, nextCursor: null, afterCursor: 'after-' + state.messages.at(-1).id, tz: 'UTC' };
      if (p.endsWith('/activity')) {
        counts.activity++;
        return { now: NOW, from: NOW - 60000, working: state.presence === 'running' ? state.working : null, presence: state.presence,
          header: { readAt: Date.now(), presence: state.presence, wait: state.wait, health: 'ok' },
          steps: state.steps, subtasks: [], awaiting: state.awaiting, seenId: state.messages.at(-1).id };
      }
      if (p.endsWith('/status') || p.endsWith('/questions')) return { items: [], nextCursor: null };
      return { conversation, stored: true, conversationId: ID, deliveryState: null, error: null };
    }
    return workbenchAnswer(url, NOW);
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
        if (req.method === 'POST' && url.pathname.endsWith('/send')) {
          counts.sends++;
          state.messages = [...state.messages, { id: state.messages.at(-1).id + 1, direction: 'in', channel: 'dashboard', content: '再看一下。',
            timestamp: iso(NOW), status: 'pending' }];
          sendJson(res, 200, { stored: true, conversationId: ID, deliveryState: 'pending', error: null }); return;
        }
        const value = req.method === 'GET' ? answer(url) : undefined;
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
  // A chat change hint, as the server sends when a message is stored: every open page reads the conversation at once.
  const push = () => {
    for (const stream of streams) stream.write(`event: chat_messages_changed\ndata: ${JSON.stringify({ version: 1, tab: 'mine', conversationId: ID, ids: [] })}\n\n`);
  };
  return { base: await sandbox.startHttp(server), state, counts, missing, push };
}

/** The header caption shown, its state, and the live area: its head, rows and handled line. */
async function observe(page) {
  return page.evaluate(() => {
    const visible = node => !!node && node.getClientRects().length > 0 && getComputedStyle(node).display !== 'none' && getComputedStyle(node).visibility !== 'hidden';
    const indicator = document.querySelector('#wb-chat .conversation-running');
    const live = document.querySelector('#wb-chat .conversation-activity-message .conversation-activity-live');
    const shown = indicator && !indicator.hidden && visible(indicator);
    return {
      header: shown ? [...indicator.querySelectorAll('.wi-ind-text')].filter(visible).map(node => node.textContent).join('') : null,
      headerState: shown ? indicator.dataset.state : null,
      head: live?.querySelector(':scope > .conversation-activity-head')?.textContent ?? null,
      rows: [...(live?.querySelector(':scope > .conversation-activity-steps')?.children ?? [])].map(row => row.classList.contains('conversation-activity-mark')
        ? ['mark', row.dataset.mark, row.textContent] : row.classList.contains('conversation-activity-step')
          ? ['step', row.querySelector('.conversation-activity-label').textContent] : ['wait', row.textContent]),
      handled: live?.querySelector('.conversation-activity-handled')?.textContent ?? null,
    };
  });
}

export async function runConversationLiveTimingBrowser(t, sandbox) {
  console.info('Live timing browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const api = await startApi(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const reset = () => Object.assign(api.state, { presence: 'running', wait: null, working: IDLE, steps: [], awaiting: null,
    messages: api.state.messages.slice(0, 2) });
  const until = async (predicate, description, ms = 7000) => {
    const end = Date.now() + ms;
    let last;
    while (!(last = await predicate())) {
      if (Date.now() >= end) assert.fail(typeof description === 'function' ? description() : description);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return last;
  };
  // A page with a paused clock, its first reads done and the stream live: from here on it reads only on its own timers.
  const inflight = new WeakMap();
  const open = async ({ width = 1280 } = {}) => {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 960 }, locale: 'zh-CN', timezoneId: 'UTC' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(api.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(() => { try { localStorage.setItem('zylos-dashboard-locale', 'zh'); } catch {} });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    // Count the page's open API requests (not the push stream) so settle also waits for a slow send or read.
    const pending = new Set(); inflight.set(page, pending);
    const isApi = request => request.url().startsWith(api.base + '/api/') && !request.url().includes('/api/stream');
    page.on('request', request => { if (isApi(request)) pending.add(request); });
    for (const done of ['requestfinished', 'requestfailed']) page.on(done, request => pending.delete(request));
    await page.clock.install({ time: new Date(NOW - 2000) });
    await page.clock.pauseAt(new Date(NOW - 1000));
    await page.goto(api.base + '/chat');
    await page.locator(`#wb-chat [data-conversation-id="${ID}"]`).click();
    await page.locator('#wb-chat .conversation-message').first().waitFor();
    await page.clock.fastForward(31000);
    await settle(page);
    return { page, context, errors };
  };
  // Let the requests a timer started finish: the reads stop changing.
  const settle = async page => {
    let last = -1;
    for (let quiet = 0; quiet < 3;) {
      const now = api.counts.activity + api.counts.groups;
      quiet = now === last && !inflight.get(page)?.size ? quiet + 1 : 0; last = now;
      await page.evaluate(() => 0);
      await new Promise(resolve => setTimeout(resolve, 60));
    }
  };
  // Move the page clock in steps and say how many activity reads each step made.
  const tick = async (page, ms) => {
    const before = api.counts.activity;
    await page.clock.fastForward(ms);
    await settle(page);
    return api.counts.activity - before;
  };
  const shot = async (page, name) => { if (evidence) await page.screenshot({ path: path.join(evidence, `live-timing-${name}.png`), animations: 'disabled' }); };

  await t.test('after a send the page reads every two seconds until work or a reply shows, and the header changes with the area', async () => {
    reset();
    const f = await open();
    try {
      assert.equal((await observe(f.page)).header, '空闲');
      assert.ok(await tick(f.page, 29000) <= 1, 'idle with a live stream: at most the thirty-second read in 29 seconds');
      await f.page.locator('#wb-chat .conversation-input').fill('再看一下。');
      await f.page.locator('#wb-chat .conversation-composer').evaluate(form => form.requestSubmit());
      await until(() => api.counts.sends > 0, 'the message is stored');
      await settle(f.page);
      // Delivered, but the runtime has not reported taking it yet: no work and nothing awaited, the first read after a send.
      for (let read = 1; read <= 4; read++) {
        assert.ok(await tick(f.page, 2000) >= 1, `read ${read} after the send comes two seconds later although no work shows yet`);
        assert.equal((await observe(f.page)).headerState, 'idle', 'no work read yet: the header stays idle');
      }
      api.state.working = MAIN; api.state.steps = [STEP]; api.state.awaiting = { id: 3, state: 'thinking', since: NOW };
      const groups = api.counts.groups;
      assert.ok(await tick(f.page, 2000) >= 1);
      let seen = await observe(f.page);
      assert.deepEqual([seen.head?.startsWith('正在工作'), seen.rows, seen.header, seen.headerState], [true, [['step', '查群名']], '正在工作', 'busy'],
        `the area and the header show the work on the same read: ${JSON.stringify(seen)}`);
      assert.equal(api.counts.groups, groups, 'the header followed the activity read, not a group list read');
      await shot(f.page, 'working-1280');
      // The work ends with a reply: the header and the area return to idle together.
      api.state.working = IDLE; api.state.steps = []; api.state.awaiting = null;
      api.state.messages = [...api.state.messages, { id: 4, direction: 'out', channel: 'dashboard', content: '看过了，没问题。', timestamp: iso(NOW + 9000), status: 'delivered' }];
      api.push();
      seen = await until(async () => { const value = await observe(f.page); return value.header === '空闲' && value; }, 'the header returns to idle');
      assert.deepEqual([seen.head, seen.rows, seen.handled], [null, [], null], 'the area is gone with the same read');
      assert.ok(await tick(f.page, 29000) <= 1, 'answered and idle: back to the slow pace');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await t.test('a cold start shows 正在唤醒 then 正在工作 in the phone header together with the area, and an idle phone header says 空闲', async () => {
    reset();
    const f = await open({ width: 390 });
    try {
      const idle = await observe(f.page);
      assert.deepEqual([idle.header, idle.headerState], ['空闲', 'idle'], 'an idle phone header says 空闲');
      await shot(f.page, 'idle-390');
      api.state.presence = 'not_running';
      await tick(f.page, 31000);
      await f.page.locator('#wb-chat .conversation-input').fill('再看一下。');
      await f.page.locator('#wb-chat .conversation-composer').evaluate(form => form.requestSubmit());
      await until(() => api.counts.sends > 0, 'the message is stored');
      api.state.wait = { kind: 'starting' }; api.state.awaiting = { id: 3, state: 'queued', since: NOW };
      await settle(f.page);
      assert.ok(await tick(f.page, 2000) >= 1);
      let seen = await observe(f.page);
      assert.deepEqual([seen.header, seen.headerState, seen.head?.startsWith('正在唤醒会话')], ['正在唤醒', 'busy', true],
        `waking: the header and the area on the same read: ${JSON.stringify(seen)}`);
      await shot(f.page, 'waking-390');
      api.state.presence = 'running'; api.state.wait = null; api.state.working = MAIN; api.state.awaiting = { id: 3, state: 'thinking', since: NOW };
      const groups = api.counts.groups;
      assert.ok(await tick(f.page, 2000) >= 1);
      seen = await observe(f.page);
      assert.deepEqual([seen.header, seen.headerState, seen.head?.startsWith('正在工作')], ['正在工作', 'busy', true],
        `working: within one two-second read of the area: ${JSON.stringify(seen)}`);
      assert.equal(api.counts.groups, groups, 'no group list read was needed');
      await shot(f.page, 'working-390');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await t.test('a tab that only watches follows a message sent elsewhere at the same pace', async () => {
    reset();
    const f = await open();
    try {
      assert.ok(await tick(f.page, 29000) <= 1, 'idle: the slow pace');
      // Another tab sends: the stored message reaches this one through the stream.
      api.state.messages = [...api.state.messages, { id: 3, direction: 'in', channel: 'dashboard', content: '再看一下。', timestamp: iso(NOW), status: 'delivered' }];
      api.push();
      await until(async () => (await f.page.locator('#wb-chat article.conversation-message').count()) === 3, 'the new message shows');
      await settle(f.page);
      for (let read = 1; read <= 3; read++) assert.ok(await tick(f.page, 2000) >= 1, `read ${read} after the new message comes two seconds later`);
      api.state.working = MAIN; api.state.steps = [STEP]; api.state.awaiting = { id: 3, state: 'thinking', since: NOW };
      assert.ok(await tick(f.page, 2000) >= 1);
      const seen = await observe(f.page);
      assert.deepEqual([seen.header, seen.rows], ['正在工作', [['step', '查群名']]], `the watching tab's header follows its area: ${JSON.stringify(seen)}`);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await t.test('work that ends without a reply shows the handled line on the next read, with no blank between', async () => {
    reset();
    api.state.messages = [...api.state.messages, { id: 3, direction: 'in', channel: 'dashboard', content: '刚才那个列表收到了，不用回。', timestamp: iso(NOW), status: 'delivered' }];
    api.state.working = MAIN; api.state.steps = [STEP]; api.state.awaiting = { id: 3, state: 'thinking', since: NOW };
    const f = await open();
    try {
      assert.deepEqual((await observe(f.page)).rows, [['step', '查群名']]);
      // Just stopped: the runtime may still take a queued message, so the server says it settles.
      api.state.working = IDLE; api.state.steps = []; api.state.awaiting = { id: 3, state: 'settling', since: NOW, delivered: NOW };
      assert.ok(await tick(f.page, 2000) >= 1);
      const seen = await observe(f.page);
      assert.deepEqual([seen.handled, seen.header], ['已处理，没有回复·在组详情查看过程', '空闲'], `no blank after the work: ${JSON.stringify(seen)}`);
      assert.ok(await tick(f.page, 2000) >= 1, 'while it settles the page still reads every two seconds');
      await shot(f.page, 'handled-1280');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });

  await t.test('a system instruction or scheduled task that starts the work has its mark row before the first step', async () => {
    reset();
    api.state.working = MAIN; api.state.awaiting = null;
    api.state.steps = [{ kind: 'mark', mark: 'control', at: NOW - 1000 }, STEP, { kind: 'mark', mark: 'scheduled', at: NOW + 1000 }];
    const f = await open();
    try {
      const seen = await until(async () => { const value = await observe(f.page); return value.rows.length === 3 && value; }, 'the marks show');
      assert.deepEqual(seen.rows, [['mark', 'control', '收到系统指令 · 19:59'], ['step', '查群名'], ['mark', 'scheduled', '收到定时任务 · 20:00']]);
      await shot(f.page, 'marks-1280');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  assert.deepEqual([...api.missing], [], 'the page asks only for routes the fixture answers');
}
