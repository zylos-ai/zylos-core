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
    const authorized = await fetch(endpoint, { headers: { Cookie: 'host-test=owner' } });
    assert.match((await authorized.json()).relationships[0].attached_at, /T.*Z$/);
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { Cookie: 'host-test=owner', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);

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
        const panel = page.locator('#settings-session-hosts');
        await panel.getByText(locale === 'en' ? 'Session hosting' : '会话托管', { exact: true }).waitFor();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
        assert.equal(await panel.locator('input').evaluate(input => Math.round(input.getBoundingClientRect().height)), width === 390 ? 36 : 30);
        assert.match(await panel.textContent(), /origin/);
        if (evidence) await panel.screenshot({ path: path.join(evidence, `host-${width}-${locale}-${theme}.png`) });
        if (width === 390 && locale === 'zh' && theme === 'dark') {
          await panel.locator('.wb-host-row').filter({ hasText: 'issue-existing' }).getByRole('button', { name: '解除', exact: true }).click();
          await panel.locator('.wb-host-row').filter({ hasText: 'issue-existing' }).waitFor({ state: 'detached' });
          await panel.getByRole('textbox', { name: '通道名称' }).fill('multica');
          await panel.getByRole('button', { name: '加入白名单' }).click();
          await panel.getByRole('button', { name: '移除' }).click();
          await panel.getByText('没有免通知的通道。').waitFor();
        }
      } finally { await context.close(); }
    }
    assert.equal(store.getSessionHost(source), null);
    assert.deepEqual(notices, [{ channel: 'multica', allowed: true }, { channel: 'multica', allowed: false }]);
  }, { timeoutMs: 110_000 });
});
