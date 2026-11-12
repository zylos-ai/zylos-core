import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP, workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const PREVIEW = '请核对这份组详情';
const ID = 'g:' + Buffer.from(GROUP).toString('hex').toUpperCase();

// Only fixed HTTP answers are changed, never product source or evaluated product modules.
async function startSummaryPage(sandbox) {
  const now = Date.now(), missing = new Set();
  let scene = 'idle';
  const row = () => {
    const value = workbenchAnswer(new URL('http://fixture/api/workbench/groups'), now).rows.find(item => item.sessionGroup === GROUP);
    value.name = { displayName: '组详情示例' };
    value.state = { kind: scene.startsWith('waiting') ? 'waiting' : scene };
    value.duration = 75;
    value.preview = { text: PREVIEW, timestamp: new Date(now - 90000).toISOString(), channel: 'telegram', source: { kind: 'channel' } };
    value.tools = scene === 'busy' ? [{ name: 'Read', detail: '/private-fixture/report.md', startedAt: now - 10000 }, { name: 'WebSearch', detail: 'fixture lookup', startedAt: now - 5000 }] : [];
    value.queue = { known: true, pending: { count: scene.startsWith('waiting') ? 1 : 0, oldestAt: now - 75000 }, running: { count: scene === 'busy' ? 1 : 0 } };
    value.wait = scene.startsWith('waiting') ? { kind: 'rate_wait', runtime: 'claude', cooldownUntil: Math.floor(now / 1000) + 3600 } : null;
    value.live.status = { valid: true, state: scene.startsWith('waiting') ? 'idle' : scene, sampledAt: now, idleSeconds: scene === 'idle' ? 75 : null };
    return value;
  };
  const answer = url => {
    if (url.pathname === '/api/workbench/groups') {
      const value = workbenchAnswer(url, now), group = row();
      value.rows = value.rows.map(item => item.sessionGroup === GROUP ? group : item);
      value.counts = { idle: 1, busy: 0, waiting: 0, error: 0, unknown: 0, not_running: 1 };
      value.counts[group.state.kind]++;
      const ok = { ok: true, readAt: now };
      value.sources = { status: { ...ok }, c4: scene === 'waiting' ? { ok: false, reason: 'messages_unreadable', readAt: now } : { ...ok },
        q: { ...ok }, ov: { ...ok }, accounts: { claude: { ...ok }, codex: { ...ok } } };
      value.instance.runtimeHealth = { claude: { health: scene.startsWith('waiting') ? 'rate_limited' : 'ok', updatedAt: now - 360000, cooldownUntil: scene.startsWith('waiting') ? Math.floor(now / 1000) + 3600 : 0 }, codex: { health: 'ok', updatedAt: now - 360000 } };
      return value;
    }
    if (url.pathname === '/api/observer/status') return { state: 'installed', desired: { enabled: true }, sessionMode: 'multi' };
    if (url.pathname === '/api/timeline') {
      if (scene !== 'busy') return { events: [] };
      const after = Number(url.searchParams.get('after_seq') ?? 0);
      const events = [1, 2].filter(id => id > after).map(id => ({ id, event_seq: id, event_type: 'subagent_start', agent_id: `helper-${id}`,
        run_id: 'run-tg', session_group: GROUP, timestamp: new Date(now - 10000 + id).toISOString(), metadata: { name: `后台助手 ${id}` } }));
      return { events };
    }
    if (url.pathname === '/api/chat/settings') return { allowRemote: false };
    if (url.pathname === '/api/chat/conversations') return { items: [{ id: ID, session_group: GROUP, display_name: '组详情示例', channel: 'telegram' }], nextCursor: null, tz: 'UTC' };
    if (url.pathname.startsWith('/api/chat/conversations/')) {
      if (url.pathname.endsWith('/messages')) return { items: [{ id: 1, direction: 'in', channel: 'telegram', content: PREVIEW, timestamp: new Date(now - 90000).toISOString() }], nextCursor: null, afterCursor: 'after-1', tz: 'UTC' };
      if (url.pathname.endsWith('/activity')) return { now: new Date(now).toISOString(), items: [] };
      if (url.pathname.endsWith('/status')) return { items: [] };
      if (url.pathname.endsWith('/questions')) return { items: [], nextCursor: null };
      return { conversation: { id: ID, sessionGroup: GROUP, channel: 'telegram', state: 'active', displayName: '组详情示例' }, stored: true, deliveryState: null, error: null };
    }
    return workbenchAnswer(url, now);
  };
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (url.pathname.startsWith('/api/')) {
        const value = req.method === 'GET' ? answer(url) : undefined;
        if (value === undefined) { assert.ok(missing.size < 10, 'unserved request capture remains bounded'); missing.add(`${req.method} ${url.pathname}`); }
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (['/', '/chat'].includes(url.pathname)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8').replaceAll('__BASE_PATH__', '')
          .replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return;
      }
      if (url.pathname === '/_assets/vendor/chart.umd.js' && process.env.ZYLOS_CHAT_CHART_ASSET) {
        res.writeHead(200, { 'content-type': 'text/javascript' }); fs.createReadStream(process.env.ZYLOS_CHAT_CHART_ASSET).pipe(res); return;
      }
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.message }); }
  });
  const base = await sandbox.startHttp(server);
  return { base, missing, setScene: value => { scene = value; } };
}

