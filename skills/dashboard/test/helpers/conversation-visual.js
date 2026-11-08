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
  const errors = [], shots = [], composerMeasurements = [];
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
      await page.locator('#wb-chat [data-action="create"]').click();
      const nameBox = await page.locator('#wb-chat .conversation-create-form input').boundingBox();
      assert.ok(nameBox && nameBox.height >= 40, 'new conversation name has a 40px phone height');
      await page.locator('#wb-chat .conversation-create-form [data-action="page.cancel"]').click();
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
  // Measure the last line's actual layout in a mirror with identical textarea styles.
  // A textarea has no DOM text ranges; each mirror line supplies a measurable line box.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    if (width === 390) await page.locator('#wb-chat .conversation-back').click();
    await select();
    const editor = page.locator('#wb-chat .chat-composer textarea');
    for (const [name, value] of [['empty', ''], ['one-line', 'A short line'], ['multi-line', 'First line\nSecond line\nThird line\nFourth line\nLast line']]) {
      await editor.fill(value);
      const measurement = await editor.evaluate(el => {
        const bounds = el.getBoundingClientRect(), style = getComputedStyle(el);
        const mirror = document.createElement('div');
        for (const property of ['boxSizing', 'font', 'lineHeight', 'letterSpacing', 'padding', 'border', 'whiteSpace', 'wordBreak', 'overflowWrap']) mirror.style[property] = style[property];
        Object.assign(mirror.style, { position: 'fixed', top: bounds.top + 'px', left: bounds.left + 'px', width: bounds.width + 'px', height: bounds.height + 'px', overflow: 'hidden', visibility: 'hidden' });
        for (const line of (el.value || '\u200b').split('\n')) {
          const row = document.createElement('div');
          row.textContent = line || '\u200b';
          mirror.append(row);
        }
        document.body.append(mirror);
        mirror.scrollTop = el.scrollTop;
        const first = mirror.firstElementChild.getBoundingClientRect();
        const last = mirror.lastElementChild.getBoundingClientRect();
        const button = el.parentElement.querySelector('[data-action="send"]').getBoundingClientRect();
        const result = { height: bounds.height, lineHeight: parseFloat(style.lineHeight), lineCenter: (last.top + last.bottom) / 2,
          buttonCenter: (button.top + button.bottom) / 2, firstTop: first.top, lastBottom: last.bottom,
          inputTop: bounds.top, inputBottom: bounds.bottom, inputRight: bounds.right, buttonLeft: button.left,
          buttonTop: button.top, buttonBottom: button.bottom, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
        mirror.remove();
        return result;
      });
      assert.ok(Math.abs(measurement.lineCenter - measurement.buttonCenter) <= 2, `${width} ${name}: send aligns with last line: ${JSON.stringify(measurement)}`);
      assert.ok(measurement.firstTop >= measurement.inputTop && measurement.lastBottom <= measurement.inputBottom + 1, `${width} ${name}: all lines remain visible`);
      assert.ok(measurement.inputRight <= measurement.buttonLeft && measurement.buttonTop >= measurement.inputTop - 1 && measurement.buttonBottom <= measurement.inputBottom + 1, `${width} ${name}: send stays beside the editor`);
      if (name === 'multi-line') assert.ok(measurement.height > 4 * measurement.lineHeight, 'editor grows beyond its initial line');
      else assert.ok(measurement.height <= (width === 390 ? 41 : 31), 'empty and one-line editors keep a one-line height');
      composerMeasurements.push({ width, name, ...measurement });
      await screenshot(`composer-${width}-${name}`);
    }
    await editor.fill(Array.from({ length: 20 }, (_, index) => `Line ${index + 1}`).join('\n'));
    assert.equal(await editor.evaluate(el => el.getBoundingClientRect().height <= 180 && el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === 'auto'), true, 'long editor is capped and scrolls internally');
    await editor.fill('');
  }
  // Width-only resizing can grow a wrapped draft without changing the page height.
  // Preserve both bottom pinning and a reader's visible row across that editor resize.
  const resizeMeasurements = [], typingMeasurements = [];
  const settleLayout = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const placeholderMeasurements = [];
  const checkPlaceholder = async expected => {
    const measurement = await page.locator('#wb-chat .chat-composer textarea').evaluate(el => {
      const style = getComputedStyle(el), context = document.createElement('canvas').getContext('2d');
      context.font = style.font;
      return { text: el.placeholder, textWidth: context.measureText(el.placeholder).width,
        availableWidth: el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) };
    });
    assert.equal(measurement.text, expected);
    assert.ok(measurement.textWidth <= measurement.availableWidth, 'phone placeholder is fully visible on one line');
    placeholderMeasurements.push(measurement);
  };
  // Real keyboard input changes the editor height while the viewport stays fixed.
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await settleLayout();
    const editor = page.locator('#wb-chat .chat-composer textarea');
    if (width === 390) await checkPlaceholder('发消息给 AI');
    for (const reading of [false, true]) {
      await editor.fill('');
      const before = await page.locator('#wb-chat .chat-messages').evaluate((el, reading) => {
        el.scrollTop = reading ? 90 : el.scrollHeight;
        const bounds = el.getBoundingClientRect();
        const anchor = [...el.querySelectorAll('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > bounds.top);
        return { anchor: anchor.dataset.messageId, top: anchor.getBoundingClientRect().top, clientHeight: el.clientHeight };
      }, reading);
      await editor.focus();
      const lineMeasurements = [];
      for (let line = 1; line <= 6; line++) {
        if (line > 1) await page.keyboard.press('Enter');
        await page.keyboard.type(`Reply line ${line}`);
        const measurement = await page.locator('#wb-chat .chat-messages').evaluate((el, anchor) => {
          const bounds = el.getBoundingClientRect();
          const last = el.querySelector('.conversation-message-list').lastElementChild.getBoundingClientRect();
          return { gap: el.scrollHeight - el.scrollTop - el.clientHeight, clientHeight: el.clientHeight,
            lastBottom: last.bottom, viewportTop: bounds.top, viewportBottom: bounds.bottom,
            anchorTop: el.querySelector(`[data-message-id="${anchor}"]`).getBoundingClientRect().top };
        }, before.anchor);
        if (reading) assert.ok(Math.abs(measurement.anchorTop - before.top) < 2, `${width} line ${line}: typing preserves historical reading anchor`);
        else {
          assert.ok(measurement.gap <= 2, `${width} line ${line}: typing preserves bottom pinning`);
          assert.ok(measurement.lastBottom >= measurement.viewportTop && measurement.lastBottom <= measurement.viewportBottom + 1, `${width} line ${line}: newest message bottom remains visible`);
        }
        lineMeasurements.push(measurement);
      }
      assert.ok(lineMeasurements.at(-1).clientHeight < before.clientHeight, 'six typed lines actually shrink the history viewport');
      typingMeasurements.push({ width, reading, before, lines: lineMeasurements });
      await screenshot(`typing-${width}-${reading ? 'history' : 'bottom'}`);
    }
    await editor.fill('');
  }
  for (const reading of [false, true]) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await settleLayout();
    const editor = page.locator('#wb-chat .chat-composer textarea');
    const draft = await editor.evaluate(el => {
      const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
      context.font = getComputedStyle(el).font;
      let value = 'Draft';
      while (context.measureText(value + ' keeps context').width < el.clientWidth - 70) value += ' keeps context';
      return value;
    });
    await editor.fill(draft);
    await settleLayout();
    const before = await page.locator('#wb-chat .chat-messages').evaluate((el, reading) => {
      el.scrollTop = reading ? 90 : el.scrollHeight;
      const bounds = el.getBoundingClientRect();
      const anchor = [...el.querySelectorAll('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > bounds.top);
      return { anchor: anchor.dataset.messageId, top: anchor.getBoundingClientRect().top,
        height: document.querySelector('#wb-chat .chat-composer textarea').getBoundingClientRect().height,
        pageHeight: document.querySelector('#wb-chat .conversation-page').getBoundingClientRect().height };
    }, reading);
    await page.setViewportSize({ width: 1280, height: 900 });
    await settleLayout();
    const after = await page.locator('#wb-chat .chat-messages').evaluate((el, anchor) => ({
      gap: el.scrollHeight - el.scrollTop - el.clientHeight,
      top: el.querySelector(`[data-message-id="${anchor}"]`).getBoundingClientRect().top,
      height: document.querySelector('#wb-chat .chat-composer textarea').getBoundingClientRect().height,
      pageHeight: document.querySelector('#wb-chat .conversation-page').getBoundingClientRect().height
    }), before.anchor);
    assert.equal(after.pageHeight, before.pageHeight, 'resize exercises an unchanged available page height');
    assert.ok(after.height > before.height, 'narrowing the viewport grows the wrapped draft');
    if (reading) assert.ok(Math.abs(after.top - before.top) < 2, 'wrapped editor resize retains the reading anchor');
    else assert.ok(after.gap <= 2, 'wrapped editor resize retains bottom pinning');
    resizeMeasurements.push({ reading, before, after });
    await editor.fill('');
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem('zylos-dashboard-locale', 'en'));
  await page.reload();
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  await select();
  assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
  await checkPlaceholder('Message your agent');
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
  if (output) fs.writeFileSync(path.join(output, 'conversation-browser.json'), JSON.stringify({ shots, reads, errors, composerMeasurements, resizeMeasurements, typingMeasurements, placeholderMeasurements, base: fixture.base }, null, 2));
  t.diagnostic(`conversation browser: ${shots.length} screenshots, ${reads} actual message reads, no page errors`);
}
