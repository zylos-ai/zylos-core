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
  const writes = [], state = { previews: 0, pending: false, stale: false, previewFailure: false, deleteFailure: false,
    removed: new Set(), deletionAllowed: true, retainedMessages: 2, countsEstimated: true };
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
        if (state.previewFailure) {
          sendJson(res, 409, { ok: false, error: { code: 'group_delete_path_unavailable', message: '/private/do-not-render' } }); return;
        }
        const draftTarget = route.includes('/drafts/');
        state.previews++;
        sendJson(res, 200, { ok: true, operationId: 'browser-operation', cutoffId: draftTarget ? 0 : 8,
          messages: 8, attachments: 2, draft: draftTarget }); return;
      }
      if (req.method === 'DELETE' && (route.startsWith('/api/workbench/groups/') || route.startsWith('/api/chat/drafts/'))) {
        const body = await readJsonBody(req, 4096); writes.push({ route, body });
        if (state.deleteFailure) sendJson(res, 500, { ok: false, error: { code: 'cleanup_unavailable' } });
        else if (state.stale) sendJson(res, 409, { ok: false, error: { code: 'DELETION_PREVIEW_STALE' } });
        else if (state.pending) sendJson(res, 202, { ok: true, pending: true, operationId: body.operationId });
        else {
          state.removed.add(route.includes('/drafts/') ? draft.id : active.id);
          sendJson(res, 200, { ok: true, operationId: body.operationId, countsEstimated: state.countsEstimated,
            retainedMessages: state.retainedMessages, groupDataRetained: state.retainedMessages > 0,
            counts: { messages: 8, attachments: 2, files: 3 } });
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
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const locale of ['zh', 'en']) for (const width of [1280, 390]) {
    const zh = locale === 'zh', phone = width === 390;
    api.state.removed.clear(); api.state.pending = false; api.state.stale = false; api.state.previewFailure = false;
    api.state.deleteFailure = false; api.state.deletionAllowed = true;
    api.state.retainedMessages = 2; api.state.countsEstimated = true;
    const context = await browser.newContext({ viewport: { width, height: 844 }, locale: zh ? 'zh-CN' : 'en-US',
      ...(phone ? { isMobile: true, hasTouch: true } : {}) });
    sandbox.addCleanup(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(api.base + '/') ? route.continue() : route.abort());
    await context.addInitScript(locale => { try { localStorage.setItem('zylos-dashboard-locale', locale); localStorage.setItem('zylos-dashboard-theme', 'light'); } catch {} }, locale);
    const page = await context.newPage(), errors = [], failed = [];
    page.on('response', response => { if (response.status() >= 400 && failed.length < 12) failed.push([response.url(), response.status()]); });
    page.on('requestfailed', request => { if (failed.length < 12) failed.push([request.url(), request.failure()?.errorText]); });
    page.setDefaultTimeout(8000); page.on('pageerror', error => { if (errors.length < 3) errors.push(error.stack); });
    const cdp = phone ? await context.newCDPSession(page) : null;
    const row = item => page.locator(`.conversation-list-row:has([data-conversation-id="${item.id}"])`);
    const remove = item => row(item).locator('.conversation-delete');
    const dialog = page.getByRole('alertdialog');
    const shot = async name => { if (evidence) await page.screenshot({ path: path.join(evidence, `${locale}-${width}-${name}.png`) }); };
    const style = (locator, property) => locator.evaluate((node, property) => getComputedStyle(node)[property], property);
    // Real touch input through the browser's input pipeline, including its scrolling decisions. Moves are
    // paced like a finger (one per frame, settling before lifting): an instantaneous jump reads as a fling
    // whose end swallows the next tap.
    const swipe = async (item, dx, dy = 0) => {
      const box = await row(item).locator('.conversation-list-item').boundingBox();
      const x = box.x + box.width * 0.7, y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
        await pause(16);
      }
      await pause(120);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    const revealed = item => row(item).evaluate(node => node.classList.contains('conversation-swipe-open'));
    // Phone: swipe the row, then tap its revealed button. Desktop: hover the row, then click its trash.
    // A row showing a deletion status keeps its button in place, so it is pressed directly.
    const startDelete = async item => {
      if (await row(item).evaluate(node => 'deletionState' in node.dataset)) {
        await (phone ? remove(item).tap() : remove(item).click()); return;
      }
      if (phone) { await swipe(item, -160); assert.equal(await revealed(item), true);
        await pause(300); await remove(item).tap(); }
      else { await row(item).hover(); await remove(item).click(); }
    };
    await page.goto(api.base + '/chat');
    try { await row(active).waitFor(); } catch (error) {
      console.info('Deletion browser initial failure', JSON.stringify({ errors, failed, body: (await page.locator('body').innerText()).slice(-3500) }));
      if (evidence) await page.screenshot({ path: path.join(evidence, 'initial-failure.png') });
      throw error;
    }
    const layout = await page.evaluate(() => ({ width: document.documentElement.scrollWidth,
      buttons: [...document.querySelectorAll('.conversation-delete')].filter(node => !node.hidden).map(node => { const b = node.getBoundingClientRect(); return { width: b.width, height: b.height, nested: Boolean(node.parentElement.closest('button')), name: node.getAttribute('aria-label') }; }) }));
    assert.equal(layout.width, width); assert.equal(layout.buttons.length, 2);
    for (const button of layout.buttons) { assert.ok(button.width >= 40 && button.height >= 40); assert.equal(button.nested, false); }
    assert.equal(layout.buttons[0].name, (zh ? '删除对话' : 'Delete conversation') + ': ' + active.displayName, 'the button has a readable name');
    metrics.push({ locale, width, ...layout });
    if (phone) {
      // No standing trash: a vertical drag scrolls, a leftward swipe reveals, a tap elsewhere puts it back.
      assert.equal(await style(remove(active), 'visibility'), 'hidden');
      await swipe(active, 0, 120);
      assert.equal(await revealed(active), false, 'vertical scrolling does not reveal delete');
      await swipe(active, -160);
      assert.equal(await revealed(active), true);
      assert.equal(await style(remove(active), 'visibility'), 'visible');
      assert.equal((await remove(active).innerText()).trim(), zh ? '删除' : 'Delete');
      const button = await remove(active).boundingBox();
      assert.ok(button.x + button.width <= width && button.width >= 80, 'the revealed button is on screen');
      assert.equal(await page.locator('.conversation-page.conversation-detail-open').count(), 0, 'swiping does not open the conversation');
      await shot('revealed');
      await swipe(draft, -160);
      assert.equal(await revealed(active), false, 'only one row is revealed at a time');
      await row(active).locator('.conversation-list-item').tap();
      assert.equal(await revealed(draft), false, 'a tap elsewhere puts the button back');
      assert.equal(await page.locator('.conversation-page.conversation-detail-open').count(), 0, 'that tap does not open a conversation');
    } else {
      // The trash appears for the hovered row or a keyboard-focused row only.
      await page.mouse.move(width - 5, 840);
      assert.equal(await style(remove(active), 'opacity'), '0');
      await row(active).hover();
      assert.equal(await style(remove(active), 'opacity'), '1');
      assert.equal(await style(remove(draft), 'opacity'), '0');
      await shot('revealed');
      await page.mouse.move(width - 5, 840);
      assert.equal(await style(remove(active), 'opacity'), '0');
      await page.keyboard.press('Shift');
      await row(draft).locator('.conversation-list-item').focus();
      assert.equal(await style(remove(draft), 'opacity'), '1', 'keyboard focus on the row shows its trash');
      await page.keyboard.press('Tab');
      assert.equal(await remove(draft).evaluate(node => node === document.activeElement), true, 'the trash is in the tab order');
      assert.equal(await style(remove(draft), 'opacity'), '1');
      assert.equal(await style(remove(active), 'opacity'), '0');
      await page.evaluate(() => document.activeElement?.blur());
    }
    // A failed preview explains itself; nothing asks for confirmation and nothing is sent.
    api.state.previewFailure = true;
    await startDelete(active);
    const preflight = row(active).locator('.conversation-delete-status').filter({ hasText: zh ? '无法安全访问' : 'cannot be accessed safely' });
    await preflight.waitFor();
    assert.equal(await dialog.count(), 0, 'a failed preflight does not ask for confirmation');
    assert.equal(api.writes.length, 0, 'a failed preflight sends no DELETE');
    assert.doesNotMatch(await preflight.innerText(), /private|do-not-render|尚未完成|继续同一次|same operation|finish deletion/i);
    api.state.previewFailure = false;
    // The existing confirmation shows the preview's counts; cancelling sends nothing.
    await startDelete(active);
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /8/); assert.match(await dialog.innerText(), /2/);
    if (phone) assert.equal(await revealed(active), false, 'pressing the revealed button puts the row back');
    await shot('confirm');
    await dialog.locator('button').first().click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(api.writes.length, 0, 'cancel sends no DELETE');
    assert.equal(await preflight.count(), 0, 'a successful preflight followed by cancel clears its previous failure');
    assert.equal(await row(active).isVisible(), true);
    await startDelete(draft); await dialog.waitFor();
    assert.ok(!(await dialog.innerText()).includes(zh ? '主记忆' : 'main memory'), 'a draft gets the light confirmation');
    await dialog.locator('button').first().click(); await dialog.waitFor({ state: 'detached' });
    assert.equal(api.writes.length, 0);
    if (phone) {
      // The non-gesture entry: the open conversation's menu, back on the list through the same confirmation.
      await row(active).locator('.conversation-list-item').tap();
      await page.locator('.conversation-page.conversation-detail-open').waitFor();
      await page.locator('.conversation-menu-toggle').tap();
      const menuDelete = page.locator('.conversation-menu-delete');
      assert.equal(await menuDelete.getAttribute('aria-label'), zh ? '删除对话' : 'Delete conversation');
      await menuDelete.tap();
      await dialog.waitFor();
      assert.equal(await page.locator('.conversation-page.conversation-detail-open').count(), 0, 'the list is shown behind the confirmation');
      assert.match(await dialog.innerText(), /8/);
      await shot('menu-confirm');
      await dialog.locator('button').first().click(); await dialog.waitFor({ state: 'detached' });
      assert.equal(api.writes.length, 0);
    }
    // Confirming sends one DELETE with the preview's boundary; a stale preview is reported on the row.
    api.state.stale = true;
    const previews = api.state.previews;
    await startDelete(active); await dialog.waitFor(); await dialog.locator('button').last().click();
    const stale = row(active).locator('.conversation-delete-status').filter({ hasText: zh ? '预览已过期' : 'preview is out of date' });
    await stale.waitFor();
    assert.equal(api.writes.length, 1, 'confirming sends exactly one DELETE');
    assert.equal(api.state.previews, previews + 1);
    assert.match(api.writes[0].route, /^\/api\/workbench\/groups\//);
    assert.deepEqual(api.writes[0].body, { confirmed: true, operationId: 'browser-operation', cutoffId: 8 });
    assert.equal(await remove(active).isVisible(), true, 'the row keeps its delete button shown with the status');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await shot('stale');
    // A failed delete keeps the row with a retry.
    api.state.stale = false; api.state.deleteFailure = true;
    await startDelete(active); await dialog.waitFor(); await dialog.locator('button').last().click();
    const interrupted = row(active).locator('.conversation-delete-status').filter({ hasText: zh ? '删除尚未完成' : 'Could not finish deletion' });
    await interrupted.waitFor();
    assert.equal(api.writes.length, 2);
    assert.equal(await remove(active).isVisible(), true, 'its retry stays shown');
    assert.equal(await remove(active).getAttribute('title'), zh ? '重试删除' : 'Retry deletion');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    await shot('delete-error');
    // Retrying a started deletion continues its operation without another confirmation, through pending to done.
    api.state.deleteFailure = false; api.state.pending = true;
    await startDelete(active);
    await row(active).locator('.conversation-delete-status').filter({ hasText: zh ? '再点一次删除继续' : 'Click delete again to continue' }).waitFor();
    assert.equal(await dialog.count(), 0, 'retry after a started deletion failure reuses its confirmation');
    api.state.pending = false;
    await startDelete(active);
    await page.waitForFunction(id => !document.querySelector(`[data-conversation-id="${id}"]`), active.id);
    assert.equal(await dialog.count(), 0, 'continuing an already confirmed deletion does not open another dialog');
    assert.deepEqual(api.writes.slice(-3).map(row => row.body.operationId), ['browser-operation', 'browser-operation', 'browser-operation']);
    assert.equal(api.state.previews, previews + 2, 'continuing needed no new preview');
    const estimate = page.locator('.conversation-deletion-notice:visible');
    await estimate.waitFor();
    const retainedText = zh ? '还有 2 条消息被保留，对话记忆已保留。' : '2 messages remain; conversation memory has been retained.';
    const estimatedText = zh ? '对话已删除；此前清理中断，删除数量为估计值。' : 'Conversation deleted. Counts are estimates after an interrupted cleanup.';
    assert.equal(await estimate.innerText(), retainedText + (zh ? '' : ' ') + estimatedText);
    await shot('retained');
    // The draft through the same gesture and confirmation.
    api.state.retainedMessages = 0; api.state.countsEstimated = false;
    await startDelete(draft); await dialog.waitFor(); await dialog.locator('button').last().click();
    await page.waitForFunction(id => !document.querySelector(`[data-conversation-id="${id}"]`), draft.id);
    assert.match(api.writes.at(-1).route, /^\/api\/chat\/drafts\//);
    assert.deepEqual(api.writes.at(-1).body, { confirmed: true, operationId: 'browser-operation', cutoffId: 0 });
    for (const { body } of api.writes) assert.deepEqual(Object.keys(body).sort(), ['confirmed', 'cutoffId', 'operationId']);
    assert.equal(await page.locator('.conversation-deletion-notice').isVisible(), false, 'zero retained messages and exact counts need no completion warning');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
    api.writes.length = 0;
    await page.locator('[data-action="external"]').click();
    await page.locator('.conversation-list-item').filter({ hasText: 'Origin' }).waitFor();
    const originRow = page.locator('.conversation-list-row').filter({ hasText: 'Origin' });
    assert.equal(await originRow.locator('.conversation-delete').count(), 1);
    assert.equal(await originRow.locator('.conversation-delete').isHidden(), true, 'Origin cannot be deleted');
    await shot('external');
    api.state.removed.clear();
    await page.goto(api.base + '/fleet/reader/chat');
    await page.locator('.conversation-list-item').first().waitFor();
    assert.equal(await page.locator('.conversation-delete:not([hidden])').count(), 0); await shot('remote');
    api.state.deletionAllowed = false;
    await page.goto(api.base + '/chat'); await page.locator('.conversation-list-item').first().waitFor();
    assert.equal(await page.locator('.conversation-delete:not([hidden])').count(), 0, 'server deletionAllowed:false hides local actions');
    await page.goto(api.base + '/usage');
    const usageNote = page.locator('.wb-usage-deletion-note:visible'); await usageNote.waitFor();
    assert.match(await usageNote.innerText(), zh ? /不再计入消息数/ : /no longer count toward message totals/);
    assert.deepEqual(errors, []); await context.close();
  }
  if (evidence) fs.writeFileSync(path.join(evidence, 'layout.json'), JSON.stringify(metrics, null, 2));
  console.info('Deletion browser verified', JSON.stringify({ screenshots: evidence ? 30 : 0, pairs: 4 }));
}
