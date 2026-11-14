import assert from 'node:assert/strict';
import { openGroupDetail } from './browser-navigation.js';
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
const ORIGIN_ID = 'g:' + Buffer.from('origin').toString('hex').toUpperCase();
const OTHER_ID = 'g:' + Buffer.from(OTHER).toString('hex').toUpperCase();
const NOW = Date.UTC(2026, 10, 11, 10, 30);
const iso = value => new Date(value).toISOString();

async function startPage(sandbox) {
  let scene = 'main', failGroups = false, title = '工作状态示例';
  const counts = { groups: 0, sends: 0 }, missing = new Set(), streams = new Set();
  const isOrigin = () => scene.startsWith('scheduled-') || scene === 'asleep';
  const activeId = () => isOrigin() ? ORIGIN_ID : ID;
  const group = () => isOrigin() ? 'origin' : GROUP;
  const working = () => {
    const main = ['main', 'main-long', 'scheduled-short', 'scheduled-long', 'both', 'rate', 'auth', 'queue', 'starting', 'unknown-busy'].includes(scene) ? { since: NOW - (scene === 'main-long' ? 121 : scene === 'scheduled-long' ? 65 : 3) * 60000 } : null;
    const subagents = ['both', 'sub'].includes(scene) ? { count: 2, since: NOW - 13 * 60000, lastActivityAt: NOW - 30000 } : null;
    if (scene === 'unavailable') return null;
    return { on: !!(main || subagents), since: main || subagents ? Math.min(...[main?.since, subagents?.since].filter(Number.isFinite)) : null, main, tools: 0, subagents };
  };
  const snapshot = url => {
    const value = workbenchAnswer(url, NOW);
    const row = value.rows.find(item => item.sessionGroup === SAMPLE_GROUP);
    row.sessionGroup = group(); row.origin = isOrigin(); row.presence = scene === 'asleep' ? 'not_running' : 'running'; row.processing = scene.startsWith('scheduled-') ? 'scheduled_task' : null; row.name = { displayName: title }; row.state = { kind: 'idle' }; row.duration = 75;
    row.tools = []; row.queue = { known: true, pending: { count: 0 }, running: { count: 0 }, fence: null };
    row.working = working(); row.preview = { text: '请继续整理这份资料', timestamp: iso(NOW - 4 * 60000), channel: 'dashboard' };
    row.wait = ({ queue: { kind: 'pool_wait' }, starting: { kind: 'starting' }, rate: { kind: 'rate_wait', cooldownUntil: NOW / 1000 + 3600 }, auth: { kind: 'auth_wait' } })[scene] ?? null;
    value.rows = [row]; value.counts = { busy: 0, idle: 1, waiting: 0, unknown: 0, error: 0, not_running: 0 };
    value.instance.runtimeHealth = { claude: { health: scene.startsWith('unknown-') ? null : ({ rate: 'rate_limited', auth: 'auth_failed' })[scene] ?? 'ok' } };
    return value;
  };
  const conversation = id => ({ id, localId: 'working-browser', sessionGroup: id === OTHER_ID ? OTHER : group(), channel: id === OTHER_ID ? 'telegram' : 'dashboard', state: 'active', origin: id === ORIGIN_ID, displayName: id === OTHER_ID ? '外部会话' : title });
  const answer = url => {
    const p = url.pathname;
    if (p === '/api/workbench/groups') { counts.groups++; return snapshot(url); }
    if (p === '/api/chat/conversations') {
      const external = url.searchParams.get('tab') === 'external';
      return { items: [{ ...conversation(external ? OTHER_ID : activeId()), session_group: external ? OTHER : group(), display_name: external ? '外部会话' : title }], nextCursor: null, tz: 'UTC' };
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
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const data = { version: 1, tab: url.searchParams.get('chat_tab') || 'mine', conversationId: url.searchParams.get('chat_conversation'), ids: [] };
        res.write(`event: chat_ready\ndata: ${JSON.stringify(data)}\n\n`);
        streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
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
  sandbox.addCleanup(() => { for (const stream of streams) stream.end(); });
  return { base: await sandbox.startHttp(server), counts, missing, activeId, setScene(value) { scene = value; }, setTitle(value) { title = value; }, fail(value) { failGroups = value; } };
}

export async function runConversationWorkingBrowser(t, sandbox) {
  console.info('Working browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const fixture = await startPage(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR, captures = [], measurements = [];
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const open = async ({ width = 1280, theme = 'light', scene = 'main', clock = false, reducedMotion = 'no-preference', locale = 'zh', title = '工作状态示例' } = {}) => {
    fixture.setScene(scene); fixture.setTitle(title); fixture.fail(false);
    const context = await browser.newContext({ viewport: { width, height: 960 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'UTC', reducedMotion });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(({ theme, locale }) => {
      try { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', locale); } catch {}
    }, { theme, locale });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    await page.clock.install({ time: new Date(NOW) });
    if (clock) await page.clock.pauseAt(new Date(NOW + 2000));
    await page.goto(fixture.base + '/chat');
    try {
      await page.locator(`#wb-chat [data-conversation-id="${fixture.activeId()}"]`).click();
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
  const checkText = async (page, expected, locale = 'zh') => {
    await wait(async () => (await indicator(page).textContent()).includes(expected), `indicator shows ${expected}`);
    assert.match(await indicator(page).getAttribute('title'), locale === 'zh' ? /点按查看时间线/ : /timeline/i);
    assert.match(await indicator(page).getAttribute('aria-label'), locale === 'zh' ? /点按查看时间线/ : /timeline/i);
    for (const value of [await indicator(page).innerText(), await indicator(page).getAttribute('title'), await indicator(page).getAttribute('aria-label')]) assert.doesNotMatch(value, /分钟|小时|\bminutes?\b|\bhours?\b|\d+h|\d+ min/);
  };
  const shot = async (page, name, { moving = false } = {}) => {
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal document overflow');
    if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png'), ...(moving ? {} : { animations: 'disabled' }) });
    captures.push(name);
  };
  const checkComet = async (page, busy) => {
    const pill = indicator(page);
    assert.equal(await pill.locator('.wi-comet').count(), busy ? 1 : 0, 'only busy state owns a comet');
    if (!busy) return;
    assert.equal(await pill.locator('.wi-comet').getAttribute('aria-hidden'), 'true');
    assert.equal(await pill.locator('.wi-comet rect[pathLength="100"]').count(), 7);
    assert.equal(await pill.locator('.wi-spin').isVisible(), false, 'comet replaces the visible spinner');
    assert.equal(await pill.locator('.wi-ind-chev').isVisible(), true, 'timeline arrow remains visible');
    const timing = await pill.locator('.wi-comet rect').first().evaluate(node => {
      const css = getComputedStyle(node); return { name: css.animationName, duration: css.animationDuration, timing: css.animationTimingFunction };
    });
    assert.equal(timing.name, 'wi-comet');
    assert.equal(timing.duration, await page.evaluate(() => innerWidth <= 760) ? '2.2s' : '2.6s');
    assert.equal(timing.timing, 'linear');
    if (await page.locator('html').getAttribute('data-theme') === 'dark') {
      const colors = await pill.locator('.wi-comet rect').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).stroke));
      assert.deepEqual(colors, ['rgb(67, 199, 181)', 'rgb(79, 214, 196)', 'rgb(95, 216, 234)', 'rgb(122, 168, 255)', 'rgb(165, 147, 255)', 'rgb(224, 140, 255)', 'rgb(255, 156, 198)'], 'dark comet keeps the approved seven-color palette');
    }
  };
  const checkDesktopCaption = async (page, expected) => {
    // Unknown health wording exists before the optional group read makes it visible.
    await indicator(page).locator('.wi-ind-desktop').waitFor({ state: 'visible' });
    assert.equal(await indicator(page).locator('.wi-ind-desktop').isVisible(), true, 'full caption is visible on desktop');
    assert.equal((await indicator(page).innerText()).replace(/\s+/g, ' ').trim(), expected, 'desktop caption omits elapsed time');
    assert.equal(await indicator(page).locator('.wi-ind-mobile').isVisible(), false, 'compact caption does not duplicate desktop text');
  };
  const checkPhonePill = async (page, expected, { longTitle = false } = {}) => {
    const m = await page.evaluate(() => {
      const box = selector => {
        const el = document.querySelector(selector), r = el.getBoundingClientRect(), css = getComputedStyle(el);
        return { x: r.x, top: r.top, right: r.right, bottom: r.bottom, height: r.height, width: r.width,
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, overflow: css.overflow, textOverflow: css.textOverflow,
          fontSize: css.fontSize, maxWidth: css.maxWidth, borderY: parseFloat(css.borderTopWidth) + parseFloat(css.borderBottomWidth), text: el.innerText };
      };
      return { header: box('.conversation-header'), title: box('.conversation-title-line'), text: box('.conversation-title-line h2'),
        pill: box('.conversation-running'), caption: box('.conversation-running .wi-ind-mobile'), menu: box('.conversation-menu-toggle'),
        hit: (() => { const css = getComputedStyle(document.querySelector('.conversation-running'), '::after'); return { top: parseFloat(css.top), bottom: parseFloat(css.bottom) }; })() };
    });
    assert.equal(await indicator(page).locator('.wi-ind-mobile').isVisible(), true);
    assert.equal(await indicator(page).locator('.wi-ind-desktop').isVisible(), false);
    measurements.push({ kind: 'compact', expected, ...m });
    assert.equal(m.header.height - m.header.borderY, 52, 'busy state adds no separate status row');
    assert.equal(m.pill.height, 22); assert.equal(m.pill.fontSize, '11px');
    assert.ok(m.pill.top >= m.header.top && m.pill.bottom <= m.header.bottom, 'pill stays inside title row');
    assert.ok(m.title.right <= m.pill.x + 1 && m.pill.right <= m.menu.x + 1, 'title, pill and menu never overlap');
    assert.equal(m.pill.text.replace(/\s+/g, ' ').trim(), expected, 'phone shows the compact complete label');
    assert.ok(m.caption.scrollWidth <= m.caption.clientWidth, 'pill caption is not clipped');
    const limit = await page.evaluate(() => innerWidth * .46);
    assert.ok(Math.abs(parseFloat(m.pill.maxWidth) - limit) < .1, 'phone pill keeps its explicit 46vw bound');
    assert.ok(m.pill.width <= limit + 1, 'rendered pill respects the bound');
    assert.ok(m.pill.height - m.hit.top - m.hit.bottom >= 44, 'pseudo-element expands the tap target');
    if (longTitle) {
      assert.ok(m.text.scrollWidth > m.text.clientWidth, 'long title yields space to the pill');
      assert.equal(m.text.textOverflow, 'ellipsis');
    }
  };
  const checkPhoneStatus = async (page, scene, locale = 'zh') => {
    const m = await indicator(page).evaluate(node => {
      const r = node.getBoundingClientRect(), css = getComputedStyle(node);
      const title = document.querySelector('.conversation-title-line').getBoundingClientRect();
      const caption = node.querySelector('.wi-ind-text');
      const probe = document.createElement('span'); probe.style.color = 'var(--text-dim)'; probe.style.background = 'var(--bg-card)'; node.append(probe);
      const expected = getComputedStyle(probe), result = { top: r.top, width: r.width, titleBottom: title.bottom,
        captionWidth: caption.clientWidth, textWidth: caption.scrollWidth, captionHeight: caption.clientHeight, textHeight: caption.scrollHeight, text: node.innerText, state: node.dataset.state, color: css.color, expectedColor: expected.color,
        background: css.backgroundColor, expectedBackground: expected.backgroundColor, weight: css.fontWeight,
        fontSize: css.fontSize, gridRow: css.gridRowStart, maxWidth: css.maxWidth };
      probe.remove(); return result;
    });
    measurements.push({ kind: 'nonworking', scene, locale, ...m });
    const labels = { zh: { rate: '服务受限，恢复后自动投递', auth: '需要认证', queue: '排队中', asleep: '休眠' },
      en: { rate: 'Service limited · delivery resumes after recovery', auth: 'Authentication required', queue: 'Queueing', asleep: 'Asleep' } };
    assert.equal(m.state, { rate: 'restricted', auth: 'restricted', queue: 'waiting', asleep: 'asleep' }[scene]);
    assert.equal(m.text.replace(/\s+/g, ' ').trim(), labels[locale][scene], 'each nonworking state retains its complete visible wording');
    assert.ok(m.textHeight <= m.captionHeight, 'wrapped nonworking label is not vertically clipped');
    assert.ok(m.top >= m.titleBottom, 'nonworking status remains below the title');
    assert.equal(m.gridRow, '3');
    assert.ok(m.textWidth <= m.captionWidth, 'nonworking status label stays complete');
    assert.equal(m.color, m.expectedColor, 'nonworking status keeps the base neutral color');
    if (await page.locator('html').getAttribute('data-theme') === 'light') assert.equal(m.color, 'rgb(82, 97, 112)');
    assert.equal(m.background, m.expectedBackground); assert.equal(m.weight, '450'); assert.equal(m.fontSize, '13px');
  };
  const scenes = { main: '正在工作', both: '正在工作 · 后台子任务 2 个', sub: '后台子任务 2 个', idle: '空闲', rate: '服务受限，恢复后自动投递', auth: '需要认证', queue: '排队中', starting: '正在唤醒', 'unknown-busy': '服务状态未知', 'unknown-idle': '服务状态未知', unavailable: null };
  let failed = false;
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) for (const [scene, expected] of Object.entries(scenes)) {
    await t.test(`${width} ${theme} ${scene}: mounted conversation shows the group working state`, async () => {
      let f;
      try {
        f = await open({ width, theme, scene, clock: true });
        if (expected) {
          await checkText(f.page, expected);
          if (width > 760) await checkDesktopCaption(f.page, expected);
          const spinning = await indicator(f.page).locator('.wi-spin').count();
          assert.equal(spinning, ['main', 'both', 'sub', 'starting'].includes(scene) ? 1 : 0);
          await checkComet(f.page, ['main', 'both', 'sub', 'starting'].includes(scene));
          if (width <= 760 && ['main', 'both', 'sub', 'starting'].includes(scene)) {
            await checkPhonePill(f.page, scene === 'sub' ? '后台子任务 2 个' : scene === 'starting' ? '正在唤醒' : '正在工作');
          }
          if (width <= 760 && scene === 'idle') {
            // As in the prototype, an idle phone header shows the dot and 空闲 beside the title, without a border.
            assert.equal(await indicator(f.page).isVisible(), true);
            assert.equal(await indicator(f.page).evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
            assert.equal(await f.page.locator('.conversation-header').evaluate(node => { const css = getComputedStyle(node); return node.getBoundingClientRect().height - parseFloat(css.borderTopWidth) - parseFloat(css.borderBottomWidth); }), 52);
          }
          if (width <= 760 && ['rate', 'auth', 'queue'].includes(scene)) await checkPhoneStatus(f.page, scene);
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
      await checkText(f.page, '正在工作'); const before = fixture.counts.groups;
      await indicator(f.page).locator('.wi-ind-desktop').evaluate(node => { window.beforePollingCaption = node; });
      await f.page.clock.fastForward(4000);
      assert.equal(await indicator(f.page).locator('.wi-ind-desktop').evaluate(node => node === window.beforePollingCaption), true,
        'the caption is not rebuilt by a per-second clock before the busy poll');
      await f.page.clock.fastForward(999); assert.equal(fixture.counts.groups, before);
      // The clock is paused: the page schedules its next read when it handles an answer. Change the answer before the
      // read, then wait until the page shows it, so no later clock jump can run ahead of the page's own timer.
      fixture.setScene('idle');
      await f.page.clock.fastForward(1); await wait(() => fixture.counts.groups === before + 1, 'busy reads at five seconds');
      await checkText(f.page, '空闲');
      assert.equal(await indicator(f.page).locator('.wi-spin').count(), 0);
      await checkComet(f.page, false);
      assert.equal(await indicator(f.page).evaluate(node => node.classList.contains('wi-settle')), true, 'busy to idle keeps settle effect');
      const idleReads = fixture.counts.groups;
      await f.page.clock.fastForward(29999); assert.equal(fixture.counts.groups, idleReads, 'idle avoids the former busy cadence');
      fixture.fail(true);
      await f.page.clock.fastForward(1); await wait(() => fixture.counts.groups > idleReads, 'idle reads at thirty seconds');
      await wait(async () => !await indicator(f.page).isVisible(), 'failure removes stale working');
    } finally { fixture.fail(false); await f.context.close(); }
  });
  await t.test('hidden document stops working reads and showing it resumes the current group', async () => {
    const f = await open({ clock: true });
    try {
      await checkText(f.page, '正在工作');
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
      // The open detail overlay covers the header's pointer target. Use the
      // same button's real keyboard activation to exercise switching its mounted panel.
      // Initial opening and the expanded phone tap target are tested with pointer input.
      await indicator(f.page).focus(); await f.page.keyboard.press('Enter'); await side.locator('.wi-now').waitFor();
      assert.equal(await side.evaluate(node => node === window.originalDetailSide), true, 'open sidebar keeps its mounted panel');
      await openGroupDetail(f.page, { keyboard: true }); assert.equal(await side.isVisible(), false);
      await openGroupDetail(f.page); await side.locator('.wb-now-card').waitFor();
      assert.equal(await side.locator('.wb-detail-tabs [aria-selected="true"]').innerText(), '概况');
      await f.page.evaluate(() => window.detailObserver.disconnect());
    } finally { await f.context.close(); }
  });
  await t.test('reduced motion keeps the working glyph still', async () => {
    const f = await open({ reducedMotion: 'reduce' });
    try {
      await checkText(f.page, '正在工作');
      assert.equal(await indicator(f.page).locator('.wi-comet').count(), 1, 'busy DOM still owns the reduced-motion comet');
      assert.equal(await indicator(f.page).locator('.wi-comet').isVisible(), false, 'reduced motion hides the entire light');
      assert.equal(await indicator(f.page).locator('.wi-spin').isVisible(), true, 'still glyph returns');
      // Each snapshot redraws the glyph. Find it and read its style in one page call: a locator resolves and evaluates in
      // two steps, and a poll between them leaves a detached node whose computed style is empty.
      assert.equal(await indicator(f.page).evaluate(node => getComputedStyle(node.querySelector('.wi-spin')).animationName), 'none');
      await shot(f.page, 'reduced-motion');
    } finally { await f.context.close(); }
  });
  for (const width of [390, 360]) for (const theme of ['light', 'dark']) for (const scene of ['main', 'sub', 'idle']) {
    await t.test(`${width} ${theme} ${scene}: long title preserves the compact pill`, async () => {
      const f = await open({ width, theme, scene, title: '工作状态标题'.repeat(7).slice(0, 40), clock: true });
      try {
        await checkText(f.page, ({ main: '正在工作', sub: '后台子任务 2 个', idle: '空闲' })[scene]);
        if (scene !== 'idle') {
          await checkPhonePill(f.page, scene === 'sub' ? '后台子任务 2 个' : '正在工作', { longTitle: true });
          const box = await indicator(f.page).boundingBox();
          await f.page.mouse.click(box.x + box.width / 2, box.y - 8);
          await f.page.locator('#wb-chat .wb-group-side .wi-now').waitFor();
          await f.page.locator('.wb-group-side-back').click();
        } else {
          // A long title yields to the idle status: 空闲 stays whole between the title and the menu.
          assert.equal(await indicator(f.page).isVisible(), true);
          const title = await f.page.locator('.conversation-title-line h2').boundingBox(), idle = await indicator(f.page).boundingBox();
          const menu = await f.page.locator('.conversation-menu-toggle').boundingBox();
          assert.ok(title.x + title.width <= idle.x + 1 && idle.x + idle.width <= menu.x + 1, 'idle status sits between the title and the menu');
          assert.equal(await indicator(f.page).locator('.wi-ind-text:visible').first().evaluate(node => node.scrollWidth <= node.clientWidth), true, 'idle caption is complete');
          assert.equal(await f.page.locator('.conversation-header').evaluate(node => { const css = getComputedStyle(node); return node.getBoundingClientRect().height - parseFloat(css.borderTopWidth) - parseFloat(css.borderBottomWidth); }), 52);
        }
        await shot(f.page, `${width}-${theme}-${scene}-long-title`);
        assert.equal(f.errors.length, 0, f.errors[0]);
      } catch (error) { failed = true; throw error; } finally { await f.context.close(); }
    });
    if (failed) return;
  }
  // Boundary: rendered compact wording, caption geometry and desktop/mobile breakpoint.
  // Run for phone wording/header changes; unrelated backend work may skip.
  // Fixed snapshots vary main-work age while preserving scheduled-origin selection and child counts.
  const compactCases = [
    { scene: 'main-long', zh: '正在工作', en: 'Working', fullZh: '正在工作', fullEn: 'Working' },
    { scene: 'scheduled-short', zh: '定时任务', en: 'Scheduled', fullZh: '正在执行定时任务', fullEn: 'Running a scheduled task' },
    { scene: 'scheduled-long', zh: '定时任务', en: 'Scheduled', fullZh: '正在执行定时任务', fullEn: 'Running a scheduled task' },
    { scene: 'sub', zh: '后台子任务 2 个', en: '2 subtasks', fullZh: '后台子任务 2 个', fullEn: '2 background tasks' },
  ];
  for (const width of [360, 390]) for (const locale of ['zh', 'en']) for (const item of compactCases) {
    await t.test(`${width} ${locale} ${item.scene}: compact wording preserves the complete label`, async () => {
      const f = await open({ width, locale, scene: item.scene, title: locale === 'zh' ? '工作状态标题'.repeat(7).slice(0, 40) : 'Release workflow verification long title', clock: true });
      try {
        const full = locale === 'zh' ? item.fullZh : item.fullEn;
        await checkText(f.page, full, locale);
        await checkPhonePill(f.page, item[locale], { longTitle: true });
        assert.ok((await indicator(f.page).getAttribute('title')).includes(full), 'tooltip preserves complete wording');
        assert.ok((await indicator(f.page).getAttribute('aria-label')).includes(full), 'accessible label preserves complete wording');
        await shot(f.page, `${width}-${locale}-${item.scene}-compact`);
        await f.page.setViewportSize({ width: 1280, height: 960 });
        await checkDesktopCaption(f.page, full);
        await f.page.setViewportSize({ width, height: 960 });
        await checkPhonePill(f.page, item[locale], { longTitle: true });
        await indicator(f.page).click(); await f.page.locator('.wb-group-side .wi-now').waitFor();
        assert.match(await f.page.locator('.wb-group-side .wi-now').innerText(), locale === 'zh' ? /现在.*正在工作|现在.*后台子任务/ : /Now.*Working|Now.*background tasks/i);
        assert.equal(f.errors.length, 0, f.errors[0]);
      } catch (error) { failed = true; throw error; } finally { await f.context.close(); }
    });
    if (failed) return;
  }
  // Boundary: existing nonworking states and their full phone status row.
  // Run for phone header/status styling or wording changes; unrelated backend work may skip.
  for (const width of [360, 390]) for (const locale of ['zh', 'en']) for (const scene of ['rate', 'auth', 'queue', 'asleep']) {
    await t.test(`${width} ${locale} ${scene}: nonworking status retains its base row`, async () => {
      const f = await open({ width, locale, scene, clock: true });
      try {
        await wait(async () => await indicator(f.page).isVisible(), 'nonworking status is visible');
        await checkPhoneStatus(f.page, scene, locale); await checkComet(f.page, false);
        await shot(f.page, `${width}-${locale}-${scene}-status-row`);
        assert.equal(f.errors.length, 0, f.errors[0]);
      } catch (error) { failed = true; throw error; } finally { await f.context.close(); }
    });
    if (failed) return;
  }
  await t.test('busy transitions replace the comet without leaving stale light', async () => {
    const f = await open({ clock: true });
    try {
      await checkText(f.page, '正在工作'); await checkComet(f.page, true);
      fixture.setScene('idle'); await f.page.clock.fastForward(5000); await checkText(f.page, '空闲'); await checkComet(f.page, false);
      fixture.setScene('main'); await f.page.clock.fastForward(30000); await checkText(f.page, '正在工作'); await checkComet(f.page, true);
      assert.equal(await indicator(f.page).evaluate(node => node.classList.contains('wi-settle')), false);
    } finally { await f.context.close(); }
  });
  await t.test('border light continues along its SVG path across a working refresh', async () => {
    const f = await open();
    try {
      await checkText(f.page, '正在工作'); await checkComet(f.page, true);
      const originalTime = await indicator(f.page).locator('.wi-comet').evaluate(node => {
        window.originalComet = node;
        return node.querySelector('rect').getAnimations()[0]?.currentTime;
      });
      assert.ok(Number.isFinite(originalTime), 'initial comet animation has a timeline');
      const reads = fixture.counts.groups;
      fixture.setScene('both');
      await wait(() => fixture.counts.groups > reads, 'busy polling fetches the changed working snapshot');
      await checkText(f.page, '正在工作 · 后台子任务 2 个');
      const continuity = await indicator(f.page).locator('.wi-comet').evaluate(node => ({
        sameNode: node === window.originalComet,
        time: node.querySelector('rect').getAnimations()[0]?.currentTime,
      }));
      assert.equal(continuity.sameNode, true, 'polled snapshot refresh preserves the animated SVG while the caption changes');
      assert.ok(continuity.time > originalTime + 1000, 'comet animation time continues across the five-second busy refresh');
      const rect = indicator(f.page).locator('.wi-comet rect').first();
      const before = await rect.evaluate(node => parseFloat(getComputedStyle(node).strokeDashoffset));
      await shot(f.page, 'motion-before', { moving: true });
      await new Promise(resolve => setTimeout(resolve, 500));
      const after = await rect.evaluate(node => parseFloat(getComputedStyle(node).strokeDashoffset));
      await shot(f.page, 'motion-after', { moving: true });
      assert.ok(Number.isFinite(before) && Number.isFinite(after) && before !== after, 'dashoffset changes after about half a second');
      if (evidence) fs.writeFileSync(path.join(evidence, 'motion.json'), JSON.stringify({ before, after, intervalMs: 500 }, null, 2));
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
      await checkText(f.page, '正在工作');
    } finally { await f.context.close(); }
  });
  await t.test('leaving the selected local conversation cancels its working timer', async () => {
    const f = await open({ clock: true });
    try {
      await checkText(f.page, '正在工作');
      await f.page.locator('#wb-chat [data-action="external"]').click();
      const before = fixture.counts.groups; await f.page.clock.fastForward(20000);
      assert.equal(fixture.counts.groups, before, 'external list never keeps local working timer');
      await f.page.locator('.tab[data-tab="memory"]').click();
      const after = fixture.counts.groups; await f.page.clock.fastForward(20000);
      assert.equal(fixture.counts.groups, after, 'closed conversation page never keeps working timer');
    } finally { await f.context.close(); }
  });
  console.info('Working capture inventory:', JSON.stringify({ captures, missing: [...fixture.missing] }));
  if (evidence) {
    fs.writeFileSync(path.join(evidence, 'captures.json'), JSON.stringify(captures, null, 2));
    fs.writeFileSync(path.join(evidence, 'working-measurements.json'), JSON.stringify(measurements, null, 2));
  }
}
