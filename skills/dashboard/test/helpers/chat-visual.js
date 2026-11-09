import strictAssert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChatApiFixture, protocolFixtures, questionContent } from './chat-integration-api.js';
import { sendJson } from '../../src/lib/http.js';
import { CONTENT_PREFIX } from '../../../comm-bridge/scripts/c4-content-schema.js';

// Actual application HTML/ESM/CSS, real HTTP chat middleware and private DBs.
// Other dashboard panes receive a bounded operational fixture, never live data.
// Run for chat UI/history changes; requires the explicit integration gate and
// an installed Playwright module/browser supplied by the caller. No downloads.
export async function runVisualCase(t, sandbox) {
  let assertions = 0;
  const assert = new Proxy(strictAssert, { get(target, key) {
    if (typeof target[key] !== 'function') return target[key];
    return (...args) => { assertions++; return target[key](...args); };
  } });
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE;
  const executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath), 'Supply the installed Playwright module path');
  assert.ok(executablePath && fs.existsSync(executablePath), 'Supply the installed browser path');
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const { chromium } = await import(pathToFileURL(modulePath));
  const fixture = await createChatApiFixture(t, sandbox, { name: 'Visual conversation', extraHandler(req, res, url, f) {
    if (!url.pathname.startsWith('/api/') || url.pathname.startsWith('/api/chat/')) return false;
    const values = {
      '/api/session-mode': { data: { sessionMode: f.readMode() } },
      '/api/state': { state: 'idle', runtime: 'claude', session_mode: f.readMode(), agent: { id: 'test', name: 'Isolated browser' }, runtime_info: {} },
      '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' },
      '/api/communication': {}, '/api/summary': {}, '/api/timeline': { items: [] },
      '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] },
    };
    if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
    sendJson(res, 200, values[url.pathname] || {}); return true;
  } });
  // More than one server page of groups, messages and question states.
  for (let index = 0; index < 52; index++) fixture.conversations.create({ displayName: `Empty draft ${index}` });
  const first = await fixture.createConversation('First text in the original group');
  const localId = first.draft.localId;
  const conversation = fixture.conversations.get(localId);
  for (let index = 0; index < 55; index++) fixture.addOutbound(localId, `Older body row ${index}`);
  const make = (name, suffix) => {
    const envelope = structuredClone(protocolFixtures.valid.find(item => item.name === name).envelope);
    envelope.messageId += `_${suffix}`;
    if (envelope.interruptId) envelope.interruptId += `_${suffix}`;
    return envelope;
  };
  const gallery = [];
  for (const name of ['markdown', 'time_series', 'breakdown', 'category_series', 'single', 'multiple', 'confirmation', 'form']) {
    const envelope = make(name, 'gallery');
    const row = fixture.addOutbound(localId, questionContent(envelope)); gallery.push({ envelope, row });
  }
  const accepted = make('single', 'answered'); fixture.addOutbound(localId, questionContent(accepted));
  const answer = fixture.answer(accepted, 'visual-accepted-action');
  assert.equal((await fixture.request(first.route + '/answers', { method: 'POST', body: answer })).status, 200);
  const replacement = make('single', 'replacement'); fixture.addOutbound(localId, questionContent(replacement));
  for (const operation of ['stop', 'replace']) {
    const question = make('single', operation); fixture.addOutbound(localId, questionContent(question));
    fixture.addOutbound(localId, questionContent({ version: 1, kind: 'control', messageId: `visual-control-${operation}`,
      fallbackText: `Explicit ${operation}`, interruptId: question.interruptId,
      control: { operation, messageId: question.messageId, ...(operation === 'replace' ? { replacementInterruptId: replacement.interruptId } : {}) } }));
  }
  // Historic bad packet remains readable; it is not sent through a permissive
  // fake hook. Product BeforeSend rejects new bad packets as intended.
  fixture.c4.insertConversation('out', 'dashboard', localId, CONTENT_PREFIX + '{historic-bad-packet', { groupName: localId });
  let unknownInputId;
  for (const [direction, status, content] of [['in', 'pending', 'Waiting for runtime'], ['in', 'failed', 'Failed delivery'],
    ['out', 'failed', 'Unknown outbound state'], ['in', 'unknown', 'Unknown authority state']]) {
    const row = fixture.c4.insertConversation(direction, 'dashboard', localId, content, { groupName: localId });
    fixture.db.prepare('UPDATE conversations SET status=? WHERE id=?').run(status, row.id);
    if (direction === 'in' && status === 'unknown') unknownInputId = row.id;
  }
  // More than 50 registered questions whose messages are older than the newest
  // body page: page loading must not fabricate unregistered status.
  for (let index = 0; index < 52; index++) fixture.addOutbound(localId, questionContent(make('single', `extra_${index}`)));
  fixture.c4.insertConversation('out', 'telegram', 'external-history', questionContent(make('single', 'external')),
    { groupName: 'external-history' });
  sandbox.assertIsolation();
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const errors = [], screenshotPaths = [];
  let expectedChatDenial = false;
  const context = await browser.newContext();
  await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie,
    domain: '127.0.0.1', path: '/', secure: true }]);
  const page = await context.newPage();
  const firstError = message => {
    if (errors.length) return;
    errors.push(message);
    void page.close();
  };
  page.on('pageerror', error => firstError(error.message));
  page.on('console', message => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) firstError(message.text()); });
  page.on('response', response => {
    const pathname = new URL(response.url()).pathname;
    if (response.status() >= 400 && pathname !== '/favicon.ico'
      && !(expectedChatDenial && response.status() === 403 && pathname.includes('/api/chat/'))) firstError(`${response.status()} ${pathname}`);
  });
  page.setDefaultTimeout(10_000);
  async function save(name, fullPage = true) {
    const overflow = await page.evaluate(() => ({ width: window.innerWidth, scroll: document.documentElement.scrollWidth,
      nodes: [...document.querySelectorAll('#wb-chat *')].filter(node => {
        const box = node.getBoundingClientRect(); return box.width > 0 && (box.left < -1 || box.right > window.innerWidth + 1);
      }).slice(0, 6).map(node => ({ tag: node.tagName, className: node.className })) }));
    assert.ok(overflow.scroll <= overflow.width + 1, JSON.stringify(overflow));
    assert.equal(overflow.nodes.length, 0, JSON.stringify(overflow));
    if (output) { const target = path.join(output, `${name}.png`); await page.screenshot({ path: target, fullPage }); screenshotPaths.push(target); }
  }
  try {
    for (const width of [390, 1440]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript(theme => { if (window === window.top) localStorage.setItem('zylos-dashboard-theme', theme); }, theme);
      await page.goto(fixture.base + '/chat');
      await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      await page.locator('[data-action="loadMore"]').waitFor({ state: 'visible' });
      let groupPages = 0;
      // Pagination controls stay mounted; cursor exhaustion hides them.
      while (await page.locator('[data-action="loadMore"]').isVisible()) {
        assert.ok(++groupPages <= 3, 'Group pagination must terminate');
        const before = await page.locator('[data-conversation-id]').count();
        await page.locator('[data-action="loadMore"]').click();
        await page.waitForFunction(before => document.querySelectorAll('[data-conversation-id]').length > before, before);
      }
      assert.ok(groupPages > 0, 'Group pagination must load another page');
      assert.equal(await page.locator('[data-conversation-id]').count(), 53);
      await page.locator(`[data-conversation-id="${first.receipt.conversationId}"]`).click();
      await page.locator('#wb-chat .chat-message').first().waitFor();
      await page.locator('[data-action="loadOlder"]').waitFor({ state: 'visible' });
      assert.equal(await page.locator('[data-action="loadMore"]').isVisible(), false);
      await page.locator('[data-action="loadMoreQuestions"]').waitFor({ state: 'visible' });
      await page.locator('[data-action="loadMoreQuestions"]').click();
      await page.locator('[data-action="loadMoreQuestions"]').waitFor({ state: 'hidden' });
      let older = 0;
      while (await page.locator('[data-action="loadOlder"]').isVisible()) {
        assert.ok(++older <= 4, 'Message pagination must terminate');
        const before = await page.locator('.chat-message').count();
        await page.locator('[data-action="loadOlder"]').click();
        await page.waitForFunction(before => document.querySelectorAll('.chat-message').length > before, before);
      }
      assert.ok(older > 0, 'Message pagination must load another page');
      await page.waitForFunction(() => document.querySelectorAll('.chat-block').length >= 8);
      // Check each gallery message by its authoritative row, so the many
      // additional choice questions cannot mask a missing block or chart.
      for (const { envelope, row } of gallery) {
        const message = page.locator(`.chat-message[data-message-id="${row.id}"]`);
        assert.equal(await message.count(), 1);
        for (const block of envelope.blocks) {
          const part = message.locator(`.chat-block[data-block-id="${block.id}"]`);
          assert.equal(await part.count(), 1);
          assert.equal(await part.getAttribute('data-block-type'), block.type);
          if (block.type === 'markdown') {
            // Markdown consumes the fixture's escaped quote; HTML stays inert text.
            assert.equal(await part.locator('.chat-message-text').innerText(), '嵌套 { 字符 } 与 " 引号；<img onerror="bad()">');
            assert.equal(await part.locator('img').count(), 0);
          } else if (['time_series', 'breakdown', 'category_series'].includes(block.type)) {
            const series = block.type === 'time_series' ? block.data.series
              : [{ points: (block.data.parts ?? block.data.points).map(point => ({ x: point.label, y: point.value })) }];
            const points = series.flatMap(entry => entry.points);
            assert.equal(await part.locator('.chat-chart').count(), 1);
            assert.equal(await part.locator('.chat-chart-table').count(), series.length);
            assert.equal(await part.locator('.chat-chart-value').count(), points.length);
            const labels = await part.locator('.chat-chart-label').allTextContents();
            assert.equal(labels.length, points.length);
            for (let index = 0; index < points.length; index++) assert.equal(labels[index], String(points[index].x));
          } else if (block.type === 'choice') {
            const kind = block.data.selection === 'multiple' ? 'checkbox' : 'radio';
            assert.equal(await part.locator(`.chat-question-options input[type="${kind}"]`).count(), block.data.options.length);
            assert.equal(await part.locator('[data-action="answer"]').isEnabled(), true);
          } else if (block.type === 'confirmation') {
            assert.equal(await part.locator('[data-action="confirmAnswer"]').isEnabled(), true);
            assert.equal(await part.locator('[data-action="cancelAnswer"]').isEnabled(), true);
          } else if (block.type === 'form_intent') {
            assert.equal(await part.locator('.chat-question-field').count(), block.data.fields.length);
            for (const field of block.data.fields) assert.equal(await part.getByLabel(field.label, { exact: true }).isEnabled(), true);
            assert.equal(await part.locator('[data-action="answer"]').isEnabled(), true);
          }
        }
      }
      const body = await page.locator('#wb-chat').innerText();
      const locale = await page.evaluate(() => document.documentElement.lang);
      const labels = JSON.parse(fs.readFileSync(new URL(`../../public/i18n/wb.${locale.startsWith('zh') ? 'zh' : 'en'}.json`, import.meta.url), 'utf8'));
      for (const key of ['chat.question.answered', 'chat.question.stopped', 'chat.question.superseded',
        'chat.page.delivery.pending', 'chat.page.delivery.failed', 'chat.page.delivery.pending_reconciliation']) assert.ok(body.includes(labels[key]), key);
      assert.equal(await page.locator('.chat-block-error').count(), 1);
      assert.ok(body.includes('historic-bad-packet') === false);
      assert.ok(await page.locator('[data-action="answer"]').count() + await page.locator('[data-action="confirmAnswer"]').count());
      await save(`chat-${width}-${theme}`);
      await page.locator('.chat-block').first().scrollIntoViewIfNeeded();
      await save(`gallery-detail-${width}-${theme}`, false);
      await page.locator('.chat-question-status').filter({ hasText: labels['chat.question.stopped'] }).first().scrollIntoViewIfNeeded();
      await save(`lifecycle-detail-${width}-${theme}`, false);
      if (width === 390) await page.locator('[data-action="page.back"]').click();
      await page.locator('[data-action="external"]').click();
      await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
      await page.locator('#wb-chat [data-conversation-id]').first().click();
      await page.locator('#wb-chat .chat-question').waitFor();
      assert.equal(await page.locator('[data-action="send"]').count(), 0);
      assert.equal(await page.locator('.chat-question button').count(), 0);
      await save(`external-readonly-${width}-${theme}`);
      if (width === 390) await page.locator('[data-action="page.back"]').click();
      await page.locator('[data-action="mine"]').click();
      await page.locator('[data-conversation-id^="d:"]').first().waitFor();
      await page.locator('[data-conversation-id^="d:"]').first().click();
      await page.waitForFunction(() => !document.querySelector('.chat-message') && document.querySelector('.chat-composer'));
      await save(`empty-draft-${width}-${theme}`);
    }
    // The real fleet page uses the API credential at its data boundary. The
    // local browser cookie is only the viewing instance's identity.
    fixture.setProxy(fixture);
    const toggle = async allowRemote => {
      const result = await fixture.request('/api/chat/settings', { method: 'PUT', body: { allowRemote } });
      assert.equal(result.status, 200);
    };
    for (const operation of ['refresh', 'refreshMessages', 'switchGroup']) {
      await toggle(true);
      await page.goto(fixture.base + '/fleet/Remote/chat');
      await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
      for (let n = 0; n < 3 && await page.locator('[data-action="loadMore"]').isVisible(); n++) {
        const before = await page.locator('[data-conversation-id]').count();
        await page.locator('[data-action="loadMore"]').click();
        await page.waitForFunction(before => document.querySelectorAll('[data-conversation-id]').length > before, before);
      }
      await page.locator(`[data-conversation-id="${first.receipt.conversationId}"]`).click();
      await page.locator('.chat-message').first().waitFor();
      expectedChatDenial = true;
      await toggle(false);
      if (operation === 'switchGroup') await page.locator('[data-conversation-id^="d:"]').first().click();
      else await page.locator(`[data-action="${operation}"]`).click();
      await page.waitForFunction(() => document.querySelector('#wb-chat')?.children.length === 1
        && document.querySelector('#wb-chat > .chat-notice'));
      assert.equal(await page.locator('#wb-chat [data-conversation-id], #wb-chat button, #wb-chat .chat-message').count(), 0);
      const notice = await page.locator('#wb-chat').innerText();
      assert.match(notice, /未开放|not enabled|not available|disabled/i);
      await save(`remote-closed-${operation}`);
      expectedChatDenial = false;
    }
    // The synthetic unknown status has been rendered; restore a drainable
    // fixture input before exercising the real mode-switch checkpoint.
    fixture.db.prepare('UPDATE conversations SET status=? WHERE id=?').run('pending', unknownInputId);
    await fixture.convertToSingle();
    await page.goto(fixture.base + '/chat');
    await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    assert.equal(await page.locator('[data-action="create"]').isVisible(), true);
    assert.equal(await page.locator('[data-action="create"]').isEnabled(), false);
    for (let n = 0; n < 3 && await page.locator('[data-action="loadMore"]').isVisible(); n++) {
      const before = await page.locator('[data-conversation-id]').count();
      await page.locator('[data-action="loadMore"]').click();
      await page.waitForFunction(before => document.querySelectorAll('[data-conversation-id]').length > before, before);
    }
    await page.locator(`[data-conversation-id="${first.receipt.conversationId}"]`).click();
    await page.locator('.chat-message').first().waitFor();
    assert.equal(await page.locator('.chat-question button').count(), 0);
    assert.equal(await page.locator('.chat-composer').isVisible(), true);
    assert.equal(await page.locator('[data-action="send"]').isEnabled(), false);
    assert.equal(await page.locator('.chat-input').isEnabled(), false);
    assert.match(await page.locator('#wb-chat').innerText(), /multi/);
    assert.equal(fixture.readMode(), 'single');
    await save('single-readonly');
    assert.equal(errors.length, 0, errors.join('\n'));
    t.diagnostic(JSON.stringify({ assertions, screenshots: screenshotPaths, evidence: 'Actual application HTML/ESM/CSS and real chat HTTP/SQLite; nonchat operational fixtures; no model runtime', gallery: gallery.length, originalGroup: conversation.sessionGroup }));
  } catch (error) {
    t.diagnostic(JSON.stringify({ url: page.url(), errors, body: page.isClosed() ? 'Closed at first browser counterexample' : (await page.locator('body').innerText()).slice(0, 2500) }));
    throw error;
  } finally { await context.close(); await browser.close(); }
}
