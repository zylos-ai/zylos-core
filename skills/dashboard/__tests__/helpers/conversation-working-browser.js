import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP as SAMPLE_GROUP, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const GROUP = 'dashboard:working-browser';
const OTHER = 'telegram:working-browser';
const ID = 'g:' + Buffer.from(GROUP).toString('hex').toUpperCase();
const OTHER_ID = 'g:' + Buffer.from(OTHER).toString('hex').toUpperCase();
const NOW = Date.UTC(2026, 10, 11, 10, 30);
const iso = value => new Date(value).toISOString();

async function startPage(sandbox) {
  let scene = 'main', failGroups = false;
  const counts = { groups: 0, sends: 0 }, missing = new Set();
  const working = () => {
    const turn = ['main', 'both', 'rate', 'auth', 'queue', 'starting', 'unknown-busy'].includes(scene) ? { since: NOW - 3 * 60000 } : null;
    const subagents = ['both', 'sub'].includes(scene) ? { count: 2, since: NOW - 13 * 60000, lastActivityAt: NOW - 30000 } : null;
    if (scene === 'unavailable') return null;
    return { on: !!(turn || subagents), since: turn || subagents ? Math.min(...[turn?.since, subagents?.since].filter(Number.isFinite)) : null, turn, tools: 0, subagents };
  };
  const snapshot = url => {
    const value = workbenchAnswer(url, NOW);
    const row = value.rows.find(item => item.sessionGroup === SAMPLE_GROUP);
    row.sessionGroup = GROUP; row.name = { displayName: '工作状态示例' }; row.state = { kind: 'idle' }; row.duration = 75;
    row.tools = []; row.queue = { known: true, pending: { count: 0 }, running: { count: 0 }, fence: null };
    row.working = working(); row.preview = { text: '请继续整理这份资料', timestamp: iso(NOW - 4 * 60000), channel: 'dashboard' };
    row.wait = ({ queue: { kind: 'pool_wait' }, starting: { kind: 'starting' }, rate: { kind: 'rate_wait', cooldownUntil: NOW / 1000 + 3600 }, auth: { kind: 'auth_wait' } })[scene] ?? null;
    value.rows = [row]; value.counts = { busy: 0, idle: 1, waiting: 0, unknown: 0, error: 0, not_running: 0 };
    value.instance.runtimeHealth = { claude: { health: scene.startsWith('unknown-') ? null : ({ rate: 'rate_limited', auth: 'auth_failed' })[scene] ?? 'ok' } };
    return value;
  };
  const conversation = id => ({ id, localId: 'working-browser', sessionGroup: id === ID ? GROUP : OTHER, channel: id === ID ? 'dashboard' : 'telegram', state: 'active', displayName: id === ID ? '工作状态示例' : '外部会话' });
  const answer = url => {
    const p = url.pathname;
    if (p === '/api/workbench/groups') { counts.groups++; return snapshot(url); }
    if (p === '/api/chat/conversations') {
      const external = url.searchParams.get('tab') === 'external';
      return { items: [{ ...conversation(external ? OTHER_ID : ID), session_group: external ? OTHER : GROUP, display_name: external ? '外部会话' : '工作状态示例' }], nextCursor: null, tz: 'UTC' };
    }
    if (p.startsWith('/api/chat/conversations/')) {
      const id = decodeURIComponent(p.split('/')[4]);
      if (p.endsWith('/messages')) return { items: [{ id: 1, direction: 'in', channel: 'dashboard', content: '请继续整理这份资料', timestamp: iso(NOW - 4 * 60000) }, { id: 2, direction: 'out', channel: 'dashboard', content: '已经整理好了，后台子任务会继续核对。', timestamp: iso(NOW - 2 * 60000) }], nextCursor: null, afterCursor: 'after-2', tz: 'UTC' };
      if (p.endsWith('/activity')) return { now: iso(NOW), items: [] };
      if (p.endsWith('/status') || p.endsWith('/questions')) return { items: [], nextCursor: null };
      return { conversation: conversation(id), stored: true, conversationId: id, deliveryState: null, error: null };
    }
    if (p.startsWith('/api/workbench/groups/') && p.endsWith('/runs')) return { runs: [{ runId: 'run-tg', startAt: iso(NOW - 20 * 60000), endAt: iso(NOW - 30000), n: 2, endReason: 'running' }], totalRuns: 1, totalEvents: 2, unattributed: 0 };
    if (p.startsWith('/api/workbench/groups/') && p.endsWith('/messages')) return { messages: [] };
    if (p === '/api/timeline') return { events: [{ id: 'working-1', event_seq: 1, event_type: 'user_prompt_submit', run_id: 'run-tg', session_group: GROUP, timestamp: iso(NOW - 3 * 60000), metadata: {} }] };
    return workbenchAnswer(url, NOW);
  };
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/workbench/groups' && failGroups) { counts.groups++; sendJson(res, 503, { error: 'fixture_unavailable' }); return; }
        if (req.method === 'POST' && url.pathname.endsWith('/send')) {
          counts.sends++; sendJson(res, 200, { stored: true, conversationId: ID, deliveryState: 'pending', error: null }); return;
        }
        const value = req.method === 'GET' ? answer(url) : undefined;
        if (value === undefined && missing.size < 10) missing.add(`${req.method} ${url.pathname}`);
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (['/', '/chat'].includes(url.pathname)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return;
      }
      if (url.pathname === '/_assets/vendor/chart.umd.js' && process.env.ZYLOS_CHAT_CHART_ASSET) {
        res.writeHead(200, { 'content-type': 'text/javascript' }); fs.createReadStream(process.env.ZYLOS_CHAT_CHART_ASSET).pipe(res); return;
      }
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.message }); }
  });
  return { base: await sandbox.startHttp(server), counts, missing, setScene(value) { scene = value; }, fail(value) { failGroups = value; } };
}

