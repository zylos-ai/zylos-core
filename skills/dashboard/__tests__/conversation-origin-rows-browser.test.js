import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture, questionContent } from './helpers/chat-integration-api.js';
import { acceptDelivery } from '../src/lib/chat/channel.js';
import { sendJson } from '../src/lib/http.js';

const translations = Object.fromEntries(['en', 'zh'].map(locale => [locale,
  JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'))]));
const fill = (locale, key, params = {}) => Object.entries(params)
  .reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), translations[locale][key]);
const ORIGIN_ID = 'g:6F726967696E';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Boundary: real Dashboard entry, authenticated chat HTTP routes, the real multi-to-single conversion, private
// C4/dashboard SQLite histories and the real channel's question registration; browser labels, quote/answer
// availability and layout of the Origin conversation at 1280/390, light/dark, en/zh. Rows of another Dashboard
// conversation and of a Telegram chat are recorded under `origin` by updating their group, as single-mode delivery
// records them. No model, PM2, tmux, real channel or live database starts.
// Run for Origin page history, row labels, question or quote availability changes; skip unrelated backend changes.
// Opt-in before allocating; sandbox proves private HOME/ZYLOS_DIR/PM2_HOME/TMPDIR/socket/DB paths and owns
// browser, HTTP and database cleanup on pass, failure or timeout. All remote browser requests are denied.
test('in single the Origin conversation shows other conversations and external chats with their channels, read only',
  { skip: !chatEnabled(), timeout: 180000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      console.log('Origin rows browser isolation:', JSON.stringify(sandbox.assertIsolation()));
      const fixture = await createChatApiFixture(t, sandbox, { name: 'Project X', extraHandler(req, res, url, f) {
        if (!url.pathname.startsWith('/api/')) return false;
        if (url.pathname === '/api/stream') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(); return true; }
        const values = {
          '/api/fleet': { agents: [] }, '/api/health': { status: 'ok' },
          '/api/groups/counts': { mode: f.readMode(), running: { total: 0, states: {}, flags: {} }, offline: { total: 0 }, pool: {} },
          '/api/groups/running': { rows: [], listKnown: true }, '/api/instance/runtime-options': { actions: [] },
        };
        sendJson(res, 200, values[url.pathname] || {}); return true;
      } });
      const x = await fixture.createConversation('Started in multi');
      const xLocal = x.draft.localId, xGroup = `${x.receipt.namespace}:${xLocal}`;
      await fixture.switchToSingle();
      const post = content => ({ method: 'POST', body: { content } });
      const own = await fixture.request(`/api/chat/conversations/${ORIGIN_ID}/send`, post('Owner asks Origin'));
      assert.equal(own.status, 200, own.text);
      const ownReply = fixture.addOutbound('origin', 'Origin answers the owner');
      // Recorded under `origin`, as single-mode delivery records every conversation's and chat's rows.
      const underOrigin = row => {
        fixture.db.prepare("UPDATE conversations SET session_group='origin' WHERE id=?").run(row.id);
        return { ...row, session_group: 'origin' };
      };
      const xIn = underOrigin(fixture.c4.insertConversation('in', 'dashboard', xLocal, 'Queued in Project X', { groupName: xLocal }));
      const question = fixture.question();
      const xQuestion = underOrigin(fixture.c4.insertConversation('out', 'dashboard', xLocal, questionContent(question), { groupName: xLocal }));
      acceptDelivery({ version: 1, c4_id: xQuestion.id, channel: 'dashboard', endpoint_id: xLocal, session_group: 'origin',
        content: xQuestion.content }, { env: sandbox.env });
      assert.equal(fixture.store.db.prepare('SELECT session_group FROM chat_questions WHERE c4_id=?').get(String(xQuestion.id)).session_group, xGroup,
        'the question registers under the conversation it is sent to');
      const tgIn = underOrigin(fixture.c4.insertConversation('in', 'telegram', '-100123|thread:7', '[TG GROUP:Team] From Telegram'));
      const tgOut = underOrigin(fixture.c4.insertConversation('out', 'telegram', '-100123|thread:7', 'Origin answers Telegram'));
      const relay = fixture.c4.insertInternalMessage(xGroup, 'origin', 'Internal relay to Origin');
      const ownIn = fixture.db.prepare("SELECT id FROM conversations WHERE channel='dashboard' AND endpoint_id='origin' AND direction='in'").get().id;
      const ordered = [ownIn, ownReply.id, xIn.id, xQuestion.id, tgIn.id, tgOut.id];
      fixture.db.prepare("UPDATE conversations SET timestamp=strftime('%Y-%m-%d %H:%M:%S', '2026-11-18 08:00:00', '+' || id || ' seconds')").run();

      const answer = await fixture.request(`${x.route}/answers`, { method: 'POST', body: fixture.answer(question, 'single-mode-answer') });
      assert.deepEqual([answer.status, answer.body.error?.code], [403, 'chat_requires_multi'], 'answering another conversation stays closed in single');

      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
        args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
      sandbox.addCleanup(() => browser.close());
      const closures = new WeakMap();
      const closeContext = context => {
        if (!closures.has(context)) closures.set(context, (async () => {
          await context.unrouteAll({ behavior: 'ignoreErrors' });
          await context.close();
        })());
        return closures.get(context);
      };
      const open = async (width, theme, locale) => {
        const context = await browser.newContext({ viewport: { width, height: 900 }, locale: locale === 'zh' ? 'zh-CN' : 'en-US', timezoneId: 'UTC' });
        sandbox.addCleanup(() => closeContext(context));
        await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
        await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
        await context.addInitScript(([theme, locale]) => {
          localStorage.setItem('zylos-dashboard-theme', theme); localStorage.setItem('zylos-dashboard-locale', locale);
          localStorage.setItem('zylos-dashboard-detail-level', 'plain');
        }, [theme, locale]);
        const page = await context.newPage(); page.setDefaultTimeout(8000);
        await page.goto(fixture.base + '/chat'); await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
        return { context, page };
      };
      const row = (page, id) => page.locator(`#wb-chat [data-message-id="${id}"]`);
      const select = async (page, id) => {
        await page.locator('#wb-chat [data-action="mine"]').click();
        await page.locator(`#wb-chat [data-conversation-id="${id}"]`).click();
      };
      const quoteBar = page => page.locator('#wb-chat .conversation-quote-bar');
      const swipe = async (page, id) => {
        const target = row(page, id).locator('.chat-message-text, .chat-question').first();
        // Let the list settle after scrolling the row into view, as a user would before swiping it.
        await target.scrollIntoViewIfNeeded(); await delay(300);
        await target.hover();
        for (let step = 0; step < 4; step++) { await page.mouse.wheel(25, 0); await delay(16); }
        await delay(260);
      };

      for (const locale of ['en', 'zh']) for (const width of [1280, 390]) for (const theme of ['light', 'dark']) {
        await t.test(`${locale} ${width} ${theme}: Origin rows carry their channel and only Origin's own rows are quotable or answerable`, async () => {
          const { context, page } = await open(width, theme, locale);
          try {
            if (width === 390) await page.locator('#wb-chat [data-action="mine"]').waitFor();
            await select(page, ORIGIN_ID); await row(page, tgOut.id).waitFor();
            const dashboard = name => fill(locale, 'chat.page.dashboardRow', { channel: 'Dashboard', name });
            const authors = await Promise.all(ordered.map(id => row(page, id).locator('.chat-message-author').innerText()));
            assert.deepEqual(authors, [dashboard('Origin'), dashboard('Origin'), dashboard('Project X'), dashboard('Project X'),
              fill(locale, 'chat.external.received', { channel: 'Telegram' }), fill(locale, 'chat.external.sent', { channel: 'Telegram' })]);
            const internal = page.locator('#wb-chat .conversation-internal');
            assert.deepEqual(await internal.evaluateAll(nodes => nodes.map(node => node.dataset.messageId)), [String(relay.inRow.id)],
              'the internal row recorded under origin shows on the Origin page as an internal message');
            assert.match(await internal.locator('.conversation-internal-content').innerText(), /Internal relay to Origin/);
            const card = row(page, xQuestion.id).locator('.chat-question');
            await card.waitFor();
            const note = card.locator('.chat-notice').filter({ hasText: translations[locale]['chat.question.otherConversationReadOnly'] });
            assert.equal(await note.count(), 1, 'the card explains why it is read only');
            assert.equal(await note.evaluate(node => node.scrollWidth <= node.clientWidth + 1
              && node.getBoundingClientRect().right <= innerWidth + 1), true, 'the explanation wraps inside the card');
            assert.equal(await card.locator('button:enabled, input:enabled').count(), 0, 'no answer control is enabled');
            const quoteHidden = await Promise.all(ordered.map(id => row(page, id).locator('.conversation-quote-button').evaluate(node => node.hidden)));
            assert.deepEqual(quoteHidden, [false, false, true, true, true, true], 'only Origin\'s own rows offer a quote');
            assert.equal(await page.locator('#wb-chat .conversation-input').isDisabled(), false, 'the Origin conversation stays writable');
            const item = page.locator(`#wb-chat [data-conversation-id="${ORIGIN_ID}"]`);
            const preview = await item.innerText();
            assert.match(preview, /Origin answers Telegram/, 'the Origin list row previews its latest non-internal row');
            assert.doesNotMatch(preview, /Internal relay to Origin/, 'the list preview never takes the internal row');
            const boxes = await page.locator('#wb-chat .conversation-message-list [data-message-id]').evaluateAll(nodes => nodes.map(node => {
              const box = node.getBoundingClientRect(); return { left: box.left, right: box.right, width: innerWidth };
            }));
            assert.ok(boxes.every(box => box.left >= 0 && box.right <= box.width + 1), 'rows stay inside the viewport');
            assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), true, 'no horizontal page scroll');
            await row(page, xQuestion.id).scrollIntoViewIfNeeded();
            if (process.env.ZYLOS_CHAT_EVIDENCE_DIR) {
              await page.evaluate(() => document.fonts.ready);
              await page.screenshot({ path: path.join(process.env.ZYLOS_CHAT_EVIDENCE_DIR, `origin-rows-${locale}-${width}-${theme}.png`) });
            }
          } finally { await closeContext(context); }
        });
      }

      await t.test('a sideways swipe quotes Origin\'s own row but not another conversation\'s or chat\'s row', async () => {
        const { context, page } = await open(1280, 'light', 'en');
        try {
          await select(page, ORIGIN_ID); await row(page, tgOut.id).waitFor();
          for (const id of [xIn.id, tgIn.id]) {
            await swipe(page, id);
            assert.equal(await quoteBar(page).isVisible(), false, `row ${id} cannot be quoted on the Origin page`);
          }
          await swipe(page, ownReply.id);
          await quoteBar(page).waitFor();
        } finally { await closeContext(context); }
      });

      await t.test('in single the other conversation stays read only on its own page', async () => {
        const { context, page } = await open(1280, 'light', 'en');
        try {
          await select(page, x.receipt.conversationId);
          await page.locator('#wb-chat .chat-message-text').filter({ hasText: 'Started in multi' }).waitFor();
          assert.equal(await page.locator('#wb-chat .conversation-input').isDisabled(), true, 'the input of another conversation is disabled in single');
        } finally { await closeContext(context); }
      });
    }, { timeoutMs: 170000 });
  });
