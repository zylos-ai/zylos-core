import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick, deferred } from './helpers/conversation-dom.js';

const schemaPath = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL && new URL(specifier, context.parentURL).pathname === schemaPath) return next(sourceSchema, context);
    return next(specifier, context);
  }
});
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const { renderOverview } = await import('../public/js/wb/detail-overview.js');

// The conversation page's group detail side panel, through the real page, panel and group detail modules on the
// injected DOM (in-memory fetch; no browser, sockets, storage, subprocesses or network). The overview renderer
// is also called directly for content parity; every mounted-page group read comes from the panel itself.
// Pixel layout (the narrowed conversation, the full-screen panel on phones) is covered by the screenshots,
// not here. Run for changes to the panel, the conversation page header or the group detail component.
const sessionGroup = 'dashboard:42';
const conversationId = 'g:' + Buffer.from(sessionGroup).toString('hex').toUpperCase();
const otherGroup = 'dashboard:43';
const otherId = 'g:' + Buffer.from(otherGroup).toString('hex').toUpperCase();
const listedRow = { sessionGroup, name: { displayName: 'Release room' }, state: 'idle', presence: 'running',
  live: { runId: 'run-1', sessionId: 's-1' }, createdAt: 1, c4: { componentName: 'dashboard' } };

function eventDocument() {
  const document = createDocument();
  const listeners = new Map();
  Object.assign(document, {
    visibilityState: 'visible',
    documentElement: { dataset: {}, lang: 'en' },
    addEventListener(name, handler) { listeners.set(name, [...(listeners.get(name) ?? []), handler]); },
    removeEventListener(name, handler) { listeners.set(name, (listeners.get(name) ?? []).filter(fn => fn !== handler)); },
    listenerCount: name => (listeners.get(name) ?? []).length,
    key(key) {
      let prevented = false;
      const event = { key, get defaultPrevented() { return prevented; }, preventDefault() { prevented = true; } };
      for (const handler of listeners.get('keydown') ?? []) handler(event);
      return prevented;
    },
  });
  return document;
}

// In-memory stand-in for localStorage, so no test reads or writes the real one.
function memoryStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, String(value)); } };
}

async function fixture(testContext, { storage = memoryStorage(), open = true, groupRow = listedRow, translate = key => key } = {}) {
  const document = eventDocument(), root = document.createElement('div');
  const reads = [], links = { memory: [], observe: [] };
  // Timers the panel started and has not cleared, by id: the panel's 5s re-read of the group list.
  const timers = new Map();
  let groupFailures = 0, groupHold = null, nextTimer = 0;
  const json = body => ({ ok: true, status: 200, json: async () => body });
  const fetch = async path => {
    reads.push(path);
    if (path === '/api/workbench/groups') {
      if (groupFailures > 0) { groupFailures--; return { ok: false, status: 500, json: async () => ({}) }; }
      if (groupHold) await groupHold.promise;
      return json({ rows: [groupRow], listKnown: true });
    }
    if (path.startsWith('/api/timeline')) return json({ events: [] });
    if (path.includes('/backlog')) return json({ pending: 0 });
    if (path.includes('/runs')) return json({ totalEvents: 0, totalRuns: 0, unattributed: 0, runs: [] });
    if (path.includes('session-mode')) return json({ data: { sessionMode: 'multi' } });
    if (path.startsWith('/api/chat/conversations?')) return json({ items: [
      { id: conversationId, sessionGroup, display_name: 'Release room', channel: 'dashboard' },
      { id: otherId, sessionGroup: otherGroup, display_name: 'Other room', channel: 'dashboard' },
    ], nextCursor: null });
    const match = /\/api\/chat\/conversations\/([^/?]+)$/.exec(path);
    if (match) {
      const id = decodeURIComponent(match[1]);
      return json({ conversation: { id, sessionGroup: id === otherId ? otherGroup : sessionGroup, state: 'active', displayName: 'Room' } });
    }
    return json({ items: [], nextCursor: null, afterCursor: 'after' });
  };
  const page = mountConversationPage({ root, document, t: translate, fetch, endpoint: path => path, storage,
    groupLinks: { onMemory: key => links.memory.push(key), onObserve: key => links.observe.push(key),
      setTimer: fn => { timers.set(++nextTimer, fn); return nextTimer; }, clearTimer: id => { timers.delete(id); } } });
  testContext.after(() => page.destroy());
  if (open) assert.equal(await page.openGroup(sessionGroup), true);
  await tick();
  const find = predicate => allNodes(root).find(predicate);
  const side = () => find(node => node.classList.contains('wb-group-side'));
  const groupButton = () => find(node => node.dataset.action === 'page.groupInfo');
  const pageNode = () => find(node => node.classList.contains('conversation-page'));
  const stream = () => find(node => node.classList.contains('conversation-stream'));
  const input = () => find(node => node.tagName === 'TEXTAREA');
  const title = () => side() && allNodes(side()).find(node => node.tagName === 'H2')?.textContent;
  const openSide = async () => { groupButton().dispatch('click'); await tick(); await tick(); await tick(); };
  // The page reads the group list for its own header too; fail only the reads made after this call.
  const failGroupReads = count => { groupFailures = count; };
  // Holds the group-list reads made after this call until the returned release() is called.
  const holdGroupReads = () => { const hold = groupHold = deferred(); return () => { groupHold = null; hold.resolve(); }; };
  const listToggle = () => find(node => node.dataset.action === 'listToggle');
  return { document, root, page, reads, links, storage, listToggle, side, groupButton, pageNode, stream, input, title, openSide, find, failGroupReads,
    holdGroupReads, timers: () => timers.size,
    poll: async () => { for (const fn of [...timers.values()]) await fn(); await tick(); await tick(); } };
}

