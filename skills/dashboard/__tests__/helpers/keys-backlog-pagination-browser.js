import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Store } from '../../src/lib/store.js';
import { hashApiKey } from '../../src/lib/auth.js';
import { apiKeysPage } from '../../src/lib/api-key-list.js';
import { createMemoryBacklog, memoryBacklogPage, parseBacklogQuery } from '../../src/lib/workbench/memory-backlog.js';
import { sendHtml, sendJson, serveStatic } from '../../src/lib/http.js';
import { listErrorBody } from '../../src/lib/list-query.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';
import { openDashboardTab } from './browser-navigation.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const pad = index => String(index).padStart(3, '0');

// 70 keys an hour apart, every third one revoked.
function populateKeys(store) {
  for (let index = 1; index <= 70; index++) store.insertApiKey({ name: `key-${pad(index)}`, keyHash: hashApiKey(`fixture-${index}`), scope: index % 4 ? 'read' : 'admin' });
  store.db.prepare("UPDATE api_keys SET created_at = datetime('2026-10-01 00:00:00', '+' || id || ' hours')").run();
  for (let index = 3; index <= 70; index += 3) store.revokeApiKey(`key-${pad(index)}`);
  return store.db.prepare('SELECT name FROM api_keys ORDER BY (revoked_at IS NOT NULL), created_at DESC, id DESC').all().map(row => row.name);
}

// 120 groups: 70 with something pending (every tenth waiting over six hours), 50 with nothing pending.
function backlogGroups(now) {
  const values = new Map();
  for (let index = 1; index <= 120; index++) {
    const pending = index <= 70, aged = pending && index % 10 === 0;
    values.set(`telegram:dm-${pad(index)}`, pending
      ? { count: index % 23 + 1, firstAt: new Date(now - (aged ? 8 : 1) * 3600e3 - index * 1000).toISOString(), syncing: false }
      : { count: 0, firstAt: null, syncing: false });
  }
  return values;
}