export async function runConversationWorkingBrowser(t, sandbox) {
  console.info('Working browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const fixture = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR, captures = [];
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const open = async ({ width = 1280, theme = 'light', scene = 'main', clock = false, reducedMotion = 'no-preference' } = {}) => {
    fixture.setScene(scene); fixture.fail(false);
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale: 'zh-CN', timezoneId: 'UTC', reducedMotion });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(({ theme }) => {
      try { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', 'zh'); } catch {}
    }, { theme });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.clock.install({ time: new Date(NOW) });
    if (clock) await page.clock.pauseAt(new Date(NOW + 2000));
    await page.goto(fixture.base + '/chat');
    try {
      await page.locator(`#wb-chat [data-conversation-id="${ID}"]`).click();
      await page.locator('#wb-chat .conversation-message').first().waitFor();
    } catch (error) {
      console.error('Working mount failure:', JSON.stringify({ errors, missing: [...fixture.missing], text: (await page.locator('body').innerText()).slice(0, 2000) }));
      if (evidence) { fs.writeFileSync(path.join(evidence, 'mount-failure.html'), await page.content()); await page.screenshot({ path: path.join(evidence, 'mount-failure.png') }); }
      throw error;
    }
    return { page, context, errors };
  };
  const indicator = page => page.locator('#wb-chat .conversation-running');
  const wait = async (predicate, description) => {
    const end = Date.now() + 7000;
    while (!await predicate()) { assert.ok(Date.now() < end, description); await new Promise(resolve => setTimeout(resolve, 10)); }
  };
  const checkText = async (page, expected) => {
    await wait(async () => (await indicator(page).textContent()).includes(expected), `indicator shows ${expected}`);
    assert.match(await indicator(page).getAttribute('title'), /点按查看时间线/);
    assert.match(await indicator(page).getAttribute('aria-label'), /点按查看时间线/);
  };
  const shot = async (page, name) => {
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal document overflow');
    if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png'), animations: 'disabled' });
    captures.push(name);
  };
  const scenes = { main: '正在处理 · 3 分钟', both: '正在处理 · 3 分钟 · 后台子任务 2 个', sub: '后台子任务 2 个 · 13 分钟', idle: '空闲', rate: '服务受限', auth: '认证', queue: '排队', starting: '启动', 'unknown-busy': '服务状态未知', 'unknown-idle': '服务状态未知', unavailable: null };
  let failed = false;
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) for (const [scene, expected] of Object.entries(scenes)) {
    await t.test(`${width} ${theme} ${scene}: mounted conversation shows the group working state`, async () => {
      let f;
      try {
        f = await open({ width, theme, scene, clock: true });
        if (expected) {
          await checkText(f.page, expected);
          const spinning = await indicator(f.page).locator('.wi-spin').count();
          assert.equal(spinning, ['main', 'both', 'sub'].includes(scene) ? 1 : 0);
          if (scene.startsWith('unknown-')) assert.equal(await indicator(f.page).evaluate(node => node.classList.contains('conversation-restricted')), true, 'unknown health keeps the warning presentation');
        } else await wait(async () => !await indicator(f.page).isVisible(), 'unavailable working is hidden');
        assert.equal(await f.page.locator('.wi-proto-bar').count(), 0, 'prototype switcher is not in the product');
        await shot(f.page, `${width}-${theme}-${scene}`);
        if (['both', 'sub'].includes(scene)) {
          await indicator(f.page).click();
          const side = f.page.locator('#wb-chat .wb-group-side');
          await side.locator('.wi-now').waitFor();
          assert.match(await side.locator('.wi-now').innerText(), /现在.*后台子任务 2 个/);
          assert.match(await side.locator('.wb-d-sub .wb-state').innerText(), /忙碌\s*13m/);
          await shot(f.page, `${width}-${theme}-${scene}-timeline`);
        }
        assert.equal(f.errors.length, 0, f.errors[0]);
      } catch (error) { failed = true; throw error; } finally { if (f) await f.context.close(); }
    });
    if (failed) return;
  }

  await t.test('working polling follows busy and idle cadence and clears unreadable state', async () => {
    const f = await open({ clock: true });
    try {
      await checkText(f.page, '正在处理'); const before = fixture.counts.groups;
      await f.page.clock.fastForward(4999); assert.equal(fixture.counts.groups, before);
      await f.page.clock.fastForward(1); await wait(() => fixture.counts.groups === before + 1, 'busy reads at five seconds');
      fixture.setScene('idle'); await f.page.clock.fastForward(5000); await checkText(f.page, '空闲');
      assert.equal(await indicator(f.page).locator('.wi-spin').count(), 0);
      const idleReads = fixture.counts.groups;
      await f.page.clock.fastForward(29999); assert.equal(fixture.counts.groups, idleReads, 'idle avoids the former busy cadence');
      await f.page.clock.fastForward(1); await wait(() => fixture.counts.groups > idleReads, 'idle reads at thirty seconds');
      fixture.fail(true); await f.page.clock.fastForward(30000);
      await wait(async () => !await indicator(f.page).isVisible(), 'failure removes stale working');
    } finally { fixture.fail(false); await f.context.close(); }
  });
  await t.test('hidden document stops working reads and showing it resumes the current group', async () => {
    const f = await open({ clock: true });
    try {
      await checkText(f.page, '正在处理');
      // This case controls only the browser document visibility boundary; it does not claim OS tab suspension.
      await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
      const before = fixture.counts.groups; await f.page.clock.fastForward(65000);
      assert.equal(fixture.counts.groups, before);
      await f.page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
      await wait(() => fixture.counts.groups > before, 'visible resumes reading');
    } finally { await f.context.close(); }
  });
  await t.test('indicator opens timeline on its first draw and an open panel only switches tabs', async () => {
    const f = await open({ scene: 'sub' });
    try {
      await checkText(f.page, '后台子任务');
      await f.page.evaluate(() => {
        window.detailDraws = [];
        const record = node => {
          if (node.nodeType !== 1) return;
          // Added subtrees retain their own selected tab even if a later synchronous draw detached them.
          const tabs = node.matches('.wb-detail-tabs') ? node : node.querySelector('.wb-detail-tabs');
          const active = tabs?.querySelector('[aria-selected="true"]');
          if (active && window.detailDraws.length < 30) window.detailDraws.push(active.textContent);
        };
        window.detailObserver = new MutationObserver(records => { for (const r of records) { record(r.target); for (const n of r.addedNodes) if (n.nodeType === 1) record(n); } });
        window.detailObserver.observe(document.querySelector('#wb-chat'), { subtree: true, childList: true, attributes: true, attributeFilter: ['hidden', 'aria-selected', 'class'] });
      });
      await indicator(f.page).click();
      const side = f.page.locator('#wb-chat .wb-group-side');
      await side.locator('.wi-now').waitFor();
      const drawn = await f.page.evaluate(() => window.detailDraws);
      assert.ok(drawn.length > 0, 'observer saw the first detail render'); assert.equal(drawn.every(text => text.startsWith('时间线')), true, JSON.stringify(drawn));
      await side.locator('.wb-detail-tabs button').filter({ hasText: '概况' }).click();
      await side.locator('.wb-now-card').waitFor();
      await side.evaluate(node => { window.originalDetailSide = node; window.originalDetailHeader = node.querySelector('.wb-d-title'); });
      await indicator(f.page).click(); await side.locator('.wi-now').waitFor();
      assert.equal(await side.evaluate(node => node === window.originalDetailSide), true, 'open sidebar keeps its mounted panel');
      await f.page.locator('#wb-chat [data-action="page.groupInfo"]').focus(); await f.page.keyboard.press('Enter'); assert.equal(await side.isVisible(), false);
      await f.page.locator('#wb-chat [data-action="page.groupInfo"]').click(); await side.locator('.wb-now-card').waitFor();
      assert.equal(await side.locator('.wb-detail-tabs [aria-selected="true"]').innerText(), '概况');
      await f.page.evaluate(() => window.detailObserver.disconnect());
    } finally { await f.context.close(); }
  });
  await t.test('reduced motion keeps the working glyph still', async () => {
    const f = await open({ reducedMotion: 'reduce' });
    try {
      await checkText(f.page, '正在处理');
      assert.equal(await indicator(f.page).locator('.wi-spin').evaluate(node => getComputedStyle(node).animationName), 'none');
    } finally { await f.context.close(); }
  });
  await t.test('a stored send refreshes healthy group state after two seconds', async () => {
    const f = await open({ clock: true, scene: 'idle' });
    try {
      await checkText(f.page, '空闲');
      await f.page.locator('#wb-chat .conversation-input').fill('请继续核对');
      await f.page.locator('#wb-chat .conversation-composer').evaluate(form => form.requestSubmit());
      await wait(() => fixture.counts.sends > 0, 'message reaches the stored receipt');
      await wait(async () => await f.page.locator('#wb-chat .conversation-input').inputValue() === '', 'stored send clears input');
      const before = fixture.counts.groups; fixture.setScene('main');
      await f.page.clock.fastForward(1999); assert.equal(fixture.counts.groups, before);
      await f.page.clock.fastForward(1); await wait(() => fixture.counts.groups > before, 'post-store refresh runs even healthy account');
      await checkText(f.page, '正在处理');
    } finally { await f.context.close(); }
  });
  await t.test('leaving the selected local conversation cancels its working timer', async () => {
    const f = await open({ clock: true });
    try {
      await checkText(f.page, '正在处理');
      await f.page.locator('#wb-chat [data-action="external"]').click();
      const before = fixture.counts.groups; await f.page.clock.fastForward(20000);
      assert.equal(fixture.counts.groups, before, 'external list never keeps local working timer');
      await f.page.locator('.tab[data-tab="memory"]').click();
      const after = fixture.counts.groups; await f.page.clock.fastForward(20000);
      assert.equal(fixture.counts.groups, after, 'closed conversation page never keeps working timer');
    } finally { await f.context.close(); }
  });
  console.info('Working capture inventory:', JSON.stringify({ captures, missing: [...fixture.missing] }));
  if (evidence) fs.writeFileSync(path.join(evidence, 'captures.json'), JSON.stringify(captures, null, 2));
}