test('the group detail opens beside the conversation, showing that group, and the page stays the conversation', async testContext => {
  const f = await fixture(testContext);
  assert.equal(f.side().hidden, true, 'closed until asked for');
  await f.openSide();
  assert.equal(f.side().hidden, false, 'the side panel is open');
  assert.equal(f.pageNode().hidden, false, 'the conversation page is still shown');
  assert.ok(f.pageNode().classList.contains('conversation-has-side'), 'the conversation makes room for it');
  assert.equal(f.title(), 'Release room', 'it shows the group of the conversation');
  assert.ok(f.reads.includes('/api/workbench/groups'), 'the panel read the group list itself');
  assert.equal(f.groupButton().attributes['aria-expanded'], 'true');
  assert.ok(f.document.activeElement === f.side(), 'the focus moved into the side panel');
});

test('without the overview, a failed first group read still opens the group, and the listed row replaces it later', async testContext => {
  const f = await fixture(testContext);
  f.failGroupReads(1);
  await f.openSide();
  assert.equal(f.side().hidden, false);
  assert.ok(f.title(), 'the panel is not blank');
  assert.notEqual(f.title(), 'Release room', 'without the list the group is shown by its key');
  assert.equal(allNodes(f.side()).some(node => node.classList.contains('wb-detail-error')), false, 'no read error is shown');
  await f.poll();
  assert.equal(f.title(), 'Release room', 'the next read shows the listed group');
});

test('while the first group read is still on its way the panel already shows the group, then the listed row', async testContext => {
  const f = await fixture(testContext);
  const release = f.holdGroupReads();
  await f.openSide();
  assert.equal(f.side().hidden, false);
  assert.ok(f.title(), 'the panel is not blank while the list is read');
  assert.notEqual(f.title(), 'Release room', 'before the list arrives the group is shown by its key');
  release();
  await tick(); await tick(); await tick();
  assert.equal(f.title(), 'Release room', 'the listed row replaces it once the read completes');
  assert.equal(f.timers(), 1, 'the panel then re-reads the list on a timer');
});

test('a group that is not on the known list shows as not running once the list arrives', async testContext => {
  const f = await fixture(testContext);
  assert.equal(await f.page.openGroup(otherGroup), true);
  await tick();
  const release = f.holdGroupReads();
  await f.openSide();
  const standby = () => allNodes(f.side()).some(node => node.textContent === 'wb.detail.standby');
  assert.equal(standby(), false, 'before the list arrives the state is not known');
  release();
  await tick(); await tick(); await tick();
  assert.equal(standby(), true, 'the known list without this group means it is not running');
});

test('a group that is not on the known list is not opened again by the later list reads', async testContext => {
  const f = await fixture(testContext);
  assert.equal(await f.page.openGroup(otherGroup), true);
  await tick();
  await f.openSide();
  const tabs = () => allNodes(f.side()).filter(node => node.attributes.role === 'tab');
  const selected = () => tabs().find(node => node.attributes['aria-selected'] === 'true')?.textContent ?? '';
  assert.equal(allNodes(f.side()).some(node => node.textContent === 'wb.detail.standby'), true, 'shown as not running');
  tabs()[1].dispatch('click');
  await tick(); await tick();
  assert.match(selected(), /^wb\.detail\.timeline/, 'the timeline tab is open');
  await f.poll();
  await f.poll();
  assert.match(selected(), /^wb\.detail\.timeline/, 'the 5s re-reads leave the timeline tab open');
});

