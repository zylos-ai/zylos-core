import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatApiFixture, protocolFixtures, questionContent } from './chat-integration-api.js';
import { sendJson } from '../../src/lib/http.js';
import { dataError } from '../../../comm-bridge/scripts/c4-session-group.js';

// Real product entry, schema, state, API and database. No source rewriting or eval.
export async function runConversationVisual(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath));
  assert.ok(executablePath && fs.existsSync(executablePath));
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  let reads = 0, draftWrites = 0;
  const messageRequests = [];
  const fixture = await createChatApiFixture(t, sandbox, { name: 'Cache design review', extraHandler(req, res, url, f) {
    if (url.pathname.startsWith('/api/chat/')) return false;
    if (!url.pathname.startsWith('/api/')) return false;
    if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
    const values = {
      '/api/session-mode': { data: { sessionMode: f.readMode() } },
      '/api/state': { state: 'idle', runtime: 'claude', session_mode: f.readMode(), agent: { id: 'test', name: 'Isolated browser' }, runtime_info: {} },
      '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' }, '/api/communication': {}, '/api/summary': {},
      '/api/timeline': { items: [] }, '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] },
    };
    sendJson(res, 200, values[url.pathname] || {}); return true;
  } });
  const first = await fixture.createConversation('Compare cache approaches and keep the limits visible.');
  const localId = first.draft.localId;
  for (let i = 0; i < 65; i++) fixture.addOutbound(localId, `Discussion ${i + 1}: retain the constraints and earlier decisions while reviewing the next step. This longer paragraph makes the reading position observable.`);
  const malformedRow = fixture.addOutbound(localId, 'Historical malformed fixture');
  fixture.db.prepare('UPDATE conversations SET content=? WHERE id=?').run(questionContent({}) + 'trailing', malformedRow.id);
  const markdown = structuredClone(protocolFixtures.valid.find(v => v.name === 'markdown').envelope);
  markdown.messageId += '_page'; const markdownRow = fixture.addOutbound(localId, questionContent(markdown));
  fixture.db.prepare('UPDATE conversations SET timestamp=? WHERE id=?').run('2026-11-01 03:02:00', markdownRow.id);
  for (const kind of ['time_series', 'breakdown', 'category_series']) {
    const envelope = structuredClone(protocolFixtures.valid.find(v => v.name === kind).envelope);
    envelope.messageId += '_page'; fixture.addOutbound(localId, questionContent(envelope));
  }
  const choice = structuredClone(protocolFixtures.valid.find(v => v.name === 'single').envelope);
  choice.messageId += '_page'; choice.interruptId += '_page'; fixture.addOutbound(localId, questionContent(choice));
  const form = structuredClone(protocolFixtures.valid.find(v => v.name === 'form').envelope);
  form.messageId += '_page'; form.interruptId += '_page'; const formRow = fixture.addOutbound(localId, questionContent(form));
  fixture.db.prepare('UPDATE conversations SET timestamp=? WHERE session_group=? AND id<>?').run(new Date(Date.now() - 7200000).toISOString(), first.receipt.namespace + ':' + localId, markdownRow.id);
  const external = fixture.c4.insertConversation('in', 'telegram', 'external-page', 'External history remains read only.', { groupName: 'external-page' });
  fixture.db.prepare("UPDATE conversations SET status='pending' WHERE id=?").run(external.id);
  const externalName = '运维群-测试';
  const unicodeExternal = fixture.c4.insertConversation('in', 'telegram', 'unicode-external', 'Unicode external history outside the first page.', { groupName: 'unicode-external' });
  // Historical imports may contain UTF-8 keys that current new-write validation rejects.
  const validExternalGroup = unicodeExternal.session_group;
  const legacyGroup = 'telegram:' + externalName;
  fixture.db.prepare('UPDATE conversations SET session_group=? WHERE id=?').run(legacyGroup, unicodeExternal.id);
  fixture.db.prepare('UPDATE group_heads SET session_group=? WHERE session_group=?').run(legacyGroup, unicodeExternal.session_group);
  unicodeExternal.session_group = legacyGroup;
  fixture.db.prepare('UPDATE conversations SET timestamp=? WHERE id=?').run(new Date(Date.now() - 3600000).toISOString(), unicodeExternal.id);
  for (let index = 0; index < 55; index++) fixture.c4.insertConversation('in', 'telegram', 'newer-' + index, 'Newer external history.', { groupName: 'newer-' + index });
  const externalGroup = unicodeExternal.session_group;
  const externalId = 'g:' + Buffer.from(externalGroup).toString('hex').toUpperCase();
  const externalFirstPage = await fixture.request('/api/chat/conversations?tab=external&limit=50');
  assert.equal(externalFirstPage.status, 200);
  assert.equal(externalFirstPage.body.items.some(row => row.id === externalId), false);

  sandbox.assertIsolation();
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
  await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/messages')) { reads++; messageRequests.push(request.url()); }
    if (path === '/api/chat/drafts' && request.method() === 'POST') draftWrites++;
  });
  const errors = [], shots = [];
  let expectedDenied = false;
  page.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  page.on('response', response => { const url = new URL(response.url()); if (response.url().startsWith(fixture.base + '/') && response.status() >= 400 && url.pathname !== '/favicon.ico' && !(expectedDenied && response.status() === 403 && url.pathname.includes('/api/chat/')) && !errors.length) errors.push(`${response.status()} ${url.pathname}`); });
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:') && !errors.length) errors.push(message.text()); });
  const select = async () => {
    await page.locator(`[data-conversation-id="${first.receipt.conversationId}"]`).click();
    await page.locator('#wb-chat .chat-message').first().waitFor();
  };
  const screenshot = async name => {
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    assert.ok(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1), 'page has no vertical document overflow');
    if (output) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, fullPage: false }); shots.push(file); }
  };
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(value => { if (window === window.top) localStorage.setItem('zylos-dashboard-theme', value); }, theme);
    await page.goto(fixture.base + '/chat');
    await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    if (width === 1440) await page.locator('#wb-chat .chat-message').first().waitFor();
    await select();
    assert.ok(await page.locator('#wb-chat .chat-composer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1), 'composer fits the actual viewport');
    assert.equal(await page.locator('#wb-chat .chat-composer textarea').count(), 1);
    assert.equal(await page.locator('#attachmentButton').count(), 0);
    if (width === 390) {
      for (const selector of ['.conversation-back', '[data-action="rename"]', '[data-action="refreshMessages"]', '[data-action="refreshStatus"]', '[data-action="send"]']) {
        const control = page.locator('#wb-chat ' + selector).first();
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 40 && box.height >= 40, selector + ' has a usable phone target');
      }
    }
    assert.match(await page.locator(`#wb-chat [data-conversation-id="${first.receipt.conversationId}"] .conversation-list-time`).innerText(), /\d{1,2}:\d{2}/, 'same-day older list entry uses a clock time');
    if (width === 390) {
      await page.locator('#wb-chat .conversation-back').click();
      for (const selector of ['.conversation-tabs [data-action="mine"]', '.conversation-tabs [data-action="external"]', '[data-action="create"]']) {
        const box = await page.locator('#wb-chat ' + selector).boundingBox();
        assert.ok(box && box.height >= 40, selector + ' has a 40px phone height');
      }
      await select();
    }
    await screenshot(`conversation-${width}-${theme}`);
    await page.locator('#wb-chat .chat-chart').first().scrollIntoViewIfNeeded();
    await screenshot(`blocks-${width}-${theme}`);
    const reference = page.locator(`[data-message-id="${malformedRow.id}"] .chat-block-reference`);
    assert.equal(await reference.isVisible(), false);
    if (width === 1440 && theme === 'light') {
      await page.locator('#wb-tech-btn').click();
      assert.equal(await reference.isVisible(), true);
      await page.locator('#wb-tech-btn').click();
      assert.equal(await reference.isVisible(), false);
    }
    assert.match(await page.locator(`[data-message-id="${markdownRow.id}"] time`).innerText(), /11:02/, 'SQL UTC time displays in the browser timezone');
    assert.equal((await page.locator('#wb-chat').innerText()).includes('[C4 messageId='), false);
  }
  await page.evaluate(() => localStorage.setItem('zylos-dashboard-locale', 'en'));
  await page.reload();
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  await select();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await screenshot('conversation-390-english');
  await page.setViewportSize({ width: 1440, height: 900 });
  // Hold a workbench read without returning it. Message polling must remain independent.
  let releaseGroup, observeGroup;
  const groupObserved = new Promise(resolve => { observeGroup = resolve; });
  const heldGroup = new Promise(resolve => { releaseGroup = resolve; });
  const groupPattern = '**/api/workbench/groups';
  await context.route(groupPattern, async route => { observeGroup(); await heldGroup; await route.continue().catch(() => {}); });
  sandbox.addCleanup(() => releaseGroup());
  await select();
  let groupObservationTimer;
  try {
    await Promise.race([groupObserved, new Promise((_, reject) => { groupObservationTimer = setTimeout(() => reject(Error('selected group status request was not observed')), 3000); })]);
  } finally { clearTimeout(groupObservationTimer); }
  // Actual scheduled after-cursor request; hold live control references so a hidden redraw fails.
  await page.setViewportSize({ width: 1440, height: 900 });
  const input = page.locator('#wb-chat .chat-composer textarea');
  await input.fill('Keep this draft and caret while reading.');
  await input.focus();
  await input.evaluate(el => { el.setSelectionRange(8, 8); el.dataset.identityProbe = 'same-input'; });
  const stream = page.locator('#wb-chat .chat-messages');
  await stream.evaluate(el => { el.scrollTop = 0; el.dataset.identityProbe = 'same-history'; });
  const firstNode = await page.locator('#wb-chat .chat-message').first().elementHandle();
  const beforeReads = reads;
  const incoming = fixture.addOutbound(localId, 'The new response arrives without replacing your draft.');
  await page.locator(`#wb-chat [data-message-id="${incoming.id}"]`).waitFor({ timeout: 6500 });
  releaseGroup();
  await context.unroute(groupPattern);
  assert.ok(reads > beforeReads, 'a real background request fetched the message');
  assert.equal(await input.inputValue(), 'Keep this draft and caret while reading.');
  assert.equal(await input.getAttribute('data-identity-probe'), 'same-input');
  assert.equal(await input.evaluate(el => document.activeElement === el && el.selectionStart === 8), true);
  assert.equal(await stream.getAttribute('data-identity-probe'), 'same-history');
  assert.equal(await firstNode.evaluate(el => el.isConnected), true);
  assert.ok((await stream.evaluate(el => el.scrollTop)) < 5, 'historical reading anchor retained');
  const unread = page.locator('#wb-chat [data-action="latest"]');
  assert.equal(await unread.isVisible(), true);
  await stream.evaluate(el => el.scrollTop = el.scrollHeight);
  await page.waitForTimeout(100);
  assert.equal(await unread.isVisible(), false);
  const field = page.locator(`[data-message-id="${formRow.id}"] .chat-question-field input`).first();
  await field.fill('Draft answer');
  await field.evaluate(el => el.dataset.identityProbe = 'same-question-input');
  fixture.addOutbound(localId, questionContent({ version: 1, kind: 'control', messageId: 'page-stop-form',
    fallbackText: 'The question was stopped.', interruptId: form.interruptId,
    control: { operation: 'stop', messageId: form.messageId } }));
  await field.waitFor({ state: 'visible' });
  await page.waitForFunction(id => document.querySelector(`[data-message-id="${id}"] .chat-question-field input`)?.disabled, formRow.id, { timeout: 15_000 });
  assert.equal(await field.inputValue(), 'Draft answer');
  assert.equal(await field.getAttribute('data-identity-probe'), 'same-question-input');
  // Earlier-page prepend keeps the first visible message offset stable.
  await stream.evaluate(el => el.scrollTop = 0);
  const anchor = await page.locator('#wb-chat .chat-message').first().getAttribute('data-message-id');
  const topBefore = await page.locator(`[data-message-id="${anchor}"]`).evaluate(el => el.getBoundingClientRect().top);
  const beforeRows = await page.locator('#wb-chat .chat-message').count();
  await page.locator('#wb-chat [data-action="loadOlder"]').click();
  await page.waitForFunction(count => document.querySelectorAll('#wb-chat .chat-message').length > count, beforeRows);
  await page.waitForTimeout(50);
  const topAfter = await page.locator(`[data-message-id="${anchor}"]`).evaluate(el => el.getBoundingClientRect().top);
  assert.ok(Math.abs(topAfter - topBefore) < 2, 'older-page prepend retains row pixel offset');
  // Ordinary text sends only through the registered group; input clears after authoritative storage.
  await input.fill('A concrete follow-up from the new page.');
  await page.locator('#wb-chat [data-action="send"]').click();
  await page.waitForFunction(() => document.querySelector('#wb-chat .chat-composer textarea')?.value === '');
  await page.locator('#wb-chat .chat-message').filter({ hasText: 'A concrete follow-up from the new page.' }).first().waitFor();
  await page.waitForFunction(() => { const el = document.querySelector('#wb-chat .chat-messages'); return el && el.scrollHeight - el.scrollTop - el.clientHeight < 2; });
  assert.ok(await stream.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight < 2), 'own send follows the stored message to the bottom');
  assert.equal(await page.locator('#wb-chat .conversation-receipt').isVisible(), false, 'stored receipt does not leave a persistent banner');
  // Creating first opens the named form; no draft write happens until submit.
  const writesBefore = draftWrites;
  await page.locator('#wb-chat [data-action="create"]').click();
  assert.equal(await page.locator('#wb-chat .conversation-create-form').count(), 1);
  assert.equal(draftWrites, writesBefore);
  await page.locator('#wb-chat .conversation-create-form input').fill('Named browser draft');
  await page.locator('#wb-chat [data-action="createDraft"]').click();
  await page.locator('#wb-chat .conversation-title-line h2').filter({ hasText: 'Named browser draft' }).waitFor();
  assert.equal(draftWrites, writesBefore + 1);
  const browserDraftId = await page.locator('#wb-chat [aria-current="true"]').getAttribute('data-conversation-id');
  assert.ok((await page.locator('#wb-chat .conversation-history-notice').innerText()).length > 20, 'blank draft explains first-message creation');
  fixture.setInvoke(() => { throw dataError('INVALID_ARGS', 'private pre-insert rejection', { persisted: [] }); });
  await input.fill('Retain the rejected browser draft.');
  await page.locator('#wb-chat [data-action="send"]').click();
  const operationReceipt = page.locator('#wb-chat .conversation-receipt');
  await page.locator('#wb-chat .conversation-receipt[data-delivery-state="not_stored"]').waitFor();
  assert.equal(await input.inputValue(), 'Retain the rejected browser draft.');
  assert.equal(await operationReceipt.locator('[data-action="refreshStatus"]').isVisible(), true);
  assert.equal(await page.locator('#wb-chat .conversation-notices > .chat-error').isVisible(), false, 'operation receipt replaces duplicate top error');
  fixture.setInvoke(null);
  // A transport failure proves unknown-result UI without rewriting product code.
  const sendPattern = '**/api/chat/conversations/*/send';
  await context.route(sendPattern, route => route.abort());
  await page.locator('#wb-chat [data-action="send"]').click();
  await page.locator('#wb-chat .conversation-receipt[data-delivery-state="pending_reconciliation"]').waitFor();
  assert.equal(await input.inputValue(), 'Retain the rejected browser draft.');
  assert.equal(await page.locator('#wb-chat .chat-composer [data-action="retry"]').isDisabled(), true);
  assert.equal(await operationReceipt.locator('[data-action="refreshStatus"]').isVisible(), true);
  assert.equal(await page.locator('#wb-chat .conversation-notices > .chat-error').isVisible(), false, 'operation receipt replaces duplicate top error');
  await context.unroute(sendPattern);
  await select();
  // The overview group drawer opens the same selected conversation, with no write.
  await page.locator('.tab[data-tab="overview"]').click();
  await page.locator('#wb-board [data-group]').filter({ hasText: 'Cache design review' }).first().click();
  await page.locator('#wb-side [data-action="viewConversation"]').click();
  await page.waitForFunction(id => document.querySelector('#wb-chat [aria-current="true"]')?.dataset.conversationId === id, first.receipt.conversationId);
  assert.equal(await page.locator('#tab-chat').evaluate(el => el.classList.contains('active')), true);
  assert.equal(draftWrites, writesBefore + 1);
  // UTF-8 external group is absent from the first list page; its drawer metadata must seed the header.
  await page.locator('.tab[data-tab="overview"]').click();
  await page.locator('#wb-board [data-group]').filter({ hasText: externalName }).first().click();
  const beforeExternalRead = messageRequests.length;
  await page.locator('#wb-side [data-action="viewConversation"]').click();
  await page.locator('#wb-chat .chat-message').filter({ hasText: 'Unicode external history outside the first page.' }).waitFor();
  assert.equal(await page.locator('#wb-chat [data-action="external"]').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#wb-chat .conversation-title-line h2').innerText(), externalGroup);
  assert.match(await page.locator('#wb-chat .conversation-subtitle').innerText(), /Telegram/);
  assert.equal(await page.locator('#wb-chat [data-action="page.groupInfo"]').isVisible(), true);
  assert.equal(await page.locator('#wb-chat .conversation-channel-icon .wb-ico-send').count(), 1);
  assert.equal(await page.locator('#wb-chat textarea').count(), 0);
  const targetReads = messageRequests.slice(beforeExternalRead).map(value => new URL(value));
  assert.ok(targetReads.some(url => decodeURIComponent(url.pathname.split('/').at(-2)) === externalId && url.searchParams.get('tab') === 'external'));
  assert.equal(draftWrites, writesBefore + 1);
  await page.locator('#wb-chat [data-action="mine"]').click();
  await page.locator('#wb-chat [data-action="external"]').click();
  await page.locator('#wb-chat [data-conversation-id]').first().click();
  await page.locator('#wb-chat .chat-message').first().waitFor();
  assert.equal(await page.locator('#wb-chat textarea').count(), 0);
  assert.equal(await page.locator('#wb-chat [data-action="send"]').count(), 0);
  assert.equal(await page.locator('#wb-chat .conversation-message-status:visible').count(), 0, 'pending external inbound has no stale delivery label');
  assert.equal(await page.locator('#wb-chat .conversation-read-only').isVisible(), true);
  assert.equal(await page.locator('#wb-chat .conversation-external-section').isVisible(), true);
  assert.match(await page.locator('#wb-chat .conversation-external-section').innerText(), /Other channels/i);
  await screenshot('external-read-only');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#wb-chat .conversation-back').click();
  const loadMoreBox = await page.locator('#wb-chat [data-action="loadMore"]').boundingBox();
  assert.ok(loadMoreBox && loadMoreBox.height >= 40, 'load more has a 40px phone height');
  await page.setViewportSize({ width: 1440, height: 900 });
  fixture.setProxy(fixture);
  const allowRemote = async value => {
    const result = await fixture.request('/api/chat/settings', { method: 'PUT', body: { allowRemote: value } });
    assert.equal(result.status, 200);
  };
  await allowRemote(true);
  await page.goto(fixture.base + '/fleet/Remote/chat');
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  await select();
  expectedDenied = true;
  await allowRemote(false);
  await page.locator('#wb-chat [data-action="refresh"]').click();
  await page.locator('#wb-chat .conversation-blocked-notice').waitFor();
  assert.equal(await page.locator('#wb-chat .chat-message, #wb-chat .chat-composer, #wb-chat [data-conversation-id]').count(), 0);
  assert.equal((await page.locator('#wb-chat').innerText()).includes('Compare cache approaches'), false);
  await screenshot('remote-closed');
  expectedDenied = false;
  // Restore the historical-only UTF-8 fixture before exercising ordinary mode conversion.
  // This page case does not claim converter support for legacy non-ASCII group keys.
  fixture.db.prepare('UPDATE conversations SET session_group=? WHERE session_group=?').run(validExternalGroup, legacyGroup);
  fixture.db.prepare('UPDATE group_heads SET session_group=? WHERE session_group=?').run(validExternalGroup, legacyGroup);
  await fixture.convertToSingle();
  await page.goto(fixture.base + '/chat');
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  await select();
  assert.equal(await page.locator('#wb-chat [data-action="create"]').isVisible(), true);
  assert.equal(await page.locator('#wb-chat [data-action="create"]').isDisabled(), true);
  assert.equal(await page.locator('#wb-chat .conversation-single-warning .wb-ico-lock').count(), 1);
  assert.equal(await page.locator('#wb-chat .chat-composer textarea').isDisabled(), true);
  assert.equal(await page.locator('#wb-chat .chat-composer [data-action="send"]').isDisabled(), true);
  assert.equal(await page.locator('#wb-chat .chat-question button:not(:disabled)').count(), 0);
  assert.equal(fixture.readMode(), 'single');
  await screenshot('single-read-only');
  await page.locator(`[data-conversation-id="${browserDraftId}"]`).click();
  const staleReceipt = page.locator('#wb-chat .conversation-receipt[data-delivery-state="not_stored"]');
  await staleReceipt.waitFor();
  assert.doesNotMatch(await staleReceipt.innerText(), /can retry|retry sending/i);
  assert.equal(await page.locator('#wb-chat .chat-composer textarea').isDisabled(), true);
  assert.deepEqual(errors, []);
  if (output) fs.writeFileSync(path.join(output, 'conversation-browser.json'), JSON.stringify({ shots, reads, errors, base: fixture.base }, null, 2));
  t.diagnostic(`conversation browser: ${shots.length} screenshots, ${reads} actual message reads, no page errors`);
}
