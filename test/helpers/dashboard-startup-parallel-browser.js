import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../../skills/dashboard/src/lib/http.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../skills/dashboard/public/', import.meta.url)));
const mainPath = '/_assets/i18n/zh.json';
const wbPath = '/_assets/i18n/wb.zh.json';
const observerPath = '/api/observer/status';
const groupsPath = '/api/workbench/groups';
const pack = locale => JSON.parse(fs.readFileSync(path.join(publicDir, 'i18n', `wb.${locale}.json`), 'utf8'));

export async function runStartupParallelBrowser(sandbox, scenario) {
  console.info('Parallel startup browser isolation:', JSON.stringify(sandbox.assertIsolation()));
  let closing = false;
  const errors = [], streams = new Set(), timers = new Map(), starts = new Map(), requests = new Map();
  const recordError = error => { if (!closing && errors.length < 5) errors.push(String(error.message ?? error).slice(0, 1000)); };
  const pause = ms => new Promise(resolve => {
    const timer = setTimeout(() => { timers.delete(timer); resolve(); }, ms);
    timers.set(timer, resolve);
  });
  // Register last as well as early enough that any setup failure owns its timers.
  const stop = () => {
    closing = true;
    for (const [timer, resolve] of timers) { clearTimeout(timer); resolve(); }
    timers.clear();
    for (const stream of streams) stream.end();
  };
  sandbox.addCleanup(stop);
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write(': ready\n\n'); streams.add(res); res.on('close', () => streams.delete(res)); return;
      }
      if (url.pathname.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now());
        return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
      }
      if (url.pathname === '/') return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
        .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
      if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
    } catch (error) { recordError(error); if (!res.headersSent) sendJson(res, 500, { error: 'fixture_failed' }); else res.end(); }
  });
  const base = await sandbox.startHttp(server);
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ viewport: { width: scenario.width, height: 960 }, locale: scenario.locale === 'zh' ? 'zh-CN' : 'en-US' });
  sandbox.addCleanup(() => context.close());
  let mainCompletedAt = null, groupsCompleted = 0;
  await context.route('**/*', async route => {
    try {
      const url = new URL(route.request().url());
      if (url.origin !== base) return await route.abort();
      const pathname = url.pathname, count = (requests.get(pathname) ?? 0) + 1;
      requests.set(pathname, count);
      if (!starts.has(pathname)) starts.set(pathname, performance.now());
      if (count > 50) { recordError(`request bound exceeded for ${pathname}`); return await route.abort(); }
      if (scenario.kind === 'parallel' && pathname === mainPath) {
        await pause(8000);
        if (closing) return await route.abort();
        await route.fulfill({ status: 200, contentType: 'application/json', body: fs.readFileSync(path.join(publicDir, 'i18n/zh.json'), 'utf8') });
        mainCompletedAt = performance.now(); return;
      }
      if (pathname === groupsPath && scenario.kind === 'groups') {
        // Delay EVERY groups response, so a retry/periodic poll cannot accidentally
        // supply a fast result and mask starvation of the original slow read.
        await pause(7000);
        if (closing) return await route.abort();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workbenchAnswer(url, Date.now())) });
        groupsCompleted++; return;
      }
      if (pathname === groupsPath && scenario.kind === 'error') {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'fixture_groups_failed' }) }); return;
      }
      await route.continue();
    } catch (error) { recordError(error); }
  });
  await context.addInitScript(({ locale, groupsPath }) => {
    if (window !== window.top) return;
    localStorage.clear();
    localStorage.setItem('zylos-dashboard-locale', locale);
    localStorage.setItem('zylos-dashboard-detail-level', 'technical');
    // Observe the real fetch calls without changing URLs, responses or timing.
    // Observer and fleet startup legitimately read groups independently. Track
    // the board's own stack separately so those reads do not hide duplicate polls.
    const fetch = window.fetch.bind(window);
    const observations = window.__startupGroups = { calls: [], active: {}, maxActive: {} };
    window.fetch = function (...args) {
      if (new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href).pathname !== groupsPath) return fetch(...args);
      const source = new Error().stack.includes('/wb/shell.js') ? 'board' : 'startup';
      const call = { source, started: performance.now(), finished: null };
      observations.calls.push(call);
      observations.active[source] = (observations.active[source] || 0) + 1;
      observations.maxActive[source] = Math.max(observations.maxActive[source] || 0, observations.active[source]);
      return fetch(...args).finally(() => { call.finished = performance.now(); observations.active[source]--; });
    };
  }, { locale: scenario.locale, groupsPath });
  const page = await context.newPage();
  page.setDefaultTimeout(10000); page.setDefaultNavigationTimeout(10000);
  page.on('pageerror', recordError);
  // Teardown resolves delayed handlers before closing their contexts.
  sandbox.addCleanup(stop);
  const start = performance.now();
  await page.goto(base + '/', { waitUntil: 'commit' });
  const labels = pack(scenario.locale);
  if (scenario.kind === 'parallel') {
    try {
      await page.waitForFunction(() => document.querySelector('[data-i18n="wb.col.state"]')?.textContent === '状态', null, { timeout: 7500 });
    } catch (error) {
      console.info('Parallel startup failure:', JSON.stringify({ errors, requests: Object.fromEntries(requests), page: await page.evaluate(() => ({
        label: document.querySelector('[data-i18n="wb.col.state"]')?.textContent,
        language: document.documentElement.lang, mounted: document.documentElement.classList.contains('wb-mobile-ready'),
        wbCache: Boolean(localStorage.getItem('zylos-dashboard-i18n-wb-zh')),
      })).catch(() => null) }));
      throw error;
    }
    await page.waitForFunction(() => document.documentElement.classList.contains('wb-mobile-ready'), null, { timeout: Math.max(1, 7500 - (performance.now() - start)) });
    await page.locator('.wb-row[data-group]').first().waitFor({ state: 'visible', timeout: Math.max(1, 7500 - (performance.now() - start)) });
    assert.equal(mainCompletedAt, null, 'visible workbench rows and translated labels render while the main Chinese response is pending');
    assert.equal(await page.evaluate(() => localStorage.getItem('zylos-dashboard-i18n-zh')), null, 'first visit has no main-pack cache');
    for (const pathname of [mainPath, wbPath, observerPath]) assert.ok(starts.has(pathname), `${pathname} actually started`);
    for (const pathname of [wbPath, observerPath]) {
      assert.ok(starts.get(pathname) - starts.get(mainPath) <= 1000, `${pathname} starts within one second of the main pack`);
      assert.ok(starts.get(pathname) - start <= 1000, `${pathname} starts promptly after navigation`);
    }
    await page.waitForFunction(() => document.querySelector('.tab[data-tab="overview"]')?.textContent === '总览', null, { timeout: 5000 });
    assert.ok(mainCompletedAt !== null, 'the delayed original main response eventually completes');
    assert.equal(requests.get(mainPath), 1, 'main pack was not aborted and retried');
  } else if (scenario.kind === 'groups') {
    const loading = page.locator('#wb-board > .wb-empty[role="status"]');
    await loading.waitFor({ state: 'visible', timeout: 6500 });
    assert.equal(await loading.textContent(), labels['wb.board.loading']);
    assert.equal(groupsCompleted, 0, 'loading is visible before ANY groups response');
    assert.equal(await page.locator('.wb-row[data-group]').count(), 0, 'loading does not manufacture rows');
    await page.locator('.wb-row[data-group]').first().waitFor({ state: 'visible', timeout: 16000 });
    assert.ok(performance.now() - starts.get(groupsPath) >= 7000, 'a genuinely slow groups response supplied the rows');
    assert.equal(await loading.count(), 0, 'loading disappears after the snapshot arrives');
    await page.waitForFunction(() => window.__startupGroups.calls.filter(call => call.source === 'board').length >= 2, null, { timeout: 10000 });
    const calls = await page.evaluate(() => window.__startupGroups);
    const boardCalls = calls.calls.filter(call => call.source === 'board');
    assert.ok(boardCalls[1].started >= boardCalls[0].finished, 'the next periodic board read starts only after the previous slow read settles');
    assert.ok(calls.calls.some(call => call.source === 'board' && call.finished !== null), 'the actual board fetch completed');
    assert.equal(calls.maxActive.board, 1, 'periodic board polls never overlap their previous groups request');
  } else {
    const error = page.locator('#wb-board > .wb-empty[role="alert"]');
    await error.waitFor({ state: 'visible', timeout: 8500 });
    assert.equal(await error.textContent(), labels['wb.readFailed']);
    assert.equal(await page.locator('#wb-board > .wb-empty[role="status"]').count(), 0, 'error replaces initial loading');
    assert.equal(await page.locator('.wb-row[data-group]').count(), 0);
    assert.ok((requests.get(groupsPath) ?? 0) >= 1, 'the failing groups endpoint was requested');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'startup state has no horizontal overflow');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.info('Parallel startup observation:', JSON.stringify({ name: scenario.name, elapsedMs: Math.round(performance.now() - start), requestStartMs: Object.fromEntries([mainPath, wbPath, observerPath].filter(path => starts.has(path)).map(path => [path, Math.round(starts.get(path) - start)])), requests: Object.fromEntries(requests), groupsCompleted }));
}
