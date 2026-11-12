import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { GROUP, workbenchAnswer } from '../fixtures/workbench-browser-api.js';
import { openGroupDetail } from './browser-navigation.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const PREVIEW = '请核对这份组详情';
const ID = 'g:' + Buffer.from(GROUP).toString('hex').toUpperCase();

// Only fixed HTTP answers are changed, never product source or evaluated product modules.
async function startSummaryPage(sandbox) {
  const now = Date.now(), missing = new Set();
  const row = () => {
    const value = workbenchAnswer(new URL('http://fixture/api/workbench/groups'), now).rows.find(item => item.sessionGroup === GROUP);
    value.name = { displayName: '组详情示例' };
    value.state = { kind: 'waiting' };
    value.duration = 75;
    value.preview = { text: PREVIEW, timestamp: new Date(now - 90000).toISOString(), channel: 'telegram', source: { kind: 'channel' } };
    value.tools = [];
    value.queue = { known: true, pending: { count: 1, oldestAt: now - 75000 }, running: { count: 0 } };
    value.wait = { kind: 'rate_wait', runtime: 'claude', cooldownUntil: Math.floor(now / 1000) + 3600 };
    value.live.status = { valid: true, state: 'idle', sampledAt: now, idleSeconds: null };
    return value;
  };
  const answer = url => {
    if (url.pathname === '/api/workbench/groups') {
      const value = workbenchAnswer(url, now), group = row();
      value.rows = value.rows.map(item => item.sessionGroup === GROUP ? group : item);
      value.counts = { idle: 1, busy: 0, waiting: 0, error: 0, unknown: 0, not_running: 1 };
      value.counts[group.state.kind]++;
      const ok = { ok: true, readAt: now };
      value.sources = { status: { ...ok }, c4: { ok: false, reason: 'messages_unreadable', readAt: now },
        q: { ...ok }, ov: { ...ok }, accounts: { claude: { ...ok }, codex: { ...ok } } };
      value.instance.runtimeHealth = { claude: { health: 'rate_limited', updatedAt: now - 360000, cooldownUntil: Math.floor(now / 1000) + 3600 }, codex: { health: 'ok', updatedAt: now - 360000 } };
      return value;
    }
    if (url.pathname === '/api/observer/status') return { state: 'installed', desired: { enabled: true }, sessionMode: 'multi' };
    if (url.pathname === '/api/timeline') return { events: [] };
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
  return { base, missing };
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
  const open = async width => {
    const theme = 'light', level = 'technical', locale = 'zh';
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
    assert.equal(await page.locator(selector).evaluate(node => node.scrollWidth > node.clientWidth), false, 'panel has no horizontal overflow');
    await page.screenshot(evidence ? { path: path.join(evidence, name + '.png') } : {});
    captures.push(name);
  };
  const visibleRegions = async panel => {
    await panel.locator('.wb-d-title').filter({ hasText: '组详情示例' }).waitFor();
    for (const selector of ['.wb-d-top', '.wb-detail-tabs', '.wb-now-card', '.wb-detail-recent']) {
      assert.equal(await panel.locator(selector).isVisible(), true, selector + ' is visible');
    }
  };
  // Content/localization variants live in conversation-group-side.test.js. Both widths retain real entry and
  // layout checks; the phone also proves a native evidence fold opens. Theme differences only change colours.
  let failed = false;
  for (const width of [1280, 390]) {
    await t.test(`${width} light: overview and conversation group detail entry and layout`, async () => {
      let f;
      try {
        f = await open(width);
        const overview = f.page.locator('#wb-side');
        await visibleRegions(overview);
        await shot(f.page, `${width}-light-overview`, '#wb-side');
        await overview.locator('[data-action="viewConversation"]').click();
        await openGroupDetail(f.page);
        const side = f.page.locator('#wb-chat .wb-group-side');
        await visibleRegions(side);
        if (width === 390) {
          const support = side.locator('.wb-detail-evidence');
          assert.equal(await support.evaluate(node => node.open), false);
          await support.locator('summary').click();
          await support.locator('table').waitFor({ state: 'visible' });
          await support.locator('summary').click();
          await support.locator('table').waitFor({ state: 'hidden' });
        }
        await shot(f.page, `${width}-light-conversation`, '#wb-chat .wb-group-side');
        assert.equal(f.errors.length, 0, f.errors[0]);
      } catch (error) { failed = true; throw error; } finally { if (f) await f.context.close(); }
    });
    if (failed) return;
  }
  assert.equal(captures.length, 4);
  console.info('Group detail capture inventory:', JSON.stringify({ captures, missing: [...fixture.missing] }));
  if (evidence) fs.writeFileSync(path.join(evidence, 'captures.json'), JSON.stringify(captures, null, 2));
}
