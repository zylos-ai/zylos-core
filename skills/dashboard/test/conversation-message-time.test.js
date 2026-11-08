import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, visibleNodes, tick } from './helpers/conversation-dom.js';
const shared = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(shared, context);
  return next(specifier, context);
} });
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');

// Real page -> state with the time zone the conversation list and message history report. Injected transport only;
// no network/DB/tmux/PM2. The process zone stands in for the browser's and is set apart from the instance zone, so
// only the reported zone can give the result. Run on changes to how the conversation page writes times.

const clock = (iso, timeZone) => new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(iso));
const day = (iso, timeZone) => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone }).format(new Date(iso));
// 17:30 UTC on 7 November: 01:30 on 8 November in Shanghai, 09:30 on 7 November in Los Angeles.
const SENT = '2026-11-07T17:30:00Z';
const ROW = { id: 12, direction: 'out', status: 'delivered', content: 'hello', timestamp: '2026-11-07 17:30:00' };

async function fixture(t, { tz, browser }) {
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = browser;
  const document = createDocument(), root = document.createElement('div');
  let zone = tz;
  // Three hours ago, as the list's Julian-day stamp: shown as a clock time.
  const listed = Date.now() - 3 * 3600_000;
  document.defaultView = { innerWidth: 390, addEventListener() {}, removeEventListener() {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {} };
  const withZone = data => zone === undefined ? data : { ...data, tz: zone };
  const page = mountConversationPage({ root, document, fetch: async p => {
    let data;
    if (p.includes('/messages?')) data = withZone({ items: [ROW], nextCursor: null, afterCursor: 'after' });
    else if (p.includes('/questions?') || p.includes('/status?')) data = { items: [], nextCursor: null };
    else if (p.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/\/g%3AAA$/.test(p)) data = { conversation: { id: 'g:AA', state: 'active' } };
    else data = withZone({ items: [{ id: 'g:AA', stamp: listed / 86400000 + 2440587.5 }], nextCursor: null });
    return { ok: true, status: 200, json: async () => data };
  } });
  t.after(() => page.destroy());
  await page.open();
  const texts = cls => allNodes(root).filter(n => n.classList?.contains(cls)).map(n => n.textContent);
  // Before a conversation is opened the list shows its own stamp; opening it moves the stamp to the latest message.
  const listTime = texts('conversation-list-time')[0];
  visibleNodes(root).find(n => n.dataset.conversationId === 'g:AA').dispatch('click');
  await tick(); await tick();
  return {
    listed,
    messageTime: () => allNodes(root).find(n => n.tagName?.toLowerCase() === 'time' && n.parentNode?.classList?.contains('conversation-message-meta'))?.textContent,
    days: () => texts('conversation-day'),
    listTime,
    setZone(value) { zone = value; },
    async refresh() { visibleNodes(root).find(n => n.dataset.action === 'refreshMessages').dispatch('click'); await tick(); await tick(); }
  };
}

test('message times, day separators and list times use the instance time zone, not the browser zone', async t => {
  const f = await fixture(t, { tz: 'Asia/Shanghai', browser: 'America/Los_Angeles' });
  assert.equal(f.messageTime(), clock(SENT, 'Asia/Shanghai'));
  assert.notEqual(f.messageTime(), clock(SENT, 'America/Los_Angeles'));
  assert.deepEqual(f.days(), [day(SENT, 'Asia/Shanghai')], 'the message sits under 8 November, its day in Shanghai');
  assert.equal(f.listTime, clock(new Date(f.listed).toISOString(), 'Asia/Shanghai'));
});

test('a changed instance time zone rewrites the times already shown', async t => {
  const f = await fixture(t, { tz: 'Asia/Shanghai', browser: 'UTC' });
  f.setZone('America/Los_Angeles'); await f.refresh();
  assert.equal(f.messageTime(), clock(SENT, 'America/Los_Angeles'));
  assert.ok(f.days().includes(day(SENT, 'America/Los_Angeles')));
});

test('without a reported time zone (an older instance) times read in UTC, not the browser zone', async t => {
  const f = await fixture(t, { tz: undefined, browser: 'Asia/Shanghai' });
  assert.equal(f.messageTime(), clock(SENT, 'UTC'));
  assert.deepEqual(f.days(), [day(SENT, 'UTC')]);
});
