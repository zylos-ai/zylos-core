import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sendHtml, sendJson, serveStatic, readJsonBody } from '../../src/lib/http.js';
import { workbenchAnswer } from '../fixtures/workbench-browser-api.js';

const publicDir = path.resolve(fileURLToPath(new URL('../../public/', import.meta.url)));
const groupId = group => 'g:' + Buffer.from(group).toString('hex').toUpperCase();
const active = { id: groupId('dashboard:sample'), sessionGroup: 'dashboard:sample', channel: 'dashboard', displayName: 'Research notes / 研究记录', stamp: 2461353, state: 'active' };
const draft = { id: 'd:333', localId: '333', channel: 'dashboard', displayName: 'Draft / 草稿', draft: true, state: 'draft', stamp: 2461352 };
const origin = { id: groupId('origin'), sessionGroup: 'origin', channel: 'origin', displayName: 'Origin', stamp: 2461353 };
const external = { id: groupId('telegram:sample'), sessionGroup: 'telegram:sample', channel: 'telegram', displayName: 'Telegram product chat', stamp: 2461352 };

async function startPage(sandbox) {
  const writes = [], state = { pending: false, stale: false, removed: new Set(), deletionAllowed: true };
  const server = http.createServer(async (req, res) => {
    try {
      const full = new URL(req.url, 'http://fixture');
      const prefix = full.pathname.startsWith('/fleet/reader') ? '/fleet/reader' : '';
      const route = full.pathname.slice(prefix.length) || '/';
      const url = new URL(route + full.search, full.origin);
      if (route === '/api/chat/conversations') {
        const items = url.searchParams.get('tab') === 'external' ? [origin, external] : [active, draft].filter(item => !state.removed.has(item.id));
        // Deliberately true for a Fleet response too: the app's local-view guard must still hide deletion.
        sendJson(res, 200, { items, nextCursor: null, tz: 'Asia/Singapore', deletionAllowed: state.deletionAllowed }); return;
      }
      if ((route.startsWith('/api/workbench/groups/') || route.startsWith('/api/chat/drafts/')) && route.endsWith('/deletion')) {
        const draftTarget = route.includes('/drafts/');
        sendJson(res, 200, { ok: true, operationId: 'browser-operation', cutoffId: draftTarget ? 0 : 8,
          generationId: null, targetKey: JSON.stringify(draftTarget ? ['draft', 'dashboard', '333'] : ['group', 'dashboard:sample']),
          messages: 8, attachments: 2, draft: draftTarget }); return;
      }
      if (req.method === 'DELETE' && (route.startsWith('/api/workbench/groups/') || route.startsWith('/api/chat/drafts/'))) {
        const body = await readJsonBody(req, 4096); writes.push({ route, body });
        if (state.stale) sendJson(res, 409, { ok: false, error: { code: 'DELETION_PREVIEW_STALE' } });
        else if (state.pending) sendJson(res, 202, { ok: true, pending: true, operationId: body.operationId });
        else {
          state.removed.add(route.includes('/drafts/') ? draft.id : active.id);
          sendJson(res, 200, { ok: true, operationId: body.operationId, countsEstimated: true, counts: { messages: 8, attachments: 2, files: 3 } });
        }
        return;
      }
      if (/^\/api\/chat\/conversations\/[^/]+$/.test(route)) {
        const id = decodeURIComponent(route.split('/').at(-1));
        const item = [active, draft, origin, external].find(item => item.id === id);
        sendJson(res, 200, { conversation: item, stored: true }); return;
      }
      if (/^\/api\/chat\/conversations\/[^/]+\/(?:messages|questions|activity|status)$/.test(route)) {
        sendJson(res, 200, { items: [], rounds: [], nextCursor: null, afterCursor: null, tz: 'Asia/Singapore' }); return;
      }
      if (route === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return; }
      if (route === '/api/workbench/usage') {
        sendJson(res, 200, { tz: 'Asia/Singapore', buckets: [], bucket: 'day', totals: { cost: 0, costByRuntime: {}, messages: { in: 0, out: 0 } },
          costByRuntime: [], tokensByRuntime: [], messages: [], rotations: [], tools: [], projects: { items: [] } }); return;
      }
      if (route.startsWith('/api/')) {
        const value = workbenchAnswer(url, Date.now()); sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' }); return;
      }
      if (['/', '/chat', '/usage'].includes(route)) {
        sendHtml(res, 200, fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8')
          .replaceAll('__BASE_PATH__', prefix).replaceAll('__ASSET_ROOT__', prefix + '/_assets').replaceAll('__REMOTE_ACCESS__', prefix ? 'read' : 'admin')); return;
      }
      req.url = route + full.search;
      if (!serveStatic(req, res, publicDir)) sendJson(res, 404, { error: 'not_found' });
    } catch (error) { sendJson(res, 500, { error: error.message }); }
  });
  return { base: await sandbox.startHttp(server), writes, state };
}

