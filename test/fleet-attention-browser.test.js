import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from '../skills/dashboard/__tests__/helpers/chat-integration-harness.js';

// Boundary: real Fleet renderer and styles in an isolated local browser with fixed data.
// Run for Fleet attention, diagnostic text, or responsive layout changes; skip for backend-only changes.

test('Fleet diagnostics wrap and remain literal across desktop/mobile and themes',
  { skip: !chatEnabled(), timeout: 120_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { startPage } = await import('../skills/dashboard/__tests__/helpers/workbench-browser.js');
      const { base } = await startPage(sandbox);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
        env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking'] });
      sandbox.addCleanup(() => browser.close());
      for (const width of [390, 1280, 1440]) for (const theme of ['light', 'dark']) {
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        try {
          await page.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
          await page.goto(base + '/_assets/themes/' + theme + '.css');
          await page.setContent(`<html data-theme="${theme}"><head><link rel="stylesheet" href="${base}/_assets/css/style.css"><link rel="stylesheet" href="${base}/_assets/themes/${theme}.css"><link rel="stylesheet" href="${base}/_assets/css/wb.css"></head><body><div id="fleet-view" class="fleet-view"><div id="root"></div></div></body></html>`);
          await page.evaluate(async base => {
            const { renderAgentFleet } = await import(base + '/_assets/js/agent-fleet.js');
            const pack = await (await fetch(base + '/_assets/i18n/wb.en.json')).json();
            const attention = [
              { kind: 'channel_send_failed', channel: 'lark', count: 4 },
              { kind: 'channel_restarting', channel: 'lark', count: 3 },
              { kind: 'start_failed', group: 'ops', count30m: 2 },
              { kind: 'rate_limited', runtime: 'codex' },
              { kind: 'data_unreadable', group: 'ops', reasonCode: '<img src=x onerror=alert(1)>' + 'very-long-reason-'.repeat(12) },
            ];
            const fleet = { agents: [{ name: 'Local', self: true, state: 'IDLE', session_mode: 'multi',
              group_summary: { running: 5, listKnown: true, counts: { busy: 2, idle: 1, no_response: 1, unknown: 1 }, problems: [], problemCount: 0, attention } }] },
              options = { t: (key, values = {}) => (pack[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? '')) };
            renderAgentFleet(document.querySelector('#root'), fleet, options);
            window.renderCleanAttention = () => {
              attention.at(-1).reasonCode = 'identity_mismatch'; attention.at(-1).displayName = 'Operations';
              renderAgentFleet(document.querySelector('#root'), fleet, options);
            };
          }, base);
          await page.locator('.wb-f-attention-item').first().waitFor();
          await page.evaluate(() => document.fonts.ready);
          assert.equal(await page.locator('.wb-f-attention-item').count(), 5);
          assert.equal(await page.locator('.wb-f-attention img').count(), 0);
          assert.match(await page.locator('.wb-f-attention').innerText(), /<img src=x onerror=alert\(1\)>/);
          const geometry = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
            rows: [...document.querySelectorAll('.wb-f-attention-item,.wb-f-attention-detail,.wb-f-running')].map(node => ({
              width: node.clientWidth, scroll: node.scrollWidth, height: node.getBoundingClientRect().height,
            })) }));
          assert.ok(geometry.scroll <= width, JSON.stringify(geometry));
          for (const row of geometry.rows) assert.ok(row.scroll <= row.width + 1, JSON.stringify(row));
          const button = page.locator('.wb-f-attention-item[data-fleet-group]').first();
          await button.focus();
          assert.equal(await button.evaluate(node => node === document.activeElement), true);
          await button.evaluate(node => node.blur());
          await page.evaluate(async base => {
            window.renderCleanAttention();
            const { renderAttention } = await import(base + '/_assets/js/wb/attention-bar.js');
            const pack = await (await fetch(base + '/_assets/i18n/wb.en.json')).json();
            const root = document.createElement('div'); root.id = 'overview-attention';
            document.body.append(root);
            renderAttention(root, { attention: { problems: [{ kind: 'data_unreadable', group: 'ops',
              displayName: 'Operations', reasonCode: 'identity_mismatch' }] } }, { level: 'plain', t: key => pack[key] ?? key });
          }, base);
          assert.match(await page.locator('#overview-attention').innerText(), /Operations.*identity_mismatch/);
          if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) await page.screenshot({
            path: process.env.ZYLOS_CHAT_EVIDENCE_DIR + `/fleet-attention-${width}-${theme}.png`, fullPage: true });
          console.log('Fleet attention geometry:', JSON.stringify({ theme, ...geometry }));
        } finally { await page.close(); }
      }
    }, { timeoutMs: 110_000 });
  });

