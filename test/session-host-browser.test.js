import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic } from '../skills/dashboard/src/lib/http.js';
import { createSessionHostRoutes } from '../skills/dashboard/src/lib/session-host-routes.js';
import { workbenchAnswer } from '../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';
import Database from '../skills/comm-bridge/scripts/sqlite-driver.js';
import { createStore } from '../skills/comm-bridge/scripts/c4-v2-store.js';
import { guardDatabase } from '../skills/comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../skills/comm-bridge/scripts/c4-schema.js';

const publicDir = path.resolve(fileURLToPath(new URL('../skills/dashboard/public/', import.meta.url)));
const source = 'multica:issue-existing';
const longGroup = 'telegram:group-topic-with-a-long-key-' + 'x'.repeat(50);

// Real settings code, route, and hosting store with a private C4 database and fixture login.
// Run when hosting controls, layout, API behavior or shared settings wiring change. Skip for
// unrelated C4 internals. The browser is blocked from non-loopback requests and the harness
// proves HOME, ZYLOS_DIR, PM2_HOME, TMPDIR, socket and database paths and reaps resources.
test('the owner can manage session hosting at desktop and phone widths', {
  skip: !chatEnabled(), timeout: 120_000,
}, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    const database = sandbox.openDatabase(sandbox.paths.c4Db, file => new Database(file));
    guardDatabase(database, schema);
    const store = createStore(database, {
      readSessionMode: () => ({ mode: 'multi' }),
      validateComponent: channel => ['multica', 'telegram'].includes(channel),
    });
    store.attachSessionHost(source, longGroup, 'origin');
    const insert = database.prepare('INSERT INTO session_hosts VALUES (?, ?, ?, ?)');
    for (let i = 1; i <= 59; i++) {
      const id = String(i).padStart(2, '0');
      const sourceGroup = i === 59 ? 'telegram:Source-59' : `telegram:source-${id}`;
      const targetGroup = i >= 51 && i <= 58 ? `multica:batch-target-${id}` : `multica:target-${id}`;
      insert.run(sourceGroup, targetGroup, 'origin', 1760000000);
    }
    database.prepare('INSERT OR IGNORE INTO channel_namespaces (namespace, component_name) VALUES (?, ?)').run('multica', 'multica');
    const notices = [];

    const route = createSessionHostRoutes({
      auth: { resolveAuthContext: req => req.headers.cookie === 'host-test=owner'
        ? { kind: 'cookie', scope: 'admin' } : { kind: 'api', scope: 'admin' } },
      loadStore: async () => store,
      notifyAllowlist: (channel, allowed) => notices.push({ channel, allowed }),
    });
    const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
      .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin');
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        res.apiPath = url.pathname;
        if (await route(req, res, url)) return;
        if (url.pathname === '/settings') { sendHtml(res, 200, index); return; }
        if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
        if (url.pathname.startsWith('/api/')) {
          const answer = workbenchAnswer(url, Date.now());
          sendJson(res, answer === undefined ? 404 : 200, answer ?? { error: 'not_found' }); return;
        }
        if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
      } catch (error) { sendJson(res, 500, { error: error.message }); }
    });
    const base = await sandbox.startHttp(server);
    const endpoint = base + '/api/session-hosts';
    assert.equal((await fetch(endpoint)).status, 403, 'An admin API key is insufficient');
    const headers = { Cookie: 'host-test=owner' };
    async function get(search, status = 200) {
      const response = await fetch(endpoint + search, { headers });
      assert.equal(response.status, status);
      return response.json();
    }
    const keys = [];
    let cursor = null;
    for (let page = 0; page < 8; page++) {
      const params = new URLSearchParams({ limit: '8', include: 'total' });
      if (cursor) params.set('cursor', cursor);
      const result = await get('?' + params);
      assert.equal(result.total, 60);
      assert.equal(result.items.length, page === 7 ? 4 : 8);
      assert.match(result.items[0].attached_at, /T.*Z$/);
      keys.push(...result.items.map(row => row.source_group));
      cursor = result.nextCursor;
    }
    assert.equal(cursor, null);
    assert.equal(new Set(keys).size, 60);
    assert.deepEqual(keys, [...keys].sort());
    for (const search of ['SOURCE-59', 'target-59']) {
      const match = await get('?q=' + search);
      assert.deepEqual(match.items.map(row => row.source_group), ['telegram:Source-59']);
      assert.equal(Object.hasOwn(match, 'total'), false);
    }
    const exactPage = await get('?q=batch-target-&limit=8');
    assert.equal(exactPage.items.length, 8);
    assert.equal(exactPage.nextCursor, null);
    for (const [params, param] of [['extra=1', 'extra'], ['q=one&q=two', 'q'], ['limit=0', 'limit']]) {
      const response = await get('?' + params, 400);
      assert.equal(response.error.code, 'invalid_parameter');
      assert.equal(response.error.param, param);
    }
    assert.equal((await get('?cursor=bad', 400)).error.code, 'invalid_cursor');
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

    const browserModule = process.env.ZYLOS_CHAT_BROWSER_MODULE;
    const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
    assert.ok(browserModule && fs.existsSync(browserModule), 'A local Playwright module is required');
    assert.ok(executablePath && fs.existsSync(executablePath), 'A local Chromium binary is required');
    const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
    if (evidence) fs.mkdirSync(evidence, { recursive: true });
    console.log('Session hosting browser launch:', JSON.stringify({ isolation: sandbox.assertIsolation(), browserModule, executablePath }));
    const { chromium } = await import(pathToFileURL(browserModule));
    const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    for (const width of [1280, 390]) for (const locale of ['en', 'zh']) for (const theme of ['light', 'dark']) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width === 390, hasTouch: width === 390 });
      sandbox.addCleanup(() => context.close());
      try {
        await context.addCookies([{ name: 'host-test', value: 'owner', url: base }]);
        await context.route('**/*', request => request.request().url().startsWith(base + '/') ? request.continue() : request.abort());
        await context.addInitScript(({ locale, theme }) => {
          localStorage.setItem('zylos-dashboard-locale', locale);
          localStorage.setItem('zylos-dashboard-theme', theme);
        }, { locale, theme });
        const page = await context.newPage();
        page.setDefaultTimeout(8000);
        await page.goto(base + '/settings');
        // Session hosting is about the whole machine: it sits in the machine section, available in the section list on a phone.
        await page.locator('[data-settings-section="machine"]').click();
        const panel = page.locator('#settings-session-hosts');
        await panel.getByText(locale === 'en' ? 'Session hosting' : '会话托管', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.equal(await panel.locator('.wb-host-allow input').evaluate(input => Math.round(input.getBoundingClientRect().height)), width === 390 ? 36 : 30);
        assert.match(await panel.textContent(), /origin/);
        if (evidence) {
          const screenshot = path.join(evidence, `host-${width}-${locale}-${theme}.png`);
          if (width === 390) {
            await panel.locator('#settings-host-relationships input[type=search]').scrollIntoViewIfNeeded();
            await page.screenshot({ path: screenshot });
          } else await panel.screenshot({ path: screenshot });
        }
        if (width === 390 && locale === 'zh' && theme === 'dark') {
          const relationships = panel.locator('#settings-host-relationships');
          await relationships.locator('.wb-plist-next').click();
          await relationships.locator('.wb-host-row').filter({ hasText: 'source-07' }).waitFor();
          const search = relationships.locator('input[type=search]');
          for (const q of ['source-59', 'target-59']) {
            await search.fill(q);
            await relationships.locator('.wb-host-row').filter({ hasText: 'Source-59' }).waitFor();
            assert.equal(await relationships.locator('.wb-host-row').count(), 1);
          }
          await search.fill('');
          await panel.locator('.wb-host-row').filter({ hasText: 'issue-existing' }).getByRole('button', { name: '解除', exact: true }).click();
          // Detaching asks first, titled with the action.
          const dialog = page.locator('.wb-modal[role="alertdialog"]');
          assert.equal(await dialog.locator('h3').textContent(), '解除会话托管');
          await dialog.locator('.wb-modal-acts button').last().click();
          await panel.locator('.wb-host-row').filter({ hasText: 'issue-existing' }).waitFor({ state: 'detached' });
          // Channels are picked from the ones this machine has registered.
          await panel.getByRole('combobox', { name: '通道名称' }).click();
          await panel.getByRole('option', { name: 'multica', exact: true }).click();
          await panel.getByRole('button', { name: '加入白名单' }).click();
          // A channel's × removes it at once, without a question.
          await panel.getByRole('button', { name: '移除 multica', exact: true }).click();
          assert.equal(await page.locator('.wb-modal[role="alertdialog"]').count(), 0);
          await panel.getByText('没有免通知的通道。').waitFor();
        }
      } finally { await context.close(); }
    }
    assert.equal(store.getSessionHost(source), null);
    assert.deepEqual(notices, [{ channel: 'multica', allowed: true }, { channel: 'multica', allowed: false }]);
  }, { timeoutMs: 110_000 });
});
