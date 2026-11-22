import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { createScheduleRead, scheduleReadResponse } from '../../src/lib/workbench/schedule-read.js';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';
import { listErrorBody } from '../../src/lib/list-query.js';
import { populateSchedulePagination, SHARED_NEEDLE, listOrder, pickerGroupPage, pickerGroups, pickerSnapshotRows,
  populateTargetGroupTasks, TARGET_GROUP } from '../fixtures/schedule-pagination.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));

export async function runSchedulePaginationBrowser(t, sandbox) {
  const schedulerDir = path.join(sandbox.paths.zylos, 'scheduler');
  fs.mkdirSync(schedulerDir);
  const dbFile = path.join(schedulerDir, 'scheduler.db');
  const proof = { databases: [sandbox.paths.c4Db, sandbox.paths.dashboardDb, dbFile] };
  console.log('Schedule browser isolation:', JSON.stringify(sandbox.assertIsolation(proof)));
  const db = sandbox.openDatabase(dbFile, filename => new Database(filename), proof);
  const fixture = populateSchedulePagination(db);
  const groups = pickerGroups(fixture.now);
  const reader = createScheduleRead({ zylosDir: sandbox.paths.zylos, scheduleTz: async () => ({ tz: 'UTC' }),
    getSnapshot: async () => ({ rows: pickerSnapshotRows(groups) }),
    displayNames: { listAll: () => new Map(groups.map(group => [group.id, { displayName: group.displayName }])) } });
  const reads = [];
  // A Dashboard restart changes the cursor key. Here each cursor sent out carries the fixture's epoch; after
  // restart() a cursor of an earlier epoch is altered on arrival, so the real route refuses it with invalid_cursor.
  let epoch = 1;
  const restart = () => { epoch++; };
  let writeCount = 0, firstWrite = null;
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.apiPath = url.pathname;
      if (url.pathname.startsWith('/api/schedules')) {
        if (req.method === 'GET') {
          if (reads.length < 1000) reads.push(url.pathname + url.search);
          if (url.searchParams.has('cursor')) {
            const [issued, cursor] = url.searchParams.get('cursor').split('~');
            url.searchParams.set('cursor', Number(issued) === epoch ? cursor : `${cursor}x`);
          }
          const value = await scheduleReadResponse(reader, url.pathname, url.searchParams);
          if (value?.nextCursor) value.nextCursor = `${epoch}~${value.nextCursor}`;
          return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
        }
        writeCount++;
        firstWrite ??= `${req.method} ${url.pathname}`.slice(0, 300);
        req.resume();
        return sendJson(res, 405, { error: 'read_only_fixture' });
      }
      if (url.pathname === '/api/groups') {
        if (reads.length < 1000) reads.push(url.pathname + url.search);
        return sendJson(res, 200, pickerGroupPage(groups, url));
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
    } catch (error) { sendJson(res, error.statusCode ?? 500, error.statusCode ? listErrorBody(error) : { error: 'internal_error' }); }
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
        const rowCount = count => page.waitForFunction(n => document.querySelectorAll('.wb-sched-row').length === n, count);
        const more = page.getByRole('button', { name: '加载更多', exact: true });
        const loadMore = async count => { await more.scrollIntoViewIfNeeded(); await more.click(); await rowCount(count); };
        await rows.first().waitFor();
        assert.equal(await rows.count(), 50);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.equal(await page.locator('.wb-sched-filters select').count(), 0, 'no target filter over loaded rows');
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
        // All: 50 per page in the documented section order, no repeats or gaps; a later page continues its section.
        await loadMore(100);
        await loadMore(120);
        assert.equal(await more.count(), 0);
        assert.deepEqual(await rows.locator('.wb-sched-title').allTextContents(), listOrder(fixture.rows).map(row => row.name));
        assert.equal(await page.locator('.wb-sched-section').count(), 3);
        assert.equal((await filters.locator('.wb-n').allTextContents()).join(','), counts.join(','));
        assert.equal(await page.locator('.wb-sched-kpi').textContent(), kpi);
        assert.equal(await page.locator('.wb-sched-dot').count(), dots);
        await page.evaluate(() => scrollTo(0, 0));
        // q matches names only: a word only in the prompt finds nothing, part of a name finds every match.
        const search = page.getByRole('searchbox', { name: '搜索任务名' });
        await search.fill(SHARED_NEEDLE);
        await search.dispatchEvent('change');
        await rowCount(0);
        await page.locator('.wb-sched-empty').waitFor();
        await search.fill('已完成任务');
        await search.dispatchEvent('change');
        await rowCount(50);
        await loadMore(100);
        await loadMore(101);
        assert.equal(new Set(await rows.locator('.wb-sched-title').allTextContents()).size, 101);
        assert.equal((await filters.locator('.wb-n').allTextContents()).join(','), counts.join(','));
        assert.equal(await page.locator('.wb-sched-kpi').textContent(), kpi);
        assert.equal(await band.count(), 1);
        assert.equal(await page.locator('.wb-sched-dot').count(), dots);
        await search.fill('');
        await search.dispatchEvent('change');
        await rowCount(50);
        await filters.getByRole('button', { name: /^已送达/ }).click();
        await rowCount(50);
        await loadMore(100);
        const names = await rows.locator('.wb-sched-title').allTextContents();
        assert.equal(new Set(names).size, 100);
        assert.ok(names.every(name => name.startsWith('已完成任务')));
        await more.scrollIntoViewIfNeeded();
        const moreBox = await more.boundingBox();
        assert.equal(Math.round(moreBox.x), 16, 'load more aligns with the list content');
        if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-completed-more.png`) });
        // After a restart the next cursor is refused; the page reloads from the first page without an error.
        restart();
        await loadMore(101);
        assert.equal(await page.locator('.wb-sched-note', { hasText: '数据读取失败' }).count(), 0);
        assert.equal(new Set(await rows.locator('.wb-sched-title').allTextContents()).size, 101);
        await search.fill('已完成任务 101');
        await search.dispatchEvent('change');
        await rowCount(1);
        assert.match(await rows.first().textContent(), /已完成任务 101/);
        assert.doesNotMatch(await rows.first().textContent(), /schedule-fulltext-tail/);
        await rows.first().locator('.wb-sched-select').click();
        await page.waitForFunction(() => document.querySelector('.wb-sched-prompt')?.textContent.includes('schedule-fulltext-tail'));
        assert.equal(await page.locator('.wb-sched-prompt').textContent(), fixture.prompt);
        await page.getByRole('button', { name: '编辑', exact: true }).click();
        assert.equal(await page.locator('.wb-sched-side textarea').inputValue(), fixture.prompt);
        await page.locator('.wb-sched-side [data-kind="cron"]').click();
        const rule = page.locator('.wb-sched-side input[type="text"]').last();
        const invalidPreview = page.waitForResponse(response => new URL(response.url()).pathname === '/api/schedules/preview' && response.status() === 400);
        await rule.fill('invalid-rule');
        const rejected = await invalidPreview;
        const payload = await rejected.json();
        assert.equal(typeof payload.error.code, 'string');
        assert.equal(typeof payload.error.message, 'string');
        await page.waitForFunction(() => document.querySelector('.wb-sched-side button[type="submit"]')?.disabled === true);
        assert.equal(await page.locator('.wb-sched-preview').textContent(), '规则写错了');
        if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-schedule-invalid-preview.png`) });
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
  // A group whose tasks all come after the third page: the picker lists the recently active groups, finds the
  // group by name, and choosing it fills the first page with that group's tasks only, paged without gaps.
  const added = populateTargetGroupTasks(db, fixture);
  const order = listOrder([...fixture.rows, ...added]);
  assert.equal(order.length, 205);
  assert.ok(order.findIndex(row => row.group === TARGET_GROUP.id) >= 150, 'the group\'s tasks start after page three');
  const groupNames = order.filter(row => row.group === TARGET_GROUP.id).map(row => row.name);
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await t.test(`${width}px ${theme} target group picker`, async () => {
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
        const titles = () => rows.locator('.wb-sched-title').allTextContents();
        const rowCount = count => page.waitForFunction(n => document.querySelectorAll('.wb-sched-row').length === n, count);
        const more = page.getByRole('button', { name: '加载更多', exact: true });
        await rows.first().waitFor();
        assert.equal((await titles()).some(name => name.startsWith('X 组任务')), false);
        const picker = page.getByRole('searchbox', { name: '全部目标组' });
        const options = page.locator('.wb-sched-picker-item');
        await picker.focus();
        assert.equal(await page.locator('.wb-sched-picker-list').isVisible(), false, 'focus alone does not open the choices');
        // No input: "All target groups", Origin, then the seven most recently active groups.
        await picker.click();
        await page.waitForFunction(() => document.querySelectorAll('.wb-sched-picker-item').length === 9);
        assert.deepEqual(await options.allTextContents(), ['全部目标组', 'Origin', ...groups.slice(1, 8).map(group => group.displayName)]);
        assert.ok(reads.includes('/api/groups?limit=8'));
        if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-picker-recent.png`) });
        await picker.fill('项目 X');
        await page.waitForFunction(() => [...document.querySelectorAll('.wb-sched-picker-item')].map(node => node.textContent).join('|') === '全部目标组|项目 X 群');
        assert.ok(reads.includes(`/api/groups?limit=8&q=${encodeURIComponent('项目 X').replace(/%20/g, '+')}`));
        await options.filter({ hasText: '项目 X 群' }).click();
        await rowCount(50);
        assert.equal(await picker.inputValue(), '项目 X 群');
        assert.deepEqual(await titles(), groupNames.slice(0, 50));
        assert.ok(reads.some(url => url === `/api/schedules?target=${encodeURIComponent(TARGET_GROUP.id)}`));
        if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-picker-group.png`) });
        await more.scrollIntoViewIfNeeded();
        await more.click();
        await rowCount(55);
        assert.deepEqual(await titles(), groupNames, 'every task of the group once, in list order');
        assert.equal(await more.count(), 0);
        assert.ok(reads.some(url => url.startsWith(`/api/schedules?target=${encodeURIComponent(TARGET_GROUP.id)}&cursor=`)));
        // "All target groups" lists every task again.
        await page.evaluate(() => scrollTo(0, 0));
        await picker.click();
        await options.first().waitFor();
        await options.first().click();
        await rowCount(50);
        assert.equal(await picker.inputValue(), '');
        assert.deepEqual(await titles(), order.slice(0, 50).map(row => row.name));
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, 'page fits viewport');
        assert.equal(errors.length, 0, errors.join('\n'));
      } catch (error) {
        failed = true;
        console.log('Schedule picker failure:', JSON.stringify({ errors, reads, text: (await page?.locator('body').textContent())?.slice(0, 2000) }));
        if (evidence && page) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-picker-failure.png`) });
        throw error;
      }
      finally { await context.close(); }
    });
    if (failed) return;
  }
  assert.equal(writeCount, 0, firstWrite ?? 'no writes');
  assert.ok(reads.some(url => url.includes('cursor=')));
  assert.ok(reads.some(url => url.includes(`q=${encodeURIComponent(SHARED_NEEDLE)}`)));
  assert.ok(reads.some(url => url.endsWith('/completed-100')));
}
