import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic, readJsonBody } from '../../src/lib/http.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const group = 'dashboard:browser-create';
const activeId = 'g:' + Buffer.from(group).toString('hex').toUpperCase();
const draftId = 'd:browser-create';
const title = '研究对话自动命名';

async function startPage(sandbox) {
  let row = null, messages = [];
  const streams = new Set(), writes = [];
  const detail = () => row && ({ id: row.id, localId: 'browser-create', namespace: row.draft ? null : 'dashboard',
    sessionGroup: row.draft ? null : group, displayName: row.display_name, state: row.draft ? 'draft' : 'active', draft: row.draft });
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://fixture'), route = url.pathname;
      if (route === '/api/chat/drafts' && req.method === 'POST') {
        assert.ok(writes.length < 8, 'write evidence is bounded');
        const body = await readJsonBody(req, 4096); writes.push({ route, body });
        row = { id: draftId, localId: 'browser-create', session_group: '', channel: 'dashboard',
          display_name: null, draft: true, state: 'draft', stamp: 2461354, preview: '' };
        sendJson(res, 201, { conversation: detail() }); return;
      }
      if (route === '/api/chat/conversations') {
        sendJson(res, 200, { items: row ? [row] : [], nextCursor: null, tz: 'Asia/Singapore' }); return;
      }
      if (/^\/api\/chat\/conversations\/[^/]+\/send$/.test(route) && req.method === 'POST') {
        assert.ok(writes.length < 8, 'write evidence is bounded');
        const body = await readJsonBody(req, 4096); writes.push({ route, body });
        row = { ...row, id: activeId, session_group: group, draft: false, state: 'active' };
        messages = [{ id: 1, direction: 'in', channel: 'dashboard', status: 'delivered', content: body.content,
          timestamp: '2026-11-11T06:00:00Z' }];
        sendJson(res, 200, { stored: true, conversationId: activeId, localId: 'browser-create', c4Id: 1 }); return;
      }
      if (/^\/api\/chat\/conversations\/[^/]+$/.test(route)) {
        sendJson(res, 200, { conversation: detail(), stored: true, conversationId: row?.id }); return;
      }
      if (/^\/api\/chat\/conversations\/[^/]+\/messages$/.test(route)) {
        sendJson(res, 200, { items: messages, nextCursor: null, afterCursor: messages.length ? 'after-reply' : null,
          tz: 'Asia/Singapore' }); return;
      }
      if (/^\/api\/chat\/conversations\/[^/]+\/(?:questions|activity|status)$/.test(route)) {
        sendJson(res, 200, { items: [], rounds: [], nextCursor: null, afterCursor: null, tz: 'Asia/Singapore' }); return;
      }
      if (route === '/api/stream') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        const stream = { res, tab: url.searchParams.get('chat_tab') || 'mine', conversationId: url.searchParams.get('chat_conversation') };
        streams.add(stream);
        res.write(`event: chat_ready\ndata: ${JSON.stringify({ version: 1, tab: stream.tab, conversationId: stream.conversationId, ids: [] })}\n\n`);
        req.on('close', () => streams.delete(stream)); return;
      }
      if (route.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now());
        sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (['/', '/chat'].includes(route)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
          .replaceAll('__BASE_PATH__', '').replaceAll('__ASSET_ROOT__', '/_assets').replaceAll('__REMOTE_ACCESS__', 'admin')); return;
      }
      if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.message }); }
  });
  return { base: await sandbox.startHttp(server), writes,
    reset() { assert.equal(streams.size, 0, 'previous page streams are closed'); row = null; messages = []; writes.length = 0; },
    completeReplyAndName() {
      row = { ...row, display_name: title, preview: '可以在首次回复后根据上下文命名。', previewDirection: 'out' };
      messages.push({ id: 2, direction: 'out', channel: 'dashboard', status: 'sent', content: row.preview,
        timestamp: '2026-11-11T06:00:03Z' });
      for (const stream of streams) stream.res.write(`event: chat_messages_changed\ndata: ${JSON.stringify({
        version: 1, tab: stream.tab, conversationId: stream.conversationId, ids: [2] })}\n\n`);
    },
  };
}

