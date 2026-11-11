import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { createChatApiFixture } from './chat-integration-api.js';
import { sendJson } from '../../src/lib/http.js';

export async function runHistoryVisibilityBrowser(t, sandbox, { width, trigger }) {
  const fixture = await createChatApiFixture(t, sandbox, { name: 'Earlier history', extraHandler(req, res, url, f) {
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
  const mine = await fixture.createConversation('Earlier history conversation');
  const localId = mine.draft.localId, conversationId = mine.receipt.conversationId;
  const original = fixture.addOutbound(localId, 'Original earlier message: rehearse the rollback before release.');
  for (let index = 1; index <= 180; index++) fixture.addOutbound(localId, `History entry ${index}: a visible message for stable reading position.`);
  const quoted = fixture.c4.insertConversation('in', 'dashboard', localId, `[quote c4_id=${original.id}]\nReturn to the earlier original.`, { groupName: localId });
  fixture.db.prepare('UPDATE conversations SET timestamp=?').run('2000-01-01 08:00:00');
  const { chromium } = await import(pathToFileURL(process.env.ZYLOS_CHAT_BROWSER_MODULE));
  const browser = await chromium.launch({ executablePath: process.env.ZYLOS_CHAT_BROWSER_BIN, headless: true, env: sandbox.env,
    args: ['--no-sandbox', '--disable-background-networking', '--disable-component-update', '--no-first-run'] });
  sandbox.addCleanup(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, locale: 'zh-CN', timezoneId: 'UTC' });
  let release, reads = 0, active = 0, maxActive = 0;
  const gate = new Promise(resolve => { release = resolve; });
  sandbox.addCleanup(async () => { release(); await context.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); });
  await context.route('**/*', route => route.request().url().startsWith(fixture.base + '/') ? route.continue() : route.abort());
  await context.route(url => url.origin === fixture.base && url.pathname.endsWith('/messages') && url.searchParams.get('direction') === 'before' && url.searchParams.has('cursor'), async route => {
    assert.ok(++reads <= 8, 'bounded earlier-page requests'); active++; maxActive = Math.max(maxActive, active);
    try {
      if (reads === 1) { await gate; await route.fulfill({ status: 500, json: { error: 'private_fixture_history_unavailable' } }); }
      else await route.continue();
    } finally { active--; }
  });
  await context.addCookies([{ name: '__Secure-zylos_dashboard_session', value: fixture.cookie, domain: '127.0.0.1', path: '/', secure: true }]);
  await context.addInitScript(() => { if (window !== window.top) return; localStorage.setItem('zylos-dashboard-theme', 'light'); localStorage.setItem('zylos-dashboard-locale', 'zh'); });
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => { if (errors.length < 5) errors.push(error.message); });
  const wait = async (predicate, label) => {
    const end = Date.now() + 8000;
    while (!await predicate()) { assert.ok(Date.now() < end, label); await delay(20); }
  };
  const stream = page.locator('#wb-chat .conversation-stream');
  const row = id => page.locator(`#wb-chat article[data-message-id="${id}"]`);
  const count = () => page.locator('#wb-chat article[data-message-id]').count();
  await page.goto(fixture.base + '/chat');
  await page.locator('#wb-chat [data-conversation-id]').first().waitFor();
  await page.locator(`#wb-chat [data-conversation-id="${conversationId}"]`).click();
  await row(quoted.id).waitFor(); await wait(async () => await count() === 50, 'normal initial fifty-message batch');
  assert.equal(await row(original.id).count(), 0, 'original is outside the initial page');
  if (trigger === 'quote') await row(quoted.id).locator('.conversation-quote-block').click();
  else await stream.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  await wait(() => reads === 1, 'first earlier fetch starts');
  const status = page.locator('#wb-chat .conversation-history-start');
  await wait(async () => (await status.innerText()).includes('正在加载更早的消息'), 'delayed fetch displays loading');
  const output = process.env.ZYLOS_CHAT_EVIDENCE_DIR;
  if (output) fs.mkdirSync(output, { recursive: true });
  const measure = async state => {
    await page.evaluate(() => document.fonts.ready);
    const geometry = await status.evaluate(node => {
      const box = node.getBoundingClientRect(), stream = node.closest('.conversation-stream').getBoundingClientRect();
      const child = node.querySelector('[data-action="retryOlder"]:not([hidden])') || node.querySelector('.conversation-history-start-label');
      const content = child.getBoundingClientRect();
      return { indicator: { top: box.top, bottom: box.bottom, height: box.height }, content: { top: content.top, bottom: content.bottom }, stream: { top: stream.top, bottom: stream.bottom }, scrollTop: node.closest('.conversation-stream').scrollTop,
        viewport: { top: Math.max(0, stream.top), bottom: Math.min(innerHeight, stream.bottom) } };
    });
    t.diagnostic(JSON.stringify({ width, trigger, state, ...geometry }));
    if (output && trigger === 'manual') {
      await page.screenshot({ path: path.join(output, `history-${width}-${state}.png`) });
      fs.writeFileSync(path.join(output, `history-${width}-${state}.json`), JSON.stringify(geometry, null, 2));
    }
    assert.ok(geometry.indicator.top >= geometry.viewport.top - .5 && geometry.indicator.bottom <= geometry.viewport.bottom + .5
      && geometry.content.top >= geometry.viewport.top - .5 && geometry.content.bottom <= geometry.viewport.bottom + .5,
      `${state} indicator fully inside stream viewport: ${JSON.stringify(geometry)}`);
  };
  await measure('loading');
  release();
  const retry = page.locator('#wb-chat [data-action="retryOlder"]'); await retry.waitFor();
  assert.equal(await retry.innerText(), '加载失败，点此重试');
  await measure('failure');
  for (let i = 0; i < 3; i++) await stream.evaluate(node => node.dispatchEvent(new Event('scroll')));
  await delay(100); assert.equal(reads, 1, 'failed history waits for explicit retry');
  const anchor = await stream.evaluate(node => {
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll('article[data-message-id]')].find(row => row.getBoundingClientRect().bottom > top);
    return { id: row.dataset.messageId, top: row.getBoundingClientRect().top };
  });
  await retry.click(); await wait(async () => await count() === 100, 'retry reloads the same earlier page');
  assert.equal(reads, 2, 'retry performs one authoritative earlier read');
  const shift = await row(anchor.id).evaluate(node => node.getBoundingClientRect().top) - anchor.top;
  t.diagnostic(JSON.stringify({ width, trigger, anchor, shift, readsAfterRetry: reads }));
  assert.ok(Math.abs(shift) <= 2, `reading position preserved after prepend (${shift}px)`);
  if (trigger === 'quote') {
    const beforeJump = reads;
    await row(quoted.id).scrollIntoViewIfNeeded();
    await row(quoted.id).locator('.conversation-quote-block').click();
    await row(original.id).waitFor();
    await wait(() => row(original.id).evaluate(node => {
      const rect = node.getBoundingClientRect(), viewport = node.closest('.conversation-stream').getBoundingClientRect();
      return node.classList.contains('conversation-flash') && rect.top >= viewport.top && rect.bottom <= viewport.bottom;
    }), 'multi-page quote jump lands on the original inside the stream');
    t.diagnostic(JSON.stringify({ width, trigger, quoteEarlierReads: reads - beforeJump, originalId: original.id, originalBounds: await row(original.id).boundingBox() }));
    assert.ok(reads >= beforeJump + 2, 'quote jump requires more than one earlier page after retry');
  }
  assert.equal(maxActive, 1, 'one earlier fetch at a time'); assert.deepEqual(errors, [], 'no browser page errors');
}