test('closing the side panel during the first group read starts no re-reading', async testContext => {
  const f = await fixture(testContext);
  const release = f.holdGroupReads();
  await f.openSide();
  f.groupButton().dispatch('click');
  assert.equal(f.side().hidden, true);
  release();
  await tick(); await tick(); await tick();
  assert.equal(f.timers(), 0, 'no timer was started for the closed panel');
});

test('the group button closes the open side panel', async testContext => {
  const f = await fixture(testContext);
  await f.openSide();
  f.groupButton().dispatch('click');
  await tick();
  assert.equal(f.side().hidden, true);
  assert.equal(f.groupButton().attributes['aria-expanded'], 'false');
  assert.equal(f.pageNode().classList.contains('conversation-has-side'), false);
});

test('Esc while renaming the group only leaves the name editor', async testContext => {
  const f = await fixture(testContext);
  await f.openSide();
  allNodes(f.side()).find(node => node.attributes['aria-label'] === 'wb.name.edit').dispatch('click');
  const editors = () => allNodes(f.side()).filter(node => node.tagName === 'INPUT').length;
  assert.equal(editors(), 1, 'the name editor is open');
  assert.equal(f.document.key('Escape'), true);
  assert.equal(editors(), 0, 'Esc left the name editor');
  assert.equal(f.side().hidden, false, 'the panel stays open');
  assert.equal(f.document.key('Escape'), true);
  assert.equal(f.side().hidden, true, 'the next Esc closes it');
});

test('opening and closing the panel again and again leaves one re-read timer while open and none once closed', async testContext => {
  const f = await fixture(testContext);
  for (let round = 0; round < 3; round++) {
    await f.openSide();
    assert.equal(f.timers(), 1, `round ${round}: one timer while open`);
    f.groupButton().dispatch('click');
    await tick();
    assert.equal(f.timers(), 0, `round ${round}: none once closed`);
  }
  await f.openSide();
  f.page.destroy();
  assert.equal(f.timers(), 0, 'destroying the page clears it');
});

for (const [how, close] of [
  ['Esc', f => { assert.equal(f.document.key('Escape'), true, 'Esc was handled'); }],
  ['its close button', f => allNodes(f.side()).find(node => node.attributes['aria-label'] === 'wb.close').dispatch('click')],
  ['the back button', f => allNodes(f.side()).find(node => node.classList.contains('wb-group-side-back')).dispatch('click')],
]) test(`closing the side panel with ${how} keeps the reading position and the draft and returns the focus`, async testContext => {
  const f = await fixture(testContext);
  const stream = f.stream();
  stream.scrollHeight = 2000; stream.clientHeight = 400; stream.scrollTop = 600;
  f.input().value = 'half-written reply'; f.input().dispatch('input');
  await f.openSide();
  close(f);
  await tick();
  assert.equal(f.side().hidden, true);
  assert.equal(f.pageNode().classList.contains('conversation-has-side'), false);
  assert.equal(stream.scrollTop, 600, 'the reading position is unchanged');
  assert.equal(f.input().value, 'half-written reply', 'the draft is unchanged');
  assert.ok(f.document.activeElement === f.groupButton(), 'the focus is back on the group button');
  assert.equal(f.groupButton().attributes['aria-expanded'], 'false');
});

test('Esc does nothing while the side panel is closed or the conversation page is hidden', async testContext => {
  const f = await fixture(testContext);
  assert.equal(f.document.key('Escape'), false);
  await f.openSide();
  f.document.visibilityState = 'hidden';
  assert.equal(f.document.key('Escape'), false);
  assert.equal(f.side().hidden, false);
});

test('the link to this group\'s conversation only closes the side panel', async testContext => {
  const f = await fixture(testContext);
  await f.openSide();
  const before = f.reads.length;
  allNodes(f.side()).find(node => node.dataset.action === 'viewConversation').dispatch('click');
  await tick();
  assert.equal(f.side().hidden, true);
  assert.equal(f.reads.slice(before).some(path => path.startsWith('/api/chat/')), false, 'the conversation was not reloaded');
  assert.ok(f.document.activeElement === f.groupButton());
});

