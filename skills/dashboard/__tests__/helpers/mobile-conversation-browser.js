import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP as SAMPLE_GROUP, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const currentPublic = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const GROUP = 'dashboard:mobile-browser', EXTERNAL = 'telegram:mobile-browser';
const ID = 'g:' + Buffer.from(GROUP).toString('hex').toUpperCase();
const EXT_ID = 'g:' + Buffer.from(EXTERNAL).toString('hex').toUpperCase();
const ORIGIN_ID = 'g:' + Buffer.from('origin').toString('hex').toUpperCase();
const NOW = Date.UTC(2026, 10, 12, 5, 30);
const iso = offset => new Date(NOW + offset).toISOString();

// Fixed existing API contracts over private loopback: the real entry/modules/styles
// render them. No database, runtime, channel, outbound request or backend extension.
async function startPage(sandbox, publicDir) {
  let scene = 'idle', connected = true, observerBlocked = false, sessionMode = 'multi';
  const streams = new Set(), missing = new Set(), actions = [];
  const conversation = id => ({ id, localId: 'mobile-browser', sessionGroup: id === EXT_ID ? EXTERNAL : id === ORIGIN_ID ? 'origin' : GROUP,
    channel: id === EXT_ID ? 'telegram' : 'dashboard', state: 'active', displayName: id === EXT_ID ? 'Howard' : id === ORIGIN_ID ? 'Origin' : '发布流程核对',
    display_name: id === EXT_ID ? 'Howard' : id === ORIGIN_ID ? 'Origin' : '发布流程核对', origin: id === ORIGIN_ID });
  const messages = [{ id: 1, direction: 'in', channel: 'dashboard', content: '发版流程改好了吗？', timestamp: iso(-5 * 60000), status: 'delivered' },
    { id: 2, direction: 'out', channel: 'dashboard', content: '改好了，新流程是这样：\n\n1. 推 server 的 tag，流水线自动打包\n2. 测试服先装，冒烟通过再正常升级\n3. 服务端升好后，再发布 App\n\n本地不再编译，也不用再手动传包。\n\n**已验证：** 打包结果与之前的内容一致。\n\n**还没验证：** 真正的流水线发版要等第一次推 tag 才会跑。', timestamp: iso(-2 * 60000), status: 'sent' }];
  const answer = url => {
    const p = url.pathname;
    if (p === '/api/chat/conversations') return { items: url.searchParams.get('tab') === 'external' ? [conversation(EXT_ID)] : [conversation(ORIGIN_ID), conversation(ID)], nextCursor: null, tz: 'UTC', deletionAllowed: true };
    if (p.startsWith('/api/chat/conversations/')) {
      const id = decodeURIComponent(p.split('/')[4]);
      if (p.endsWith('/messages')) return { items: messages, nextCursor: null, afterCursor: 'after-2', tz: 'UTC' };
      if (p.endsWith('/activity')) return { now: iso(0), items: [] };
      if (p.endsWith('/status') || p.endsWith('/questions')) return { items: [], nextCursor: null };
      return { conversation: conversation(id) };
    }
    if (p === '/api/session-mode') return { ok: true, data: { sessionMode, transition: null } };
    if (p === '/api/settings/timezone') return { tz: 'UTC', writable: true, restart_status: 'known', restart_services: [] };
    if (p === '/api/observer/status' && observerBlocked) return { state: 'not_installed', startupError: 'teardown_failed' };
    if (p === '/api/state') return { state: 'IDLE', agent: { name: 'luna' }, session_mode: 'multi', runtime_info: { runtime: 'claude', zylos_version: '1.0.0-beta.7' } };
    if (p === '/api/fleet') return { agents: [{ name: 'luna', self: true, access: 'admin' }], updated_at: iso(0) };
    if (p === '/api/fleet/agents') return { self: { name: 'luna' }, agents: [] };
    if (p === '/api/workbench/groups') {
      const value = workbenchAnswer(url, NOW), row = value.rows.find(item => item.sessionGroup === SAMPLE_GROUP);
      row.sessionGroup = GROUP; row.name = { displayName: '发布流程核对' }; row.state = { kind: 'idle' }; row.tools = [];
      row.queue = { known: true, pending: { count: 0 }, running: { count: 0 }, fence: null };
      row.working = { on: scene === 'running', since: scene === 'running' ? NOW - 3 * 60000 : null, turn: scene === 'running' ? { since: NOW - 3 * 60000 } : null, tools: 0, subagents: null };
      value.rows = [row, { ...row, sessionGroup: 'origin', origin: true, name: null, working: { on: false, since: null, turn: null, tools: 0, subagents: null } }];
      value.instance.runtimeHealth = { claude: { health: 'ok' } };
      value.counts = { busy: 0, idle: 2, waiting: 0, unknown: 0, error: 0, not_running: 0 };
      return value;
    }
    if (p.startsWith('/api/workbench/groups/') && p.endsWith('/runs')) return { runs: [{ runId: 'run-tg', startAt: iso(-20 * 60000), endAt: iso(-30000), n: 2, endReason: 'running' }], totalRuns: 1, totalEvents: 2, unattributed: 0 };
    if (p.startsWith('/api/workbench/groups/') && p.endsWith('/messages')) return { messages: [] };
    return workbenchAnswer(url, NOW);
  };
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (!connected) { res.end(); return; }
        const data = { version: 1, tab: url.searchParams.get('chat_tab') || 'mine', conversationId: url.searchParams.get('chat_conversation'), ids: [] };
        res.write(`event: chat_ready\ndata: ${JSON.stringify(data)}\n\n`); streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET') {
          actions.push({ method: req.method, path: url.pathname });
          if (req.method === 'PATCH' && url.pathname.startsWith('/api/chat/conversations/')) { sendJson(res, 200, { conversation: conversation(ID) }); return; }
          sendJson(res, 200, { ok: true }); return;
        }
        const value = answer(url);
        if (value === undefined && missing.size < 10) missing.add(`${req.method} ${url.pathname}`);
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (url.pathname === '/__prototype' && process.env.ZYLOS_MOBILE_PROTOTYPE_SOURCE) { sendHtml(res, 200, fs.readFileSync(process.env.ZYLOS_MOBILE_PROTOTYPE_SOURCE, 'utf8')); return; }
      if (['/', '/chat', '/memory', '/schedule', '/usage', '/settings'].includes(url.pathname)) {
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
  return { base: await sandbox.startHttp(server), missing, actions,
    setScene(value) { scene = value; }, setSessionMode(value) { sessionMode = value; }, setObserverBlocked(value) { observerBlocked = value; }, disconnect() { connected = false; for (const stream of streams) stream.end(); } };
}

