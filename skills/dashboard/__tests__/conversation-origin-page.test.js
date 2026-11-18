import { conversationDetail } from './helpers/conversation-object-api.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { tick } from './fixtures/workbench-dom.js';
import { allNodes, createDocument as conversationDocument } from './helpers/conversation-dom.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const { ORIGIN_CONVERSATION_ID } = await import('../public/js/wb/conversation-state.js');

const ORIGIN = ORIGIN_CONVERSATION_ID, OTHER = 'g:AA';
const originItem = { id: ORIGIN, session_group: 'origin', channel: 'dashboard', display_name: 'Origin', origin: true, stamp: 1 };
const otherItem = { id: OTHER, session_group: 'dashboard:a', channel: 'dashboard', display_name: 'Newer chat', stamp: 5 };

// The Origin row as the workbench reports it: keyed `origin` in multi, no group in single, marked `origin` in both.
// `processing` is set only when the latest message handed to Origin came from a scheduled task (and nothing after it).
function originRow(mode, { presence = 'running', working = { on: false }, processing = null, wait = null } = {}) {
  return { sessionGroup: mode === 'single' ? null : 'origin', origin: true, presence, target: { runtime: 'claude' },
    working: presence === 'running' ? working : undefined, processing, wait, preview: { text: 'hello' } };
}
const busy = () => ({ on: true, main: { since: Date.now() } });

function originPage(t, { locale = 'en', mode = 'multi', row = originRow(mode), health = 'ok', messages = [], sends = [] } = {}) {
  const translations = JSON.parse(fs.readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url)));
  const document = conversationDocument(), root = document.createElement('div');
  // The group side panel listens on the document; nothing here dispatches to it.
  Object.assign(document, { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} });
  const requests = [];
  // Placeholders are filled as the Dashboard's own t() fills them.
  const translate = (key, params = {}) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value ?? ''), translations[key] ?? key);
  const page = mountConversationPage({ root, document, groupLinks: {}, t: translate, fetch: async (path, options = {}) => {
    requests.push(path);
    const body = path === '/api/instance' ? { session_mode: { sessionMode: mode }, runtimeHealth: { claude: { health } } }
      : path.split('?')[0] === '/api/groups/origin' ? conversationDetail(row)
      : path.startsWith('/api/chat/conversations?') ? { items: [otherItem, originItem], nextCursor: null }
      : path.endsWith('/send') ? (sends.push({ path, body: options.body }), { stored: true, conversationId: ORIGIN })
      : path.includes('/messages?') ? { items: path.includes(encodeURIComponent(ORIGIN)) ? messages : [], afterCursor: 'after', nextCursor: null }
      : /\/conversations\/[^/?]+$/.test(path) ? { conversation: path.endsWith(encodeURIComponent(ORIGIN))
        ? { ...originItem, state: 'active' } : { ...otherItem, state: 'active' } }
      : { items: [], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  } });
  t.after(() => page.destroy());
  return { page, root, translations, requests };
}

const header = root => root.querySelector('.conversation-running');
const byAction = (root, action) => allNodes(root).find(node => node.dataset?.action === action);
const listNames = root => [...root.querySelectorAll('.conversation-list-item')].map(node => node.textContent);