export async function runGroupDetailSummaryBrowser(t, sandbox) {
  console.info('Group detail browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const fixture = await startSummaryPage(sandbox);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR, captures = [];
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const open = async (width, theme, level, locale = 'zh') => {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'UTC' });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(({ theme, level, locale }) => {
      try { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-detail-level', level); } catch {}
    }, { theme, level, locale });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const network = []; page.on('requestfailed', req => { if(network.length < 10) network.push({url:req.url(), failure:req.failure()}); });
    page.on('console', msg => { if(msg.type() === 'error' && network.length < 10) network.push(msg.text()); });
    const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    try {
      const main = await page.goto(fixture.base + '/');
      console.info('Detail entry response:', main.url(), JSON.stringify(await main.allHeaders()));
      await page.locator('#wb-board .wb-row', { hasText: '组详情示例' }).click();
      await page.locator('#wb-side .wb-now-title').first().waitFor();
      return { page, context, errors };
    } catch (error) {
      console.error('Detail opening failed:', error.message, JSON.stringify({ errors, network, missing: [...fixture.missing] }));
      if (evidence) { await page.screenshot({ path: path.join(evidence, 'opening-failure.png') }); fs.writeFileSync(path.join(evidence, 'opening-failure.html'), await page.content()); }
      await context.close(); throw error;
    }
  };
  const shot = async (page, name, selector) => {
    await page.evaluate(() => document.fonts.ready);
    const frame = await page.locator(selector).boundingBox(); assert.ok(frame?.width > 0 && frame?.height > 0, 'the detail panel is visible before capture');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'page has no horizontal overflow');
    if (evidence) await page.screenshot({ path: path.join(evidence, name + '.png') });
    captures.push(name);
  };
  const checkCard = async (page, panel, scene, level, fromConversation) => {
    const card = panel.locator('.wb-now-card'); await card.waitFor();
    const title = card.locator('.wb-now-title');
    if (level === 'plain') assert.equal(await title.count(), 1, 'plain current state is one title line');
    const titles = (await title.allTextContents()).join(' ');
    assert.equal(titles.includes(PREVIEW), false, 'last received never becomes the current-state title');
    if (scene === 'idle') {
      if (level === 'plain') assert.equal(titles, '空闲 · 已 1 分钟');
      else { assert.match(titles, /空闲/); assert.match(titles, /1m15s/); }
    }
    if (scene === 'busy' && level === 'plain') {
      await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('后台子任务 2 个'), fromConversation ? '.wb-group-side .wb-now-card' : '#wb-side .wb-now-card');
      assert.match(await title.innerText(), /读文件.*后台子任务 2 个/);
      assert.equal(await panel.locator('.wb-subs').count(), 0, 'plain state uses the count without separate agent tags');
    }
    if (scene === 'busy' && level === 'technical') await panel.locator('.wb-subs .wb-tag').last().waitFor();
    if (scene.startsWith('waiting') && level === 'plain') {
      assert.match(titles, /额度已用完，.*恢复。1 条消息在等/);
      assert.equal(titles.includes('恢复时间未知'), false, 'the actual rate limit has a known future recovery time');
    }
    const preview = card.locator('.wb-now-sub');
    if (fromConversation) {
      assert.equal((await preview.allTextContents()).some(text => text.includes(PREVIEW)), false, 'conversation detail omits received-message subtitle');
      assert.equal(await card.locator('.wb-now-raw').count(), 0, 'conversation sidebar omits the received message original fold too');
    } else assert.equal((await preview.allTextContents()).some(text => text.includes(PREVIEW)), true, 'overview retains received-message preview as small text');
    const terminal = card.locator('[data-observer-group]');
    assert.equal(await terminal.count(), level === 'technical' ? 1 : 0, 'terminal entry appears only with technical detail');
    if (level === 'technical') { assert.equal(await terminal.innerText(), '终端'); assert.equal(await terminal.getAttribute('title'), '终端'); assert.equal(await terminal.getAttribute('aria-label'), '终端'); }
    const support = card.locator('.wb-detail-evidence');
    assert.equal(await support.count(), level === 'technical' && scene.startsWith('waiting') ? 1 : 0, 'evidence appears only for technical waiting states');
    if (level === 'technical' && scene.startsWith('waiting')) {
      await support.locator('summary').click(); await support.locator('table').waitFor();
      const content = await support.innerText();
      assert.match(content, /会话忙闲/);
      assert.match(content, /claude · rate_limited/);
      assert.match(await card.locator('.wb-now-sub').first().innerText(), /rate_wait/);
      if (scene === 'waiting') { assert.match(content, /messages_unreadable/); assert.equal(content.includes('accounts'), false, 'healthy nested account reads are not failed sources'); }
      else assert.match(content, /数据来源全部正常/);
    }
  };
  let failed = false;
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) for (const level of ['plain', 'technical']) for (const scene of ['idle', 'busy', 'waiting']) {
    await t.test(`${width} ${theme} ${level} ${scene}: overview and conversation sidebar`, async () => {
      fixture.setScene(scene); let f;
      try {
        f = await open(width, theme, level);
        const overview = f.page.locator('#wb-side');
        await checkCard(f.page, overview, scene, level, false);
        await shot(f.page, `${width}-${theme}-${level}-${scene}-overview`, '#wb-side');
        await overview.locator('[data-action="viewConversation"]').click();
        if (width <= 760) {
          await f.page.locator('#wb-chat .conversation-menu-toggle').click();
          await f.page.locator('#wb-chat [data-action="page.menuGroup"]').click();
        } else {
          await f.page.locator('#wb-chat [data-action="page.groupInfo"]').click();
        }
        const side = f.page.locator('#wb-chat .wb-group-side');
        await side.locator('.wb-d-title').filter({ hasText: '组详情示例' }).waitFor();
        await side.locator('.wb-now-title').first().waitFor();
        await checkCard(f.page, side, scene, level, true);
        await shot(f.page, `${width}-${theme}-${level}-${scene}-conversation`, '#wb-chat .wb-group-side');
        assert.equal(f.errors.length, 0, f.errors[0]);
      } catch (error) { failed = true; throw error; } finally { if (f) await f.context.close(); }
    });
    if (failed) return;
  }
  await t.test('healthy waiting sources consolidate and English state and terminal labels are readable', async () => {
    fixture.setScene('waiting-healthy'); const f = await open(390, 'light', 'technical');
    try {
      await checkCard(f.page, f.page.locator('#wb-side'), 'waiting-healthy', 'technical', false);
      assert.equal(f.errors.length, 0, f.errors[0]);
    } finally { await f.context.close(); }
    const en = await open(390, 'dark', 'technical', 'en');
    try {
      const terminal = en.page.locator('#wb-side [data-observer-group]');
      assert.equal(await terminal.innerText(), 'Terminal'); assert.equal(await terminal.getAttribute('title'), 'Terminal'); assert.equal(await terminal.getAttribute('aria-label'), 'Terminal');
      assert.equal(en.errors.length, 0, en.errors[0]);
    } finally { await en.context.close(); }
    fixture.setScene('busy'); const busy = await open(390, 'light', 'plain', 'en');
    try {
      assert.match(await busy.page.locator('#wb-side .wb-now-title').innerText(), /Read file, Search web/);
      assert.equal((await busy.page.locator('#wb-side .wb-now-title').innerText()).includes('、'), false, 'English tools use the localized separator');
      assert.equal(busy.errors.length, 0, busy.errors[0]);
    } finally { await busy.context.close(); }
    fixture.setScene('idle'); const idle = await open(390, 'light', 'plain', 'en');
    try {
      assert.equal(await idle.page.locator('#wb-side .wb-now-title').textContent(), 'Idle · for 1 minute');
      assert.equal(idle.errors.length, 0, idle.errors[0]);
    } finally { await idle.context.close(); }
  });
  assert.equal(captures.length, 48);
  console.info('Group detail capture inventory:', JSON.stringify({ captures, missing: [...fixture.missing] }));
  if (evidence) fs.writeFileSync(path.join(evidence, 'captures.json'), JSON.stringify(captures, null, 2));
}
