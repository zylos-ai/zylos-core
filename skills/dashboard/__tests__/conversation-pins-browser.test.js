import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture } from './helpers/chat-integration-api.js';
import { ORIGIN_CONVERSATION_ID as origin } from '../src/lib/chat/origin.js';
import { ChatChangeObserver } from '../src/lib/chat/change-observer.js';
import { handleChatStream } from '../src/lib/chat/stream.js';
import { SseHub } from '../src/lib/sse.js';

// Boundary: real chat HTTP and SQLite for pin replacement, access and pagination.
// Chromium exercises message-only preview updates, frozen order, and cross-client pin and read updates over SSE at 1280px and 390px.
// Run for changes to pin storage/migration, chat list or write contracts, pin invalidation, or
// browser list ordering and refresh. Unrelated runtime or presentation changes may skip this opt-in.
// The official runner and sandbox prove private HOME/ZYLOS_DIR/PM2_HOME, a short TMPDIR,
// a private tmux socket and fixture-only database paths before allocation. Browser, contexts,
// HTTP, SSE, and databases are cleaned up on success, failure or timeout.

const listPath = '/api/conversations';
const putPins = (fixture, ids, options) => fixture.request('/api/conversations/pins', {
  method: 'PUT', body: { ids }, ...options,
});
const idOf = conversation => conversation.receipt.conversationId;
const ordered = items => items.map(item => item.id);

async function seed(fixture, names) {
  const records = [];
  const stamp = fixture.db.prepare('UPDATE conversations SET timestamp=? WHERE id=?');
  for (const [i, name] of names.entries()) {
    const record = await fixture.createConversation(name);
    stamp.run(`2026-01-01 12:00:0${i}`, record.receipt.messageId);
    records.push(record);
  }
  return records;
}

test('pins replace the whole order over the real chat HTTP routes and stay out of later pages',
  { skip: !chatEnabled(), timeout: 30000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const fixture = await createChatApiFixture(t, sandbox);
      const [a, b, d, c] = (await seed(fixture, ['A', 'B', 'D', 'C'])).map(idOf);
      const draft = await fixture.request('/api/conversations/drafts', { method: 'POST' });
      fixture.c4.insertConversation('in', 'telegram', 'external', 'external conversation');
      const external = await fixture.request(listPath + '?tab=external');
      const externalId = external.body.items[0].id;
      const getPage = async (limit, cursor) => {
        const query = new URLSearchParams({ limit });
        if (cursor) query.set('cursor', cursor);
        const result = await fixture.request(listPath + '?' + query);
        assert.equal(result.status, 200, result.text);
        return result.body;
      };
      const before = (await getPage(50)).items;
      assert.deepEqual(before.filter(item => !item.draft).map(item => item.id), [origin, c, d, b, a]);

      const expected = [b, a];
      const replace = async () => {
        const result = await putPins(fixture, expected);
        assert.equal(result.status, 200, result.text);
        assert.deepEqual(result.body, { ok: true, ids: expected });
      };
      await replace();
      await replace();
      const all = (await getPage(50)).items.filter(item => !item.draft);
      assert.deepEqual(ordered(all), [origin, b, a, c, d]);
      assert.deepEqual(all.filter(item => Object.hasOwn(item, 'pinOrder')).map(item => item.pinOrder), [0, 1]);
      for (const limit of [1, 2]) {
        const first = await getPage(limit);
        assert.deepEqual(ordered(first.items.slice(0, 3)), [origin, b, a], 'every pin fits on the first page');
        const items = [...ordered(first.items)];
        let cursor = first.nextCursor;
        for (let i = 0; cursor && i < before.length; i++) {
          const next = await getPage(limit, cursor);
          assert.ok(next.items.every(item => !Object.hasOwn(item, 'pinOrder')));
          items.push(...ordered(next.items));
          cursor = next.nextCursor;
        }
        assert.equal(cursor, null);
        assert.deepEqual(items, [origin, b, a, ...ordered(before).filter(id => ![origin, a, b].includes(id))]);
      }
      assert.deepEqual((await fixture.request(listPath + '?tab=external')).body, external.body);

      for (const invalid of [origin, draft.body.conversation.id, externalId, 'g:414243', c + 'Z', null, b]) {
        const result = await putPins(fixture, [b, invalid]);
        assert.equal(result.status, 400, result.text);
        assert.deepEqual((await getPage(50)).items.filter(item => Object.hasOwn(item, 'pinOrder')).map(item => item.id), expected);
      }
      for (const body of [{}, { ids: 'invalid' }, { ids: [], other: true }]) {
        assert.equal((await putPins(fixture, [], { body })).status, 400);
      }
      fixture.config.chat.allowRemote = true;
      for (const [options, code] of [
        [{ origin: 'https://elsewhere.invalid' }, 'same_origin_required'],
        [{ identity: 'read' }, 'insufficient_scope'],
      ]) {
        const denied = await putPins(fixture, [], options);
        assert.deepEqual([denied.status, denied.body.error.code], [403, code]);
      }
      assert.deepEqual((await getPage(50)).items.filter(item => Object.hasOwn(item, 'pinOrder')).map(item => item.id), expected);
      const cleared = await putPins(fixture, [], { identity: 'admin', origin: null });
      assert.equal(cleared.status, 200, cleared.text);
      assert.deepEqual(cleared.body.ids, []);
      assert.deepEqual((await getPage(50)).items, before);
    });
  });