export async function runConversationDeleteBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath)); assert.ok(executablePath && fs.existsSync(executablePath));
  console.info('Deletion browser isolation', JSON.stringify(sandbox.assertIsolation()));
  const evidence = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (evidence) fs.mkdirSync(evidence, { recursive: true });
  const api = await startPage(sandbox), { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const metrics = [];
  for (const locale of ['zh', 'en']) for (const width of [1280, 390]) {
    api.state.removed.clear(); api.state.pending = false; api.state.stale = false; api.state.deletionAllowed = true;
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US',
      ...(width === 390 ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(api.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(locale => { try { localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-theme', 'light'); } catch {} }, locale);
    const page = await context.newPage(), errors = [], failed = [];
    page.on('response', response => { if (response.status() >= 400 && failed.length < 12) failed.push([response.url(), response.status()]); });
    page.on('requestfailed', request => { if (failed.length < 12) failed.push([request.url(), request.failure()?.errorText]); });
    page.setDefaultTimeout(8000); page.on('pageerror', error => { if (errors.length < 3) errors.push(error.stack); });
    await page.goto(api.base + '/chat');
    try { await page.locator('.conversation-delete:visible').first().waitFor(); } catch (error) {
      console.info('Deletion browser initial failure', JSON.stringify({ errors, failed, html: (await page.content()).slice(0,1600), body: (await page.locator('body').innerText()).slice(-3500), rows: await page.locator('.conversation-list-row').count(), url: page.url(), tabs: await page.locator('.tab-content.active').count() }));
      if (evidence) await page.screenshot({ path: path.join(evidence, 'initial-failure.png') });
      throw error;
    }
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll('.conversation-delete')].filter(node => !node.hidden).map(node => { const b = node.getBoundingClientRect(); return { width: b.width, height: b.height, nested: Boolean(node.parentElement.closest('button')) }; }) }));
    assert.equal(layout.width, width); assert.equal(layout.buttons.length, 2);
    for (const button of layout.buttons) { assert.ok(button.width >= 40 && button.height >= 40); assert.equal(button.nested, false); }
    metrics.push({ locale, width, ...layout });
    const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `${locale}-${width}-${name}.png`) }); };
    await shot('list');
    await page.locator('.conversation-delete:visible').first().click();
    const dialog = page.getByRole('alertdialog'); await dialog.waitFor();
    assert.match(await dialog.innerText(), /8/); assert.match(await dialog.innerText(), /2/);
    await shot('confirm');
    const before = api.writes.length;
    await dialog.locator('button').first().click(); assert.equal(api.writes.length, before);
    await page.locator('.conversation-delete:visible').nth(1).click(); await dialog.waitFor();
    assert.ok(!(await dialog.innerText()).includes(locale === 'zh' ? '主记忆' : 'main memory'));
    await shot('draft-confirm'); await dialog.locator('button').first().click();
    api.state.stale = true;
    await page.locator('.conversation-delete:visible').first().click(); await dialog.waitFor(); await dialog.locator('button').last().click();
    const stale = page.locator('.conversation-delete-status:visible').filter({ hasText: locale === 'zh' ? '预览已过期' : 'preview is out of date' });
    await stale.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await shot('stale');
    api.state.stale = false;
    api.state.pending = true;
    await page.locator('.conversation-delete:visible').first().click(); await dialog.waitFor(); await dialog.locator('button').last().click();
    const pending = page.locator('.conversation-delete-status:visible').filter({ hasText: locale === 'zh' ? '再点一次删除继续' : 'Click delete again to continue' });
    await pending.waitFor();
    assert.match(await pending.innerText(), locale === 'zh' ? /再点一次删除继续/ : /Click delete again to continue/);
    await shot('pending');
    api.state.pending = false;
    await page.locator('.conversation-delete:visible').first().click();
    await page.waitForFunction(id => !document.querySelector(`[data-conversation-id="${id}"]`), active.id);
    assert.equal(await dialog.count(), 0, 'continuing an already confirmed deletion does not open another dialog');
    assert.deepEqual(api.writes.slice(-2).map(row => row.body.operationId), ['browser-operation', 'browser-operation']);
    const estimate = page.locator('.conversation-deletion-notice:visible');
    await estimate.waitFor();
    assert.match(await estimate.innerText(), locale === 'zh' ? /估计值/ : /estimates/);
    await shot('estimated');
    await page.locator('[data-action="external"]').click();
    await page.locator('.conversation-list-item').filter({ hasText: 'Origin' }).waitFor();
    const originRow = page.locator('.conversation-list-row').filter({ hasText: 'Origin' });
    assert.equal(await originRow.locator('.conversation-delete').isVisible(), false);
    assert.equal(await page.locator('.conversation-delete:visible').count(), 1); await shot('external');
    await page.goto(api.base + '/fleet/reader/chat');
    await page.locator('.conversation-list-item').first().waitFor();
    assert.equal(await page.locator('.conversation-delete:visible').count(), 0); await shot('remote');
    api.state.deletionAllowed = false;
    await page.goto(api.base + '/chat'); await page.locator('.conversation-list-item').first().waitFor();
    assert.equal(await page.locator('.conversation-delete:visible').count(), 0, 'server deletionAllowed:false hides local actions');
    await page.goto(api.base + '/usage');
    const usageNote = page.locator('.wb-usage-deletion-note:visible'); await usageNote.waitFor();
    assert.match(await usageNote.innerText(), locale === 'zh' ? /不再计入消息数/ : /no longer count toward message totals/);
    const noteStyle = await usageNote.evaluate(node => {
      const css = getComputedStyle(node), status = getComputedStyle(document.querySelector('.wb-usage-status'));
      return { size: css.fontSize, margin: css.marginTop, color: css.color, statusColor: status.color, viewport: document.documentElement.scrollWidth };
    });
    assert.equal(noteStyle.size, '12.5px'); assert.equal(noteStyle.margin, '8px'); assert.equal(noteStyle.color, noteStyle.statusColor);
    assert.equal(noteStyle.viewport, width); await shot('usage');
    assert.deepEqual(errors, []); await context.close();
  }
  if (evidence) fs.writeFileSync(path.join(evidence, 'layout.json'), JSON.stringify(metrics, null, 2));
  console.info('Deletion browser verified', JSON.stringify({ screenshots: evidence ? 36 : 0, pairs: 4, writes: api.writes.length }));
}