test('links that lead to another page still go there', async testContext => {
  const f = await fixture(testContext);
  await f.openSide();
  allNodes(f.side()).find(node => node.textContent === 'wb.detail.memoryLink' && node.tagName === 'BUTTON').dispatch('click');
  assert.deepEqual(f.links.memory, [sessionGroup]);
});

test('choosing another conversation or leaving the page closes the side panel without taking the focus', async testContext => {
  const f = await fixture(testContext);
  await f.openSide();
  f.input().focus();
  f.find(node => node.dataset.conversationId === otherId).dispatch('click');
  await tick(); await tick();
  assert.equal(f.side().hidden, true, 'another conversation closes it');
  assert.ok(f.document.activeElement !== f.groupButton(), 'the focus was left alone');
  await f.page.openGroup(sessionGroup);
  await f.openSide();
  assert.equal(f.timers(), 1);
  f.page.close();
  assert.equal(f.side().hidden, true, 'leaving the page closes it');
  assert.equal(f.timers(), 0, 'and stops its re-reading');
  f.page.destroy();
  assert.equal(f.document.listenerCount('keydown'), 0, 'destroying the page removes its Esc handler');
});

test('the dashboard opens the group detail on the conversation page instead of switching to the overview', () => {
  const app = readFileSync(new URL('../public/js/app.js', import.meta.url), 'utf8');
  const mount = app.slice(app.indexOf('chatPage = mountConversationPage('), app.indexOf('const chatLocaleChange'));
  assert.match(mount, /groupLinks: \{/);
  assert.doesNotMatch(mount, /openWorkbenchGroup|onOpenGroup/);
  assert.match(mount, /onMemory: openGroupMemory/);
  assert.match(mount, /onObserve: openObserverFor/);
});

test('both languages name the way back from the side panel', () => {
  for (const locale of ['zh', 'en']) {
    const pack = JSON.parse(readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    assert.equal(typeof pack['chat.page.backToConversation'], 'string', locale);
    assert.notEqual(pack['chat.page.backToConversation'], pack['chat.page.back'], `${locale}: not the way back to the list`);
  }
});

test('the list button collapses and shows the conversation list again, and the choice is remembered', async testContext => {
  const f = await fixture(testContext);
  const collapsed = () => f.pageNode().classList.contains('conversation-list-collapsed');
  assert.equal(collapsed(), false);
  assert.equal(f.listToggle().attributes['aria-expanded'], 'true');
  assert.equal(f.listToggle().attributes['aria-label'], 'chat.page.hideList');
  f.listToggle().dispatch('click');
  assert.equal(collapsed(), true, 'the list is collapsed');
  assert.equal(f.listToggle().attributes['aria-expanded'], 'false');
  assert.equal(f.listToggle().attributes['aria-label'], 'chat.page.showList');
  assert.equal(f.storage.values.get('zylos-dashboard-conversation-list'), 'collapsed');
  f.listToggle().dispatch('click');
  assert.equal(collapsed(), false, 'the list is shown again');
  assert.equal(f.listToggle().attributes['aria-expanded'], 'true');
  assert.equal(f.storage.values.get('zylos-dashboard-conversation-list'), 'shown');
});

test('a remembered collapsed list starts collapsed, but stays shown while no conversation is open', async testContext => {
  const f = await fixture(testContext, { storage: memoryStorage({ 'zylos-dashboard-conversation-list': 'collapsed' }), open: false });
  const collapsed = () => f.pageNode().classList.contains('conversation-list-collapsed');
  assert.equal(collapsed(), false, 'with nothing open the list (and the way back to it) stays visible');
  assert.equal(await f.page.openGroup(sessionGroup), true);
  await tick();
  assert.equal(collapsed(), true, 'an open conversation gets the remembered collapsed list');
  assert.equal(f.listToggle().attributes['aria-expanded'], 'false');
});

test('the group detail sits beside the conversation only where about 600px of it remain, otherwise over it', () => {
  const css = readFileSync(new URL('../public/css/conversation.css', import.meta.url), 'utf8');
  const block = query => {
    const start = css.indexOf(`@media(${query})`);
    assert.ok(start >= 0, query);
    let depth = 0, index = css.indexOf('{', start);
    for (let at = index; at < css.length; at++) {
      if (css[at] === '{') depth++;
      else if (css[at] === '}' && --depth === 0) return css.slice(index, at);
    }
    return '';
  };
  const rule = (text, selector) => new RegExp(`${selector.replace(/[.>]/g, m => '\\' + m)}\\s*\\{([^}]*)\\}`).exec(text)?.[1] ?? '';
  const base = rule(css, '.conversation-page > .wb-group-side');
  assert.match(base, /position:fixed/, 'by default the panel covers the conversation');
  const sideWidth = Number(/width:(\d+)px/.exec(base.replace(/min-height[^;]*;/, ''))?.[1]);
  const listWidth = Number(/width:(\d+)px/.exec(rule(css, '.conversation-sidebar'))?.[1]);
  const margins = 48; // the page's 24px margins on each side, as measured in the browser
  for (const [query, selector, list] of [
    ['min-width:1440px', '.conversation-page > .wb-group-side', listWidth],
    ['min-width:1120px', '.conversation-list-collapsed > .wb-group-side', 0],
  ]) {
    assert.match(rule(block(query), selector), /position:static/, `${query}: beside the conversation`);
    const width = Number(/\d+/.exec(query)[0]);
    const left = width - margins - list - sideWidth;
    assert.ok(left >= 590 && left < 610, `${query}: about 600px of conversation remain beside the panel (${left})`);
  }
});


test('the conversation group sidebar keeps current state without repeating the last received preview', async t => {
  const labels = JSON.parse(readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url), 'utf8'));
  const translate = (key, params) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replaceAll('{'+name+'}', value), labels[key] ?? key);
  const f = await fixture(t, { translate, groupRow: { ...listedRow, state: { kind: 'idle' }, duration: 75,
    preview: { text: 'private preview already shown in conversation', channel: 'dashboard', timestamp: 1000 } } });
  await f.openSide();
  const title = allNodes(f.side()).find(node => node.classList.contains('wb-now-title'));
  assert.equal(title.textContent, 'Idle · for 1 minute');
  assert.equal(f.side().textContent.includes('private preview already shown in conversation'), false);
  assert.equal(f.side().textContent.includes('wb.board.lastReceived'), false);
  assert.equal(allNodes(f.side()).some(node => node.classList.contains('wb-now-raw')), false);
});

