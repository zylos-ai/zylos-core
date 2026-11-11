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

/** Records each send body the page posts (bounded) and passes the request on to the real route unchanged. */
async function recordSends(context, sent) {
  await context.route(url => url.pathname.endsWith('/send') && url.pathname.startsWith('/api/chat/conversations/'), async route => {
    assert.ok(sent.length < 50, 'bounded send capture');
    sent.push(structuredClone(route.request().postDataJSON()));
    await route.continue();
  });
}

export async function runQuoteAnnotateBrowser(t, sandbox) {
  const modulePath = process.env.ZYLOS_CHAT_BROWSER_MODULE, executablePath = process.env.ZYLOS_CHAT_BROWSER_BIN;
  assert.ok(modulePath && fs.existsSync(modulePath));
  assert.ok(executablePath && fs.existsSync(executablePath));
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const hub = new SseHub(1000), errors = [], shots = [], sent = [], olderReads = [];
  let observer;
  sandbox.addCleanup(() => { observer?.close(); hub.closeAll(); });
  const fixture = await createChatApiFixture(t, sandbox, { name: 'Rollout plan', instanceTz: async () => ({ tz: 'Asia/Shanghai' }), extraHandler(req, res, url, f) {
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

  // Conversation A: an early AI message (several pages back), filler, a two-paragraph AI reply to annotate,
  // a scrollable code block, a stored quote of the early message and one whose original is gone.
  const mine = await fixture.createConversation('我们讨论一下灰度发布。');
  const localId = mine.draft.localId, conversationId = mine.receipt.conversationId;
  const early = fixture.addOutbound(localId, '很早的方案：先在测试环境演练一次回滚。');
  for (let index = 1; index <= 130; index++) fixture.addOutbound(localId, `进度记录 ${index}`);
  const plan = fixture.addOutbound(localId, '灰度只影响一小部分实例，出问题时撤回这一批即可。\n\n资源占用：蓝绿要同时保留两套完整环境，机器翻倍。\n\n验证方式：灰度可以先放 5% 的流量观察错误率和延迟，再逐步放大。');
  const code = fixture.addOutbound(localId, '回滚命令：\n\n```\n' + 'deploy rollback --batch=1 --keep-traffic --confirm '.repeat(6) + '\n```');
  const table = fixture.addOutbound(localId, '| 批次 | 实例 | 观察时长 | 错误率阈值 | 延迟阈值 | 负责人 | 回滚命令 |\n|---|---|---|---|---|---|---|\n' + '| 第一批 | node-01, node-02 | 30 分钟 | 0.5% | P95 800ms | 值班工程师 | deploy rollback --batch=1 --keep-traffic |\n'.repeat(2));
  const quoted = fixture.c4.insertConversation('in', 'dashboard', localId, `[quote c4_id=${early.id}]\n这个早的方案还算数吗？`, { groupName: localId });
  // Quotes an earlier message that later left this conversation (moved to the other one below).
  const movedAway = fixture.addOutbound(localId, '这条后来被移到另一个对话了。');
  const gone = fixture.c4.insertConversation('in', 'dashboard', localId, `[quote c4_id=${movedAway.id}]\n原消息已经不在这个对话里了。`, { groupName: localId });
  const other = await fixture.createConversation('另一个对话的草稿不应串过来。');
  const otherId = other.receipt.conversationId;
  // An internal message from the other conversation's session group, shown in conversation A.
  const groupWith = content => fixture.db.prepare('SELECT session_group FROM conversations WHERE content = ?').get(content).session_group;
  fixture.db.prepare('UPDATE conversations SET session_group = ? WHERE id = ?').run(groupWith('另一个对话的草稿不应串过来。'), movedAway.id);
  const internal = fixture.c4.insertInternalMessage(groupWith('另一个对话的草稿不应串过来。'), groupWith('我们讨论一下灰度发布。'), '内部协调：发布窗口定在周四晚上。').inRow;
  const reply = fixture.addOutbound(localId, '建议第一批放 2 台，观察 30 分钟再放到全部 4 台。');

  const { chromium } = await import(pathToFileURL(modulePath));
  console.info('Quote browser private targets:', JSON.stringify(sandbox.assertIsolation()), 'model/PM2/tmux unused');
  const browser = await chromium.launch({ executablePath, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const waitUntil = async (predicate, message, ms = 8000) => {
    const deadline = Date.now() + ms;
    while (!await predicate()) {
      assert.ok(Date.now() < deadline, message);
      await delay(25);
    }
  };
  async function openContext({ width, theme, touch = false }) {
    const context = await browser.newContext({ locale: 'zh-CN', timezoneId: 'Asia/Shanghai', viewport: { width, height: width === 390 ? 844 : 900 },
      ...(touch ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    await context.route(url => !url.href.startsWith(fixture.base + '/'), route => route.abort());
    await recordSends(context, sent);
    await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
    await context.addInitScript(value => {
      if (window !== window.top) return;
      localStorage.setItem('zylos-dashboard-theme', value);
      localStorage.setItem('zylos-dashboard-locale', 'zh');
    }, theme);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'before' && url.searchParams.has('cursor')) {
        assert.ok(olderReads.length < 100, 'bounded older-page capture');
        olderReads.push(url.href);
      }
    });
    return { context, page };
  }
  const row = (page, id) => page.locator(`#wb-chat article[data-message-id="${id}"]`);
  const quoteBar = page => page.locator('#wb-chat .conversation-quote-bar');
  const count = page => page.locator('#wb-chat .conversation-annotations-button');
  const markButton = page => page.locator('body > .conversation-mark-button');
  const select = async (page, id) => {
    if (await page.locator('#wb-chat .conversation-back').isVisible()) await page.locator('#wb-chat .conversation-back').click();
    await page.locator(`#wb-chat [data-conversation-id="${id}"]`).click();
    await page.waitForFunction(id => document.querySelector('#wb-chat [aria-current="true"]')?.dataset.conversationId === id, id);
  };
  const openA = async page => {
    await page.goto(fixture.base + '/chat');
    await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    await select(page, conversationId);
    await row(page, reply.id).waitFor();
  };
  // Selects `from`…`to` inside one message's text (or across two messages) the way a user's drag does.
  const selectText = (page, fromId, from, toId = fromId, to = from) => page.evaluate(({ fromId, from, toId, to }) => {
    const find = (id, needle) => {
      const article = document.querySelector(`#wb-chat article[data-message-id="${id}"]`);
      const walker = document.createTreeWalker(article.querySelector('.chat-message-text'), NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.data.indexOf(needle);
        if (at >= 0) return [node, at];
      }
      throw new Error('text not found: ' + needle);
    };
    const [startNode, startAt] = find(fromId, from), [endNode, endAt] = find(toId, to);
    const range = document.createRange();
    range.setStart(startNode, startAt);
    range.setEnd(endNode, endAt + to.length);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }, { fromId, from, toId, to });
  const composeKeys = page => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('zylos-dashboard-compose-draft:')));
  const shot = async (page, name) => {
    if (!output) return;
    const file = path.join(output, `quote-annotate-${name}.png`);
    await page.screenshot({ path: file });
    shots.push(file);
  };
  // Nothing floating may leave the screen or cover the send button (a narrow-screen sheet with a scrim may).
  const assertLayout = async (page, label) => {
    const layout = await page.evaluate(() => {
      const width = innerWidth, height = innerHeight, box = el => el.getBoundingClientRect();
      const send = box(document.querySelector('#wb-chat .conversation-send'));
      const visible = [...document.querySelectorAll('.conversation-quote-bar, .conversation-mark-button, .conversation-annotation-pop, .conversation-annotations-button')]
        .filter(el => !el.hidden && el.getClientRects().length);
      return { width, height, send: { left: send.left, right: send.right, top: send.top, bottom: send.bottom },
        items: visible.map(el => ({ cls: el.className, sheet: el.classList.contains('conversation-annotation-sheet'), ...JSON.parse(JSON.stringify(box(el))) })) };
    });
    for (const item of layout.items) {
      assert.ok(item.left >= -0.5 && item.right <= layout.width + 0.5 && item.top >= -0.5 && item.bottom <= layout.height + 0.5,
        `${label}: ${item.cls} stays on screen ${JSON.stringify(item)}`);
      const covers = !(item.right <= layout.send.left || item.left >= layout.send.right || item.bottom <= layout.send.top || item.top >= layout.send.bottom);
      if (!item.sheet && !item.cls.includes('conversation-annotations-button')) assert.ok(!covers, `${label}: ${item.cls} does not cover the send button`);
    }
    return layout.items.length;
  };

  // ── 1280 light, mouse and trackpad ──
  {
    const { context, page } = await openContext({ width: 1280, theme: 'light' });
    await openA(page);
    // History: the stored marker line is not shown; the quote block names the original and jumps to it.
    const quotedRow = row(page, quoted.id);
    assert.doesNotMatch(await quotedRow.locator('.chat-message-text').innerText(), /quote c4_id/);
    const block = quotedRow.locator('.conversation-quote-block');
    assert.match(await block.innerText(), /^AI · \d{2}:\d{2}\n很早的方案：先在测试环境演练一次回滚。$/);
    const goneBlock = row(page, gone.id).locator('.conversation-quote-block');
    assert.equal(await goneBlock.innerText(), '原消息不可用');
    assert.equal(await goneBlock.isDisabled(), true);
    assert.equal(await row(page, early.id).count(), 0, 'the early message is several pages back');
    const before = olderReads.length;
    await block.click();
    await row(page, early.id).waitFor();
    await waitUntil(() => row(page, early.id).evaluate(el => el.classList.contains('conversation-flash')), 'the original flashes');
    await waitUntil(() => row(page, early.id).evaluate(el => { const box = el.getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight; }), 'the original scrolls into view');
    assert.ok(olderReads.length >= before + 2, 'earlier pages were loaded one after another to reach it');

    // Mouse: the hover button quotes; a quote alone cannot be sent.
    await row(page, reply.id).scrollIntoViewIfNeeded();
    const replyButton = row(page, reply.id).locator('.conversation-quote-button');
    assert.equal(await replyButton.evaluate(el => getComputedStyle(el).opacity), '0');
    await row(page, reply.id).hover();
    await waitUntil(() => replyButton.evaluate(el => getComputedStyle(el).opacity === '1'), 'hover shows the quote button');
    await replyButton.click();
    await quoteBar(page).waitFor();
    assert.match(await quoteBar(page).innerText(), /引用 AI · \d{2}:\d{2}\n建议第一批放 2 台，观察 30 分钟再放到全部 4 台。/);
    assert.equal(await replyButton.getAttribute('data-quoted'), 'true');
    assert.equal(await page.locator('#wb-chat .conversation-send').isDisabled(), true, 'a quote alone is not sendable');
    await row(page, reply.id).evaluate(el => el.classList.remove('conversation-flash'));
    await page.locator('#wb-chat .conversation-quote-bar-body').click();
    await waitUntil(() => row(page, reply.id).evaluate(el => el.classList.contains('conversation-flash')), 'the quote bar jumps to the quoted message');
    await page.locator('#wb-chat .conversation-quote-bar-close').click();
    await quoteBar(page).waitFor({ state: 'hidden' });

    // Trackpad: a vertical scroll and a sideways scroll over code do not quote; a leftward two-finger swipe does.
    await row(page, plan.id).locator('.chat-message-text').hover();
    await page.mouse.wheel(0, 90);
    await delay(260);
    assert.equal(await quoteBar(page).isVisible(), false, 'vertical wheel does not quote');
    const pre = row(page, code.id).locator('pre');
    await pre.scrollIntoViewIfNeeded();
    assert.ok(await pre.evaluate(el => el.scrollWidth > el.clientWidth), 'the code block scrolls sideways');
    await pre.hover();
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(25, 0); await delay(16); }
    await delay(260);
    assert.equal(await quoteBar(page).isVisible(), false, 'sideways scrolling code does not quote');
    assert.ok(await pre.evaluate(el => el.scrollLeft > 0), 'the code block scrolled instead');
    const tableNode = row(page, table.id).locator('table');
    await tableNode.scrollIntoViewIfNeeded();
    await tableNode.hover();
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(25, 0); await delay(16); }
    await delay(260);
    assert.equal(await quoteBar(page).isVisible(), false, 'sideways input over a table does not quote');
    await row(page, plan.id).locator('.chat-message-text').scrollIntoViewIfNeeded();
    await row(page, plan.id).locator('.chat-message-text').hover();
    await page.keyboard.down('Shift');
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(25, 0); await delay(16); }
    await page.keyboard.up('Shift');
    await delay(260);
    assert.equal(await quoteBar(page).isVisible(), false, 'Shift+wheel (a mouse wheel turned sideways) does not quote');
    for (let step = 0; step < 2; step++) { await page.mouse.wheel(20, 0); await delay(16); }
    await delay(260);
    assert.equal(await quoteBar(page).isVisible(), false, 'a short swipe springs back');
    assert.equal(await row(page, plan.id).evaluate(el => el.classList.contains('conversation-swiping')), false);
    // Recorded as it happens: reading the class once after the last event would depend on the machine's timing.
    await row(page, plan.id).evaluate(el => {
      window.swipeSeen = false;
      new MutationObserver(() => { if (el.classList.contains('conversation-swipe-ready')) window.swipeSeen = true; }).observe(el, { attributes: true, attributeFilter: ['class'] });
    });
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(22, 0); await delay(16); }
    await delay(260);
    assert.equal(await page.evaluate(() => window.swipeSeen), true, 'the row follows the swipe');
    await quoteBar(page).waitFor();
    assert.match(await quoteBar(page).innerText(), /灰度只影响一小部分实例/);

    // A mouse drag selects text and never quotes; the selection offers 标注 instead.
    await page.locator('#wb-chat .conversation-quote-bar-close').click();
    await row(page, reply.id).locator('.chat-message-text').scrollIntoViewIfNeeded();
    const textBox = await row(page, reply.id).locator('.chat-message-text').boundingBox();
    await page.mouse.move(textBox.x + textBox.width - 4, textBox.y + textBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(textBox.x + 4, textBox.y + textBox.height / 2, { steps: 8 });
    await page.mouse.up();
    assert.equal(await quoteBar(page).isVisible(), false, 'a mouse drag does not quote');
    assert.ok((await page.evaluate(() => getSelection().toString())).length > 0, 'the drag selected text');
    await markButton(page).waitFor();
    await row(page, plan.id).locator('.chat-message-text').hover();
    for (let step = 0; step < 4; step++) { await page.mouse.wheel(25, 0); await delay(16); }
    await delay(260);
    assert.equal(await quoteBar(page).isVisible(), false, 'no swipe quote while text is selected');

    // Annotations: a selection across messages offers nothing; two annotations, one spanning two paragraphs.
    await selectText(page, plan.id, '验证方式', reply.id, '观察 30 分钟');
    await delay(200);
    assert.equal(await markButton(page).isVisible(), false, 'no 标注 across messages');
    await row(page, internal.id).waitFor();
    assert.equal(await row(page, internal.id).evaluate(el => el.classList.contains('conversation-internal')), true);
    await selectText(page, internal.id, '发布窗口定在周四晚上');
    await delay(200);
    assert.equal(await markButton(page).isVisible(), false, 'internal messages cannot be annotated');
    await selectText(page, plan.id, '灰度只影响一小部分实例，出问题时撤回这一批即可。');
    await markButton(page).waitFor();
    assert.ok(await assertLayout(page, '1280 mark') >= 1);
    await markButton(page).click();
    const editor = page.locator('body > .conversation-annotation-editor');
    await editor.waitFor();
    assert.equal(await editor.locator('.conversation-annotation-excerpt').innerText(), '灰度只影响一小部分实例，出问题时撤回这一批即可。');
    await editor.locator('textarea').fill('撤回具体怎么操作？要停服务吗？');
    await editor.locator('[data-action="saveAnnotation"]').click();
    await editor.waitFor({ state: 'hidden' });
    await selectText(page, plan.id, '资源占用', plan.id, '再逐步放大。');
    await markButton(page).click();
    await editor.locator('textarea').fill('我们一共 4 台，5% 怎么落到实例上？');
    await editor.locator('[data-action="saveAnnotation"]').click();
    await waitUntil(async () => (await count(page).innerText()).trim() === '2', 'two annotations counted');
    const highlighted = await page.evaluate(() => CSS.highlights.get('conversation-annotations')?.size ?? 0);
    assert.equal(highlighted, 2, 'both selections stay highlighted');

    // Quote the reply and add words; reload and switching conversations keep the whole draft.
    await row(page, reply.id).hover();
    await replyButton.click();
    await page.locator('#wb-chat textarea.conversation-input').first().fill('第一批只放 2 台是不是太保守了？');
    assert.equal((await composeKeys(page)).length, 1, 'the draft is stored for this conversation only');
    await page.reload();
    await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
    await select(page, conversationId);
    await quoteBar(page).waitFor();
    await waitUntil(async () => (await count(page).innerText()).trim() === '2', 'annotations survive a reload');
    assert.equal(await page.locator('#wb-chat textarea.conversation-input').first().inputValue(), '第一批只放 2 台是不是太保守了？');
    await row(page, plan.id).waitFor();
    await waitUntil(() => page.evaluate(() => (CSS.highlights.get('conversation-annotations')?.size ?? 0) === 2), 'highlights return once the message is loaded');
    await select(page, otherId);
    assert.equal(await quoteBar(page).isVisible(), false, 'another conversation has its own draft');
    assert.equal(await count(page).isVisible(), false);
    await select(page, conversationId);
    await quoteBar(page).waitFor();

    // The list and the text that will be sent.
    await count(page).click();
    const list = page.locator('body > .conversation-annotation-list');
    await list.waitFor();
    assert.equal(await list.locator('.conversation-annotation-item').count(), 2);
    await row(page, plan.id).evaluate(el => el.classList.remove('conversation-flash'));
    await list.locator('[data-action="locateAnnotation"]').first().click();
    await waitUntil(() => row(page, plan.id).evaluate(el => el.classList.contains('conversation-flash')), '定位原文 shows the annotated message');
    await list.locator('details.conversation-annotation-preview > summary').click();
    const preview = await list.locator('.conversation-annotation-preview-text').innerText();
    const stamp = (await row(page, plan.id).locator('time').getAttribute('datetime'));
    const zoned = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(stamp)).reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
    const when = `${zoned.month}-${zoned.day} ${zoned.hour}:${zoned.minute}`;
    assert.equal(preview, [
      '第一批只放 2 台是不是太保守了？',
      '',
      '【标注 2 条】原消息都在本对话里，c4_id 是消息编号。',
      `1. AI · ${when} · c4_id=${plan.id}`,
      '   原文：「灰度只影响一小部分实例，出问题时撤回这一批即可。」',
      '   批注：撤回具体怎么操作？要停服务吗？',
      `2. AI · ${when} · c4_id=${plan.id}`,
      '   原文：「资源占用：蓝绿要同时保留两套完整环境，机器翻倍。',
      '   验证方式：灰度可以先放 5% 的流量观察错误率和延迟，再逐步放大。」',
      '   批注：我们一共 4 台，5% 怎么落到实例上？',
    ].join('\n'));
    assert.ok(await assertLayout(page, '1280 light list') >= 3);
    await shot(page, '1280-light-list');
    await page.evaluate(() => { localStorage.setItem('zylos-dashboard-theme', 'dark'); document.documentElement.dataset.theme = 'dark'; });
    await shot(page, '1280-dark-list');
    await page.evaluate(() => { localStorage.setItem('zylos-dashboard-theme', 'light'); document.documentElement.dataset.theme = 'light'; });
    await list.locator('.conversation-annotation-foot .wb-btn', { hasText: '完成' }).click();
    await list.waitFor({ state: 'hidden' });

    // Send: the stored content is the quote line and exactly the previewed text; the draft is gone afterwards.
    const lastId = fixture.db.prepare('SELECT max(id) AS id FROM conversations').get().id;
    await page.locator('#wb-chat .conversation-send').click();
    await waitUntil(() => !!fixture.db.prepare("SELECT id FROM conversations WHERE id > ? AND direction = 'in'").get(lastId), 'the message is stored');
    const stored = fixture.db.prepare("SELECT id, content FROM conversations WHERE id > ? AND direction = 'in'").get(lastId);
    assert.deepEqual(sent.at(-1), { content: preview, quote: reply.id });
    assert.equal(stored.content, `[quote c4_id=${reply.id}]\n${preview}`);
    await quoteBar(page).waitFor({ state: 'hidden' });
    await count(page).waitFor({ state: 'hidden' });
    assert.deepEqual(await composeKeys(page), []);
    await row(page, stored.id).waitFor();
    assert.match(await row(page, stored.id).locator('.conversation-quote-block').innerText(), /^AI · \d{2}:\d{2}\n建议第一批放 2 台/);
    assert.doesNotMatch(await row(page, stored.id).locator('.chat-message-text').innerText(), /quote c4_id/);
    await shot(page, '1280-light-sent');
    await context.close();
  }

  // ── 1280 dark: quote bar and editor ──
  {
    const { context, page } = await openContext({ width: 1280, theme: 'dark' });
    await openA(page);
    await page.locator('#wb-chat textarea.conversation-input').fill('长'.repeat(22000));
    await page.locator('#wb-chat .conversation-compose-notice').waitFor();
    assert.match(await page.locator('#wb-chat .conversation-compose-notice').innerText(), /超过单条消息上限（64 KB）.*66,000 字节/);
    assert.equal(await page.locator('#wb-chat .conversation-send').isDisabled(), true, 'over 65536 bytes is not sendable');
    await page.locator('#wb-chat textarea.conversation-input').fill('');
    await page.locator('#wb-chat .conversation-compose-notice').waitFor({ state: 'hidden' });
    await row(page, reply.id).hover();
    await row(page, reply.id).locator('.conversation-quote-button').click();
    await selectText(page, reply.id, '观察 30 分钟');
    await markButton(page).click();
    const editor = page.locator('body > .conversation-annotation-editor');
    await editor.waitFor();
    assert.ok(await assertLayout(page, '1280 dark editor') >= 2);
    await shot(page, '1280-dark-editor');
    // A window resize moves the editor with its text; what was typed stays.
    await editor.locator('textarea').fill('半小时够吗？');
    await page.setViewportSize({ width: 1000, height: 620 });
    await delay(120);
    assert.equal(await editor.isVisible(), true, 'a resize keeps the editor open');
    assert.equal(await editor.locator('textarea').inputValue(), '半小时够吗？');
    assert.ok(await assertLayout(page, '1280 dark editor after resize') >= 2);
    // The selected text scrolled out of a shorter window: the editor and its buttons stay on screen.
    await page.locator('#wb-chat .conversation-stream').evaluate(el => { el.scrollTop = Math.max(0, el.scrollTop - 900); });
    await waitUntil(() => row(page, reply.id).evaluate(el => el.getBoundingClientRect().top > innerHeight), 'the selected text is below the window');
    await page.setViewportSize({ width: 1000, height: 560 });
    await delay(120);
    assert.equal(await editor.isVisible(), true);
    assert.ok(await assertLayout(page, '1280 dark editor, selection off screen') >= 2);
    assert.ok(await editor.locator('[data-action="saveAnnotation"]').evaluate(el => el.getBoundingClientRect().bottom <= innerHeight), 'save stays reachable');
    await editor.locator('.wb-btn:not(.wb-btn-primary)').click();
    await page.locator('#wb-chat .conversation-quote-bar-close').click();
    await context.close();
  }

  // ── 1280 light, slow earlier pages: a second jump while one is loading waits for it ──
  {
    const { context, page } = await openContext({ width: 1280, theme: 'light' });
    await context.route(url => url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'before' && url.searchParams.has('cursor'),
      async route => { await delay(700); await route.fallback(); });
    await openA(page);
    // Recorded as it happens: the first jump's success would clear a false notice before a later read could see it.
    await page.evaluate(() => {
      const chat = document.querySelector('#wb-chat');
      window.goneNoticeSeen = false;
      new MutationObserver(() => { if (chat.textContent.includes('原消息已不在这个对话里')) window.goneNoticeSeen = true; })
        .observe(chat, { subtree: true, childList: true, characterData: true });
    });
    const block = row(page, quoted.id).locator('.conversation-quote-block');
    await block.click();
    await delay(150);
    await block.click();
    await row(page, early.id).waitFor({ timeout: 15_000 });
    await waitUntil(() => row(page, early.id).evaluate(el => el.classList.contains('conversation-flash')), 'the original flashes', 15_000);
    await delay(200);
    assert.equal(await page.evaluate(() => window.goneNoticeSeen), false, 'no false "original gone" notice, not even briefly');
    await context.close();
  }

  // ── 1280 light, slow earlier pages: a refresh during a jump drops the page in flight without calling the original gone ──
  {
    const { context, page } = await openContext({ width: 1280, theme: 'light' });
    await context.route(url => url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'before' && url.searchParams.has('cursor'),
      async route => { await delay(700); await route.fallback(); });
    await openA(page);
    await page.evaluate(() => {
      const chat = document.querySelector('#wb-chat');
      window.goneNoticeSeen = false;
      new MutationObserver(() => { if (chat.textContent.includes('原消息已不在这个对话里')) window.goneNoticeSeen = true; })
        .observe(chat, { subtree: true, childList: true, characterData: true });
    });
    const before = olderReads.length;
    await row(page, quoted.id).locator('.conversation-quote-block').click();
    await waitUntil(() => olderReads.length > before, 'the jump requested an earlier page');
    await page.locator('#wb-chat .conversation-reload').click();
    await delay(2000);
    assert.equal(await page.evaluate(() => window.goneNoticeSeen), false, 'a refresh mid-jump does not report the original gone');
    await context.close();
  }

  // ── 390, touch: swipe, sheets, light and dark ──
  for (const theme of ['light', 'dark']) {
    const { context, page } = await openContext({ width: 390, theme, touch: true });
    await openA(page);
    const touchInput = await context.newCDPSession(page);
    const swipe = async (locator, dx, dy = 0) => {
      await locator.scrollIntoViewIfNeeded();
      const box = await locator.boundingBox();
      const x = box.x + box.width * 0.7, y = box.y + Math.min(box.height / 2, 20);
      await touchInput.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let step = 1; step <= 8; step++) {
        await touchInput.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * step / 8, y: y + dy * step / 8 }] });
        await delay(16);
      }
      await touchInput.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await delay(120);
    };
    const target = row(page, reply.id).locator('.chat-message-text');
    await target.scrollIntoViewIfNeeded();
    await swipe(target, 0, -120);
    assert.equal(await quoteBar(page).isVisible(), false, 'a vertical swipe scrolls');
    await target.scrollIntoViewIfNeeded();
    await swipe(target, -30);
    assert.equal(await quoteBar(page).isVisible(), false, 'a short swipe springs back');
    await swipe(target, -90);
    await quoteBar(page).waitFor();
    assert.match(await quoteBar(page).innerText(), /建议第一批放 2 台/);
    const pre = row(page, code.id).locator('pre');
    await pre.scrollIntoViewIfNeeded();
    await page.locator('#wb-chat .conversation-quote-bar-close').click();
    await swipe(pre, -90);
    assert.equal(await quoteBar(page).isVisible(), false, 'swiping code does not quote');
    await swipe(row(page, table.id).locator('table'), -90);
    assert.equal(await quoteBar(page).isVisible(), false, 'swiping a table does not quote');
    await swipe(row(page, plan.id).locator('.chat-message-text'), -90);
    await quoteBar(page).waitFor();
    assert.ok(await assertLayout(page, `390 ${theme} quote bar`) >= 1);
    await shot(page, `390-${theme}-quote-bar`);
    await selectText(page, plan.id, '机器翻倍');
    await markButton(page).click();
    const editor = page.locator('body > .conversation-annotation-editor');
    await editor.waitFor();
    assert.equal(await editor.evaluate(el => el.classList.contains('conversation-annotation-sheet')), true, 'a bottom sheet on phones');
    assert.ok(await assertLayout(page, `390 ${theme} editor`) >= 2);
    await shot(page, `390-${theme}-editor`);
    // The on-screen keyboard shrinks the viewport: the sheet stays, with what was typed, and saves.
    await editor.locator('textarea').fill('两套环境要保留多久？');
    await page.setViewportSize({ width: 390, height: 480 });
    await delay(120);
    assert.equal(await editor.isVisible(), true, 'the keyboard does not close the editor');
    assert.equal(await editor.locator('textarea').inputValue(), '两套环境要保留多久？');
    assert.ok(await assertLayout(page, `390 ${theme} editor with keyboard`) >= 2);
    await editor.locator('[data-action="saveAnnotation"]').click();
    await waitUntil(async () => (await count(page).innerText()).trim() === '1', 'the annotation typed with the keyboard open is saved');
    await page.setViewportSize({ width: 390, height: 844 });
    await count(page).click();
    const list = page.locator('body > .conversation-annotation-list');
    await list.waitFor();
    assert.ok(await assertLayout(page, `390 ${theme} list`) >= 2);
    await shot(page, `390-${theme}-list`);
    await list.locator('[data-action="clearAnnotations"]').click();
    await count(page).waitFor({ state: 'hidden' });
    await page.locator('#wb-chat .conversation-quote-bar-close').click();
    await row(page, gone.id).evaluate(el => el.scrollIntoView({ block: 'end' }));
    await row(page, quoted.id).locator('.conversation-quote-block').waitFor();
    await shot(page, `390-${theme}-history`);
    await context.close();
  }
  // ── 1280, touch screen: swiping works at desktop width too ──
  {
    const { context, page } = await openContext({ width: 1280, theme: 'light', touch: true });
    await openA(page);
    const touchInput = await context.newCDPSession(page);
    const target = row(page, reply.id).locator('.chat-message-text');
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    const x = box.x + box.width * 0.7, y = box.y + box.height / 2;
    await touchInput.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
    for (let step = 1; step <= 8; step++) {
      await touchInput.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - 90 * step / 8, y }] });
      await delay(16);
    }
    await touchInput.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await quoteBar(page).waitFor();
    assert.match(await quoteBar(page).innerText(), /建议第一批放 2 台/);
    await page.locator('#wb-chat .conversation-quote-bar-close').click();
    await context.close();
  }
  assert.deepEqual(errors, [], 'no page errors');
  t.diagnostic(`quote/annotate browser: ${shots.length} screenshots, ${olderReads.length} older-page reads, ${sent.length} sends`);
}
