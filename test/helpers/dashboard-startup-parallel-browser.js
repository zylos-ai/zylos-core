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
  let releaseHeld, heldReleased = false, heldRequest = null;
  const heldGate = new Promise(resolve => { releaseHeld = resolve; });
  // Register last as well as early enough that any setup failure owns its timers.
  const stop = () => {
    closing = true;
    heldReleased = true; releaseHeld();
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
  let mainCompletedAt = null, groupsCompleted = 0, lateCostDelayed = false;
  await context.route('**/*', async route => {
    try {
      const url = new URL(route.request().url());
      if (url.origin !== base) return await route.abort();
      const pathname = url.pathname, count = (requests.get(pathname) ?? 0) + 1;
      requests.set(pathname, count);
      if (!starts.has(pathname)) starts.set(pathname, performance.now());
      if (count > 50) { recordError(`request bound exceeded for ${pathname}`); return await route.abort(); }
      const isHeldGroups = scenario.kind === 'timeout' && scenario.held === 'groups' && pathname === groupsPath && count === 2;
      const isHeldCost = scenario.kind === 'timeout' && scenario.held === 'cost' && pathname === '/api/workbench/usage' && url.searchParams.get('summary') === 'cost';
      if (isHeldGroups || isHeldCost) {
        heldRequest ??= { pathname, count };
        // Supply no response, not even after the product aborts. Only lifecycle
        // cleanup releases this handler; recovery must come from a later poll.
        await heldGate;
        return await route.abort();
      }
      if (scenario.kind === 'cost-late' && pathname === '/api/workbench/usage' && url.searchParams.get('summary') === 'cost' && !lateCostDelayed) {
        lateCostDelayed = true;
        await pause(2000);
        if (closing) return await route.abort();
        return await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(workbenchAnswer(url, Date.now())) });
      }
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
    const observations = window.__startupGroups = { calls: [], active: {}, maxActive: {}, alerts: [], firstRowAt: null };
    const observer = new MutationObserver(() => {
      const row = document.querySelector('#wb-board .wb-row[data-group]');
      if (observations.firstRowAt === null && row?.getBoundingClientRect().height > 0) observations.firstRowAt = performance.now();
      const alert = document.querySelector('#wb-board > .wb-empty[role="alert"]');
      if (alert && observations.alerts.length < 5 && observations.alerts.at(-1)?.text !== alert.textContent) observations.alerts.push({ text: alert.textContent, at: performance.now() });
    });
    observer.observe(document, { childList: true, subtree: true });
    window.addEventListener('pagehide', () => observer.disconnect(), { once: true });
    window.fetch = function (...args) {
      const url = new URL(typeof args[0] === 'string' ? args[0] : args[0].url, location.href);
      const cost = url.pathname === '/api/workbench/usage' && url.searchParams.get('summary') === 'cost';
      if (url.pathname !== groupsPath && !cost) return fetch(...args);
      const source = cost ? 'cost' : new Error().stack.includes('/wb/shell.js') ? 'board' : 'startup';
      const signal = args[1]?.signal ?? args[0]?.signal;
      const call = { source, started: performance.now(), finished: null, aborted: false };
      observations.calls.push(call);
      observations.active[source] = (observations.active[source] || 0) + 1;
      observations.maxActive[source] = Math.max(observations.maxActive[source] || 0, observations.active[source]);
      return fetch(...args).finally(() => { call.finished = performance.now(); call.aborted = signal?.aborted === true; observations.active[source]--; });
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
  if (scenario.kind === 'cost-late' || (scenario.kind === 'timeout' && scenario.held === 'cost')) {
    await page.waitForFunction(() => window.__startupGroups.calls.some(call => call.source === 'board' && call.finished !== null), null, { timeout: 8500 });
    // A recoupled Promise.allSettled snapshot fails here after one second;
    // checking only after the cost deadline would miss the blank initial board.
    await page.locator('#wb-board .wb-row[data-group]').first().waitFor({ state: 'visible', timeout: 1000 });
    const early = await page.evaluate(() => window.__startupGroups);
    const firstGroups = early.calls.find(call => call.source === 'board');
    assert.ok(early.firstRowAt !== null && early.firstRowAt - firstGroups.finished <= 1000, 'groups render within one second of their first board response without waiting for optional cost');
    assert.equal(early.calls.find(call => call.source === 'cost')?.finished, null, 'groups are visible while the first optional cost response is pending');
    const expense = page.locator('#wb-instance .wb-cost');
    assert.equal(await expense.locator('b').count(), 2);
    for (const value of await expense.locator('b').allTextContents()) assert.equal(value, '—', 'pending optional cost starts blank');
    assert.equal(early.alerts.length, 0);
    console.info('Prompt groups observation:', JSON.stringify({ kind: scenario.kind, responseMs: firstGroups.finished, firstRowMs: early.firstRowAt, lagMs: early.firstRowAt - firstGroups.finished }));
  }
  if (scenario.kind === 'cost-late') {
    await page.waitForFunction(() => [...document.querySelectorAll('#wb-instance .wb-cost b')].map(node => node.textContent).join('|') === '$1.50|$9.20', null, { timeout: 3500 });
    const observations = await page.evaluate(() => window.__startupGroups);
    const cost = observations.calls.find(call => call.source === 'cost');
    assert.ok(lateCostDelayed && cost.finished - cost.started >= 2000, 'the successful optional expense response really arrived late');
    assert.equal(observations.alerts.length, 0, 'late optional expense never produces a board error');
    assert.equal(observations.maxActive.cost, 1);
    await page.locator('#wb-board .wb-row[data-group]').first().waitFor({ state: 'visible' });
  } else if (scenario.kind === 'timeout') {
    const loading = page.locator('#wb-board > .wb-empty[role="status"]');
    if (scenario.held === 'groups') {
      await loading.waitFor({ state: 'visible', timeout: 8500 });
      assert.equal(await loading.textContent(), labels['wb.board.loading']);
      assert.equal(await page.locator('.wb-row[data-group]').count(), 0, 'held first board snapshot has not supplied rows');
    }
    assert.ok(heldRequest, 'the intended first board request is actually held');
    const initial = await page.evaluate(() => window.__startupGroups.calls);
    const board = initial.filter(call => call.source === 'board');
    assert.equal(board.length, 1, 'one actual board snapshot request started');
    if (scenario.held === 'groups') {
      assert.equal(heldRequest.count, 2, 'startup observer groups response is not the held board response');
      assert.equal(initial.filter(call => call.source === 'startup').length, 1);
      assert.ok(initial.find(call => call.source === 'startup').finished !== null, 'independent observer startup groups already completed');
      assert.equal(board[0].finished, null, 'the held second groups HTTP request belongs to the board');
    } else {
      assert.equal(initial.filter(call => call.source === 'cost').length, 1);
      assert.equal(initial.find(call => call.source === 'cost').finished, null, 'the first summary=cost request is still held');
    }
    // This bound exceeds the real 30s timeout plus a 5s poll. With no request
    // timeout, the first snapshot/second poll cannot complete and this wait fails.
    try {
      await page.waitForFunction(source => {
        const observations = window.__startupGroups;
        return observations.calls.filter(call => call.source === source).length >= 2 &&
          (source === 'cost' || observations.alerts.length > 0) && document.querySelector('#wb-board .wb-row[data-group]');
      }, scenario.held === 'groups' ? 'board' : 'cost', { timeout: 43000 });
    } catch (error) {
      console.info('Board timeout recovery failure:', JSON.stringify({ heldRequest, heldReleased, errors,
        observations: await page.evaluate(() => window.__startupGroups).catch(() => null) }));
      throw error;
    }
    await page.locator('.wb-row[data-group]').first().waitFor({ state: 'visible' });
    const observations = await page.evaluate(() => window.__startupGroups);
    const source = scenario.held === 'groups' ? 'board' : 'cost';
    const calls = observations.calls.filter(call => call.source === source);
    assert.equal(calls[0].aborted, true, 'the product aborts the unanswered request signal');
    assert.ok(calls[0].finished - calls[0].started >= 29500, 'the real thirty-second budget elapsed without a shortened clock');
    assert.ok(calls[0].finished - calls[0].started <= 35000, 'the unanswered read has a bounded deadline');
    assert.ok(calls[1].started >= calls[0].finished, 'the next poll starts only after the old request settles');
    assert.ok(calls[1].started - calls[0].finished <= 6500, 'the normal five-second polling cadence resumes');
    assert.equal(observations.maxActive[source], 1, 'timeout recovery does not overlap same-purpose requests');
    if (scenario.held === 'groups') {
      assert.equal(observations.alerts[0].text, labels['wb.readFailed'], 'the existing error path renders before recovery');
    } else {
      assert.equal(observations.alerts.length, 0, 'optional cost timeout never shows a board error');
      assert.equal(await page.locator('#wb-board > [role="alert"]').count(), 0);
      assert.ok(!(await page.locator('#wb-attention').innerText()).includes(labels['wb.readFailed']), 'optional cost timeout does not report a data-read failure');
      const expense = page.locator('#wb-instance .wb-cost');
      await expense.waitFor({ state: 'visible' });
      assert.equal(await expense.locator('b').count(), 2, 'technical cost strip renders both today and seven-day values');
      for (const value of await expense.locator('b').allTextContents()) assert.equal(value, '—', 'unavailable cost is blank instead of an invented amount');
      assert.equal(calls[1].finished, null, 'subsequent optional cost request remains unanswered while groups stay visible');
      assert.equal(calls[1].aborted, false, 'the next poll is active within its own request budget');
    }
    assert.equal(heldReleased, false, 'test never released or answered the hung original request');
    assert.equal(await page.locator('#wb-board > .wb-empty').count(), 0, 'successful groups snapshot displays rows without a loading or error placeholder');
    console.info('Board timeout recovery observation:', JSON.stringify({ held: scenario.held, heldRequest, observations }));
  } else if (scenario.kind === 'parallel') {
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