export async function runConversationCreateBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath)); assert.ok(executablePath && fs.existsSync(executablePath));
  console.info('Creation browser isolation', JSON.stringify(sandbox.assertIsolation()));
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const api = await startPage(sandbox), { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const metrics = [];
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    api.reset();
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: 'zh-CN', colorScheme: theme,
      ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(api.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(theme => { try { localStorage.setItem('zylos-dashboard-locale', 'zh');
      localStorage.setItem('zylos-dashboard-theme', theme); } catch {} }, theme);
    const page = await context.newPage(), errors = [], failed = [];
    page.on('response', response => { if (response.status() >= 400 && failed.length < 12) failed.push([response.url(), response.status()]); });
    page.on('console', message => { if (message.type() === 'error' && failed.length < 12) failed.push(message.text()); });
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => { if (errors.length < 3) errors.push(error.stack); });
    const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `${width}-${theme}-${name}.png`) }); };
    await page.goto(api.base + '/chat');
    try { await page.locator('.conversation-create:visible').waitFor(); } catch (error) {
      console.info('Creation initial failure', JSON.stringify({ errors, failed, body: (await page.locator('body').innerText()).slice(-4000), html: (await page.content()).slice(0, 500), url: page.url() }));
      await shot('initial-failure'); throw error;
    }
    assert.equal(await page.locator('.conversation-create').isEnabled(), true);
    await shot('before-create');
    await page.locator('.conversation-create').click();
    assert.equal(await page.locator('.conversation-create-form').count(), 0, 'there is no create-name form');
    await page.locator('.conversation-header h2:visible').filter({ hasText: '未命名对话' }).waitFor();
    assert.equal(api.writes.length, 1, 'one click issues exactly one draft creation');
    assert.equal(api.writes[0].route, '/api/chat/drafts');
    assert.equal(Object.keys(api.writes[0].body).length, 0, 'creation does not supply a name');
    assert.equal(await page.locator('.conversation-create-form input').count(), 0);
    assert.equal(await page.locator('.conversation-input:visible').count(), 1, 'the new conversation is already open');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await shot('created');
    await page.locator('.conversation-input').fill('请解释如何根据对话上下文自动命名。');
    await page.locator('.conversation-send').click();
    await page.locator('[data-message-id="1"]').waitFor();
    await page.waitForFunction(() => { const input = document.querySelector('.conversation-input'); return input && !input.disabled && input.value === ''; });
    const second = await context.newPage(); second.setDefaultTimeout(8000);
    await second.goto(api.base + '/chat');
    await second.locator('.conversation-list-item').first().waitFor();
    if (width === 390) await second.locator('.conversation-list-item').first().click();
    await second.locator('.conversation-header h2:visible').waitFor();
    await second.locator('[data-message-id="1"]').waitFor();
    // The fixture performs the server-side change and emits the normal SSE hint;
    // this case proves browser propagation, while server decision/CLI tests own naming.
    api.completeReplyAndName();
    for (const openPage of [page, second]) {
      await openPage.locator('.conversation-header h2:visible').filter({ hasText: title }).waitFor();
      assert.equal(await openPage.locator('.conversation-list-title strong').first().innerText(), title);
      assert.equal(await openPage.locator('.conversation-list-row').count(), 1, 'draft promotion leaves one canonical conversation');
      await openPage.locator('[data-message-id="2"]').waitFor();
      assert.equal(await openPage.evaluate(() => document.documentElement.scrollWidth), width);
    }
    await shot('named-detail');
    if (width === 390) await page.locator('.conversation-back').click();
    await page.locator('.conversation-list-title:visible').filter({ hasText: title }).waitFor();
    await shot('named-list');
    assert.equal(api.writes.length, 2, 'automatic UI refresh submits no extra writes');
    assert.equal(errors.length, 0, errors[0]);
    metrics.push({ width, theme, writes: api.writes.length, pagesUpdated: 2, overflow: false });
    await second.close(); await page.close(); await context.close();
  }
  if (evidence) fs.writeFileSync(path.join(evidence, 'creation-layout.json'), JSON.stringify(metrics, null, 2));
  console.info('Creation browser verified', JSON.stringify({ variants: metrics.length, pagesUpdated: 8, screenshots: evidence ? 16 : 0 }));
}
