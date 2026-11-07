import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatApiFixture, protocolFixtures, questionContent } from './chat-integration-api.js';
import { sendJson } from '../../src/lib/http.js';

// Real product entry, schema, state, API and database. No source rewriting or eval.
export async function runConversationVisual(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath));
  assert.ok(executablePath && fs.existsSync(executablePath));
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  let reads = 0;
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
  const markdown = structuredClone(protocolFixtures.valid.find(v => v.name === 'markdown').envelope);
  markdown.messageId += '_page'; fixture.addOutbound(localId, questionContent(markdown));
  for (const kind of ['time_series', 'breakdown', 'category_series']) {
    const envelope = structuredClone(protocolFixtures.valid.find(v => v.name === kind).envelope);
    envelope.messageId += '_page'; fixture.addOutbound(localId, questionContent(envelope));
  }
  const choice = structuredClone(protocolFixtures.valid.find(v => v.name === 'single').envelope);
  choice.messageId += '_page'; choice.interruptId += '_page'; fixture.addOutbound(localId, questionContent(choice));
  const form = structuredClone(protocolFixtures.valid.find(v => v.name === 'form').envelope);
  form.messageId += '_page'; form.interruptId += '_page'; const formRow = fixture.addOutbound(localId, questionContent(form));
  fixture.c4.insertConversation('out', 'telegram', 'external-page', 'External history remains read only.', { groupName: 'external-page' });
  sandbox.assertIsolation();
  const { chromium } = await import(pathToFileURL(modulePath));
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN' });
  await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
  await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/messages')) reads++; });
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
    if (output) { const file = path.join(output, name + '.png'); await page.screenshot({ path: file, fullPage: false }); shots.push(file); }
  };
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(value => { if (window === window.top) localStorage.setItem('zylos-dashboard-theme', value); }, theme);
    await page.goto(fixture.base + '/chat');
    await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    await select();
    assert.ok(await page.locator('#wb-chat .chat-composer').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight + 1), 'composer fits the actual viewport');
    assert.equal(await page.locator('#wb-chat .chat-composer textarea').count(), 1);
    assert.equal(await page.locator('#attachmentButton').count(), 0);
    await screenshot(`conversation-${width}-${theme}`);
    await page.locator('#wb-chat .chat-chart').first().scrollIntoViewIfNeeded();
    await screenshot(`blocks-${width}-${theme}`);
    assert.equal((await page.locator('#wb-chat').innerText()).includes('[C4 messageId='), false);
  }
  await page.evaluate(() => localStorage.setItem('zylos-dashboard-locale', 'en'));
  await page.reload();
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  await select();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await screenshot('conversation-390-english');
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
  await page.locator(`#wb-chat [data-message-id="${incoming.id}"]`).waitFor({ timeout: 15_000 });
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
  await page.locator('#wb-chat [data-action="external"]').click();
  await page.locator('#wb-chat [data-conversation-id]').first().click();
  await page.locator('#wb-chat .chat-message').first().waitFor();
  assert.equal(await page.locator('#wb-chat textarea').count(), 0);
  assert.equal(await page.locator('#wb-chat [data-action="send"]').count(), 0);
  await screenshot('external-read-only');
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
  await fixture.convertToSingle();
  await page.goto(fixture.base + '/chat');
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  await select();
  assert.equal(await page.locator('#wb-chat [data-action="create"]').isVisible(), false);
  assert.equal(await page.locator('#wb-chat .chat-composer, #wb-chat .chat-question button').count(), 0);
  assert.equal(fixture.readMode(), 'single');
  await screenshot('single-read-only');
  assert.deepEqual(errors, []);
  if (output) fs.writeFileSync(path.join(output, 'conversation-browser.json'), JSON.stringify({ shots, reads, errors, base: fixture.base }, null, 2));
  t.diagnostic(`conversation browser: ${shots.length} screenshots, ${reads} actual message reads, no page errors`);
}
