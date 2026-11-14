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
const workbenchPath = '/_assets/i18n/wb.zh.json';
const observerPath = '/api/observer/status';
const groupsPath = '/api/workbench/groups';
const readPack = name => JSON.parse(fs.readFileSync(path.join(publicDir, 'i18n', name), 'utf8'));

export async function runStartupTimeoutBrowser(sandbox, scenario) {
  // Read back the exact child environment and resource targets before launching anything.
  console.info('Startup timeout browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  const streams = new Set(), errors = [];
  const recordError = error => { if (errors.length < 5) errors.push(String(error.message ?? error).slice(0, 1000)); };
  const fresh = { ...readPack('zh.json'), 'tab.overview': '恢复总览' };
  const freshWb = { ...readPack('wb.zh.json'), 'wb.col.state': '恢复状态' };
  let postObserver = false, observerReplies = 0;
  const timers = new Map();
  const pause = ms => new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
    timers.set(timer, resolve);
  });
  sandbox.addCleanup(() => { for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); } timers.clear(); });
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': ready\n\n');
        streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname.startsWith('/api/')) {
        let value = workbenchAnswer(url, Date.now());
        if (url.pathname === observerPath && (scenario.lateObserver || scenario.postObserver)) {
          observerReplies++;
          value = { state: 'installed', desired: { enabled: true }, sessionMode: 'multi', target: null,
            runtime: { state: 'idle' }, platform: 'fixture', version: postObserver ? 'fresh-status' : 'startup-status' };
        }
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
  // A route remains unanswered, rather than failing immediately. The UI deadline
  // must leave the real request alive; release proves late completion still renders.
  // All held handlers and delayed responses belong to the sandbox lifecycle.
  sandbox.addCleanup(release);
  const attempts = new Map(), delayed = new Map();
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
    if (hanging && ((scenario.slow === pathname) || (postObserver && pathname === observerPath))) {
      delayed.set(pathname, (delayed.get(pathname) ?? 0) + 1);
      if (delayed.get(pathname) > 50) { recordError('delayed request count exceeded case bound'); release(); }
      await pause(pathname === observerPath ? 2000 : scenario.delayMs);
    }
    try {
      const freshLanguage = released || scenario.slow === pathname;
      if (freshLanguage && pathname === workbenchPath) return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(freshWb) });
      if (freshLanguage && pathname === primaryPath) return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fresh) });
      await route.continue();
    } catch (error) {
      // Timed-out requests and context teardown can invalidate held routes.
      if (!released) recordError(error);
    }
  });
  await context.addInitScript(() => {
    // Dashboard embeds sandboxed frames that cannot access origin storage.
    try { localStorage.setItem('zylos-dashboard-locale', 'zh'); localStorage.setItem('zylos-dashboard-detail-level', 'technical'); } catch {}
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
    // Both pack requests must be live; observers can start after pack UI waiting
    // completes. Their independent cases prove interception before mount.
    if (pathname.startsWith('/api/') && scenario.blocked.includes(primaryPath)) continue;
    assert.ok((attempts.get(pathname) ?? 0) >= 1, `actually held ${pathname}`);
    if (pathname.startsWith('/_assets/i18n/')) assert.equal(attempts.get(pathname), 1, 'UI wait leaves the original language request pending rather than aborting/retrying it');
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
  } else assert.equal(await nav.textContent(), scenario.slow === primaryPath ? '恢复总览' : '总览');
  if (scenario.blocked.includes('/_assets/i18n/wb.zh.json')) {
    assert.equal(await page.locator('[data-i18n="wb.col.state"]').first().textContent(), scenario.cached ? '缓存状态' : 'wb.col.state');
  }
  if (scenario.slow) {
    assert.ok((delayed.get(scenario.slow) ?? 0) >= 1, 'the valid language response was delayed');
    assert.ok(performance.now() - start >= 1500, 'slow response really took at least 1.5 seconds');
    await assertFreshPack(scenario.slow);
    assert.doesNotMatch(await page.locator('body').innerText(), /\b(?:wb\.[a-z_]+|tab\.overview)\b/, 'visible Chinese page has no raw language keys');
  }
  const mountMs = Math.round(performance.now() - start);
  assert.ok(mountMs <= 8000, 'visible header and content stay within the startup bound');
  const capture = async phase => {
    if (!process.env.ZYLOS_CHAT_EVIDENCE_DIR || !scenario.heal) return;
    fs.mkdirSync(process.env.ZYLOS_CHAT_EVIDENCE_DIR, { recursive: true });
    const pack = scenario.blocked.length === 4 ? 'all' : scenario.blocked.includes(workbenchPath) ? 'workbench' : 'main';
    const name = `startup-${pack}-${scenario.cached ? 'cached' : 'first'}-${scenario.width}-${phase}.png`;
    await page.screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, name), animations: 'disabled', timeout: 5000 });
  };
  await capture('mounted');
  release();
  if (scenario.heal) {
    if (scenario.blocked.includes(primaryPath)) await assertFreshPack(primaryPath);
    if (scenario.blocked.includes(workbenchPath)) await assertFreshPack(workbenchPath);
    await capture('healed');
  }
  if (scenario.lateObserver) {
    // No navigation or second refresh is allowed to manufacture this update.
    // The original request was unanswered past the six-second UI wait.
    assert.ok(mountMs >= 5800, 'observer remained pending past the startup wait');
    await page.waitForFunction(() => document.querySelector('#observer-main')?.hidden === false, null, { timeout: 4000 });
    assert.equal(observerReplies, 1, 'late original startup status rendered without another request');
    assert.equal(attempts.get(observerPath), 1, 'startup wait did not abort and retry the held request');
  }
  if (scenario.postObserver) {
    // Open the actual Observer page, whose open path refreshes status non-quietly.
    // Keep its successful startup state through a genuinely slow refresh.
    await openDashboardTab(page, 'settings');
    await page.waitForFunction(() => document.querySelector('#observer-settings-platform')?.textContent.includes('startup-status'), null, { timeout: 4000 });
    await openDashboardTab(page, 'overview');
    postObserver = true;
    const openStart = performance.now();
    const response = page.waitForResponse(r => new URL(r.url()).pathname === observerPath, { timeout: 6000 });
    response.catch(() => {}); // Teardown may close the page after an earlier assertion fails.
    await openDashboardTab(page, 'observer');
    await pause(1200);
    assert.equal(await page.locator('#observer-main').getAttribute('hidden'), null, 'pending slow refresh retains known observer state');
    assert.notEqual(await page.locator('#observer-notice').getAttribute('data-state'), 'error');
    assert.match(await page.locator('#observer-settings-platform').textContent(), /startup-status/);
    await response;
    await page.waitForFunction(() => document.querySelector('#observer-settings-platform')?.textContent.includes('fresh-status'), null, { timeout: 4000 });
    assert.ok(performance.now() - openStart >= 2000, 'non-quiet opening accepted a two-second refresh');
    assert.equal(delayed.get(observerPath), 1, 'opening succeeds without retrying a prematurely aborted status read');
    assert.notEqual(await page.locator('#observer-notice').getAttribute('data-state'), 'error');
  }
  if (scenario.blocked.includes(groupsPath)) {
    await page.locator('.wb-row[data-group]').first().waitFor({ state: 'visible', timeout: 12000 });
  }
  async function assertFreshPack(packPath) {
    const main = packPath === primaryPath;
    const selector = main ? '.tab[data-tab="overview"]' : '[data-i18n="wb.col.state"]';
    const label = main ? '恢复总览' : '恢复状态';
    await page.waitForFunction(({ selector, label }) => document.querySelector(selector)?.textContent === label,
      { selector, label }, { timeout: 13000 });
    const cacheKey = main ? 'zylos-dashboard-i18n-zh' : 'zylos-dashboard-i18n-wb-zh';
    const field = main ? 'tab.overview' : 'wb.col.state';
    assert.equal(await page.evaluate(({ cacheKey, field }) => JSON.parse(localStorage.getItem(cacheKey))?.[field], { cacheKey, field }), label,
      'late or slow response updates persistent language cache');
  }
  assert.equal(errors.length, 0, errors.join('\n'));
  console.info('Startup timeout observation:', JSON.stringify({ name: scenario.name, mountMs, attempts: Object.fromEntries(attempts), delayed: Object.fromEntries(delayed), healed: Boolean(scenario.heal) }));
}
