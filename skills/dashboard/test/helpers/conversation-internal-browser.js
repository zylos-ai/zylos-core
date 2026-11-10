import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createChatApiFixture } from './chat-integration-api.js';
import { ChatChangeObserver } from '../../src/lib/chat/change-observer.js';
import { SseHub } from '../../src/lib/sse.js';
import { handleChatStream } from '../../src/lib/chat/stream.js';
import { sendJson } from '../../src/lib/http.js';

export async function runInternalConversationBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath));
  assert.ok(executablePath && fs.existsSync(executablePath));
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const hub = new SseHub(1000), events = [], reads = [], errors = [], shots = [];
  let observer;
  const send = hub.sendTo.bind(hub);
  hub.sendTo = (client, name, data) => {
    assert.ok(events.length < 200, 'bounded SSE event capture');
    events.push({ name, data }); return send(client, name, data);
  };
  sandbox.addCleanup(() => { observer?.close(); hub.closeAll(); });
  const fixture = await createChatApiFixture(t, sandbox, { name: 'Product design', extraHandler(req, res, url, f) {
    if (!url.pathname.startsWith('/api/')) return false;
    if (url.pathname === '/api/stream') {
      observer ??= new ChatChangeObserver({ c4Reader: f.reader, history: f.history, intervalMs: 100 });
      if (!handleChatStream(req, res, url, { auth: f.auth, config: f.config, hub, observer })) hub.addClient(res);
      return true;
    }
    const values = {
      '/api/session-mode': { data: { sessionMode: f.readMode() } },
      '/api/state': { state: 'idle', runtime: 'claude', session_mode: f.readMode(), agent: { id: 'test', name: 'Private browser' }, runtime_info: {} },
      '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' }, '/api/communication': {}, '/api/summary': {},
      '/api/timeline': { items: [] }, '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] },
    };
    sendJson(res, 200, values[url.pathname] || {}); return true;
  } });
  const mine = await fixture.createConversation('请整理需求，保留外部消息预览。');
  const mineGroup = mine.receipt.namespace + ':' + mine.draft.localId;
  const external = fixture.c4.insertConversation('in', 'telegram', 'relay-browser', '请协调发布进度。', { groupName: 'relay-browser' });
  const externalGroup = external.session_group, externalId = 'g:' + Buffer.from(externalGroup).toString('hex').toUpperCase();
  fixture.store.writeGroupDisplayName(mineGroup, '产品设计', 'human');
  fixture.store.writeGroupDisplayName(externalGroup, '发布协作', 'human');
  const outgoing = fixture.c4.insertInternalMessage(mineGroup, externalGroup, '请确认发布安排。');
  fixture.addOutbound(mine.draft.localId, '正在与发布会话确认安排。');
  fixture.c4.insertConversation('out', 'telegram', 'relay-browser', '收到，我来核对。', { groupName: 'relay-browser' });
  const hostile = '<img src=x onerror="window.internalHtmlExecuted=true"> **literal markdown**';
  const htmlPair = fixture.c4.insertInternalMessage(mineGroup, externalGroup, hostile);
  const incoming = fixture.c4.insertInternalMessage(externalGroup, mineGroup, '安排已确认，稍后发出通知。');
  fixture.c4.insertInternalMessage(mineGroup, externalGroup, '谢谢，请保留通知链接。');
  const { chromium } = await import(pathToFileURL(modulePath));
  console.info('Internal browser private targets:', JSON.stringify(sandbox.assertIsolation()), 'model/PM2/tmux unused');
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
  await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
  await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => { if (!errors.length) errors.push(error.message); });
  // Chromium's transport events identify the actual EventSource, including receipt
  // of chat_ready. A live badge from the previous selection cannot satisfy this.
  const transport = await context.newCDPSession(page);
  const requests = new Map(), pending = new Set(), received = [], completed = [];
  let sequence = 0;
  await transport.send('Network.enable');
  transport.on('Network.requestWillBeSent', ({ requestId, request }) => {
    const url = new URL(request.url);
    if (url.origin !== fixture.base) return;
    requests.set(requestId, url);
    if (url.pathname.startsWith('/api/chat/')) pending.add(requestId);
    if (url.pathname.endsWith('/messages')) {
      assert.ok(reads.length < 300, 'bounded message request capture');
      reads.push({ url: request.url, requestId, sequence: ++sequence });
    }
  });
  transport.on('Network.eventSourceMessageReceived', ({ requestId, eventName, data }) => {
    if (!eventName.startsWith('chat_')) return;
    assert.ok(received.length < 200, 'bounded browser SSE capture');
    received.push({ requestId, name: eventName, data: JSON.parse(data), sequence: ++sequence });
  });
  transport.on('Network.loadingFinished', ({ requestId }) => {
    pending.delete(requestId);
    const url = requests.get(requestId);
    if (url?.pathname.endsWith('/messages')) completed.push({ requestId, url, sequence: ++sequence });
    requests.delete(requestId);
  });
  transport.on('Network.loadingFailed', ({ requestId }) => { pending.delete(requestId); requests.delete(requestId); });
  const waitUntil = async (predicate, message) => {
    const deadline = Date.now() + 8000;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, message);
      await delay(20);
    }
  };
  const historyRead = (url, id, side) => url.pathname === `/api/chat/conversations/${encodeURIComponent(id)}/messages`
    && url.searchParams.get('tab') === side && url.searchParams.get('direction') === 'after' && url.searchParams.has('cursor');
  const selected = async id => page.waitForFunction(id => document.querySelector('#wb-chat [aria-current="true"]')?.dataset.conversationId === id, id);
  const row = id => page.locator(`#wb-chat [data-message-id="${id}"]`);
  const openMine = async () => {
    if (await page.locator('#wb-chat .conversation-back').isVisible()) await page.locator('#wb-chat .conversation-back').click();
    await page.locator('#wb-chat [data-action="mine"]').click();
    await page.locator(`#wb-chat [data-conversation-id="${mine.receipt.conversationId}"]`).click();
    await row(outgoing.outRow.id).waitFor();
  };
  for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await page.addInitScript(value => {
      if (window !== window.top) return;
      localStorage.setItem('zylos-dashboard-theme', value);
      localStorage.setItem('zylos-dashboard-locale', 'zh');
    }, theme);
    await page.goto(fixture.base + '/chat');
    await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    await openMine();
    for (const side of ['mine', 'external']) {
      const out = side === 'mine' ? outgoing.outRow : incoming.outRow;
      const received = side === 'mine' ? incoming.inRow : outgoing.inRow;
      await row(out.id).waitFor(); await row(received.id).waitFor();
      assert.match(await row(out.id).locator('.conversation-internal-label').innerText(), /内部.*→/);
      assert.match(await row(received.id).locator('.conversation-internal-label').innerText(), /内部.*←/);
      assert.equal(await row(received.id).locator('.conversation-internal-content').innerText(), side === 'mine' ? '安排已确认，稍后发出通知。' : '请确认发布安排。');
      assert.equal(await row(received.id).locator('.conversation-internal-raw').isVisible(), false);
      assert.equal(await row(out.id).locator('.conversation-message-status, .conversation-message-author').count(), 0);
      assert.equal(await row(out.id).locator('.conversation-internal-raw').evaluate(raw => raw.hidden), true, 'outbound detail does not repeat the body');
      const html = row(side === 'mine' ? htmlPair.outRow.id : htmlPair.inRow.id).locator('.conversation-internal-content');
      assert.equal(await html.innerText(), hostile);
      assert.equal(await html.locator('*').count(), 0, 'HTML body creates no elements');
      assert.equal(await page.evaluate(() => window.internalHtmlExecuted), undefined);
      await page.locator('#wb-chat .chat-notice').filter({ hasText: '正在读取问题状态…' }).waitFor({ state: 'hidden' });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no document overflow');
      for (const message of [out, received]) {
        const geometry = await row(message.id).locator('.conversation-internal-body').evaluate(body => {
          const column = body.closest('.conversation-message-list').getBoundingClientRect();
          const box = body.getBoundingClientRect();
          return { center: (box.left + box.right) / 2, columnCenter: (column.left + column.right) / 2 };
        });
        assert.ok(Math.abs(geometry.center - geometry.columnCenter) <= 2,
          `${side} ${width} ${theme}: internal body centered in message column (${JSON.stringify(geometry)})`);
      }
      const boxes = await page.locator('.conversation-internal-body').evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right, width: node.clientWidth, scroll: node.scrollWidth })));
      for (const box of boxes) { assert.ok(box.left >= 0 && box.right <= width + 1); assert.ok(box.scroll <= box.width + 1); }
      if (output) { const file = path.join(output, `internal-${side}-${width}-${theme}.png`); await page.screenshot({ path: file }); shots.push(file); }
      await row(out.id).locator('button.conversation-internal-peer').click();
      await selected(side === 'mine' ? externalId : mine.receipt.conversationId);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 }); await openMine();
  // Both selected histories must consume a real observer hint and then read authoritative rows.
  for (const side of ['mine', 'external']) {
    const id = side === 'mine' ? mine.receipt.conversationId : externalId;
    await selected(id);
    let ready;
    await waitUntil(async () => {
      ready = received.findLast(event => event.name === 'chat_ready' && event.data.conversationId === id && event.data.tab === side
        && requests.get(event.requestId)?.searchParams.get('chat_conversation') === id
        && requests.get(event.requestId)?.searchParams.get('chat_tab') === side);
      if (!ready || pending.size || !completed.some(read => read.sequence > ready.sequence && historyRead(read.url, id, side))) return false;
      const live = await page.evaluate(async id => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return document.querySelector('#wb-chat [aria-current="true"]')?.dataset.conversationId === id
          && document.querySelector('.conversation-push-status')?.dataset.streamState === 'live';
      }, id);
      return live && pending.size === 0;
    }, `${side}: new subscription received chat_ready and initial/admission reads settled`);
    const eventCount = events.length, readCount = reads.length, receivedCount = received.length;
    const pair = fixture.c4.insertInternalMessage(mineGroup, externalGroup, `实时传话 ${side}`);
    await row(side === 'mine' ? pair.outRow.id : pair.inRow.id).waitFor({ timeout: 4000 });
    const hint = received.slice(receivedCount).find(event => event.requestId === ready.requestId
      && event.name === 'chat_messages_changed' && event.data.conversationId === id && event.data.tab === side);
    assert.ok(hint, 'selected subscription receives real SSE history hint');
    assert.ok(events.slice(eventCount).some(event => event.name === hint.name && event.data.conversationId === id
      && event.data.tab === side), 'real observer emitted selected-history hint');
    assert.ok(reads.slice(readCount).some(read => read.sequence > hint.sequence && historyRead(new URL(read.url), id, side)),
      'selected subscription hint triggers authoritative after-cursor read');
    if (side === 'mine') await row(pair.outRow.id).locator('button.conversation-internal-peer').click();
  }
  // Imported malformed prefixes remain literal; non-navigable peers remain inert.
  const malformed = fixture.c4.insertInternalMessage(mineGroup, externalGroup, 'Malformed source');
  const literal = '[internal] Yourself, from your "wrong-peer" session group, said: literal text';
  fixture.db.prepare('UPDATE conversations SET content=? WHERE id=?').run(literal, malformed.inRow.id);
  const missing = fixture.c4.insertInternalMessage(mineGroup, externalGroup, 'Peer no longer available');
  fixture.db.prepare('UPDATE conversations SET endpoint_id=? WHERE id=?').run('telegram:missing-peer', missing.inRow.id);
  await row(malformed.inRow.id).waitFor(); await row(missing.inRow.id).waitFor();
  assert.equal(await row(malformed.inRow.id).locator('.conversation-internal-content').innerText(), literal);
  assert.equal(await row(missing.inRow.id).locator('button.conversation-internal-peer').count(), 0);
  assert.equal(await row(missing.inRow.id).locator('.conversation-internal-peer').innerText(), 'telegram:missing-peer');
  assert.equal(await row(missing.inRow.id).locator('.conversation-internal-missing').isVisible(), true);
  // A long unbroken peer name and body must wrap inside a narrow conversation.
  const longName = 'Relay'.repeat(60), longBody = 'unbroken-message-'.repeat(80);
  fixture.store.writeGroupDisplayName(mineGroup, longName, 'human');
  const longPair = fixture.c4.insertInternalMessage(mineGroup, externalGroup, longBody);
  await page.setViewportSize({ width: 390, height: 844 });
  await row(longPair.inRow.id).waitFor();
  assert.equal(await row(longPair.inRow.id).locator('.conversation-internal-peer').innerText(), longName);
  assert.equal(await row(longPair.inRow.id).locator('.conversation-internal-content').innerText(), longBody);
  const longBoxes = await row(longPair.inRow.id).locator('.conversation-internal-body, .conversation-internal-peer, .conversation-internal-content')
    .evaluateAll(nodes => nodes.map(node => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      width: node.clientWidth, scroll: node.scrollWidth })));
  for (const box of longBoxes) { assert.ok(box.left >= 0 && box.right <= 391); assert.ok(box.scroll <= box.width + 1); }
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  assert.equal(errors.length, 0, errors[0]);
  if (output) fs.writeFileSync(path.join(output, 'internal-browser.json'), JSON.stringify({ shots, reads: reads.length, events: events.map(event => ({ name: event.name, conversationId: event.data.conversationId })),
    received: received.map(event => ({ requestId: event.requestId, name: event.name, tab: event.data.tab, conversationId: event.data.conversationId, sequence: event.sequence })), errors }, null, 2));
  t.diagnostic(`internal browser: ${shots.length} screenshots, ${reads.length} message reads, both histories navigate and receive live SSE`);
}
