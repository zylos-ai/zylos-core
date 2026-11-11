import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture } from './helpers/chat-integration-api.js';
import { sendJson } from '../src/lib/http.js';

// Boundary: actual Dashboard DOM/controller, authenticated HTTP pagination and private C4/dashboard SQLite.
// Run for automatic older-history triggering, scroll retention, retry UI or removal of header recovery controls.
// Unrelated runtime changes can skip. Official runner + opt-in sandbox prove private HOME/ZYLOS_DIR/PM2_HOME,
// short TMPDIR/socket/database paths before allocating; own HTTP/browser/DB cleanup on failure/timeout.
// History response delay/failure/page-size controls affect fixture data only. No model, PM2, tmux or live channel.
test('conversation history loads older messages while preserving the reading position', { skip: !chatEnabled(), timeout: 180000 }, async t => {
  const sandbox = createChatSandbox(t);
  await sandbox.runCase(async () => {
    console.info('History scroll browser isolation:', JSON.stringify(sandbox.assertIsolation()));
    const fixture = await createChatApiFixture(t, sandbox, { name: 'History fixture', extraHandler(req, res, url, f) {
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
    const groups = {};
    for (const tab of ['mine', 'external']) for (const [kind, count] of [['long', 120], ['fill', 35], ['short', 3]]) {
      let localId, id, lastId;
      if (tab === 'mine') {
        const mine = await fixture.createConversation(`${kind} message 1`); localId = mine.draft.localId; id = mine.receipt.conversationId;
      } else {
        localId = `scroll-${kind}`;
        const row = fixture.c4.insertConversation('in', 'telegram', localId, `${kind} message 1`, { groupName: localId });
        id = 'g:' + Buffer.from(row.session_group).toString('hex').toUpperCase();
      }
      for (let n = 2; n <= count; n++) lastId = fixture.c4.insertConversation('in', tab === 'mine' ? 'dashboard' : 'telegram', localId,
        `${kind} message ${n} — A visible message used to check stable reading position.`, { groupName: localId }).id;
      groups[`${tab}:${kind}`] = { id, count, lastId };
    }
    fixture.db.prepare('UPDATE conversations SET timestamp=?').run('2000-01-01 08:00:00');
    const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
    const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
      args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
    sandbox.addCleanup(() => browser.close());
    const closures = new WeakMap(), measurements = [];
    const close = context => {
      if (!closures.has(context)) closures.set(context, (async () => {
        await context.unrouteAll({ behavior: 'ignoreErrors' }); await context.close();
      })());
      return closures.get(context);
    };
    const wait = async (predicate, description, timeout = 8000) => {
      const end = Date.now() + timeout;
      while (!await predicate()) { assert.ok(Date.now() < end, description); await new Promise(resolve => setTimeout(resolve, 20)); }
    };
    const open = async (tab, kind, width, theme, { shortPages = false, delayOlder = false, failOlder = false } = {}) => {
      const target = groups[`${tab}:${kind}`], requests = [], metrics = { older: 0, active: 0, maxActive: 0, statuses: 0 };
      let release, blocked = delayOlder ? new Promise(resolve => { release = resolve; }) : null, failed = false;
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
      sandbox.addCleanup(() => { release?.(); return close(context); });
      await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
      await context.route('**/api/chat/conversations/**', async route => {
        const url = new URL(route.request().url());
        const selected = decodeURIComponent(url.pathname.split('/')[4]) === target.id;
        const history = selected && url.pathname.endsWith('/messages');
        const older = history && url.searchParams.get('direction') === 'before' && url.searchParams.has('cursor');
        if (selected && url.pathname.endsWith('/status')) metrics.statuses++;
        if (history) { assert.ok(requests.length < 40, 'bounded history request capture'); requests.push({ direction: url.searchParams.get('direction'), cursor: url.searchParams.has('cursor'), limit: url.searchParams.get('limit') }); }
        if (older) {
          metrics.older++; metrics.active++; metrics.maxActive = Math.max(metrics.maxActive, metrics.active);
          try {
            if (blocked) { const gate = blocked; blocked = null; await gate; }
            if (failOlder && !failed) { failed = true; await route.fulfill({ status: 500, json: { error: 'private_fixture_history_unavailable' } }); return; }
            if (shortPages) url.searchParams.set('limit', '2');
            const response = await route.fetch({ url: url.href }); await route.fulfill({ response });
          } finally { metrics.active--; }
          return;
        }
        if (history && shortPages) { url.searchParams.set('limit', '2'); const response = await route.fetch({ url: url.href }); await route.fulfill({ response }); return; }
        // Unknown row states exercise the retained per-row reconciliation link on the real mounted page.
        if (selected && tab === 'mine' && (history || url.pathname.endsWith('/status'))) {
          const response = await route.fetch(); const data = await response.json();
          for (const item of data.items || []) if (item.direction === 'in' || url.pathname.endsWith('/status')) item.status = 'unrecognized';
          await route.fulfill({ response, json: data }); return;
        }
        await route.continue();
      });
      await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
      await context.addInitScript(theme => { localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', 'zh'); }, theme);
      const page = await context.newPage(); page.setDefaultTimeout(8000);
      await page.goto(fixture.base + '/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
      await page.locator(`#wb-chat [data-action="${tab}"]`).click();
      await page.locator(`#wb-chat [data-conversation-id="${target.id}"]`).click();
      await page.locator(`#wb-chat [data-message-id="${target.lastId}"]`).waitFor();
      return { page, context, target, requests, metrics, release: () => release?.() };
    };
    const count = page => page.locator('#wb-chat [data-message-id]').count();
    const stream = page => page.locator('#wb-chat .conversation-stream');
    const nearTop = page => stream(page).evaluate(node => { node.scrollTop = node.clientHeight * .3; node.dispatchEvent(new Event('scroll')); });
    const shot = async (page, name) => {
      await page.evaluate(() => document.fonts.ready);
      if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) await page.screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `${name}.png`) });
    };
    for (const tab of ['mine', 'external']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) await t.test(`${tab} ${width} ${theme}: older page keeps its reading anchor and reaches the beginning`, async () => {
      const f = await open(tab, 'long', width, theme, { delayOlder: true });
      try {
        await wait(async () => await count(f.page) === 50, 'initial page has the normal fifty messages');
        assert.equal(await f.page.locator('.conversation-header [data-action="refreshMessages"], .conversation-header [data-action="refreshStatus"], [data-action="loadOlder"]').count(), 0);
        if (tab === 'mine') {
          const link = f.page.locator('.conversation-message-status [data-action="refreshStatus"]:visible').first();
          await link.waitFor(); const before = f.metrics.statuses; await link.click();
          await wait(() => f.metrics.statuses > before, 'retained per-row link performs authoritative status read');
        }
        await nearTop(f.page);
        await wait(() => f.metrics.older === 1, 'near-top scrolling starts one older page');
        assert.match(await f.page.locator('.conversation-history-start').innerText(), /正在加载更早的消息/);
        for (let n = 0; n < 3; n++) await stream(f.page).evaluate(node => node.dispatchEvent(new Event('scroll')));
        assert.equal(f.metrics.older, 1, 'repeated scroll events do not duplicate an in-flight page');
        // Continue to the physical top while this page is still in flight, so the status is visible in evidence.
        await stream(f.page).evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
        await shot(f.page, `${tab}-${width}-${theme}-loading`);
        const anchor = await stream(f.page).evaluate(node => {
          const bounds = node.getBoundingClientRect(), row = [...node.querySelectorAll('[data-message-id]')].find(row => row.getBoundingClientRect().bottom > bounds.top);
          return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
        });
        f.release(); await wait(async () => await count(f.page) === 100, 'one older batch merges');
        const after = await f.page.locator(`[data-message-id="${anchor.id}"]`).evaluate(node => node.getBoundingClientRect().top);
        assert.ok(Math.abs(after - anchor.top) <= 2, `reading row stays fixed (${after - anchor.top}px)`);
        assert.equal(f.metrics.maxActive, 1);
        assert.equal(f.requests.filter(row => row.direction === 'before').every(row => row.limit === '50'), true, 'older and initial requests use the same batch size');
        for (let n = 0; n < 3 && await count(f.page) < f.target.count; n++) { await nearTop(f.page); await wait(async () => await count(f.page) > 100 || f.metrics.active > 0, 'next older page starts'); }
        await wait(async () => await count(f.page) === f.target.count, 'all older messages eventually load');
        await stream(f.page).evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
        await wait(async () => (await f.page.locator('.conversation-history-start').innerText()).includes('没有更早的消息了'), 'beginning notice shown');
        const finalRequests = f.metrics.older; await nearTop(f.page); await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(f.metrics.older, finalRequests, 'no older read after the cursor ends');
        await stream(f.page).evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
        const beginning = f.page.locator('.conversation-history-start');
        assert.equal(await beginning.innerText(), '没有更早的消息了');
        assert.equal(await beginning.evaluate(node => {
          const box = node.getBoundingClientRect(), viewport = node.closest('.conversation-stream').getBoundingClientRect();
          return box.top >= Math.max(0, viewport.top) && box.bottom <= Math.min(innerHeight, viewport.bottom);
        }), true, 'the beginning notice is fully inside the visible history before capture');
        await shot(f.page, `${tab}-${width}-${theme}-beginning`);
        measurements.push({ tab, width, theme, anchorId: anchor.id, shift: after - anchor.top, olderRequests: f.metrics.older, maxActive: f.metrics.maxActive });
      } finally { f.release(); await close(f.context); }
    });
    for (const tab of ['mine', 'external']) await t.test(`${tab}: initially short pages fill the viewport or stop at the beginning`, async () => {
      for (const kind of ['fill', 'short']) {
        const f = await open(tab, kind, 390, 'light', { shortPages: true });
        try {
          await wait(async () => await stream(f.page).evaluate(node => node.scrollHeight > node.clientHeight + 2)
            || (await f.page.locator('.conversation-history-start').innerText()).includes('没有更早的消息了'), 'automatic initial filling reaches a full screen or the beginning');
          assert.ok(f.metrics.older >= 1, 'short first page automatically requests another');
          assert.equal(f.metrics.maxActive, 1);
          if (kind === 'short') assert.equal(await count(f.page), 3);
          else assert.ok(await count(f.page) < f.target.count, 'filling stops once a screen is occupied');
          await shot(f.page, `${tab}-underfilled-${kind}`);
        } finally { await close(f.context); }
      }
    });
    for (const tab of ['mine', 'external']) await t.test(`${tab}: failed older history waits for an explicit retry`, async () => {
      const f = await open(tab, 'long', 390, 'dark', { failOlder: true });
      try {
        await nearTop(f.page); const retry = f.page.locator('[data-action="retryOlder"]'); await retry.waitFor();
        assert.equal(await retry.innerText(), '加载失败，点此重试');
        const reads = f.metrics.older;
        for (let n = 0; n < 3; n++) await stream(f.page).evaluate(node => node.dispatchEvent(new Event('scroll')));
        await new Promise(resolve => setTimeout(resolve, 250));
        assert.equal(f.metrics.older, reads, 'failure is not retried by further scroll events');
        await stream(f.page).evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
        await shot(f.page, `${tab}-retry`); await retry.click();
        await wait(async () => await count(f.page) === 100, 'explicit retry successfully loads the same older page');
        assert.equal(f.metrics.older, reads + 1);
      } finally { await close(f.context); }
    });
    if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, 'anchor-measurements.json'), JSON.stringify(measurements, null, 2));
  }, { timeoutMs: 170000 });
});
