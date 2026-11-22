import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { chatEnabled, createChatSandbox } from './helpers/chat-integration-harness.js';
import { createChatApiFixture } from './helpers/chat-integration-api.js';
import { ORIGIN_CONVERSATION_ID as origin } from '../src/lib/chat/origin.js';
import { ChatChangeObserver } from '../src/lib/chat/change-observer.js';
import { handleChatStream } from '../src/lib/chat/stream.js';
import { SseHub } from '../src/lib/sse.js';

const listPath = '/api/chat/conversations';
const putPins = (fixture, ids, options) => fixture.request('/api/chat/pins', {
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
      const draft = await fixture.request('/api/chat/drafts', { method: 'POST' });
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

test('the mounted conversation list keeps its pins in order as messages arrive at 1280px and 390px',
  { skip: !chatEnabled(), timeout: 60000 }, async t => {
    const sandbox = createChatSandbox(t);
    await sandbox.runCase(async () => {
      const hub = new SseHub(1000);
      let observer;
      const fixture = await createChatApiFixture(t, sandbox, { extraHandler(req, res, url, f) {
        if (url.pathname !== '/api/stream') return false;
        observer ??= new ChatChangeObserver({ c4Reader: f.reader, history: f.history, intervalMs: 100 });
        if (!handleChatStream(req, res, url, { auth: f.auth, config: f.config, hub, observer })) hub.addClient(res);
        return true;
      } });
      sandbox.addCleanup(() => { observer?.close(); hub.closeAll(); });
      const [a, b, d, c] = await seed(fixture, ['A', 'B', 'D', 'C']);
      const [aId, bId, dId, cId] = [a, b, d, c].map(idOf);
      const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
      const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN,
        env: sandbox.env, headless: true, args: ['--disable-background-networking', '--disable-component-update'] });
      sandbox.addCleanup(() => browser.close());

      for (const width of [1280, 390]) {
        await t.test(`${width}px`, async () => {
          // Hold the list response at its original stamps so only a message read
          // can reorder a row in the browser.
          fixture.db.prepare("DELETE FROM conversations WHERE direction='out'").run();
          assert.equal((await putPins(fixture, [bId, aId])).status, 200);
          let snapshot = (await fixture.request(listPath)).body;
          assert.deepEqual(ordered(snapshot.items), [origin, bId, aId, cId, dId]);
          const context = await browser.newContext({ viewport: { width, height: 900 } });
          try {
            await context.route('**/*', route => {
              const url = new URL(route.request().url());
              if (url.origin !== fixture.base) return route.abort();
              if (url.pathname === listPath && snapshot) return route.fulfill({ json: snapshot });
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

            async function receive(conversation, body, expected) {
              await page.locator(`#wb-chat [data-conversation-id="${idOf(conversation)}"]`).click();
              await page.locator('#wb-chat [data-message-id]').first().waitFor();
              const reply = fixture.addOutbound(conversation.draft.localId, body);
              await page.clock.fastForward(10000);
              await page.locator(`#wb-chat [data-message-id="${reply.id}"]`).waitFor();
              if (width === 390) await page.locator('#wb-chat .conversation-back').click();
              assert.deepEqual(await ids(), expected);
            }
            await receive(d, 'New message in an ordinary conversation', [origin, bId, aId, dId, cId]);
            snapshot = (await fixture.request(listPath)).body;
            await receive(a, 'New message in the second pinned conversation', [origin, bId, aId, dId, cId]);

            // A second client writes the order. This already-open browser
            // receives a list hint without refreshing or navigating.
            snapshot = null;
            assert.equal((await putPins(fixture, [aId, bId])).status, 200);
            await page.waitForFunction(expected => {
              const ids = [...document.querySelectorAll('#wb-chat [data-conversation-id]')]
                .map(node => node.dataset.conversationId);
              return ids.join() === expected.join();
            }, [origin, aId, bId, dId, cId]);
            assert.equal(await page.evaluate(() => document.scrollingElement.scrollWidth <= innerWidth + 1), true);
          } finally {
            await context.unrouteAll({ behavior: 'ignoreErrors' });
            await context.close();
          }
        });
      }
    });
  });
