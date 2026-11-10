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
  const hub = new SseHub(1000), events = [], reads = [], errors = [], shots = [], layouts = [];
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
  const checkPeerHits = async (peer, horizontal = false) => {
    await peer.scrollIntoViewIfNeeded();
    const target = await peer.evaluate(button => {
      const box = button.getBoundingClientRect();
      const x = (box.left + box.right) / 2, y = (box.top + box.bottom) / 2;
      const points = [
        ['top', x, box.top + 2], ['bottom', x, box.bottom - 2],
        ['left', box.left + 2, y], ['right', box.right - 2, y],
      ];
      return { width: box.width, height: box.height, hits: points.map(([edge, x, y]) => {
        const hit = document.elementFromPoint(x, y);
        return { edge, hit: hit !== null && button.contains(hit) };
      }) };
    });
    for (const point of target.hits.slice(0, horizontal ? 4 : 2)) {
      assert.equal(point.hit, true, `mobile peer button ${point.edge} inner edge receives pointer hits`);
    }
    return target;
  };
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
      assert.equal(await row(out.id).locator('.conversation-internal-label').innerText(), '发给');
      assert.equal(await row(received.id).locator('.conversation-internal-label').innerText(), '来自');
      assert.doesNotMatch(await row(out.id).locator('.conversation-internal-heading').innerText(), /内部|→|←/);
      assert.doesNotMatch(await row(received.id).locator('.conversation-internal-heading').innerText(), /内部|→|←/);
      assert.equal(await row(received.id).locator('.conversation-internal-content').innerText(), side === 'mine' ? '安排已确认，稍后发出通知。' : '请确认发布安排。');
      assert.equal(await row(received.id).locator('.conversation-internal-raw').isVisible(), false);
      assert.equal(await row(out.id).locator('.conversation-message-status, .chat-message-author').count(), 0);
      assert.equal(await row(out.id).locator('.conversation-internal-raw').evaluate(raw => raw.hidden), true, 'outbound detail does not repeat the body');
      const html = row(side === 'mine' ? htmlPair.outRow.id : htmlPair.inRow.id).locator('.conversation-internal-content');
      assert.equal(await html.innerText(), hostile);
      assert.equal(await html.locator('*').count(), 0, 'HTML body creates no elements');
      assert.equal(await page.evaluate(() => window.internalHtmlExecuted), undefined);
      await page.locator('#wb-chat .chat-notice').filter({ hasText: '正在读取问题状态…' }).waitFor({ state: 'hidden' });
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), theme);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no document overflow');
      // The fixture contains ordinary input and output in both histories. Compare
      // visible bubble edges, not a direction class or a centered wrapper alone.
      // This also checks shared shape/width/timestamp layout and actual AA colors.
      for (const [message, direction] of [[out, 'out'], [received, 'in']]) {
        const ordinary = page.locator(`#wb-chat .conversation-message.chat-${direction}:not(.conversation-internal)`).first();
        await ordinary.waitFor();
        assert.ok((await ordinary.innerText()).includes(side === 'mine'
          ? direction === 'in' ? '请整理需求，保留外部消息预览。' : '正在与发布会话确认安排。'
          : direction === 'in' ? '请协调发布进度。' : '收到，我来核对。'), 'same-side ordinary reference is present');
        const measure = (article, direction) => {
          const body = article.querySelector('.conversation-message-body');
          const bubble = article.querySelector(direction === 'in' ? '.chat-message-content' : '.chat-message-content > .chat-message-text');
          const text = article.querySelector('.chat-message-text');
          const meta = article.querySelector('.conversation-message-meta');
          const time = meta?.querySelector('time');
          const spacer = article.querySelector('.conversation-internal-spacer');
          const peer = article.querySelector('button.conversation-internal-peer')?.getBoundingClientRect();
          if (!body || !bubble || !text || !meta || !time) throw Error('ordinary-compatible internal bubble and timestamp structure required');
          const column = article.closest('.conversation-message-list').getBoundingClientRect();
          const box = bubble.getBoundingClientRect();
          const style = getComputedStyle(bubble), metaStyle = getComputedStyle(meta), timeStyle = getComputedStyle(time);
          const metaBox = meta.getBoundingClientRect(), timeBox = time.getBoundingClientRect();
          const authorBox = meta.firstElementChild.getBoundingClientRect();
          return {
            left:box.left - column.left, right:column.right - box.right,
            maxWidth:getComputedStyle(body).maxWidth,
            radius:style.borderRadius, padding:style.padding,
            background:style.backgroundColor, color:getComputedStyle(text).color,
            metaDirection:metaStyle.flexDirection, metaGap:metaStyle.gap,
            timeMargin:timeStyle.margin, timeFontSize:timeStyle.fontSize,
            metaHeight:metaBox.height, timeCenterOffset:(timeBox.top + timeBox.bottom - metaBox.top - metaBox.bottom) / 2,
            timeSide:timeBox.right <= authorBox.left + 1 ? 'left' : timeBox.left >= authorBox.right - 1 ? 'right' : 'overlap',
            spacerVisibility:spacer ? getComputedStyle(spacer).visibility : null,
            peerHeight:peer?.height ?? null, peerWidth:peer?.width ?? null,
          };
        };
        const internal = await row(message.id).evaluate(measure, direction);
        const reference = await ordinary.evaluate(measure, direction);
        assert.equal(internal.spacerVisibility, 'hidden', 'internal avatar spacer remains invisible');
        if (width === 390) {
          assert.ok(internal.peerHeight >= 40, 'mobile peer button target is at least 40px high');
          assert.ok(internal.peerWidth >= 40, 'mobile peer button target is at least 40px wide');
          await checkPeerHits(row(message.id).locator('button.conversation-internal-peer'));
        }
        const edge = direction === 'in' ? 'right' : 'left';
        const opposite = direction === 'in' ? 'left' : 'right';
        const difference = Math.abs(internal[edge] - reference[edge]);
        assert.ok(difference <= 2,
          `${side} ${width} ${theme}: ${direction} bubble shares ordinary ${edge} margin (${JSON.stringify({internal, reference})})`);
        assert.ok(internal[edge] < internal[opposite], `${direction} bubble is on the ${edge}, not centered`);
        for (const key of ['maxWidth', 'radius', 'padding', 'metaDirection', 'metaGap', 'timeMargin', 'timeFontSize', 'timeSide']) {
          assert.equal(internal[key], reference[key], `${side} ${direction}: ordinary ${key}`);
        }
        assert.equal(internal.timeSide, direction === 'in' ? 'left' : 'right', 'time keeps its ordinary side of the label');
        assert.ok(Math.abs(internal.metaHeight - reference.metaHeight) <= 2, 'internal label keeps the ordinary metadata line height');
        assert.ok(Math.abs(internal.timeCenterOffset - reference.timeCenterOffset) <= 2, 'time keeps ordinary vertical alignment in metadata');
        assert.notEqual(internal.background, reference.background, 'internal bubble has its own background');
        const channels = value => {
          const components = value.match(/[\d.]+/g)?.map(Number);
          assert.ok(components?.length >= 3, `resolved RGB color: ${value}`);
          assert.ok(components.length === 3 || components[3] === 1, 'bubble colors are opaque');
          return components.slice(0, 3);
        };
        const luminance = value => channels(value).map(component => {
          const normalized = component / 255;
          return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
        }).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
        const foreground = luminance(internal.color), background = luminance(internal.background);
        const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
        assert.ok(contrast >= 4.5, `${side} ${width} ${theme}: internal body text meets AA (${contrast.toFixed(2)})`);
        assert.ok(layouts.length < 16, 'bounded geometry and contrast evidence');
        layouts.push({side, width, theme, direction, marginDifference:difference, contrast, internal, reference});
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
  fixture.store.writeGroupDisplayName(mineGroup, 'A', 'human');
  const shortPair = fixture.c4.insertInternalMessage(mineGroup, externalGroup, 'Short peer name');
  const shortPeer = row(shortPair.inRow.id).locator('button.conversation-internal-peer');
  await shortPeer.waitFor();
  assert.equal(await shortPeer.innerText(), 'A');
  const shortTarget = await checkPeerHits(shortPeer, true);
  assert.ok(shortTarget.width >= 40, 'short-name mobile peer button target is at least 40px wide');
  assert.ok(shortTarget.height >= 40, 'short-name mobile peer button target is at least 40px high');
  t.diagnostic(`short-name mobile peer button: ${shortTarget.width}x${shortTarget.height}, four inner edges receive pointer hits`);
  assert.equal(errors.length, 0, errors[0]);
  assert.equal(layouts.length, 16, 'both directions checked in all eight screenshot views');
  if (output) fs.writeFileSync(path.join(output, 'internal-browser.json'), JSON.stringify({ shots, layouts, reads: reads.length, events: events.map(event => ({ name: event.name, conversationId: event.data.conversationId })),
    received: received.map(event => ({ requestId: event.requestId, name: event.name, tab: event.data.tab, conversationId: event.data.conversationId, sequence: event.sequence })), errors }, null, 2));
  t.diagnostic(`internal browser: ${shots.length} screenshots, ${reads.length} message reads, both histories navigate and receive live SSE`);
}
