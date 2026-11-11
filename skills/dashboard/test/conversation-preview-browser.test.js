import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture } from './helpers/chat-integration-api.js';
import { sendJson } from '../src/lib/http.js';

// Boundary: actual Dashboard entry/list, authenticated HTTP history routes and private C4/dashboard SQLite.
// Run for conversation-list preview direction/copy changes; skip unrelated runtime/backend changes.
// The opt-in official runner and sandbox prove private HOME/ZYLOS_DIR/PM2_HOME/short TMPDIR/socket/DB paths.
// Browser/HTTP/DB allocations are owned by the sandbox on pass/failure/timeout; no model, PM2 or tmux starts.
// Browser requests may only reach this case's localhost server; no live channel or database is used.
test('conversation list previews distinguish received and sent external messages', { skip: !chatEnabled(), timeout: 120000 }, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    console.info('Preview browser private targets:', JSON.stringify(sandbox.assertIsolation()));
    const fixture = await createChatApiFixture(t, sandbox, { name: 'Preview fixture', extraHandler(req, res, url, f) {
      if (!url.pathname.startsWith('/api/')) return false;
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
      const values = {
        '/api/session-mode': { data: { sessionMode: f.readMode() } },
        '/api/state': { state: 'idle', runtime: 'claude', session_mode: f.readMode(), agent: { id: 'test', name: 'Private browser' }, runtime_info: {} },
        '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' }, '/api/communication': {}, '/api/summary': {},
        '/api/timeline': { items: [] }, '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] },
      };
      sendJson(res, 200, values[url.pathname] || {}); return true;
    } });
    const mineIn = await fixture.createConversation('我的来信预览');
    const mineOut = await fixture.createConversation('之前的来信');
    fixture.addOutbound(mineOut.draft.localId, '我的发出预览');
    fixture.store.writeGroupDisplayName(`${mineIn.receipt.namespace}:${mineIn.draft.localId}`, '我的来信', 'human');
    fixture.store.writeGroupDisplayName(`${mineOut.receipt.namespace}:${mineOut.draft.localId}`, '我的发出', 'human');
    const externalIn = fixture.c4.insertConversation('in', 'telegram', 'preview-in', '外部来信预览', { groupName: 'preview-in' });
    const externalOut = fixture.c4.insertConversation('out', 'telegram', 'preview-out', '外部发出预览', { groupName: 'preview-out' });
    fixture.store.writeGroupDisplayName(externalIn.session_group, '来信会话', 'human');
    fixture.store.writeGroupDisplayName(externalOut.session_group, '发出会话', 'human');
    fixture.db.prepare('UPDATE conversations SET timestamp=?').run('2000-01-01 08:00:00');
    const externalId = item => 'g:' + Buffer.from(item.session_group).toString('hex').toUpperCase();
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const closures = new WeakMap();
    const close = context => {
      if (!closures.has(context)) closures.set(context, (async () => {
        await context.unrouteAll({ behavior: 'ignoreErrors' }); await context.close();
      })());
      return closures.get(context);
    };
    const open = async (width, theme) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
      sandbox.addCleanup(() => close(context));
      await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
      await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
      await context.addInitScript(theme => {
        localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', 'zh');
        localStorage.setItem('zylos-dashboard-detail-level', 'plain');
      }, theme);
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      await page.goto(fixture.base + '/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
      return { context, page };
    };
    const listRow = (page, id) => page.locator(`#wb-chat .conversation-list-item[data-conversation-id="${id}"]`);
    const preview = (page, id) => listRow(page, id).locator('.chat-preview');
    const shot = async (page, name) => {
      await page.evaluate(() => document.fonts.ready);
      if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) await page.locator('#wb-chat .conversation-sidebar').screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `${name}.png`) });
    };
    await t.test('mine incoming and outgoing preview copy remains unchanged', async () => {
      const { context, page } = await open(1280, 'light');
      try {
        assert.equal(await preview(page, mineIn.receipt.conversationId).innerText(), '你：我的来信预览');
        assert.equal(await preview(page, mineOut.receipt.conversationId).innerText(), '我的发出预览');
        await shot(page, 'mine-list-1280-light');
      } finally { await close(context); }
    });
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}: external received and sent previews`, async () => {
      const { context, page } = await open(width, theme);
      try {
        await page.locator('#wb-chat [data-action="external"]').click();
        await listRow(page, externalId(externalIn)).waitFor(); await listRow(page, externalId(externalOut)).waitFor();
        await shot(page, `external-list-${width}-${theme}`);
        assert.equal(await preview(page, externalId(externalIn)).innerText(), '收到：外部来信预览');
        assert.equal(await preview(page, externalId(externalOut)).innerText(), '发出：外部发出预览');
        for (const item of [externalIn, externalOut]) {
          const box = await listRow(page, externalId(item)).boundingBox();
          assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 900, 'both external conversations fit on screen');
        }
      } finally { await close(context); }
    });
    await t.test('automatic polling refreshes the selected external list preview in both directions', async () => {
      const { context, page } = await open(1280, 'light');
      try {
        await page.locator('#wb-chat [data-action="external"]').click();
        await listRow(page, externalId(externalIn)).click();
        await page.locator(`#wb-chat [data-message-id="${externalIn.id}"]`).waitFor();
        for (const [direction, body, expected] of [['out', '刷新后的发出预览', '发出：刷新后的发出预览'], ['in', '刷新后的来信预览', '收到：刷新后的来信预览']]) {
          const added = fixture.c4.insertConversation(direction, 'telegram', 'preview-in', body, { groupName: 'preview-in' });
          await page.locator(`#wb-chat [data-message-id="${added.id}"]`).waitFor();
          assert.equal(await preview(page, externalId(externalIn)).innerText(), expected);
        }
      } finally { await close(context); }
    });
  }, { timeoutMs: 110000 });
});