test('the mounted list moves local sends forward and holds other activity behind the notice at 1280px and 390px',
  { skip: !chatEnabled(), timeout: 60000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const hub = new SseHub(1000);
      let observer, chatHints = false;
      const fixture = await createChatApiFixture(t, sandbox, { extraHandler(req, res, url, f) {
        if (url.pathname !== '/api/stream') return false;
        if (chatHints && url.searchParams.has('chat')) {
          observer ??= new ChatChangeObserver({ c4Reader: f.reader, history: f.history, intervalMs: 100 });
          return handleChatStream(req, res, url, { auth: f.auth, config: f.config, hub, observer });
        }
        hub.addClient(res);
        return true;
      } });
      sandbox.addCleanup(() => { observer?.close(); hub.closeAll(); });
      fixture.config.chat.allowRemote = true;
      const [a, b, d, c] = await seed(fixture, ['A', 'B', 'D', 'C']);
      const [aId, bId, dId, cId] = [a, b, d, c].map(idOf);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
        env: sandbox.env, headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
      sandbox.addCleanup(() => browser.close());

      for (const width of [1280, 390]) {
        await t.test(`${width}px`, async () => {
          // Exercise message polling before the periodic list read is due.
          // The server always returns the real list if the browser requests it.
          chatHints = false;
          fixture.db.prepare("DELETE FROM conversations WHERE id>?").run(c.receipt.messageId);
          fixture.store.db.prepare("DELETE FROM chat_read_positions WHERE last_read>?").run(c.receipt.messageId);
          assert.equal((await putPins(fixture, [bId, aId])).status, 200);
          const initial = await fixture.request(listPath);
          assert.deepEqual(ordered(initial.body.items), [origin, bId, aId, cId, dId]);
          const locale = width === 1280 ? 'en' : 'zh';
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.addInitScript(value => localStorage.setItem('zylos-dashboard-locale', value), locale);
            let listReads = 0, holdNextList;
            await context.route('**/*', async route => {
              const url = new URL(route.request().url());
              if (url.origin !== fixture.base) return route.abort();
              if (url.pathname === listPath) {
                listReads++;
                const hold = holdNextList;
                holdNextList = null;
                if (hold) await hold();
              }
              return route.continue();
            });
            await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie,
              domain: '127.0.0.1', path: '/', secure: true }]);
            const page = await context.newPage();
            page.setDefaultTimeout(10000);
            await page.clock.install();
            await page.goto(fixture.base + '/chat');
            const rows = page.locator('#wb-chat [data-conversation-id]');
            const ids = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.conversationId));
            await rows.first().waitFor();
            assert.deepEqual(await ids(), [origin, bId, aId, cId, dId]);

            async function receive(conversation, append) {
              const opened = page.waitForResponse(response => {
                const url = new URL(response.url());
                return url.pathname === `${conversation.route}/messages` && url.searchParams.get('anchor') === 'read'
                  && url.searchParams.get('limit') === '50';
              });
              await page.locator(`#wb-chat [data-conversation-id="${idOf(conversation)}"]`).click();
              assert.equal((await opened).status(), 200);
              await page.locator('#wb-chat .conversation-history-start').waitFor();
              const priorListReads = listReads;
              const reply = append(conversation.draft.localId);
              await page.clock.fastForward(6000);
              await page.locator(`#wb-chat [data-message-id="${reply.id}"]`).waitFor();
              if (width === 390) await page.locator('#wb-chat .conversation-back').click();
              assert.equal(listReads, priorListReads, 'the message read alone updated the browser list');
            }
            const hint = page.locator('#wb-chat [data-action="page.newConversations"]');
            const dRow = page.locator(`#wb-chat [data-conversation-id="${dId}"]`);
            const originalTime = await dRow.locator('time').getAttribute('datetime');
            await receive(d, localId => fixture.addOutbound(localId, 'Ordinary conversation reply'));
            assert.match(await dRow.locator('.chat-preview').innerText(), /Ordinary conversation reply/);
            assert.equal(await dRow.locator('time').getAttribute('datetime'), originalTime);
            assert.deepEqual(await ids(), [origin, bId, aId, cId, dId]);
            assert.equal(await hint.isVisible(), false, 'an outgoing reply does not change activity order');

            await receive(d, localId => fixture.c4.insertConversation('in', 'dashboard', localId,
              'New received message', { groupName: localId }));
            assert.notEqual(await dRow.locator('time').getAttribute('datetime'), originalTime);
            assert.deepEqual(await ids(), [origin, bId, aId, cId, dId]);
            await hint.waitFor();
            // Hold the user's request while a scheduled poll sees a real reply.
            let releaseList;
            const listGate = new Promise(resolve => { releaseList = resolve; });
            const listStarted = new Promise(resolve => {
              holdNextList = () => { resolve(); return listGate; };
            });
            try {
              await hint.click();
              await listStarted;
              const duringClick = fixture.addOutbound(d.draft.localId, 'Reply during the requested list refresh');
              await page.clock.fastForward(31_000);
              await page.locator(`#wb-chat [data-message-id="${duringClick.id}"]`).waitFor({ state: 'attached' });
              await page.waitForFunction(expected => [...document.querySelectorAll('#wb-chat [data-conversation-id]')]
                .map(node => node.dataset.conversationId).join() === expected.join(), [origin, bId, aId, dId, cId]);
              await hint.waitFor({ state: 'hidden' });
            } finally {
              releaseList();
            }

            await receive(a, localId => fixture.c4.insertConversation('in', 'dashboard', localId,
              'New received message in a pinned conversation', { groupName: localId }));
            assert.deepEqual(await ids(), [origin, bId, aId, dId, cId]);
            assert.equal(await hint.isVisible(), false, 'activity does not change the pinned order');

            // Selecting a different conversation opens a real chat stream.
            // The subsequent write from a second client updates this open page.
            chatHints = true;
            await page.locator(`#wb-chat [data-conversation-id="${dId}"]`).click();
            await page.locator('#wb-chat .conversation-push-status[data-stream-state="live"]').waitFor({ state: 'attached' });
            if (width === 390) await page.locator('#wb-chat .conversation-back').click();
            assert.equal((await putPins(fixture, [aId, bId])).status, 200);
            await page.waitForFunction(expected => {
              const ids = [...document.querySelectorAll('#wb-chat [data-conversation-id]')]
                .map(node => node.dataset.conversationId);
              return ids.join() === expected.join();
            }, [origin, aId, bId, dId, cId]);
            const cDot = page.locator(`.conversation-list-row:has([data-conversation-id="${cId}"]) .conversation-unread-dot`);
            const reply = fixture.addOutbound(c.draft.localId, 'Unread on this client');
            await cDot.waitFor();
            const read = await fixture.request(`${c.route}/read`, { method: 'PUT', identity: 'admin', origin: null,
              body: { upTo: reply.id } });
            assert.equal(read.status, 200, read.text);
            await cDot.waitFor({ state: 'hidden' });

            const added = await fixture.createConversation('First incoming message in a new conversation');
            await hint.waitFor();
            assert.equal(await page.locator(`#wb-chat [data-conversation-id="${idOf(added)}"]`).count(), 0);
            const singular = locale === 'en' ? '1 conversation has new messages' : '有 1 个对话有新消息';
            assert.equal(await hint.innerText(), singular);
            assert.deepEqual(await ids(), [origin, aId, bId, dId, cId]);

            await page.locator(`#wb-chat [data-conversation-id="${cId}"]`).click();
            const composer = page.locator('#wb-chat .conversation-input:enabled');
            await composer.fill('Sent from the mounted dashboard page');
            const sent = page.waitForResponse(response => new URL(response.url()).pathname === `${c.route}/send`);
            await page.locator('#wb-chat [data-action="send"]').click();
            assert.equal((await (await sent).json()).stored, true);
            await page.locator('#wb-chat .conversation-message-list').getByText('Sent from the mounted dashboard page').waitFor();
            if (width === 390) await page.locator('#wb-chat .conversation-back').click();
            assert.deepEqual(await ids(), [origin, aId, bId, cId, dId], 'the local send moves ahead of unpinned rows');
            assert.equal(await hint.innerText(), singular, 'the existing notice still counts only the other conversation');

            const second = await fixture.createConversation('Second incoming message in a new conversation');
            const plural = locale === 'en' ? '2 conversations have new messages' : '有 2 个对话有新消息';
            await page.waitForFunction(expected => document.querySelector('#wb-chat [data-action="page.newConversations"]').innerText === expected, plural);
            await hint.click();
            await page.locator(`#wb-chat [data-conversation-id="${idOf(added)}"]`).waitFor();
            await page.locator(`#wb-chat [data-conversation-id="${idOf(second)}"]`).waitFor();
            await hint.waitFor({ state: 'hidden' });
            assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), true);
          } finally {
            await context.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
          }
        });
      }
    });
  });