// Boundary: actual chat HTTP history, private C4/dashboard databases and full page at 390px.
// Run when outbound status or chat history delivery mapping changes; skip unrelated Fleet-only changes.
test('failed external outbound history renders its text without a page error',
  { skip: !chatEnabled(), timeout: 60_000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const { createChatApiFixture } = await import('../skills/dashboard/__tests__/helpers/chat-integration-api.js');
      const { sendJson } = await import('../skills/dashboard/src/lib/http.js');
      const fixture = await createChatApiFixture(t, sandbox, { extraHandler(req, res, url, f) {
        if (!url.pathname.startsWith('/api/')) return false;
        if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
        const values = {
          '/api/instance': { default_runtime: 'claude', session_mode: { sessionMode: f.readMode() }, agent: { id: 'test', name: 'Private browser' } },
          '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' },
          '/api/groups/counts': { mode: f.readMode(), running: { total: 0, states: {}, flags: {} }, offline: { total: 0 }, pool: {} },
          '/api/groups/running': { rows: [], listKnown: true }, '/api/instance/runtime-options': { actions: [] },
        };
        sendJson(res, 200, values[url.pathname] || {}); return true;
      } });
      const outbound = fixture.c4.insertConversation('out', 'telegram', 'failed-history', 'Reply could not be sent', { groupName: 'failed-history' });
      fixture.db.prepare("UPDATE conversations SET status='failed', delivery_action='send_failed' WHERE id=?").run(outbound.id);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true,
        env: sandbox.env, args: ['--no-sandbox', '--disable-background-networking'] });
      sandbox.addCleanup(() => browser.close());
      const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
      sandbox.addCleanup(() => context.close());
      await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
      await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
      const page = await context.newPage(), errors = []; page.setDefaultTimeout(10_000);
      page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
      await page.goto(fixture.base + '/chat');
      await page.locator('#wb-chat [data-action="external"]').click();
      const id = 'g:' + Buffer.from(outbound.session_group).toString('hex').toUpperCase();
      await page.locator(`#wb-chat .conversation-list-item[data-conversation-id="${id}"]`).click();
      await page.locator(`#wb-chat [data-message-id="${outbound.id}"]`).waitFor();
      const history = await fixture.request(`/api/chat/conversations/${encodeURIComponent(id)}/messages?tab=external`);
      assert.equal(history.body.items.find(row => row.id === outbound.id).deliveryState, 'pending_reconciliation');
      assert.equal(await page.locator(`#wb-chat [data-message-id="${outbound.id}"] .chat-message-status`).isVisible(), false);
      assert.match(await page.locator('#wb-chat').innerText(), /Reply could not be sent/);
      assert.equal(errors.length, 0, errors.slice(0, 5).join('\n'));
      console.log('Failed outbound history browser:', JSON.stringify({ status: 'failed', apiDeliveryState: 'pending_reconciliation', visibleStatusBadge: false, pageErrors: errors.length, width: 390 }));
      if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) await page.screenshot({
        path: process.env.ZYLOS_CHAT_EVIDENCE_DIR + '/failed-outbound-history-390.png', fullPage: true });
    }, { timeoutMs: 50_000 });
  });
