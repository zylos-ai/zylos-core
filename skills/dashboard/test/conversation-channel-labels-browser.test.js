import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture } from './helpers/chat-integration-api.js';
import { sendJson } from '../src/lib/http.js';

// Boundary: real Dashboard entry, authenticated chat HTTP routes, private C4/dashboard SQLite histories,
// and browser layout/raw-message/avatar interaction. No model, PM2, tmux, real channel or live database starts.
// Run for external message author/internal labels and raw visibility changes; skip unrelated backend changes.
// Opt-in before allocating; sandbox proves private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB paths and
// owns browser, HTTP and database cleanup on pass, failure or timeout. All remote browser requests denied.
test('external conversation labels identify channels and internal peers', { skip: !chatEnabled(), timeout: 120000 }, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    console.log('Channel label browser isolation:', JSON.stringify(sandbox.assertIsolation()));
    const fixture = await createChatApiFixture(t, sandbox, { name: 'Peer Session', extraHandler(req, res, url, f) {
      if (!url.pathname.startsWith('/api/')) return false;
      if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
      const values = {
        '/api/session-mode': { data: { sessionMode: f.readMode() } },
        '/api/state': { state: 'idle', runtime: 'claude', session_mode: f.readMode(), agent: { id: 'test', name: 'Private browser' }, runtime_info: {} },
        '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' }, '/api/communication': {}, '/api/summary': {},
        '/api/timeline': { items: [] }, '/api/instance-status': { status: 'ok' }, '/api/actions/meta': { actions: [] },
      };
      sendJson(res, 200, values[url.pathname] || {}); return true;
    } });
    const mine = await fixture.createConversation('Mine input');
    fixture.addOutbound(mine.draft.localId, 'Mine output');
    const mineGroup = `${mine.receipt.namespace}:${mine.draft.localId}`;
    const incoming = fixture.c4.insertConversation('in', 'telegram', 'channel-labels', 'External input', { groupName: 'channel-labels' });
    const externalGroup = incoming.session_group;
    fixture.db.prepare('UPDATE conversations SET channel=? WHERE id=?').run('openmax', incoming.id);
    const outgoing = fixture.c4.insertConversation('out', 'telegram', 'channel-labels', 'External output', { groupName: 'channel-labels' });
    // A row's recorded channel can differ from its history's channel. Only this private fixture row is changed.
    fixture.db.prepare('UPDATE conversations SET channel=? WHERE id=?').run('openmax', outgoing.id);
    fixture.store.writeGroupDisplayName(externalGroup, 'Channel history', 'human');
    fixture.store.writeGroupDisplayName(mineGroup, 'Peer Session', 'human');
    const relayOut = fixture.c4.insertInternalMessage(externalGroup, mineGroup, 'Internal output');
    const relayIn = fixture.c4.insertInternalMessage(mineGroup, externalGroup, 'Internal input');
    fixture.db.prepare('UPDATE conversations SET timestamp=?').run('2026-11-11 08:00:00');
    const externalId = 'g:' + Buffer.from(externalGroup).toString('hex').toUpperCase();
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const contextClosures = new WeakMap();
    const closeContext = context => {
      if (!contextClosures.has(context)) contextClosures.set(context, (async () => {
        await context.unrouteAll({ behavior: 'ignoreErrors' });
        await context.close();
      })());
      return contextClosures.get(context);
    };
    const open = async (width, theme) => {
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
      sandbox.addCleanup(() => closeContext(context));
      await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
      await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
      await context.addInitScript(theme => { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', 'zh'); localStorage.setItem('zylos-dashboard-detail-level', 'plain'); }, theme);
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      await page.goto(fixture.base + '/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
      return { context, page };
    };
    const row = (page, id) => page.locator(`#wb-chat [data-message-id="${id}"]`);
    const select = async (page, tab, id) => { await page.locator(`#wb-chat [data-action="${tab}"]`).click(); await page.locator(`#wb-chat [data-conversation-id="${id}"]`).click(); };
    const shot = async (page, name, selector) => {
      await page.locator('#wb-chat .chat-notice').filter({ hasText: '正在读取问题状态…' }).waitFor({ state: 'hidden' });
      await page.evaluate(() => document.fonts.ready);
      if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) await (selector ? page.locator(selector) : page).screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `${name}.png`) });
    };
    await t.test('mine labels and internal raw behavior stay unchanged', async () => {
      const { context, page } = await open(1280, 'light');
      try {
        await select(page, 'mine', mine.receipt.conversationId); await row(page, relayOut.inRow.id).waitFor();
        assert.deepEqual(await page.locator('#wb-chat .chat-message-author').allTextContents(), ['你', 'AI']);
        assert.equal(await row(page, relayOut.inRow.id).locator('.conversation-internal-label').innerText(), '来自');
        assert.equal(await row(page, relayIn.outRow.id).locator('.conversation-internal-label').innerText(), '发给');
        assert.equal(await row(page, relayOut.inRow.id).locator('.conversation-internal-raw').isVisible(), false);
        assert.doesNotMatch(await row(page, relayOut.inRow.id).locator('.conversation-internal-heading').innerText(), /内部|←|→/);
        assert.equal(await page.locator('#wb-chat .chat-in:not(.conversation-internal) .conversation-avatar .wb-ico-monitor').count(), 1);
        assert.equal(await page.locator('#wb-chat .chat-out:not(.conversation-internal) .conversation-avatar .wb-ico-bot').count(), 1);
        await shot(page, 'mine-light-1280', '.conversation-detail');
      } finally { await closeContext(context); }
    });
    for (const width of [1280, 390]) for (const theme of ['light', 'dark']) await t.test(`${width} ${theme}: external directions, peers and raw entry`, async () => {
      const { context, page } = await open(width, theme);
      try {
        await select(page, 'external', externalId); await row(page, relayIn.inRow.id).waitFor();
        const ids = [incoming.id, outgoing.id, relayOut.outRow.id, relayIn.inRow.id];
        const layout = await page.locator('#wb-chat .conversation-message-list').evaluate((list, ids) => ids.map(id => {
          const node = list.querySelector(`[data-message-id="${id}"]`), body = node.querySelector(node.classList.contains('chat-out') ? '.chat-message-content > .chat-message-text' : '.chat-message-content'), b = body.getBoundingClientRect();
          return { id, in: node.classList.contains('chat-in'), background: getComputedStyle(body).backgroundColor, top: b.top, bottom: b.bottom, left: b.left, right: b.right };
        }), ids);
        await shot(page, `external-${width}-${theme}`);
        assert.equal(await row(page, incoming.id).locator('.chat-message-author').innerText(), '收到 · OpenMax');
        assert.equal(await row(page, incoming.id).locator('.conversation-avatar .wb-ico-hex').count(), 1, 'avatar uses the incoming row channel instead of Telegram history');
        assert.equal(await row(page, outgoing.id).locator('.conversation-avatar .wb-ico-bot').count(), 1);
        for (const id of [relayOut.outRow.id, relayIn.inRow.id]) {
          assert.equal(await row(page, id).locator('.conversation-internal-spacer[aria-hidden="true"]').count(), 1);
          assert.equal(await row(page, id).locator('.conversation-avatar .wb-ico').count(), 0);
        }
        assert.equal(await row(page, outgoing.id).locator('.chat-message-author').innerText(), '发出 → OpenMax', 'use the row channel, not the Telegram history channel');
        assert.match(await row(page, relayOut.outRow.id).locator('.conversation-internal-heading').innerText(), /发出 →\s*Peer Session/);
        assert.match(await row(page, relayIn.inRow.id).locator('.conversation-internal-heading').innerText(), /收到 ←\s*Peer Session/);
        for (const id of [relayOut.outRow.id, relayIn.inRow.id]) {
          assert.match(await row(page, id).locator('.conversation-internal-heading').innerText(), /内部/);
          const badge = row(page, id).locator('.conversation-internal-badge');
          assert.equal(await badge.evaluate(node => node.parentElement.matches('.conversation-internal-route')
            && node.parentElement.lastElementChild === node), true, 'internal badge follows the peer inside its route');
          assert.deepEqual(await badge.evaluate(node => {
            const style = getComputedStyle(node);
            return [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth];
          }), ['1px', '1px', '1px', '1px'], 'internal badge retains its outlined style');
        }
        assert.deepEqual(layout.map(value => value.in), [true, false, false, true]);
        assert.ok(layout.every(value => value.top >= 0 && value.bottom <= 900), 'all four messages are on screen');
        assert.ok(layout[0].right > layout[1].right && layout[3].right > layout[2].right, 'incoming bubbles align right');
        assert.equal(layout[2].background, layout[3].background, 'both internal directions retain the same beige bubble');
        assert.notEqual(layout[2].background, layout[0].background);
        assert.notEqual(layout[2].background, layout[1].background);
        const raw = row(page, relayIn.inRow.id).locator('.conversation-internal-raw');
        assert.equal(await raw.isVisible(), true, 'raw entry available with technical details off');
        assert.equal(await raw.evaluate(node => node.open), false, 'raw starts collapsed');
        await raw.locator('summary').click();
        assert.equal(await raw.evaluate(node => node.open), true);
        assert.ok((await raw.locator('pre').innerText()).includes('Internal input'));
        assert.equal(await row(page, relayOut.outRow.id).locator('.conversation-internal-raw').isVisible(), false);
        assert.equal(await row(page, incoming.id).locator('.conversation-internal-raw').count(), 0);
      } finally { await closeContext(context); }
    });
    // A controlled history response replays an existing row with updated channel metadata;
    // real state merging and keyed DOM reconciliation must refresh its icon without replacing its wrapper.
    await t.test('existing external row avatar refreshes when its recorded channel changes', async () => {
      const { context, page } = await open(1280, 'light');
      let original, patchedChannel = null;
      try {
        await context.route('**/api/chat/conversations/**/messages?*', async route => {
          const response = await route.fetch();
          const data = await response.json();
          original ??= data.items?.find(item => item.id === incoming.id);
          if (patchedChannel && original) data.items = [{ ...original, channel: patchedChannel }];
          await route.fulfill({ response, json: data });
        });
        await select(page, 'external', externalId);
        const avatar = row(page, incoming.id).locator('.conversation-avatar');
        await avatar.locator('.wb-ico-hex').waitFor();
        const handle = await avatar.elementHandle();
        for (const [channel, symbol] of [['telegram', 'send'], ['lark', 'msg'], ['web-console', 'monitor'], ['unrecognized-channel', 'msg'], ['toString', 'msg'], ['openmax', 'hex']]) {
          patchedChannel = channel;
          await page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'after';
          }, { timeout: 10000 });
          await avatar.locator(`.wb-ico-${symbol}`).waitFor();
          assert.equal(await avatar.evaluate((node, original) => node === original, handle), true, 'avatar wrapper retains identity');
          assert.equal(await row(page, outgoing.id).locator('.conversation-avatar .wb-ico-bot').count(), 1);
        }
      } finally { await closeContext(context); }
    });
  }, { timeoutMs: 110000 });
});