test('mobile lists page and search on demand, and Mine opens at the unread divider',
  { skip: !chatEnabled(), timeout: 60000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const fixture = await createChatApiFixture(t, sandbox);
      const stamp = fixture.db.prepare('UPDATE conversations SET timestamp=? WHERE id=?');
      for (let i = 0; i < 120; i++) {
        const groupName = `team-${String(i).padStart(3, '0')}`;
        const row = fixture.c4.insertConversation('in', 'telegram', groupName, `message ${i}`, { groupName });
        stamp.run(new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(), row.id);
      }
      const firstPage = await fixture.request(listPath + '?tab=external');
      assert.equal(firstPage.status, 200, firstPage.text);
      assert.equal(firstPage.body.items.length, 50);
      assert.ok(firstPage.body.nextCursor);
      const mine = await fixture.createConversation('Read anchor');
      const mineId = idOf(mine), localId = mine.draft.localId;
      const append = i => fixture.c4.insertConversation('out', 'dashboard', localId, `Reply ${i}`, { groupName: localId }).id;
      let last = 0;
      for (let i = 1; i <= 30; i++) last = append(i);
      assert.equal((await fixture.request(`${mine.route}/read`, { method: 'PUT', body: { upTo: last } })).status, 200);
      const firstUnread = append(31);
      for (let i = 32; i <= 180; i++) last = append(i);

      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
        env: sandbox.env, headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
      sandbox.addCleanup(() => browser.close());
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      sandbox.addCleanup(() => context.close());
      let invalidateCursor = false, invalidations = 0, externalReads = 0;
      const readWrites = [];
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== fixture.base) return route.abort();
        if (url.pathname === listPath && url.searchParams.get('tab') === 'external') {
          externalReads++;
          if (invalidateCursor && url.searchParams.has('cursor')) {
            invalidateCursor = false;
            invalidations++;
            url.searchParams.set('cursor', 'invalid-position');
            return route.continue({ url: url.href });
          }
        }
        if (url.pathname.endsWith('/read') && route.request().method() === 'PUT') {
          assert.ok(readWrites.length < 5, 'read writes stay bounded');
          readWrites.push(route.request().postDataJSON().upTo);
        }
        return route.continue();
      });
      await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie,
        domain: '127.0.0.1', path: '/', secure: true }]);
      const page = await context.newPage();
      page.setDefaultTimeout(10000);
      await page.clock.install();
      await page.goto(fixture.base + '/chat');
      await page.locator('#wb-chat [data-action="external"]').click();

      const sidebar = page.locator('#wb-chat .conversation-sidebar');
      const list = sidebar.locator('.conversation-items');
      const rows = sidebar.locator('[data-conversation-id]');
      const waitForRows = count => page.waitForFunction(expected =>
        document.querySelectorAll('#wb-chat .conversation-sidebar [data-conversation-id]').length === expected, count);
      const ids = () => rows.evaluateAll(nodes => nodes.map(node => node.dataset.conversationId));
      const bottom = () => list.evaluate(node => { node.scrollTop = node.scrollHeight; node.dispatchEvent(new Event('scroll')); });
      await waitForRows(50);
      assert.equal(externalReads, 1);
      assert.equal(await sidebar.locator('[data-action="loadMore"]').count(), 0);

      invalidateCursor = true;
      const recovered = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname === listPath && url.searchParams.get('tab') === 'external' && !url.searchParams.has('cursor');
      });
      await bottom();
      assert.equal((await recovered).status(), 200);
      assert.equal(invalidations, 1, 'an invalid continuation re-reads the first page');
      await waitForRows(50);
      await bottom();
      await waitForRows(100);
      await bottom();
      await waitForRows(120);
      assert.equal(new Set(await ids()).size, 120);

      const [first, second] = await ids();
      const pin = id => sidebar.locator(`.conversation-list-row:has([data-conversation-id="${id}"]) [data-action="pin"]`);
      async function pinConversation(id) {
        const changed = page.waitForResponse(response => response.request().method() === 'PUT'
          && new URL(response.url()).pathname === `${listPath}/pins`);
        await pin(id).click();
        assert.equal((await changed).status(), 200);
        await pin(id).and(page.locator('[aria-pressed="true"]:enabled')).waitFor();
      }
      await pinConversation(first);
      await pinConversation(second);
      const dragFrom = await pin(second).boundingBox(), dragTo = await pin(first).boundingBox();
      await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragFrom.y + dragFrom.height / 2);
      await page.mouse.down();
      await page.mouse.move(dragTo.x + dragTo.width / 2, dragTo.y + dragTo.height / 2, { steps: 3 });
      await page.mouse.up();
      await page.waitForFunction(id =>
        document.querySelector('#wb-chat .conversation-sidebar [data-conversation-id]')?.dataset.conversationId === id, second);

      const searchInput = sidebar.locator('input[type="search"]');
      await searchInput.fill('no matching group');
      await page.clock.fastForward(300);
      await sidebar.locator('.conversation-list-notice').waitFor();
      await waitForRows(0);
      assert.match(await sidebar.locator('.conversation-list-notice').innerText(), /No matching results|没有匹配的结果/);
      await searchInput.fill('telegram:team-119');
      await page.clock.fastForward(300);
      await waitForRows(1);
      assert.equal(await rows.first().getAttribute('data-conversation-id'), first);
      assert.equal(await pin(first).getAttribute('aria-pressed'), 'true');
      await searchInput.fill('');
      await page.clock.fastForward(300);
      await waitForRows(52);

      await page.locator('#wb-chat [data-action="mine"]').click();
      const mineRow = sidebar.locator(`.conversation-list-row:has([data-conversation-id="${mineId}"])`);
      await mineRow.locator('.conversation-unread-dot').waitFor();
      await page.clock.pauseAt(new Date(Date.now() + 3000));
      await page.bringToFront();
      await mineRow.locator('[data-conversation-id]').click();
      const stream = page.locator('#wb-chat .conversation-stream');
      const divider = stream.locator('.conversation-unread-divider');
      await divider.waitFor();
      assert.equal(await divider.evaluate(node => Number(node.nextElementSibling.dataset.messageId)), firstUnread);
      const latest = page.locator('#wb-chat [data-action="latest"]');
      assert.equal(await latest.innerText(), '99+');
      const jump = page.waitForRequest(req => {
        const url = new URL(req.url());
        return url.pathname.endsWith('/messages') && !url.searchParams.has('anchor')
          && !url.searchParams.has('cursor') && url.searchParams.get('direction') === 'before';
      });
      await latest.click();
      await jump;
      await stream.locator(`[data-message-id="${last}"]`).waitFor();
      assert.equal(await stream.locator(`[data-message-id="${firstUnread}"]`).count(), 0, 'jump replaces the anchored window');
      await page.clock.runFor(650);
      assert.equal(readWrites.length, 0, 'writing the read position waits for a visible bottom edge');
      const committed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/read')
        && response.request().method() === 'PUT');
      await page.clock.runFor(100);
      assert.equal((await committed).status(), 200);
      const read = await fixture.request(`${mine.route}/messages?anchor=read&limit=1`);
      assert.equal(read.body.readUpTo, last);
      assert.equal(readWrites.at(-1), last);
      assert.equal(read.body.unreadCount, 0);
    });
  });