export async function runKeysBacklogPaginationBrowser(t, sandbox) {
  const dbFile = sandbox.paths.dashboardDb;
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  const proof = { databases: [sandbox.paths.c4Db, dbFile] };
  console.log('Keys and backlog browser isolation:', JSON.stringify(sandbox.assertIsolation(proof)));
  const store = sandbox.openDatabase(dbFile, filename => new Store(filename), proof);
  const expectedKeys = populateKeys(store);
  const groups = backlogGroups(Date.now());
  const readBacklog = createMemoryBacklog({ zylosDir: sandbox.paths.zylos, readConfig: async () => ({}), env: {},
    getSnapshot: async () => ({ view: 'single', rows: [...groups.keys()].map(sessionGroup => ({ sessionGroup, name: { displayName: null } })), hasOlder: false }),
    groupBacklog: async group => groups.get(group) });
  const reads = [];
  // A Dashboard restart changes the cursor key. Each cursor sent out carries the fixture's epoch; after restart()
  // a cursor of an earlier epoch is altered on arrival, so the real list code refuses it with invalid_cursor.
  let epoch = 1, writeCount = 0;
  const restart = () => { epoch++; };
  const paged = async (url, answer) => {
    if (url.searchParams.has('cursor')) {
      const [issued, cursor] = url.searchParams.get('cursor').split('~');
      url.searchParams.set('cursor', Number(issued) === epoch ? cursor : `${cursor}x`);
    }
    const value = await answer(url.searchParams);
    if (value.nextCursor) value.nextCursor = `${epoch}~${value.nextCursor}`;
    return value;
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.apiPath = url.pathname;
      if (url.pathname === '/api/keys' || url.pathname === '/api/memory/backlog') {
        if (req.method !== 'GET') { writeCount++; req.resume(); return sendJson(res, 405, { error: 'read_only_fixture' }); }
        if (reads.length < 200) reads.push(url.pathname + url.search);
        const value = await paged(url, url.pathname === '/api/keys' ? params => apiKeysPage(store, params)
          : async params => memoryBacklogPage(await readBacklog(), parseBacklogQuery(params)));
        return sendJson(res, 200, value);
      }
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (url.pathname.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now());
        return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
      }
      if (['/', '/settings', '/memory'].includes(url.pathname)) {
        return sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
          .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin'));
      }
      if (url.pathname === '/_assets/vendor/chart.umd.js' && process.env.ZYLOS_CHAT_CHART_ASSET) {
        res.writeHead(200, { 'content-type': 'text/javascript' }); fs.createReadStream(process.env.ZYLOS_CHAT_CHART_ASSET).pipe(res); return;
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
  const until = async (read, check, message) => {
    let value;
    for (const end = Date.now() + 8000; !check(value = await read()) && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(check(value), `${message}: ${JSON.stringify(value)?.slice(0, 600)}`);
    return value;
  };
  let failed = false;
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) for (const locale of ['zh', 'en']) {
    await t.test(`${width}px ${theme} ${locale}: keys and backlog page through the server`, async () => {
      const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US',
        timezoneId: 'UTC', colorScheme: theme, ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
      sandbox.addCleanup(() => context.close());
      let page;
      const errors = [];
      // The whole card, pager and fold included, however far it reaches below the screen.
      const shot = async (name, target) => { if (evidence) await target.screenshot({ path: path.join(evidence, `${width}-${theme}-${locale}-${name}.png`) }); };
      try {
        await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
        await context.addInitScript(({ theme, locale }) => {
          if (window.top !== window) return;
          localStorage.setItem('zylos-dashboard-locale', locale);
          localStorage.setItem('zylos-dashboard-detail-level', 'technical');
          localStorage.setItem('zylos-dashboard-theme', theme);
        }, { theme, locale });
        page = await context.newPage();
        page.setDefaultTimeout(12_000);
        page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });

        // S1: 70 keys, eight a page, forward to the end and back to the start, none repeated or missed.
        await page.goto(base + '/settings');
        if (!(await page.locator('#settings-section-account').isVisible())) {
          const back = page.locator('.wb-set-back:visible');
          if (await back.isVisible()) await back.click();
          await page.locator('[data-settings-section="account"]').click();
        }
        const keyRows = () => page.locator('#api-key-list tbody tr').evaluateAll(rows => rows.map(row => row.children[0].textContent));
        const keyCard = page.locator('#api-key-list').locator('xpath=ancestor-or-self::*[contains(concat(" ", @class, " "), " wb-set-card ")][1]');
        const pager = keyCard.locator('.wb-plist-pager'), at = pager.locator('.wb-plist-at');
        const pageNumbers = async () => (await at.textContent()).match(/\d+/g).map(Number);
        const first = await until(keyRows, rows => rows.length === 8, 'eight keys on the first page');
        assert.deepEqual(first, expectedKeys.slice(0, 8), 'active keys first, newest first');
        assert.match(await keyCard.locator('.wb-set-card-sub').allTextContents().then(texts => texts.join(' ')), /47\D+23/, 'the header counts every key');
        assert.deepEqual(await pageNumbers(), [1, 9]);
        await shot('keys-first', keyCard);
        const forward = [first];
        for (let number = 2; number <= 9; number++) {
          const before = forward.at(-1);
          await pager.locator('.wb-plist-next').click();
          forward.push(await until(keyRows, rows => rows.length && rows[0] !== before[0], `page ${number}`));
          assert.deepEqual(await pageNumbers(), [number, 9]);
        }
        assert.deepEqual(forward.flat(), expectedKeys, 'all 70 keys once each, in the server order');
        assert.equal(await pager.locator('.wb-plist-next').isDisabled(), true);
        await shot('keys-last', keyCard);
        for (let number = 8; number >= 1; number--) {
          await pager.locator('.wb-plist-prev').click();
          assert.deepEqual(await until(keyRows, rows => rows[0] === forward[number - 1][0], `back to page ${number}`), forward[number - 1]);
        }
        // S3: a restart between pages reads the first page again without an error.
        await pager.locator('.wb-plist-next').click();
        await until(keyRows, rows => rows[0] === forward[1][0], 'page 2');
        restart();
        await pager.locator('.wb-plist-next').click();
        assert.deepEqual(await until(keyRows, rows => rows[0] === forward[0][0], 'the first page again after a restart'), forward[0]);
        assert.deepEqual(await pageNumbers(), [1, 9]);
        assert.equal(await page.locator('#fleet-manage-status.wb-status-error:visible').count(), 0, 'no error is shown');
        // The search goes to the server: key-01 matches key-010 to key-019.
        const search = keyCard.locator('.wb-plist-search input');
        await search.fill('KEY-01');
        const found = await until(keyRows, rows => rows.length === 8 && rows.every(name => name.startsWith('key-01')), 'the search results');
        await pager.locator('.wb-plist-next').click();
        const rest = await until(keyRows, rows => rows.length === 2, 'the second page of results');
        assert.deepEqual([...found, ...rest].sort(), Array.from({ length: 10 }, (_, i) => `key-01${i}`));
        await search.fill('nothing-like-this');
        await keyCard.locator('.wb-plist-empty:visible').waitFor();
        await shot('keys-no-match', keyCard);
        await search.fill('');
        await until(keyRows, rows => rows[0] === forward[0][0], 'the full list again');

        // S2: 120 groups, 50 a request; the quiet ones fold under one line with the server's count.
        await openDashboardTab(page, 'memory');
        const card = page.locator('.wb-memory-progress');
        const backlogRows = () => card.locator('.wb-memory-bl').evaluateAll(rows => rows.map(row => row.querySelector('.wb-memory-chart-label')?.textContent ?? ''));
        await until(backlogRows, rows => rows.length === 50, 'fifty groups first');
        const fold = card.locator('.wb-memory-rest');
        assert.match(await fold.locator('summary').textContent(), /50/, 'the fold counts every quiet group');
        assert.equal(await fold.evaluate(node => node.open), false);
        await shot('backlog-first', card);
        // S3 for the backlog: a refused cursor reads the first page again, silently.
        restart();
        await card.locator('.wb-memory-more').first().click();
        await until(() => reads.filter(url => url.startsWith('/api/memory/backlog') && !url.includes('cursor')).length, count => count >= 2, 'the first page is read again');
        await until(backlogRows, rows => rows.length === 50, 'fifty groups again');
        await card.locator('.wb-memory-more').first().click();
        await until(backlogRows, rows => rows.length === 100, 'the next fifty: the last 20 needing a look, then 30 quiet in the fold');
        assert.equal(await card.locator(':scope > .wb-memory-rows > .wb-memory-more').count(), 0, 'every group needing a look is loaded');
        await fold.locator('summary').click();
        await fold.locator('.wb-memory-more').click();
        await until(backlogRows, rows => rows.length === 120, 'all 120 groups');
        assert.equal(await card.locator('.wb-memory-more').count(), 0, 'nothing left to load');
        await shot('backlog-all', card);
        // The search goes to the server: dm-11 matches dm-110 to dm-119, unfolded.
        await card.locator('.wb-memory-gfilter input').fill('dm-11');
        await until(() => card.locator('.wb-memory-bl').count(), count => count === 10, 'ten matching groups');
        assert.equal(await card.locator('.wb-memory-rest').count(), 0, 'a search shows the matches unfolded');
        await card.locator('.wb-memory-gfilter input').fill('');
        // The fold opened above stays open, so after the first page it reads one more page, which brings the
        // first quiet groups into the fold; the remaining quiet groups wait behind the fold's own load-more.
        await until(backlogRows, rows => rows.length === 100 && new Set(rows).size === 100, 'the first page again, then the open fold given its first quiet groups');
        assert.equal(await fold.locator('.wb-memory-more').count(), 1, 'the rest of the fold waits behind its own load-more');
        assert.equal(errors.length, 0, errors.join('\n'));
      } catch (error) {
        failed = true;
        console.log('Keys and backlog browser failure:', JSON.stringify({ errors, reads: reads.slice(-20), text: (await page?.locator('body').textContent())?.slice(0, 2000) }));
        if (evidence && page) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-${locale}-failure.png`) });
        throw error;
      } finally { await context.close(); }
    });
    if (failed) return;
  }
  assert.equal(writeCount, 0, 'no writes');
  // S4 in the browser's terms: the pages never send an unknown or repeated parameter.
  for (const url of reads) {
    const params = new URL(url, 'http://x').searchParams, keys = [...params.keys()];
    assert.equal(new Set(keys).size, keys.length, url);
    assert.ok(keys.every(key => ['q', 'cursor', 'limit', 'include'].includes(key)), url);
  }
}
