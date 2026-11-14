import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../skills/dashboard/src/lib/http.js';
import { openDashboardTab } from '../../skills/dashboard/__tests__/helpers/browser-navigation.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url)));
const primaryPath = '/_assets/i18n/zh.json';
const groupsPath = '/api/workbench/groups';
const readPack = name => JSON.parse(fs.readFileSync(path.join(publicDir, 'i18n', name), 'utf8'));

export async function runStartupTimeoutBrowser(sandbox, scenario) {
  // Read back the exact child environment and resource targets before launching anything.
  console.info('Startup timeout browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const streams = new Set(), errors = [];
  const recordError = error => { if (errors.length < 5) errors.push(String(error.message ?? error).slice(0, 1000)); };
  const fresh = { ...readPack('zh.json'), 'tab.overview': '恢复总览' };
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': ready\n\n');
        streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now());
        return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
      }
      if (url.pathname === '/') return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
        .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
      if (serveStatic(req, res, publicDir)) return;
      sendJson(res, 404, { error: 'not_found' });
    } catch (error) { recordError(error); sendJson(res, 500, { error: 'fixture_failed' }); }
  });
  sandbox.addCleanup(() => { for (const stream of streams) stream.end(); });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ viewport: { width: scenario.width, height: 960 }, locale: 'zh-CN' });
  sandbox.addCleanup(() => context.close());
  let hanging = false, released = false, release;
  const gate = new Promise(resolve => { release = () => { released = true; resolve(); }; });
  // A route remains unanswered, rather than failing immediately. Browser AbortSignal
  // must end each fetch; all held handlers are released before context cleanup.
  sandbox.addCleanup(release);
  const attempts = new Map();
  await context.route('**/*', async route => {
    const requestUrl = route.request().url();
    if (!requestUrl.startsWith(base + '/')) return route.abort();
    const pathname = new URL(requestUrl).pathname;
    if (hanging && !released && scenario.blocked.includes(pathname)) {
      const count = (attempts.get(pathname) ?? 0) + 1;
      attempts.set(pathname, count);
      if (count > 50) { recordError('request count exceeded case bound'); release(); }
      await gate;
    }
    try {
      if (released && pathname === primaryPath) return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fresh) });
      await route.continue();
    } catch (error) {
      // Timed-out requests and context teardown can invalidate held routes.
      if (!released) recordError(error);
    }
  });
  await context.addInitScript(() => {
    // Dashboard embeds sandboxed frames that cannot access origin storage.
    try { localStorage.setItem('zylos-dashboard-locale', 'zh'); } catch {}
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', recordError);
  let httpFailures = 0;
  page.on('response', response => {
    if (response.status() >= 400 && httpFailures++ < 5) console.warn('Startup browser HTTP:', response.status(), response.url());
  });
  if (scenario.cached) {
    await page.goto(base + '/');
    await page.locator('.wb-row[data-group]').first().waitFor({ state: 'visible' });
    // Prime through a real successful startup, then distinguish stale cache from
    // the server's fresh recovery response without changing any product code.
    await page.evaluate(() => {
      for (const [key, field, value] of [
        ['zylos-dashboard-i18n-zh', 'tab.overview', '缓存总览'],
        ['zylos-dashboard-i18n-wb-zh', 'wb.col.state', '缓存状态'],
      ]) {
        const pack = JSON.parse(localStorage.getItem(key));
        if (!pack) throw Error('successful startup did not populate cache');
        pack[field] = value; localStorage.setItem(key, JSON.stringify(pack));
      }
    });
  }
  hanging = true;
  const start = performance.now();
  const remaining = () => Math.max(1, 8000 - (performance.now() - start));
  if (scenario.cached) await page.reload({ waitUntil: 'commit', timeout: remaining() });
  else await page.goto(base + '/', { waitUntil: 'commit', timeout: remaining() });
  await page.waitForFunction(() => document.documentElement.classList.contains('wb-mobile-ready'), null, { timeout: remaining() });
  assert.ok(performance.now() - start <= 8000, 'mounted within eight seconds while requests remain held');
  assert.equal(released, false, 'timeout must mount before intercepted requests are released');
  await page.locator(scenario.width <= 760 ? '.wb-mobile-topbar' : '.app-header').waitFor({ state: 'visible', timeout: remaining() });
  await page.locator('.view-stack').waitFor({ state: 'visible', timeout: remaining() });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mounted page has no horizontal overflow');
  for (const pathname of scenario.blocked) {
    // With no pack cache, language retries can consume the shared startup
    // deadline before observer reads begin. Independent API cases and cached
    // combined cases must still prove that their actual requests were held.
    const expiredBeforeObserver = !scenario.cached && scenario.blocked.length === 4 && pathname.startsWith('/api/');
    if (!expiredBeforeObserver) assert.ok((attempts.get(pathname) ?? 0) > 0, `actually intercepted ${pathname}`);
    if (pathname.startsWith('/_assets/i18n/')) assert.ok(attempts.get(pathname) >= 3, `${pathname} exhausted all three hanging attempts before fallback`);
  }
  if (!scenario.blocked.includes(groupsPath)) {
    await page.locator('.wb-row[data-group]').first().waitFor({ state: 'visible', timeout: remaining() });
    assert.ok(performance.now() - start <= 8000, 'content rows visible within eight seconds');
  } else {
    assert.ok((await page.locator('body').innerText()).trim().length > 0, 'mounted shell has visible text while groups remain hung');
  }
  const nav = page.locator('.tab[data-tab="overview"]');
  if (scenario.blocked.includes(primaryPath)) {
    assert.equal(await nav.textContent(), scenario.cached ? '缓存总览' : 'tab.overview');
  } else assert.equal(await nav.textContent(), '总览');
  if (scenario.blocked.includes('/_assets/i18n/wb.zh.json')) {
    assert.equal(await page.locator('[data-i18n="wb.col.state"]').first().textContent(), scenario.cached ? '缓存状态' : 'wb.col.state');
  }
  const mountMs = Math.round(performance.now() - start);
  assert.ok(mountMs <= 8000, 'visible header and content stay within the startup bound');
  const capture = async phase => {
    if (!process.env.ZYLOS_CHAT_EVIDENCE_DIR || !scenario.heal) return;
    fs.mkdirSync(process.env.ZYLOS_CHAT_EVIDENCE_DIR, { recursive: true });
    const name = `startup-${scenario.cached ? 'cached' : 'first'}-${scenario.width}-${phase}.png`;
    await page.screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, name), animations: 'disabled', timeout: 5000 });
  };
  await capture('mounted');
  if (scenario.blocked.length === 1 && scenario.blocked[0] === groupsPath) {
    // A groups timeout must preserve the independently successful observer response.
    // Read it through real settings UI while groups requests remain unanswered.
    await openDashboardTab(page, 'settings');
    await page.waitForFunction(() => document.querySelector('#observer-settings-state')?.textContent === '未安装', null, { timeout: 4000 });
    assert.equal(released, false, 'observer status is known before groups recover');
    await openDashboardTab(page, 'overview');
  }
  release();
  if (scenario.heal) {
    await page.waitForFunction(() => document.querySelector('.tab[data-tab="overview"]')?.textContent === '恢复总览', null, { timeout: 13000 });
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('zylos-dashboard-i18n-zh'))['tab.overview']), '恢复总览', 'background heal updates persistent cache');
    await capture('healed');
  }
  if (scenario.blocked.includes(groupsPath)) {
    await page.locator('.wb-row[data-group]').first().waitFor({ state: 'visible', timeout: 12000 });
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.info('Startup timeout observation:', JSON.stringify({ name: scenario.name, mountMs, attempts: Object.fromEntries(attempts), healed: Boolean(scenario.heal) }));
}
