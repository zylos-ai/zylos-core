import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { createScheduleRead, scheduleReadResponse } from '../../src/lib/workbench/schedule-read.js';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';
import { populateSchedulePagination, SHARED_NEEDLE } from '../fixtures/schedule-pagination.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));

export async function runSchedulePaginationBrowser(t, sandbox) {
  const schedulerDir = path.join(sandbox.paths.zylos, 'scheduler');
  fs.mkdirSync(schedulerDir);
  const dbFile = path.join(schedulerDir, 'scheduler.db');
  const proof = { databases: [sandbox.paths.c4Db, sandbox.paths.dashboardDb, dbFile] };
  console.log('Schedule browser isolation:', JSON.stringify(sandbox.assertIsolation(proof)));
  const db = sandbox.openDatabase(dbFile, filename => new Database(filename), proof);
  const fixture = populateSchedulePagination(db);
  const reader = createScheduleRead({ zylosDir: sandbox.paths.zylos, scheduleTz: async () => ({ tz: 'UTC' }) });
  const reads = [];
  let writeCount = 0, firstWrite = null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname.startsWith('/api/workbench/schedule')) {
        if (req.method === 'GET') {
          if (reads.length < 100) reads.push(url.pathname + url.search);
          const value = await scheduleReadResponse(reader, url.pathname, url.searchParams);
          return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
        }
        writeCount++;
        firstWrite ??= `${req.method} ${url.pathname}`.slice(0, 300);
        req.resume();
        return sendJson(res, 405, { error: 'read_only_fixture' });
      }
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (url.pathname.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now());
        return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
      }
      if (url.pathname === '/' || url.pathname === '/schedule') {
        return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
          .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
      }
      if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, error.statusCode ?? 500, { error: error.code ?? error.message }); }
  });
  const base = await sandbox.startHttp(server, proof);
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath));
  assert.ok(executablePath && fs.existsSync(executablePath));
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  let failed = false;
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await t.test(`${width}px ${theme} schedule paging and content`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'zh-CN',
        timezoneId: 'UTC', colorScheme: theme, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
      sandbox.addCleanup(() => context.close());
      let page;
      const errors = [];
      try {
        await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
        await context.addInitScript(({ theme }) => {
          if (window.top !== window) return;
          localStorage.setItem('zylos-dashboard-locale', 'zh');
          localStorage.setItem('zylos-dashboard-detail-level', 'plain');
          localStorage.setItem('zylos-dashboard-theme', theme);
        }, { theme });
        page = await context.newPage();
        page.setDefaultTimeout(12_000);
        page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
        await page.goto(base + '/schedule');
        const rows = page.locator('.wb-sched-row');
        await rows.first().waitFor();
        assert.equal(await rows.count(), 19);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        const filters = page.locator('.wb-sched-filters .wb-seg');
        const counts = await filters.locator('.wb-n').allTextContents();
        assert.equal(counts[0], '120');
        assert.equal(counts.at(-1), '101');
        const kpi = await page.locator('.wb-sched-kpi').textContent();
        assert.match(kpi, /1473/);
        const band = page.locator('.wb-sched-band');
        assert.equal(await band.count(), 1);
        assert.equal(await band.isVisible(), true);
        assert.match(await band.getAttribute('aria-label'), /每分钟检查.*1440/);
        const dots = await page.locator('.wb-sched-dot').count();
        assert.equal(dots, 33, 'other tasks keep their exact low-frequency occurrences');
        const dailyDot = page.locator('.wb-sched-dot[title^="每日工作简报 1"]');
        const onceDot = page.locator('.wb-sched-dot[title^="待办事项提醒"]');
        assert.equal(await dailyDot.isVisible(), true);
        assert.equal(await onceDot.isVisible(), true);
        const bandBox = await band.boundingBox();
        for (const dot of [dailyDot, onceDot]) {
          const box = await dot.boundingBox();
          assert.ok(box.y + box.height <= bandBox.y || box.y >= bandBox.y + bandBox.height,
            'the dense band does not cover the low-frequency dots');
        }
        await band.click();
        await page.locator('.wb-sched-detail .wb-d-title', { hasText: '每分钟检查' }).waitFor();
        await page.locator('.wb-sched-close').click();
        await page.evaluate(() => scrollTo(0, 0));
        if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-schedule.png`) });
        const search = page.getByRole('searchbox', { name: '搜索任务' });
        await search.fill(SHARED_NEEDLE);
        await search.dispatchEvent('change');
        await page.waitForFunction(() => document.querySelectorAll('.wb-sched-row').length === 49);
        const activeNames = (await rows.locator('.wb-sched-title').allTextContents()).slice(0, 19);
        assert.ok(activeNames.every(name => !name.startsWith('已完成任务')));
        assert.equal(await rows.filter({ hasText: '已完成任务' }).count(), 30);
        const more = page.getByRole('button', { name: '加载更多', exact: true });
        await more.scrollIntoViewIfNeeded();
        await more.click();
        await page.waitForFunction(() => document.querySelectorAll('.wb-sched-row').length === 79);
        const mixedNames = await rows.locator('.wb-sched-title').allTextContents();
        assert.equal(mixedNames.slice(0, 19).join('\n'), activeNames.join('\n'));
        assert.equal(await rows.filter({ hasText: '已完成任务' }).count(), 60);
        assert.equal(new Set(mixedNames).size, 79, 'combined search preserves active rows and pages completed rows without duplicates');
        assert.equal((await filters.locator('.wb-n').allTextContents()).join(','), counts.join(','));
        assert.equal(await page.locator('.wb-sched-kpi').textContent(), kpi);
        assert.equal(await band.count(), 1);
        assert.equal(await page.locator('.wb-sched-dot').count(), dots);
        await search.fill('');
        await search.dispatchEvent('change');
        await page.waitForFunction(() => document.querySelectorAll('.wb-sched-row').length === 19);
        await filters.getByRole('button', { name: /^已送达/ }).click();
        await page.waitForFunction(() => document.querySelectorAll('.wb-sched-row').length === 30);
        await more.scrollIntoViewIfNeeded();
        await more.click();
        await page.waitForFunction(() => document.querySelectorAll('.wb-sched-row').length === 60);
        assert.equal((await filters.locator('.wb-n').allTextContents()).join(','), counts.join(','));
        assert.equal(await page.locator('.wb-sched-kpi').textContent(), kpi);
        assert.equal(await page.locator('.wb-sched-dot').count(), dots);
        assert.equal(await band.count(), 1);
        const names = await rows.locator('.wb-sched-title').allTextContents();
        assert.equal(new Set(names).size, 60);
        await more.scrollIntoViewIfNeeded();
        const moreBox = await more.boundingBox();
        assert.equal(Math.round(moreBox.x), 16, 'load more aligns with the list content');
        if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-completed-more.png`) });
        await search.fill('schedule-fulltext-tail');
        await search.dispatchEvent('change');
        await page.waitForFunction(() => document.querySelectorAll('.wb-sched-row').length === 1);
        assert.match(await rows.first().textContent(), /已完成任务 101/);
        assert.doesNotMatch(await rows.first().textContent(), /schedule-fulltext-tail/);
        await rows.first().locator('.wb-sched-select').click();
        await page.waitForFunction(() => document.querySelector('.wb-sched-prompt')?.textContent.includes('schedule-fulltext-tail'));
        assert.equal(await page.locator('.wb-sched-prompt').textContent(), fixture.prompt);
        await page.getByRole('button', { name: '编辑', exact: true }).click();
        assert.equal(await page.locator('.wb-sched-side textarea').inputValue(), fixture.prompt);
        await page.getByRole('button', { name: '取消', exact: true }).click();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, 'page fits viewport');
        assert.equal(errors.length, 0, errors.join('\n'));
      } catch (error) {
        failed = true;
        console.log('Schedule browser failure:', JSON.stringify({ errors, reads, text: (await page?.locator('body').textContent())?.slice(0, 2000) }));
        if (evidence && page) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-failure.png`) });
        throw error;
      }
      finally { await context.close(); }
    });
    if (failed) return;
  }
  assert.equal(writeCount, 0, firstWrite ?? 'no writes');
  assert.ok(reads.some(url => url.includes('cursor=')));
  assert.ok(reads.some(url => url.includes('q=schedule-fulltext-tail')));
  assert.ok(reads.some(url => url.endsWith('/completed-100')));
}