function summaryTranslation(locale) {
  const labels = JSON.parse(readFileSync(new URL('../public/i18n/wb.' + locale + '.json', import.meta.url), 'utf8'));
  return (key, params = {}) => (labels[key] ?? key).replace(/\{([^}]+)\}/g, (match, name) => params[name] ?? match);
}

// Content variants run through the actual overview renderer with both preview-origin policies. The mounted
// sidebar tests above cover its wiring to that policy. The browser cases retain
// navigation, viewport geometry and screenshots; this fixed twelve-case matrix needs no layout or browser.
for (const locale of ['zh', 'en']) for (const level of ['plain', 'technical']) for (const scene of ['idle', 'busy', 'waiting']) {
  test(`${locale} ${level} ${scene}: group summaries keep content and evidence in their intended regions`, () => {
    const now = Date.now(), preview = 'The received message must stay a subtitle';
    const translate = summaryTranslation(locale), zh = locale === 'zh';
    const current = { ...listedRow, state: { kind: scene }, duration: 75,
      preview: { text: preview, timestamp: now - 90000, channel: 'dashboard', source: { kind: 'channel' } },
      tools: scene === 'busy' ? [{ name: 'Read' }, { name: 'WebSearch' }] : [],
      queue: { known: true, pending: { count: scene === 'waiting' ? 1 : 0 }, running: { count: scene === 'busy' ? 1 : 0 } },
      wait: scene === 'waiting' ? { kind: 'rate_wait', runtime: 'claude', cooldownUntil: Math.floor(now / 1000) + 3600 } : null,
      live: { ...listedRow.live, status: { valid: true, state: scene === 'waiting' ? 'idle' : scene, sampledAt: now } } };
    const events = scene === 'busy' ? [1, 2].map(id => ({ event_seq: id, event_type: 'subagent_start',
      agent_id: 'helper-' + id, run_id: 'run-1', metadata: { name: 'Background helper ' + id } })) : [];
    const ok = { ok: true, readAt: now };
    const snapshot = { readAt: now, sources: { status: ok, c4: scene === 'waiting' ? { ok: false, reason: 'messages_unreadable', readAt: now } : ok,
      q: ok, ov: ok, accounts: { claude: ok, codex: ok } },
      instance: { runtimeHealth: { claude: { health: scene === 'waiting' ? 'rate_limited' : 'ok', updatedAt: now } } } };
    const document = eventDocument();
    document.documentElement.lang = locale;
    const overview = document.createElement('div');
    for (const showPreview of [true, false]) {
      const root = showPreview ? overview : document.createElement('div');
      renderOverview(root, current, { currentEvents: events }, { document, t: translate, level, snapshot,
        currentTime: now, showLastReceived: showPreview, onObserve() {} });
      const nodes = selector => root.querySelectorAll(selector);
      const card = root.querySelector('.wb-now-card'), titles = nodes('.wb-now-title');
      assert.ok(card, 'current-state card is rendered');
      assert.equal(titles.some(node => node.textContent.includes(preview)), false, 'received text never becomes a current-state title');
      assert.equal(nodes('.wb-now-sub').some(node => node.textContent.includes(preview)), showPreview, 'only the overview repeats received text as a subtitle');
      assert.equal(nodes('.wb-now-raw').length, showPreview && level === 'technical' ? 1 : 0, 'received text and its raw fold share the same origin policy');
      if (level === 'plain') assert.equal(titles.length, 1, 'plain summaries stay on one title line');
      if (scene === 'idle') {
        assert.equal(titles.length, 1);
        assert.equal(titles[0].textContent, level === 'plain' ? zh ? '空闲 · 已 1 分钟' : 'Idle · for 1 minute'
          : (zh ? '空闲' : 'Idle') + '1m15s');
      } else if (scene === 'busy') {
        if (level === 'plain') {
          assert.equal(titles[0].textContent, zh ? '读文件、搜索网页 · 后台子任务 2 个' : 'Read file, Search web · 2 background subtasks');
          assert.equal(nodes('.wb-subs').length, 0, 'the plain count replaces separate technical tags');
          if (!zh) assert.equal(titles[0].textContent.includes('、'), false, 'English tool names use their locale separator');
        } else {
          assert.deepEqual(nodes('.wb-detail-tool').map(node => node.textContent), ['Read', 'WebSearch']);
          const tags = nodes('.wb-subs .wb-tag');
          assert.equal(tags.length, 2);
          assert.ok(tags[0].textContent.includes('Background helper 1'));
          assert.ok(tags[1].textContent.includes('Background helper 2'));
        }
      } else if (level === 'plain') {
        assert.match(titles[0].textContent, zh ? /^额度已用完，.+恢复。1 条消息在等/ : /^Allowance exhausted; recovers at .+\. 1 messages are waiting/);
        assert.doesNotMatch(titles[0].textContent, /恢复时间未知|recovery time unknown/);
      } else {
        assert.equal(titles[0].textContent, zh ? '等待' : 'Waiting');
        assert.match(nodes('.wb-now-sub')[0].textContent, /rate_wait/);
      }
      const terminal = card.querySelectorAll('[data-observer-group]');
      assert.equal(terminal.length, level === 'technical' ? 1 : 0);
      if (terminal.length) {
        const label = zh ? '终端' : 'Terminal';
        assert.equal(terminal[0].textContent, label);
        assert.equal(terminal[0].title, label);
        assert.equal(terminal[0].getAttribute('aria-label'), label);
      }
      const evidence = card.querySelector('.wb-detail-evidence');
      assert.equal(Boolean(evidence), level === 'technical' && scene === 'waiting', 'only technical waiting summaries offer evidence');
      if (evidence) {
        assert.equal(evidence.open, false, 'supporting evidence starts folded');
        assert.ok(evidence.querySelector('summary'));
        assert.ok(evidence.querySelector('table'), 'the fold contains its supporting table');
        assert.ok(evidence.textContent.includes(zh ? '会话忙闲' : 'Session activity'));
        assert.match(evidence.textContent, /claude · rate_limited/);
        assert.match(evidence.textContent, /messages_unreadable/);
        assert.equal(evidence.querySelectorAll('tr').some(node => node.dataset.updateKey.startsWith('accounts')), false, 'healthy nested accounts are not failed sources');
      }
    }
    if (scene === 'waiting') {
      const healthy = { ...snapshot, sources: { ...snapshot.sources, c4: ok } };
      renderOverview(overview, current, {}, { document, t: translate, level, snapshot: healthy, onObserve() {} });
      const evidence = overview.querySelector('.wb-detail-evidence');
      if (level === 'technical') {
        assert.ok(evidence.textContent.includes(zh ? '数据来源全部正常' : 'All data sources are healthy'));
        assert.equal(evidence.querySelectorAll('tr').filter(node => node.dataset.updateKey === 'sources').length, 1);
        assert.doesNotMatch(evidence.textContent, /messages_unreadable/);
      } else assert.equal(evidence, null, 'healthy waiting sources do not expose evidence in plain view either');
    }
  });
}