for (const locale of ['en', 'zh']) {
  for (const mode of ['multi', 'single']) {
    for (const [name, options, key] of [
      ['running a scheduled task when the latest message handed to Origin is one', { working: busy(), processing: 'scheduled_task' }, 'chat.working.scheduled'],
      ['running a scheduled task while an owner message waits behind it', { working: busy(), processing: 'scheduled_task', wait: { kind: 'queued' } }, 'chat.working.scheduled'],
      ['processing when the latest message handed to Origin is not a scheduled task', { working: busy() }, 'chat.working.processing'],
      ['idle', { working: { on: false } }, 'wb.state.idle']]) {
      test(`Origin's header uses the conversation working line: ${name} in ${mode} (${locale})`, { timeout: 2000 }, async t => {
        const f = originPage(t, { locale, mode, row: originRow(mode, options) });
        await f.page.openGroup('origin'); await tick();
        const line = header(f.root);
        assert.equal(line.hidden, false);
        const caption = line.querySelector('.wi-ind-text').textContent;
        assert.equal(caption, f.translations[key]);
        assert.equal(line.dataset.state, options.working.on ? 'busy' : 'idle');
        assert.equal(line.classList.contains('conversation-restricted'), false);
      });
    }
    test(`Origin not running is ${mode === 'multi' ? 'asleep, woken by a message' : 'not called asleep'} in ${mode} (${locale})`, { timeout: 2000 }, async t => {
      const f = originPage(t, { locale, mode, row: originRow(mode, { presence: 'not_running' }) });
      await f.page.openGroup('origin'); await tick();
      const line = header(f.root);
      if (mode === 'multi') {
        assert.equal(line.hidden, false);
        // One word on the line; the explanation is in the tooltip and the accessible name.
        assert.equal(line.querySelector('.wi-ind-text').textContent, f.translations['chat.page.origin.asleepShort']);
        const explained = f.translations['chat.working.timeline'].replace('{state}', f.translations['chat.page.origin.asleep']);
        assert.equal(line.title, explained);
        assert.equal(line.getAttribute('aria-label'), explained);
        assert.equal(allNodes(line).some(node => node.textContent.includes(f.translations['chat.page.origin.asleep'])), false, 'not written on the line');
        assert.equal(line.dataset.state, 'asleep');
        assert.equal(line.classList.contains('conversation-waiting'), true, 'shown muted');
      } else {
        // A single session is not reclaimed when idle; not running there means down or restarting.
        assert.equal(line.hidden, true);
        assert.equal(allNodes(line).some(node => [f.translations['chat.page.origin.asleep'], f.translations['chat.page.origin.asleepShort']].includes(node.textContent)), false);
        assert.equal(line.title.includes(f.translations['chat.page.origin.asleep']), false);
      }
    });
    test(`Origin is pinned first, fixed and writable in ${mode} (${locale})`, { timeout: 2000 }, async t => {
      const f = originPage(t, { locale, mode });
      await f.page.openGroup('origin'); await tick();
      assert.match(listNames(f.root)[0], /^Origin/, 'Origin leads the list although the other conversation is newer');
      assert.equal(f.root.querySelector('h2').textContent, 'Origin');
      assert.equal(f.root.querySelector('.conversation-subtitle').textContent, 'Dashboard · ' + f.translations['chat.page.originPinned']);
      assert.equal(f.root.querySelector('.conversation-history-notice').textContent, f.translations['chat.page.originEmpty']);
      assert.equal(byAction(f.root, 'rename').hidden, true, 'Origin cannot be renamed');
      const input = f.root.querySelector('.conversation-input');
      assert.equal(input.disabled, false);
      assert.equal(input.placeholder === f.translations['chat.page.singlePlaceholder'], false);
      assert.equal(f.root.querySelector('.conversation-composer').classList.contains('conversation-composer-disabled'), false);
      assert.equal(f.root.querySelector('.conversation-single-warning').hidden, true);
      assert.equal(byAction(f.root, 'page.groupInfo').hidden, mode === 'single',
        'single has no Origin group detail to open');
    });
  }
  test(`a health problem still overrides Origin's own status line (${locale})`, { timeout: 2000 }, async t => {
    const f = originPage(t, { locale, health: 'auth_failed', row: originRow('multi', { working: busy(), processing: 'scheduled_task' }) });
    await f.page.openGroup('origin'); await tick();
    assert.equal(header(f.root).querySelector('.wi-ind-text').textContent, f.translations['chat.page.authFailed']);
    assert.equal(header(f.root).classList.contains('conversation-restricted'), true);
  });
  test(`Origin not running with failed authentication shows the authentication problem, not asleep (${locale})`, { timeout: 2000 }, async t => {
    // A message would not wake Origin here; it would be recorded as undelivered.
    const f = originPage(t, { locale, health: 'auth_failed', row: originRow('multi', { presence: 'not_running' }) });
    await f.page.openGroup('origin'); await tick();
    const line = header(f.root);
    assert.equal(line.hidden, false);
    assert.equal(line.querySelector('.wi-ind-text').textContent, f.translations['chat.page.authFailed']);
    assert.notEqual(line.dataset.state, 'asleep');
    assert.equal(line.classList.contains('conversation-restricted'), true);
  });
  test(`a wait reason still overrides Origin's own status line (${locale})`, { timeout: 2000 }, async t => {
    const f = originPage(t, { locale, row: originRow('multi', { presence: 'not_running', wait: { kind: 'starting' } }) });
    await f.page.openGroup('origin'); await tick();
    assert.equal(header(f.root).querySelector('.wi-ind-text').textContent, f.translations['chat.page.waking']);
    assert.equal(header(f.root).dataset.state, 'busy', 'waking, not asleep');
  });
}

test('single keeps other conversations read-only while Origin sends without a session group', { timeout: 2000 }, async t => {
  const sends = [];
  const f = originPage(t, { mode: 'single', sends });
  await f.page.openGroup('dashboard:a'); await tick();
  const input = () => f.root.querySelector('.conversation-input');
  assert.equal(input().disabled, true);
  assert.equal(input().placeholder, f.translations['chat.page.singlePlaceholder']);
  assert.equal(f.root.querySelector('.conversation-single-warning').hidden, false);
  assert.equal(byAction(f.root, 'rename').hidden, true);
  await f.page.openGroup('origin'); await tick();
  assert.equal(input().disabled, false);
  input().value = 'hi Origin'; input().dispatch('input');
  f.root.querySelector('.conversation-composer').dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  assert.equal(sends.length, 1);
  assert.equal(sends[0].path, `/api/chat/conversations/${encodeURIComponent(ORIGIN)}/send`);
});