export async function runMobileConversationBrowser(t, sandbox) {
  console.info('Mobile browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const publicDir = process.env.ZYLOS_MOBILE_BASELINE_PUBLIC || currentPublic;
  const fixture = await startPage(sandbox, publicDir);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const captures = [], measurements = [];
  const open = async ({ width = 390, locale = 'zh', theme = 'light', scene = 'idle', observerBlocked = false, detail = 'plain', sessionMode = 'multi' } = {}) => {
    fixture.setScene(scene); fixture.setObserverBlocked(observerBlocked); fixture.setSessionMode(sessionMode);
    const context = await browser.newContext({ viewport: { width, height: width < 761 ? 844 : 900 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'UTC' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(({ locale, theme, detail }) => { if (window !== window.top) return; localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-detail-level', detail); }, { locale, theme, detail });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.stack || error.message); });
    await page.clock.install({ time: new Date(NOW) });
    await page.goto(fixture.base + '/chat');
    try { await page.locator(`[data-conversation-id="${ID}"]`).waitFor(); }
    catch (error) { if (evidence) { await page.screenshot({path:path.join(evidence, 'mount-failure.png')}); fs.writeFileSync(path.join(evidence, 'mount-failure.html'), await page.content()); } console.error('Mobile mount:', JSON.stringify({ errors, missing: [...fixture.missing], text: (await page.locator('body').innerText()).slice(0, 1500) })); throw error; }
    return { page, context, errors };
  };
  const select = async page => { await page.locator(`[data-conversation-id="${ID}"]`).click(); await page.locator('.conversation-message').first().waitFor(); };
  const shot = async (page, name) => {
    await page.evaluate(() => document.fonts.ready);
    const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(size.width <= size.viewport + 1, name + ' no horizontal overflow');
    if (evidence) { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file, animations: 'disabled' }); captures.push(file); }
  };
  // Baseline capture is an opt-in evidence mode using untouched git-archived public files.
  // It has the same fixture and clock as final desktop screenshots, not altered product text.
  if (process.env.ZYLOS_MOBILE_BASELINE_PUBLIC) {
    const f = await open({ width: 1280 }); await select(f.page); await shot(f.page, 'desktop-1280-zh-before');
    await f.page.locator('.tab[data-tab="overview"]').click(); await shot(f.page, 'overview-1280-zh-before');
    await f.context.close();
    if (process.env.ZYLOS_MOBILE_PROTOTYPE_SOURCE) {
      const reference = await browser.newContext({ viewport: { width: 390, height: 844 } }); sandbox.addCleanup(() => reference.close());
      const page = await reference.newPage(); await page.goto(fixture.base + '/__prototype'); await shot(page, 'approved-prototype-390-focus');
      await page.locator('[data-act="back"]').click(); await shot(page, 'approved-prototype-390-list'); await reference.close();
    }
    console.info('Mobile captures:', JSON.stringify(captures)); return;
  }
  const noOverflow = async page => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal overflow');
  // The document can stay narrow while a control is clipped by its container.
  // Inspect the rendered control rectangles too, with a bounded fail-first scan.
  const controlsFit = async (page, state) => {
    const result = await page.evaluate(() => {
      const controls = document.querySelectorAll('button,input,textarea,select,a[href],[role="button"]');
      if (controls.length > 256) return { failure: { reason: 'fixture control limit', count: controls.length } };
      let checked = 0;
      for (const el of controls) {
        const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
        if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || style.pointerEvents === 'none' || el.closest('[inert]')) continue;
        // Quote actions deliberately use a one-pixel clipped accessibility target
        // until selected; those are not the visible controls being measured.
        if (rect.width <= 1 && rect.height <= 1 && style.clip !== 'auto') continue;
        checked++;
        if (rect.left < 0 || rect.right > innerWidth) return { checked, failure: { tag: el.tagName, class: el.className, action: el.dataset.action, text: (el.textContent || el.getAttribute('aria-label') || '').slice(0, 80), left: rect.left, right: rect.right, viewport: innerWidth } };
      }
      return { checked, failure: null };
    });
    assert.equal(result.failure, null, state + ' control outside viewport: ' + JSON.stringify(result.failure));
    assert.ok(result.checked > 0, state + ' measured visible controls');
  };
  const menu = page => page.locator('.conversation-menu-sheet');
  const rendered = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await t.test('desktop remains unchanged and mobile chrome is absent', async () => {
    const f = await open({ width: 1280 });
    try {
      await select(f.page); await shot(f.page, 'desktop-1280-zh');
      assert.equal(await f.page.locator('#wb-mobile-nav').isVisible(), false);
      assert.equal(await f.page.locator('.wb-mobile-topbar').isVisible(), false);
      assert.equal(await f.page.locator('.conversation-menu-toggle').isVisible(), false);
      assert.equal(await f.page.locator('.conversation-compose-hint').isVisible(), true);
      assert.equal(await f.page.locator('.app-header').isVisible(), true);
      await f.page.locator('.tab[data-tab="overview"]').click(); await shot(f.page, 'overview-1280-zh');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await t.test('bottom tabs and More delegate to existing controls and visibility', async () => {
    const f = await open(); const page = f.page;
    try {
      assert.equal(await page.locator('#wb-mobile-nav').isVisible(), true);
      assert.equal(await page.locator('.app-header').isVisible(), false);
      assert.match(await page.locator('#wb-mobile-brand').innerText(), /luna.*1\.0\.0-beta\.7/);
      assert.equal(await page.locator('#wb-mobile-list-refresh').isVisible(), true);
      assert.equal(await page.locator('#wb-mobile-list-create').isVisible(), true);
      await page.waitForFunction(() => { const chat = document.querySelector('.conversation-page').getBoundingClientRect(), nav = document.querySelector('#wb-mobile-nav').getBoundingClientRect(); return chat.height > 100 && Math.abs(chat.bottom - nav.top) <= 1; });
      const listBounds = await page.locator('.conversation-page').boundingBox(), navigationBounds = await page.locator('#wb-mobile-nav').boundingBox();
      assert.ok(Math.abs(listBounds.y + listBounds.height - navigationBounds.y) <= 1, 'conversation list ends above fixed navigation');
      assert.equal(await page.locator(`[data-conversation-id="${ORIGIN_ID}"] .conversation-pinned`).isVisible(), true, 'Origin is pinned');
      assert.equal(await page.locator(`[data-conversation-id="${ID}"] .conversation-pinned`).isVisible(), false, 'ordinary conversation is not pinned');
      await shot(page, 'mobile-390-zh-list');
      for (const name of ['overview', 'schedule', 'memory', 'chat']) {
        await page.locator(`[data-mobile-tab="${name}"]`).click();
        await page.locator(`#tab-${name}`).waitFor({ state: 'visible' });
        assert.equal(await page.locator(`#tab-${name}`).isVisible(), true, name + ' uses original tab');
        assert.equal(await page.locator(`[data-mobile-tab="${name}"]`).getAttribute('aria-current'), 'page');
      }
      const openMore = async () => { await page.locator('#wb-mobile-more').click(); await page.locator('#wb-mobile-more-sheet').waitFor(); };
      await openMore();
      await page.setViewportSize({ width: 761, height: 844 });
      await page.waitForFunction(() => document.querySelector('#wb-mobile-more-sheet').hidden);
      assert.equal(await page.locator('#wb-mobile-more-sheet').evaluate(el => el.hidden), true, 'leaving the phone closes More state');
      await page.setViewportSize({ width: 390, height: 844 }); await rendered(page);
      assert.equal(await page.locator('#wb-mobile-more-sheet').isVisible(), false, 'returning to the phone does not reopen More');
      await openMore();
      for (const name of ['usage', 'settings', 'machines', 'detail', 'theme']) assert.equal(await page.locator(`[data-mobile-action="${name}"]`).isVisible(), true);
      const observer = page.locator('[data-mobile-action="observer"]');
      assert.equal(await page.locator('html').getAttribute('data-detail'), 'plain');
      await observer.waitFor({ state: 'hidden' });
      await page.locator('[data-mobile-action="detail"]').click();
      await observer.waitFor({ state: 'visible' });
      assert.equal(await page.locator('#observer-tab').evaluate(el => el.hidden), false, 'technical available source is shown');
      await page.locator('[data-mobile-action="detail"]').click();
      await observer.waitFor({ state: 'hidden' });
      const unavailable = await open({ observerBlocked: true, detail: 'technical' });
      try {
        await unavailable.page.locator('#wb-mobile-more').click();
        await unavailable.page.locator('#wb-mobile-more-sheet').waitFor();
        assert.equal(await unavailable.page.locator('#observer-tab').evaluate(el => el.hidden), true, 'recovery-blocked observer hides original source');
        assert.equal(await unavailable.page.locator('[data-mobile-action="observer"]').isVisible(), false, 'unavailable source stays absent in More');
        assert.deepEqual(unavailable.errors, []);
      } finally { await unavailable.context.close(); fixture.setObserverBlocked(false); }
      await controlsFit(page, 'More');
      await shot(page, 'mobile-390-zh-more');
      const before = await page.locator('#wb-detail-toggle').isChecked();
      await page.locator('[data-mobile-action="detail"]').click();
      assert.equal(await page.locator('#wb-detail-toggle').isChecked(), !before);
      await page.locator('[data-mobile-action="detail"]').click();
      await page.locator('[data-mobile-action="theme"]').click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
      await page.locator('[data-mobile-action="theme"]').click();
      await page.keyboard.press('Escape'); assert.equal(await page.locator('#wb-mobile-more-sheet').isVisible(), false);
      await openMore(); await page.locator('[data-mobile-action="usage"]').click(); await page.locator('#tab-trends').waitFor({ state: 'visible' }); assert.equal(await page.locator('#tab-trends').isVisible(), true);
      await openMore(); await page.locator('[data-mobile-action="settings"]').click();
      await page.locator('#tab-settings').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#tab-settings').isVisible(), true);
      await page.keyboard.press('Escape');
      await page.locator('[data-mobile-tab="chat"]').click();
      await openMore(); await page.locator('[data-mobile-action="machines"]').click();
      await page.locator('#tab-settings').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-settings-section="fleet"]').getAttribute('aria-current'), 'true', 'single-machine action opens existing machine settings');
      await page.keyboard.press('Escape');
      assert.deepEqual(f.errors, []); await noOverflow(page);
    } catch (error) { console.error('Mobile navigation case:', error); throw error; } finally { await f.context.close(); }
  });
  await t.test('focus, menu ownership, rename and group detail preserve existing actions', async () => {
    const f = await open(); const page = f.page;
    try {
      await select(page);
      assert.equal(await page.locator('html').getAttribute('data-conversation-focus'), 'true');
      assert.equal(await page.locator('.app-header').isVisible(), false);
      assert.equal(await page.locator('#wb-mobile-nav').isVisible(), false);
      await page.locator('.conversation-connection-dot[data-stream-state="live"]').waitFor();
      assert.equal(await page.locator('.conversation-push-status').isVisible(), false);
      assert.equal(await page.locator('.conversation-running').isVisible(), false, 'idle is hidden only on mobile');
      assert.equal(await page.locator('.conversation-compose-hint').isVisible(), false);
      const editor = page.locator('.conversation-input');
      const initial = await editor.evaluate(el => ({ font: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height }));
      assert.equal(initial.font, '16px'); assert.ok(initial.height <= 46, 'one-line editor starts compact');
      await editor.fill(Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n'));
      assert.ok(await editor.evaluate(el => el.getBoundingClientRect().height <= 134 && el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'));
      await editor.fill('');
      const flush = await page.locator('.conversation-header').boundingBox();
      assert.ok(Math.abs(flush.x) <= 1 && Math.abs(flush.y) <= 1 && flush.width >= 389, 'focus header starts flush at viewport edges');
      await shot(page, 'mobile-390-zh');
      await page.locator('.conversation-menu-toggle').click(); await menu(page).waitFor();
      assert.equal(await page.locator('.conversation-menu-rename').isVisible(), true);
      assert.equal(await page.locator('.conversation-menu-group').isVisible(), true);
      assert.equal(await menu(page).locator('.wb-ico-wifi').count(), 1);
      assert.equal(await menu(page).locator('.wb-ico-info').count(), 1);
      assert.equal(await menu(page).locator('.conversation-menu-chevron.wb-ico-chev').count(), 1);
      assert.equal(await menu(page).locator('.conversation-menu-summary').innerText(), '运行状态、时间线、用量');
      assert.match(await menu(page).innerText(), /Dashboard/); assert.match(await menu(page).innerText(), /发送|投递/);
      await shot(page, 'mobile-390-zh-conversation-menu');
      await page.locator('.conversation-menu-rename').click();
      assert.equal(await page.locator('.conversation-rename').isVisible(), true);
      assert.equal(await page.locator('.conversation-rename input').getAttribute('maxlength'), '40');
      await page.locator('.conversation-rename [data-action="page.cancel"]').click();
      await page.locator('.conversation-menu-toggle').click(); await page.locator('.conversation-menu-group').click();
      await page.locator('.wb-group-side').waitFor();
      const bounds = await page.locator('.wb-group-side').boundingBox();
      assert.ok(bounds.x <= 1 && bounds.y <= 1 && bounds.width >= 388 && bounds.height >= 842, 'group detail fills phone viewport');
      assert.equal(await page.locator('.wb-group-side .wb-d-top > .wb-icon-btn').isVisible(), false, 'phone group detail has only the top back button');
      await controlsFit(page, 'group detail');
      await shot(page, 'mobile-390-zh-group');
      await page.setViewportSize({ width: 1280, height: 900 }); await rendered(page);
      assert.equal(await page.locator('.wb-group-side .wb-d-top > .wb-icon-btn').isVisible(), true, 'desktop keeps the detail close action');
      await page.setViewportSize({ width: 390, height: 844 }); await rendered(page);
      await page.locator('.wb-group-side-back').click(); assert.equal(await page.locator('.wb-group-side').isVisible(), false);
      await page.locator('.conversation-back').click();
      assert.equal(await page.locator('html').getAttribute('data-conversation-focus'), 'false');
      assert.equal(await page.locator('#wb-mobile-nav').isVisible(), true);
      await page.locator(`[data-conversation-id="${ORIGIN_ID}"]`).click();
      await page.locator('.conversation-menu-toggle').click(); assert.equal(await page.locator('.conversation-menu-rename').isVisible(), false, 'Origin keeps existing fixed name');
      await page.keyboard.press('Escape'); await page.locator('.conversation-back').click();
      await page.locator('.conversation-tabs [data-action="external"]').click();
      await page.locator(`[data-conversation-id="${EXT_ID}"]`).click();
      await page.locator('.conversation-menu-toggle').click();
      assert.equal(await page.locator('.conversation-menu-rename').isVisible(), false);
      assert.match(await menu(page).innerText(), /Telegram|telegram/);
      await page.keyboard.press('Escape'); assert.equal(await page.locator('.conversation-read-only').isVisible(), true);
      assert.equal(await page.locator('.conversation-composer').count(), 0, 'external conversation retains read-only footer');
      await controlsFit(page, 'read-only conversation');
      await shot(page, 'mobile-390-zh-read-only');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await t.test('focus follows breakpoint and leaving chat for settings', async () => {
    const f = await open({ width: 760 }); const page = f.page;
    try {
      await select(page);
      assert.equal(await page.locator('.app-header').isVisible(), false);
      await page.setViewportSize({ width: 761, height: 844 });
      await page.locator('.app-header').waitFor({ state: 'visible' });
      assert.equal(await page.locator('.conversation-compose-hint').isVisible(), true);
      await page.locator('#wb-settings-btn').click();
      await page.locator('#tab-settings').waitFor({ state: 'visible' });
      await page.setViewportSize({ width: 390, height: 844 });
      await rendered(page);
      await page.locator('.wb-mobile-topbar').waitFor({ state: 'visible' });
      assert.equal(await page.locator('#wb-mobile-nav').isVisible(), true, 'Settings retains mobile navigation after a desktop chat');
      assert.equal(await page.locator('html').getAttribute('data-conversation-focus'), 'false');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await t.test('history entering a focused conversation closes More', async () => {
    const f = await open({ width: 1280 }); const page = f.page;
    try {
      await select(page);
      await page.locator('.tab[data-tab="overview"]').click();
      await page.locator('#tab-overview').waitFor({ state: 'visible' });
      await page.setViewportSize({ width: 390, height: 844 }); await rendered(page);
      await page.locator('#wb-mobile-more').click(); await page.locator('#wb-mobile-more-sheet').waitFor();
      await page.goBack(); await rendered(page);
      await page.waitForFunction(() => document.documentElement.dataset.conversationFocus === 'true');
      assert.equal(await page.locator('#wb-mobile-more-sheet').evaluate(el => el.hidden), true, 'history focus entry closes More state');
      await page.locator('.conversation-back').click();
      assert.equal(await page.locator('#wb-mobile-more-sheet').isVisible(), false, 'back to the list leaves More closed');
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await t.test('sending menu skips disabled rename and keeps keyboard focus', async () => {
    const f = await open(); const page = f.page;
    let release, sendTimeout;
    const held = new Promise(resolve => { release = resolve; });
    let sendSeen;
    const seen = new Promise(resolve => { sendSeen = resolve; });
    await page.route('**/api/chat/conversations/*/send', async route => {
      sendSeen();
      await Promise.race([held, new Promise(resolve => { sendTimeout = setTimeout(resolve, 4000); })]);
      await route.fulfill({ status: 200, json: { ok: true } }).catch(() => {});
    });
    try {
      await select(page);
      await page.locator('.conversation-input').fill('键盘焦点核对');
      await page.locator('.conversation-send').click();
      await seen;
      await page.locator('.conversation-menu-toggle').click();
      assert.equal(await page.locator('.conversation-menu-rename').isDisabled(), true);
      assert.equal(await page.locator('.conversation-menu-group').evaluate(el => el === document.activeElement), true, 'first enabled action receives focus');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await menu(page).evaluate(el => el.contains(document.activeElement)), true);
      await page.keyboard.press('Escape');
      assert.equal(await menu(page).isVisible(), false);
      assert.equal(await page.locator('.conversation-menu-toggle').evaluate(el => el === document.activeElement), true);
    } finally { release(); clearTimeout(sendTimeout); await f.context.close(); }
  });
  await t.test('retry controls and hint stay inside narrow mobile screens', async () => {
    for (const width of [390, 360, 430]) {
      const f = await open({ width }); const page = f.page;
      try {
        await select(page);
        assert.equal(await page.locator('.conversation-mobile-retry-hint').isVisible(), false);
        await page.route('**/api/chat/conversations/*/send', route => route.abort('failed'));
        await page.locator('.conversation-input').fill('核对未确定的投递');
        await page.locator('.conversation-send').click();
        await page.locator('.conversation-mobile-retry-hint').waitFor({ state: 'visible' });
        assert.match(await page.locator('.conversation-mobile-retry-hint').innerText(), /如需重试/);
        assert.equal(await page.locator('.conversation-compose-hint').isVisible(), false, 'permanent hint stays hidden');
        // A network failure initially locks retry. The existing status check can
        // authorize an explicit retry without clearing the uncertain receipt.
        await page.route('**/api/chat/conversations/*', route => route.fulfill({ status: 200, json: {
          conversation: { id: ID, sessionGroup: GROUP, channel: 'dashboard', displayName: '发布流程核对' },
          stored: null, retryAllowed: true, preserveInput: true,
        } }));
        await page.locator('.conversation-receipt button').click();
        await page.waitForFunction(() => !document.querySelector('.conversation-send[data-action="retry"]').disabled);
        const bounds = await page.evaluate(() => {
          const read = selector => { const el = document.querySelector(selector), rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; };
          return { viewport: innerWidth, detail: read('.conversation-detail'), composer: read('.conversation-composer'), composeBox: read('.conversation-compose-box'), input: read('.conversation-input'), check: read('.conversation-receipt button'), retry: read('.conversation-send[data-action="retry"]'), hint: read('.conversation-mobile-retry-hint') };
        });
        console.info('Retry control bounds:', JSON.stringify(bounds));
        if (evidence) fs.writeFileSync(path.join(evidence, `retry-${width}-bounds.json`), JSON.stringify(bounds, null, 2));
        await shot(page, `mobile-${width}-retry`);
        for (const name of ['check', 'retry']) {
          assert.ok(bounds[name].left >= 0 && bounds[name].right <= bounds.viewport, `${width}: ${name} button fits viewport: ${JSON.stringify(bounds[name])}`);
          assert.ok(bounds[name].scrollWidth <= bounds[name].clientWidth, `${width}: ${name} button text fits its control`);
        }
        assert.ok(Math.abs(bounds.retry.left - bounds.composeBox.left) <= 1 && Math.abs(bounds.retry.right - bounds.composeBox.right) <= 1, `${width}: explicit retry spans the input area: ${JSON.stringify(bounds)}`);
        assert.ok(bounds.hint.scrollWidth <= bounds.hint.clientWidth, `${width}: complete retry hint fits its container`);
        assert.ok(bounds.hint.left >= 0 && bounds.hint.right <= bounds.viewport, `${width}: retry hint container fits viewport`);
        await page.locator('.conversation-receipt button').click({ trial: true });
        await page.locator('.conversation-send[data-action="retry"]').click({ trial: true });
        await controlsFit(page, width + ' retry conversation');
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
  });
  await t.test('single-mode Origin menu omits unavailable group detail', async () => {
    const f = await open({ sessionMode: 'single' }); const page = f.page;
    try {
      await page.locator(`[data-conversation-id="${ORIGIN_ID}"]`).click();
      await page.locator('.conversation-header-actions > button:not(.conversation-menu-toggle)').waitFor({ state: 'hidden' });
      await page.locator('.conversation-menu-toggle').click(); await menu(page).waitFor();
      assert.equal(await page.locator('.conversation-menu-group').isVisible(), false, 'menu mirrors unavailable original group action');
      assert.equal(await page.locator('.conversation-menu-rename').isVisible(), false);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await t.test('locale, theme and narrow mobile widths fit without overflow', async () => {
    for (const options of [{ width: 390, locale: 'en' }, { width: 390, theme: 'dark' }, { width: 360 }, { width: 430 }, { width: 360, theme: 'dark' }, { width: 430, theme: 'dark' }]) {
      const f = await open(options);
      try {
        await noOverflow(f.page); await select(f.page); await noOverflow(f.page);
        const width = options.width, name = width === 390 ? options.locale === 'en' ? 'mobile-390-en' : 'mobile-390-dark' : `mobile-${width}-${options.theme || 'light'}`;
        await shot(f.page, name);
        measurements.push({ ...options, width: await f.page.evaluate(() => document.documentElement.scrollWidth) });
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
  });
  await t.test('disconnected running state uses existing status and opens timeline', async () => {
    const f = await open({ scene: 'running' }); const page = f.page;
    try {
      await select(page); fixture.disconnect();
      await page.locator('.conversation-push-status').waitFor({ state: 'visible' });
      assert.match(await page.locator('.conversation-push-status').innerText(), /轮询/);
      assert.match(await page.locator('.conversation-running').innerText(), /正在处理/);
      await controlsFit(page, 'disconnected running conversation');
      await shot(page, 'mobile-390-disconnected-running');
      await page.locator('.conversation-running').click(); await page.locator('.wb-group-side').waitFor();
      assert.match(await page.locator('.wb-group-side .wb-detail-tabs [aria-selected="true"]').innerText(), /时间线/);
      await page.locator('.wb-group-side-back').click();
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  assert.deepEqual([...fixture.missing], []);
  if (evidence) fs.writeFileSync(path.join(evidence, 'mobile-measurements.json'), JSON.stringify(measurements, null, 2));
  console.info('Mobile captures:', JSON.stringify(captures));
}
