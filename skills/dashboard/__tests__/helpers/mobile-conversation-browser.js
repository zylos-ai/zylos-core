import assert from 'node:assert/strict';
import { conversationAction, openConversationMenu, openGroupDetail, openMobileMore } from './browser-navigation.js';
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
const DEFAULT_TITLE = '发布流程核对';
const LONG_TITLE = '发布流程核对'.repeat(7).slice(0, 40);
const LONG_SOURCE = '跨地区项目沟通渠道'.repeat(12);
const iso = offset => new Date(NOW + offset).toISOString();

// Fixed existing API contracts over private loopback: the real entry/modules/styles
// render them. No database, runtime, channel, outbound request or backend extension.
export async function startPage(sandbox, publicDir = currentPublic) {
  let scene = 'idle', connected = true, observerBlocked = false, sessionMode = 'multi', title = DEFAULT_TITLE, channel = 'dashboard';
  let listGate = null, releaseList = () => {};
  const streams = new Set(), missing = new Set(), actions = [];
  const conversation = id => ({ id, localId: 'mobile-browser', sessionGroup: id === EXT_ID ? EXTERNAL : id === ORIGIN_ID ? 'origin' : GROUP,
    channel: id === EXT_ID ? 'telegram' : id === ORIGIN_ID ? 'dashboard' : channel, state: 'active', displayName: id === EXT_ID ? 'Howard' : id === ORIGIN_ID ? 'Origin' : title,
    display_name: id === EXT_ID ? 'Howard' : id === ORIGIN_ID ? 'Origin' : title, origin: id === ORIGIN_ID });
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
      row.sessionGroup = GROUP; row.name = { displayName: title }; row.state = { kind: 'idle' }; row.tools = [];
      row.queue = { known: true, pending: { count: 0 }, running: { count: 0 }, fence: null };
      row.working = { on: scene === 'running', since: scene === 'running' ? NOW - 3 * 60000 : null, main: scene === 'running' ? { since: NOW - 3 * 60000 } : null, tools: 0, subagents: null };
      value.rows = [row, { ...row, sessionGroup: 'origin', origin: true, name: null, working: { on: false, since: null, main: null, tools: 0, subagents: null } }];
      value.instance.runtimeHealth = { claude: { health: 'ok' } };
      value.counts = { busy: 0, idle: 2, waiting: 0, unknown: 0, error: 0, not_running: 0 };
      return value;
    }
    if (p.startsWith('/api/workbench/groups/') && p.endsWith('/runs')) return { runs: [{ runId: 'run-tg', startAt: iso(-20 * 60000), endAt: iso(-30000), n: 2, endReason: 'running' }], totalRuns: 1, totalEvents: 2, unattributed: 0 };
    if (p.startsWith('/api/workbench/groups/') && p.endsWith('/messages')) return { messages: [] };
    return workbenchAnswer(url, NOW);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        if (!connected) { res.end(); return; }
        const data = { version: 1, tab: url.searchParams.get('chat_tab') || 'mine', conversationId: url.searchParams.get('chat_conversation'), ids: [] };
        res.write(`event: chat_ready\ndata: ${JSON.stringify(data)}\n\n`); streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (req.method === 'GET' && url.pathname === '/api/chat/conversations' && listGate) await listGate;
        if (req.method !== 'GET') {
          actions.push({ method: req.method, path: url.pathname });
          if (req.method === 'PATCH' && url.pathname.startsWith('/api/chat/conversations/')) { sendJson(res, 200, { conversation: conversation(ID) }); return; }
          sendJson(res, 200, { ok: true }); return;
        }
        const value = answer(url);
        if (value === undefined && missing.size < 10) missing.add(`${req.method} ${url.pathname}`);
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
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
  sandbox.addCleanup(() => { releaseList(); for (const stream of streams) stream.end(); });
  return { base: await sandbox.startHttp(server), missing, actions,
    holdConversationList() {
      listGate = new Promise(resolve => { releaseList = () => { listGate = null; resolve(); }; });
      return releaseList;
    },
    setScene(value) { scene = value; }, setTitle(value) { title = value; }, setChannel(value) { channel = value; }, reconnect() { connected = true; }, setSessionMode(value) { sessionMode = value; }, setObserverBlocked(value) { observerBlocked = value; }, disconnect() { connected = false; for (const stream of streams) stream.end(); } };
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
  // Boundary: real startup ordering, stylesheet visibility and late control
  // subscriptions. Run for mobile chrome/bootstrap changes; backend-only work
  // may skip. All requests stay in this sandbox's loopback fixture.
  await t.test('slow phone refresh first reveals the address tab with mobile navigation', async () => {
    for (const [pathname, tab] of [['/chat', 'chat'], ['/', 'overview']]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
      sandbox.addCleanup(() => context.close());
      let releaseFleet, fleetArrived, holdFleet = false, fleetTimer;
      const fleetGate = new Promise(resolve => { releaseFleet = resolve; });
      const fleetRequest = new Promise((resolve, reject) => {
        fleetArrived = resolve;
        fleetTimer = setTimeout(() => reject(new Error('held fleet request did not arrive')), 60_000);
      });
      try {
        await context.route('**/*', async route => {
          const url = route.request().url();
          if (!url.startsWith(fixture.base + '/')) return route.abort();
          if (holdFleet && new URL(url).pathname === '/api/fleet') {
            clearTimeout(fleetTimer);
            fleetArrived();
            await fleetGate;
          }
          return route.continue();
        });
        await context.addInitScript(() => {
          localStorage.setItem('zylos-dashboard-locale', 'zh');
          window.startupFrames = { count: 0, preReady: null, firstVisible: null, failure: null };
          const visible = el => el && el.getBoundingClientRect().height > 0 &&
            getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
          const check = () => {
            const result = window.startupFrames;
            result.count++;
            const header = document.querySelector('.app-header'), stack = document.querySelector('.view-stack');
            const ready = document.documentElement.classList.contains('wb-mobile-ready');
            const visibility = { header: header ? getComputedStyle(header).visibility : null, stack: stack ? getComputedStyle(stack).visibility : null };
            if (!ready && header && stack) result.preReady ??= visibility;
            if (visible(header) || visible(stack) || visible(document.querySelector('.wb-mobile-topbar'))) {
              const active = document.querySelector('.tab.active')?.dataset.tab;
              result.firstVisible ??= { ready, active, header: visible(header) };
              const expected = location.pathname === '/chat' ? 'chat' : 'overview';
              if (!ready || visible(header) || active !== expected) result.failure = { ready, active, header: visible(header), visibility };
            }
            if (!result.failure && result.count < 2400) requestAnimationFrame(check);
          };
          requestAnimationFrame(check);
        });
        const page = await context.newPage();
        page.setDefaultTimeout(60_000);
        await page.goto(fixture.base + pathname);
        await page.locator('.conversation-reload').waitFor({ state: 'attached' });
        holdFleet = true;
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 400,
          downloadThroughput: -1, uploadThroughput: -1, connectionType: 'cellular3g' });
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
        const capture = async stage => {
          if (evidence) await page.screenshot({ path: path.join(evidence, `startup-${tab}-${stage}.png`) });
        };
        // Cold assets retain 400ms request latency and 6x CPU throttling without
        // making the assertion budget depend on the growing static download size.
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await page.reload({ waitUntil: 'commit' });
        await capture('waiting');
        await fleetRequest;
        assert.equal(await page.locator('#wb-mobile-nav').count(), 1,
          'mobile navigation must mount before the fleet request starts');
        assert.equal(await page.locator('.app-header').isVisible(), false);
        assert.equal(await page.locator(`#tab-${tab}`).evaluate(el => el.hidden), false);
        assert.equal(await page.locator(`[data-mobile-tab="${tab}"]`).getAttribute('aria-current'), 'page');
        await capture('navigation');
        releaseFleet();
        if (tab === 'chat') {
          await page.locator('.conversation-reload').waitFor({ state: 'attached' });
          await page.locator('#wb-mobile-list-refresh').waitFor();
          await page.waitForFunction(() => ['.conversation-reload', '.conversation-create',
            '#wb-mobile-list-refresh', '#wb-mobile-list-create'].every(selector => document.querySelector(selector)?.disabled === false));
          // Hold a real refresh in loading state. No source-property writes or
          // app sync call: late MutationObserver subscriptions update the copies.
          const releaseList = fixture.holdConversationList();
          try {
            const arrived = page.waitForRequest(request => new URL(request.url()).pathname === '/api/chat/conversations', { timeout: 10_000 });
            const disabled = await page.evaluate(async () => {
              // Click the real source: the mobile proxy's own click handler
              // calls sync(), which would hide a missing observer subscription.
              document.querySelector('.conversation-reload').click();
              await new Promise(requestAnimationFrame);
              return ['.conversation-reload', '.conversation-create', '#wb-mobile-list-refresh',
                '#wb-mobile-list-create'].map(selector => document.querySelector(selector)?.disabled);
            });
            await arrived;
            assert.deepEqual(disabled, [true, true, true, true],
              'late controls and their mobile copies become disabled by the next frame');
          } finally { releaseList(); }
          await page.waitForFunction(() => ['.conversation-reload', '.conversation-create',
            '#wb-mobile-list-refresh', '#wb-mobile-list-create'].every(selector => document.querySelector(selector)?.disabled === false));
          await page.locator('.conversation-tabs [role="tab"]').nth(1).click();
          await page.waitForFunction(() => document.querySelector('.conversation-create')?.hidden === true &&
            document.querySelector('#wb-mobile-list-create')?.hidden === true);
          await page.locator('.conversation-tabs [role="tab"]').nth(0).click();
          await page.waitForFunction(() => document.querySelector('.conversation-create')?.hidden === false &&
            document.querySelector('#wb-mobile-list-create')?.hidden === false);
        } else await page.locator('#wb-board .wb-row').first().waitFor();
        await capture('stable');
        const frames = await page.evaluate(() => window.startupFrames);
        assert.equal(frames.failure, null, 'unexpected visible startup frame: ' + JSON.stringify(frames.failure));
        assert.deepEqual(frames.preReady, { header: 'hidden', stack: 'hidden' }, 'pre-navigation shell visibility is recorded, not awaited');
        assert.equal(frames.firstVisible?.ready, true);
        assert.equal(frames.firstVisible?.active, tab);
        assert.equal(frames.firstVisible?.header, false);
        console.info('Throttled startup:', JSON.stringify({ pathname, cpu: 6, latency: 400, bytesPerSecond: 'unlimited', frames }));
        if (evidence) fs.writeFileSync(path.join(evidence, `startup-${tab}.json`), JSON.stringify(frames, null, 2));
      } finally { clearTimeout(fleetTimer); releaseFleet(); await context.close(); }
    }
  });
  const open = async ({ width = 390, locale = 'zh', theme = 'light', scene = 'idle', observerBlocked = false, detail = 'plain', sessionMode = 'multi', title = DEFAULT_TITLE, channel = 'dashboard', remote = false } = {}) => {
    fixture.reconnect(); fixture.setScene(scene); fixture.setTitle(title); fixture.setChannel(channel); fixture.setObserverBlocked(observerBlocked); fixture.setSessionMode(sessionMode);
    const context = await browser.newContext({ viewport: { width, height: width < 761 ? 844 : 900 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'UTC' });
    sandbox.addCleanup(() => context.close());
    const remoteState = { allow: true, reads: 0 }, prefix = '/fleet/phone';
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (!url.href.startsWith(fixture.base + '/')) return route.abort();
      if (!remote || !url.pathname.startsWith(prefix + '/')) return route.continue();
      if (url.pathname === prefix + '/') return route.fulfill({ contentType: 'text/html', body:
        fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__BASE_PATH__', prefix)
          .replaceAll('__ASSET_ROOT__', prefix + '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin') });
      const target = fixture.base + url.pathname.slice(prefix.length) + url.search;
      if (url.pathname === prefix + '/api/state') {
        remoteState.reads++;
        const response = await route.fetch({ url: target });
        return route.fulfill({ json: { ...await response.json(), chat_allow_remote: remoteState.allow } });
      }
      return route.continue({ url: target });
    });
    await context.addInitScript(({ locale, theme, detail }) => { if (window !== window.top) return; localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-detail-level', detail); }, { locale, theme, detail });
    const page = await context.newPage(); page.setDefaultTimeout(7000);
    const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.stack || error.message); });
    await page.clock.install({ time: new Date(NOW) });
    await page.goto(fixture.base + (remote ? prefix + '/' : '/chat'));
    try { await page.locator(remote ? '#wb-board .wb-row' : `[data-conversation-id="${ID}"]`).first().waitFor(); }
    catch (error) { if (evidence) { await page.screenshot({path:path.join(evidence, 'mount-failure.png')}); fs.writeFileSync(path.join(evidence, 'mount-failure.html'), await page.content()); } console.error('Mobile mount:', JSON.stringify({ errors, missing: [...fixture.missing], text: (await page.locator('body').innerText()).slice(0, 1500) })); throw error; }
    return { page, context, errors, remoteState };
  };
  const select = async page => { await page.locator(`[data-conversation-id="${ID}"]`).click(); await page.locator('.conversation-message').first().waitFor(); };
  const shot = async (page, name) => {
    await page.evaluate(() => document.fonts.ready);
    const size = await page.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
    assert.ok(size.width <= size.viewport + 1, name + ' no horizontal overflow');
    if (evidence) { const file = path.join(evidence, name + '.png'); await page.screenshot({ path: file, animations: 'disabled' }); captures.push(file); }
  };
  // Boundary: remote state reads drive hidden navigation through real access policy;
  // visible mobile navigation items share all available columns;
  // hidden source controls also collapse in the topbar and More sheet.
  // Run for mobile navigation/layout changes; unrelated backend work may skip.
  await t.test('hidden phone tabs leave equal columns and no empty action slots', async () => {
    const f = await open({ remote: true }), page = f.page;
    try {
      const checkColumns = async count => {
        const boxes = await page.locator('#wb-mobile-nav > button:visible').evaluateAll(nodes => nodes.map(el => {
          const rect = el.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width };
        }));
        assert.equal(boxes.length, count);
        assert.ok(Math.abs(boxes[0].left) <= 1);
        assert.ok(Math.abs(boxes.at(-1).right - 390) <= 1, 'last item reaches the right edge');
        for (let i = 0; i < boxes.length; i++) {
          assert.ok(Math.abs(boxes[i].width - 390 / count) <= 1, 'visible items divide the viewport equally');
          if (i) assert.ok(Math.abs(boxes[i].left - boxes[i - 1].right) <= 1, 'no empty columns');
        }
      };
      await checkColumns(5);
      f.remoteState.allow = false;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('[data-mobile-tab="chat"]').waitFor({ state: 'hidden' });
      await checkColumns(4);
      const polledState = page.waitForResponse(response => new URL(response.url()).pathname === '/fleet/phone/api/state');
      const readsBeforePoll = f.remoteState.reads;
      await page.clock.runFor(30_000);
      await polledState;
      assert.ok(f.remoteState.reads > readsBeforePoll, 'periodic refresh reads the real remote state again');
      assert.equal(await page.locator('.tab[data-tab="chat"]').evaluate(el => el.hidden), true, 'remote closure survives the periodic state refresh');
      await checkColumns(4);
      const topbar = await page.locator('.wb-mobile-topbar').evaluate(el => {
        const heading = el.querySelector('h1').getBoundingClientRect(), bar = el.getBoundingClientRect();
        return { right: bar.right, headingRight: heading.right, padding: parseFloat(getComputedStyle(el).paddingRight),
          actions: [...el.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0).length };
      });
      assert.equal(topbar.actions, 0);
      assert.ok(Math.abs(topbar.right - topbar.headingRight - topbar.padding) <= 1, 'heading fills the topbar without action slots');
      await openMobileMore(page);
      const usage = await page.locator('[data-mobile-action="usage"]').boundingBox();
      const settings = await page.locator('[data-mobile-action="settings"]').boundingBox();
      assert.equal(await page.locator('[data-mobile-action="observer"]').isVisible(), false);
      assert.ok(Math.abs(settings.y - usage.y - usage.height) <= 1, 'hidden terminal action leaves no menu gap');
      await shot(page, 'mobile-390-hidden-chat-more');
      await page.keyboard.press('Escape');
      await shot(page, 'mobile-390-hidden-chat-navigation');
      f.remoteState.allow = true;
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await page.locator('[data-mobile-tab="chat"]').waitFor();
      await checkColumns(5);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  const headerScenes = [
    { width: 1280, theme: 'light', name: 'header-1280-light' },
    { width: 1280, theme: 'dark', name: 'header-1280-dark' },
    { width: 900, theme: 'light', name: 'header-900-light' },
    { width: 900, theme: 'dark', name: 'header-900-dark' },
    { width: 1280, scene: 'running', name: 'header-1280-running' },
    { width: 1280, disconnected: true, name: 'header-1280-polling' },
    { width: 390, name: 'header-390-mobile' },
    { width: 1280, title: LONG_TITLE, channel: LONG_SOURCE, scene: 'running', disconnected: true, name: 'header-1280-long-title' },
    { width: 900, title: LONG_TITLE, channel: LONG_SOURCE, scene: 'running', disconnected: true, name: 'header-900-long-title' },
  ];
  const prepareHeader = async (page, options) => {
    await select(page);
    await page.locator('.conversation-connection-dot[data-stream-state="live"]').waitFor({ state: 'attached' });
    if (options.scene === 'running') await page.waitForFunction(() => document.querySelector('.conversation-running').textContent.includes('正在工作'));
    if (options.disconnected) {
      fixture.disconnect();
      await page.locator('.conversation-push-status[data-stream-state="polling"]').waitFor({ state: 'attached' });
    }
    await page.evaluate(() => document.fonts.ready);
  };
  // Untouched git-archived public files use the identical fixture and clock for
  // before/after images. This mode captures evidence without asserting new layout.
  if (process.env.ZYLOS_MOBILE_BASELINE_PUBLIC) {
    for (const options of headerScenes) {
      const f = await open(options);
      try { await prepareHeader(f.page, options); await shot(f.page, options.name + '-before'); }
      finally { await f.context.close(); }
    }
    console.info('Header baseline captures:', JSON.stringify(captures)); return;
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
  const phoneHeaderFits = async page => {
    const m = await page.evaluate(() => {
      const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, top: r.top, right: r.right, bottom: r.bottom, height: r.height }; };
      const header = document.querySelector('.conversation-header'), css = getComputedStyle(header);
      return { viewport: innerWidth, header: box('.conversation-header'), back: box('.conversation-back'),
        title: box('.conversation-title-line'), menu: box('.conversation-menu-toggle'),
        contentRight: header.getBoundingClientRect().right - Number.parseFloat(css.paddingRight) - Number.parseFloat(css.borderRightWidth) };
    });
    for (const name of ['back', 'title', 'menu']) {
      assert.ok(m[name].height > 0 && m[name].top >= m.header.top - 1 && m[name].bottom <= m.header.top + 53,
        name + ' stays inside the first 52px phone header row: ' + JSON.stringify(m));
    }
    assert.ok(Math.abs(m.back.top - m.menu.top) <= 1, 'phone back and menu align');
    const center = r => (r.top + r.bottom) / 2;
    assert.ok(Math.abs(center(m.title) - center(m.back)) <= 1 && Math.abs(center(m.title) - center(m.menu)) <= 1,
      'phone title, back and menu share a row');
    assert.ok(m.back.right <= m.title.x + 1 && m.title.right <= m.menu.x + 1, 'phone menu follows the title at the right');
    assert.ok(Math.abs(m.contentRight - m.menu.right) <= 1, 'phone menu reaches the content right edge');
    measurements.push({ name: 'phone-header-row', ...m });
  };
  await t.test('desktop header uses two rows and keeps status actions readable', async () => {
    const headerMetrics = async page => page.evaluate(() => {
      const box = selector => {
        const el = document.querySelector(selector), r = el.getBoundingClientRect(), css = getComputedStyle(el);
        const range = document.createRange(); range.selectNodeContents(el);
        return { x: r.x, y: r.y, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
          textRight: range.getBoundingClientRect().right,
          paddingRight: Number.parseFloat(css.paddingRight), borderRight: Number.parseFloat(css.borderRightWidth), lineHeight: Number.parseFloat(css.lineHeight),
          scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, caption: el.querySelector('.wi-ind-text') ? { scrollWidth: el.querySelector('.wi-ind-text').scrollWidth, clientWidth: el.querySelector('.wi-ind-text').clientWidth } : null, whiteSpace: css.whiteSpace, overflow: css.overflow,
          textOverflow: css.textOverflow, fontSize: Number.parseFloat(css.fontSize), text: el.textContent, title: el.title, role: el.getAttribute('role') };
      };
      return { viewport: innerWidth, header: box('.conversation-header'), title: box('.conversation-title-line'), titleText: box('.conversation-title-line h2'),
        subtitle: box('.conversation-subtitle'), running: box('.conversation-running'),
        push: box('.conversation-push-status'), group: box('.conversation-header-actions > .wb-btn') };
    });
    const compact = m => {
      assert.ok(m.header.height <= 76, 'header fits two compact text rows: ' + JSON.stringify(m));
      assert.ok(Math.abs(m.running.top - m.group.top) <= 1, 'status and group align on one row');
      for (const name of ['running', 'group']) {
        assert.ok(m[name].top >= m.title.top - 1 && m[name].bottom <= m.title.bottom + 1, name + ' stays within title row');
        assert.ok(m[name].x >= 0 && m[name].right <= m.viewport, name + ' is inside viewport');
        // The comet intentionally overflows the pill border; measure its actual
        // caption rather than counting that decorative SVG as text overflow.
        const label = m[name].caption ?? m[name];
        assert.ok(label.scrollWidth <= label.clientWidth, name + ' text remains complete');
        assert.ok(m[name].fontSize > 0, name + ' text remains visible');
      }
      assert.ok(m.title.right <= m.running.x && m.running.right <= m.push.x && m.push.right <= m.group.x,
        'title, status, connection and group occupy separate ordered columns');
      assert.ok(m.subtitle.top >= m.title.bottom - 1 && m.subtitle.bottom <= m.header.bottom, 'source is the second row');
      const rightGap = m.header.right - m.header.paddingRight - m.header.borderRight - m.group.right;
      assert.ok(rightGap >= -1 && rightGap <= 16, 'status actions stay anchored to the header content right edge');
      assert.equal(m.push.whiteSpace, 'nowrap');
      assert.equal(m.push.textOverflow, 'ellipsis');
      assert.equal(m.push.role, 'status');
      assert.equal(m.push.title, m.push.text, 'hover exposes complete connection text');
    };
    for (const options of headerScenes) {
      const f = await open(options), page = f.page;
      try {
        await prepareHeader(page, options);
        if (options.width > 760) {
          const m = await headerMetrics(page);
          console.info('Header scene metrics:', JSON.stringify({ name: options.name, ...m }));
          compact(m);
          if (options.width === 1280 && !options.title) {
            assert.ok(m.group.x - m.push.textRight <= 16, 'connection text stays beside group details on a wide screen');
            assert.ok(m.titleText.scrollWidth <= m.titleText.clientWidth, 'short title remains complete');
          }
          if (options.title) {
            assert.equal(m.titleText.text.length, 40, 'fixture supplies a long title');
            assert.ok(m.titleText.scrollWidth > m.titleText.clientWidth, 'long title exercises truncation pressure');
            assert.ok(m.push.scrollWidth > m.push.clientWidth, 'connection hint yields space before a long title');
            assert.ok(m.subtitle.text.startsWith(LONG_SOURCE), 'existing channel label renders the long source');
            assert.equal(m.subtitle.whiteSpace, 'nowrap');
            assert.equal(m.subtitle.overflow, 'hidden');
            assert.equal(m.subtitle.textOverflow, 'ellipsis');
            assert.ok(m.subtitle.height <= m.subtitle.lineHeight + 1, 'long source stays on one line');
            assert.ok(m.subtitle.scrollWidth > m.subtitle.clientWidth, 'long source exercises ellipsis pressure');
          }
          if (m.titleText.scrollWidth > m.titleText.clientWidth) {
            assert.ok(m.push.scrollWidth > m.push.clientWidth, 'title only truncates after the connection hint is truncated');
          }
          measurements.push({ name: options.name, ...m });
          assert.equal(await page.locator('#wb-mobile-nav').isVisible(), false);
          assert.equal(await page.locator('.conversation-menu-toggle').isVisible(), false);
          assert.equal(await page.locator('.app-header').isVisible(), true);
          const rename = page.locator('.conversation-title-line button');
          await rename.focus(); await page.keyboard.press('Tab');
          assert.equal(await page.locator('.conversation-running').evaluate(el => el === document.activeElement), true, 'status follows rename');
          await page.keyboard.press('Tab');
          assert.equal(await page.locator('.conversation-header-actions > .wb-btn').evaluate(el => el === document.activeElement), true, 'group follows status');
          await rename.evaluate(el => el.blur()); await page.locator('body').click({ position: { x: 2, y: 2 } });
        } else {
          assert.equal(await page.locator('#wb-mobile-nav').isVisible(), false);
          assert.equal(await page.locator('.conversation-running').isVisible(), false);
          assert.equal(await page.locator('.conversation-push-status').isVisible(), false);
          assert.equal(await page.locator('.conversation-menu-toggle').isVisible(), true);
          await phoneHeaderFits(page);
        }
        await shot(page, options.name + '-after');
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
    const medium = await open({ width: 1280, title: LONG_TITLE.slice(0, 20), scene: 'running' });
    try {
      await prepareHeader(medium.page, { scene: 'running', disconnected: true });
      const m = await headerMetrics(medium.page); compact(m);
      measurements.push({ name: 'header-medium-title', ...m });
      if (m.titleText.scrollWidth > m.titleText.clientWidth) {
        assert.ok(m.push.scrollWidth > m.push.clientWidth, 'medium title only truncates after connection hint truncation');
      }
      assert.deepEqual(medium.errors, []);
    } finally { await medium.context.close(); }
    // A short working caption can leave enough room for the full polling hint.
    // Keep that scene, and use a real long title to require truncation pressure
    // independently of the current status wording.
    for (const { width, title } of [900, 761].flatMap(width =>
      [DEFAULT_TITLE, LONG_TITLE].map(title => ({ width, title })))) {
      const f = await open({ width, title, scene: 'running' }), page = f.page;
      try {
        await prepareHeader(page, { scene: 'running', disconnected: true });
        const m = await headerMetrics(page); compact(m);
        const name = `header-${width}-running-polling-${title === LONG_TITLE ? 'long' : 'short'}-title`;
        console.info('Header polling metrics:', JSON.stringify({ name, ...m }));
        measurements.push({ name, ...m });
        if (title === LONG_TITLE) {
          assert.equal(m.titleText.text.length, 40, 'fixture supplies a long title');
          assert.ok(m.titleText.scrollWidth > m.titleText.clientWidth, 'long title creates truncation pressure');
          assert.ok(m.push.scrollWidth > m.push.clientWidth, 'long polling hint truncates before status or group');
        }
        if (m.titleText.scrollWidth > m.titleText.clientWidth) {
          assert.ok(m.push.scrollWidth > m.push.clientWidth, 'title only truncates after the connection hint is truncated');
        }
        assert.match(m.push.text, /轮询/);
        await shot(page, name);
        await page.locator('.conversation-running').click(); await page.locator('.wb-group-side').waitFor();
        assert.match(await page.locator('.wb-group-side .wb-detail-tabs [aria-selected="true"]').innerText(), /时间线/);
        assert.deepEqual(f.errors, []);
      } finally { await f.context.close(); }
    }
    const side = await open({ width: 1280, scene: 'running' });
    try {
      await prepareHeader(side.page, { scene: 'running' });
      await side.page.locator('.conversation-list-toggle').click();
      await side.page.locator('.conversation-header-actions > .wb-btn').click();
      await side.page.locator('.conversation-page.conversation-list-collapsed.conversation-has-side').waitFor();
      const m = await headerMetrics(side.page); compact(m);
      measurements.push({ name: 'header-list-collapsed-side-open', ...m });
      assert.deepEqual(side.errors, []);
    } finally { await side.context.close(); }
    const edge = await open({ width: 760, scene: 'running' });
    try {
      await prepareHeader(edge.page, { scene: 'running' });
      await phoneHeaderFits(edge.page);
      assert.equal(await edge.page.locator('.conversation-running').isVisible(), true, 'phone running status remains available in the title row');
      assert.equal(await edge.page.locator('.conversation-menu-toggle').isVisible(), true);
      assert.equal(await edge.page.locator('.conversation-header-actions > .wb-btn').isVisible(), false);
      const title = await edge.page.locator('.conversation-title-line').boundingBox();
      const running = await edge.page.locator('.conversation-running').boundingBox();
      assert.ok(running.y >= title.y - 15 && running.y + running.height <= title.y + title.height + 15, 'phone status stays in the title row');
      assert.equal(await edge.page.locator('.conversation-header').evaluate(node => { const css = getComputedStyle(node); return node.getBoundingClientRect().height - parseFloat(css.borderTopWidth) - parseFloat(css.borderBottomWidth); }), 52);
      const toggle = await edge.page.locator('.conversation-menu-toggle').boundingBox();
      assert.ok(title.x + title.width <= running.x && running.x + running.width <= toggle.x, 'phone pill sits between title and menu');
      await noOverflow(edge.page);
    } finally { await edge.context.close(); }
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
      const openMore = () => openMobileMore(page);
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
        await openMobileMore(unavailable.page);
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
      await openConversationMenu(page); await menu(page).waitFor();
      assert.equal(await page.locator('.conversation-menu-rename').isVisible(), true);
      assert.equal(await page.locator('.conversation-menu-group').isVisible(), true);
      assert.equal(await menu(page).locator('.wb-ico-wifi').count(), 1);
      assert.equal(await menu(page).locator('.wb-ico-info').count(), 1);
      assert.equal(await menu(page).locator('.conversation-menu-chevron.wb-ico-chev').count(), 1);
      assert.equal(await menu(page).locator('.conversation-menu-summary').innerText(), '运行状态、时间线、用量');
      assert.match(await menu(page).innerText(), /Dashboard/); assert.match(await menu(page).innerText(), /发送|投递/);
      await shot(page, 'mobile-390-zh-conversation-menu');
      await conversationAction(page, 'rename');
      assert.equal(await page.locator('.conversation-rename').isVisible(), true);
      assert.equal(await page.locator('.conversation-rename input').getAttribute('maxlength'), '40');
      await page.locator('.conversation-rename [data-action="page.cancel"]').click();
      await openGroupDetail(page);
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
      await openConversationMenu(page); assert.equal(await page.locator('.conversation-menu-rename').isVisible(), false, 'Origin keeps existing fixed name');
      await page.keyboard.press('Escape'); await page.locator('.conversation-back').click();
      await page.locator('.conversation-tabs [data-action="external"]').click();
      await page.locator(`[data-conversation-id="${EXT_ID}"]`).click();
      await openConversationMenu(page);
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
      await openMobileMore(page); await page.locator('#wb-mobile-more-sheet').waitFor();
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
      await page.locator('.conversation-header-actions > .wb-btn').waitFor({ state: 'hidden' });
      await openConversationMenu(page); await menu(page).waitFor();
      assert.equal(await page.locator('.conversation-menu-group').isVisible(), false, 'menu mirrors unavailable original group action');
      assert.equal(await page.locator('.conversation-menu-rename').isVisible(), false);
      assert.deepEqual(f.errors, []);
    } finally { await f.context.close(); }
  });
  await t.test('locale, theme and narrow mobile widths fit without overflow', async () => {
    for (const options of [{ width: 390, locale: 'en' }, { width: 360, locale: 'en' }, { width: 390 }, { width: 390, theme: 'dark' }, { width: 360 }, { width: 430 }, { width: 360, theme: 'dark' }, { width: 430, theme: 'dark' }, { width: 1280, locale: 'en' }]) {
      const f = await open(options);
      try {
        const width = options.width, locale = options.locale || 'zh', theme = options.theme || 'light';
        await noOverflow(f.page);
        // Check the list state before conversation focus hides the bottom navigation.
        await shot(f.page, `navigation-${width}-${locale}-${theme}`);
        const tabs = await f.page.locator('.conversation-tabs [role="tab"]').evaluateAll(buttons => buttons.map(button => {
          const label = [...button.querySelectorAll(':scope > span')].find(span => getComputedStyle(span).display !== 'none');
          const box = button.getBoundingClientRect();
          return { text: label.textContent, scrollWidth: button.scrollWidth, clientWidth: button.clientWidth,
            scrollHeight: button.scrollHeight, clientHeight: button.clientHeight,
            labelScrollWidth: label.scrollWidth, labelClientWidth: label.clientWidth,
            labelScrollHeight: label.scrollHeight, labelClientHeight: label.clientHeight,
            width: box.width, height: box.height };
        }));
        if (evidence) fs.writeFileSync(path.join(evidence, `list-tabs-${width}-${locale}-${theme}.json`), JSON.stringify(tabs, null, 2));
        assert.equal(tabs.length, 2, 'both conversation list tabs are present');
        assert.deepEqual(tabs.map(tab => tab.text), locale === 'en' ? ['My conversations', 'External channels'] : ['我的对话', '外部渠道'], 'conversation tabs use the approved labels');
        for (const tab of tabs) {
          assert.ok(tab.scrollWidth <= tab.clientWidth, `${width} ${locale}: ${tab.text} tab fits horizontally ${JSON.stringify(tab)}`);
          assert.ok(tab.labelScrollWidth <= tab.labelClientWidth, `${width} ${locale}: ${tab.text} caption fits horizontally ${JSON.stringify(tab)}`);
          assert.ok(tab.scrollHeight <= tab.clientHeight && tab.labelScrollHeight <= tab.labelClientHeight, `${width} ${locale}: ${tab.text} fits vertically`);
          if (width < 761) assert.ok(Math.abs(tab.width - tabs[0].width) <= 1 && tab.height === 32, 'list tabs keep their equal-width 32px touch targets');
        }
        if (width < 761) {
          const labels = await f.page.locator('#wb-mobile-nav .wb-mobile-tab').evaluateAll(buttons => buttons.map(button => {
            const label = button.querySelector(':scope > span'), box = button.getBoundingClientRect();
            return { text: label.textContent, scrollWidth: label.scrollWidth, clientWidth: label.clientWidth,
              scrollHeight: label.scrollHeight, clientHeight: label.clientHeight, width: box.width, height: box.height };
          }));
          if (evidence) fs.writeFileSync(path.join(evidence, `navigation-${width}-${locale}-${theme}.json`), JSON.stringify(labels, null, 2));
          assert.equal(labels.length, 5, 'all five bottom navigation labels are present');
          if (locale === 'en') assert.deepEqual(labels.map(label => label.text), ['Overview', 'Conversations', 'Schedule', 'Memory', 'More'], 'navigation wording stays unchanged');
          for (const label of labels) {
            assert.ok(label.scrollWidth <= label.clientWidth, `${width} ${locale}: ${label.text} fits horizontally ${JSON.stringify(label)}`);
            assert.ok(label.scrollHeight <= label.clientHeight, `${width} ${locale}: ${label.text} fits vertically`);
            assert.ok(Math.abs(label.width - width / 5) <= 1 && label.height === 56, 'navigation keeps equal-width 56px touch targets');
          }
        } else {
          assert.equal(await f.page.locator('#wb-mobile-nav').isVisible(), false, 'desktop keeps its original header');
          assert.equal(await f.page.locator('.app-header').isVisible(), true);
        }
        await select(f.page); await noOverflow(f.page);
        const name = width === 390 ? locale === 'en' ? 'mobile-390-en' : theme === 'dark' ? 'mobile-390-dark' : 'mobile-390-light' : `mobile-${width}-${locale}-${theme}`;
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
      assert.match(await page.locator('.conversation-running').innerText(), /正在工作/);
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