test('opening group origin selects the Origin conversation in "mine"', { timeout: 2000 }, async t => {
  const f = originPage(t);
  assert.equal(await f.page.openGroup('origin', { channel: 'internal' }), true);
  assert.ok(f.requests.some(path => path.startsWith('/api/chat/conversations?') && path.includes('tab=mine')));
  assert.equal(f.requests.some(path => path.includes('tab=external')), false);
  assert.equal(f.root.querySelector('h2').textContent, 'Origin');
});


test('canonical conversation detail preserves explicit single-session null scope', () => {
  const single = conversationDetail({ sessionGroup: null, presence: 'running', working: { on: false } });
  assert.equal(single.id, 'origin', 'the public resource identity still addresses Origin');
  assert.equal(single.sessionGroup, null, 'null is the canonical Core single-session scope');
  assert.equal(conversationDetail({ presence: 'running' }).sessionGroup, 'origin', 'an omitted scope keeps the fixture default');
  assert.equal(conversationDetail({ sessionGroup: 'origin', presence: 'running' }).sessionGroup, 'origin');
});

// In single mode the Origin conversation shows other conversations' and external
// chats' rows; each row names its channel, and only Origin's own rows can be
// quoted or answered there.
const protocol = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
const mixedRow = (id, direction, channel, endpoint, content, extra = {}) => ({ id, direction, channel, endpoint_id: endpoint,
  session_group: 'origin', content, timestamp: new Date(1_800_000_000_000 + id * 1000).toISOString(), status: 'delivered',
  deliveryState: direction === 'in' ? 'delivered' : 'stored', preview: content, attachments: [], ...extra });
test('Origin rows name their channel and only Origin\'s own rows are quotable or answerable', { timeout: 2000 }, async t => {
  const question = protocol.valid.find(item => item.name === 'single').content;
  const messages = [
    mixedRow(1, 'in', 'dashboard', 'origin', 'owner asks Origin', { conversationName: 'Origin' }),
    mixedRow(2, 'in', 'dashboard', 'x1', 'queued in X', { conversationName: 'Project X' }),
    mixedRow(3, 'out', 'dashboard', 'x1', question, { conversationName: 'Project X' }),
    mixedRow(4, 'out', 'dashboard', 'y1', 'to an unnamed conversation', { conversationName: null }),
    mixedRow(5, 'in', 'telegram', '-100|thread:7', '[TG GROUP:Team] from Telegram\n[MEDIA:/private/photo.jpg]'),
    mixedRow(6, 'out', 'telegram', '-100|thread:7', 'Origin answers Telegram'),
  ];
  const f = originPage(t, { mode: 'single', messages });
  await f.page.openGroup('origin'); await tick(); await tick();
  const article = id => f.root.querySelector(`article[data-message-id="${id}"]`);
  const author = id => article(id).querySelector('.chat-message-author').textContent;
  const fill = (key, params) => Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, value), f.translations[key]);
  assert.deepEqual(messages.map(row => author(row.id)), [
    fill('chat.page.dashboardRow', { channel: 'Dashboard', name: 'Origin' }),
    fill('chat.page.dashboardRow', { channel: 'Dashboard', name: 'Project X' }),
    fill('chat.page.dashboardRow', { channel: 'Dashboard', name: 'Project X' }),
    fill('chat.page.dashboardRow', { channel: 'Dashboard', name: f.translations['chat.unnamed'] }),
    fill('chat.external.received', { channel: 'Telegram' }),
    fill('chat.external.sent', { channel: 'Telegram' }),
  ]);
  const quote = id => article(id).querySelector('.conversation-quote-button');
  assert.deepEqual(messages.map(row => quote(row.id).hidden), [false, true, true, true, true, true]);
  const card = article(3).querySelector('.chat-question');
  assert.ok(card, 'the question is shown');
  assert.ok(allNodes(card).some(node => node.textContent === f.translations['chat.question.otherConversationReadOnly']));
  assert.equal(allNodes(card).some(node => node.tagName === 'BUTTON' && !node.disabled), false, 'no answer control is enabled');
  assert.equal(article(5).querySelector('.chat-message-status').hidden, true, 'external rows show no Dashboard delivery state');
  const telegramBody = article(5).querySelector('.chat-message-text').textContent;
  assert.equal(telegramBody, `[TG GROUP:Team] from Telegram\n${f.translations['chat.attachment.externalMedia']}`,
    'an external chat media line shows the original-channel label');
  assert.equal(telegramBody.includes('/private/photo.jpg'), false, 'the local media path is not shown');
  assert.equal(f.root.querySelector('.conversation-input').disabled, false, 'the Origin conversation stays writable');
});
