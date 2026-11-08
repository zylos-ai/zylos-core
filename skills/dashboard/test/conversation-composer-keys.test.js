import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, visibleNodes as allNodes, visibleText, tick } from './helpers/conversation-dom.js';

// The conversation page's composer keys and its icon-only attach / send buttons, through the real page module
// on the injected DOM (no browser, sockets, storage, subprocesses or network; fetch is an in-memory stub).
// Layout and focus rings are covered by the browser screenshots, not here. Run for changes to the composer.
const browserSchema = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { mountConversationPage, composerKeySends, touchFirst } = await import('../public/js/wb/conversation-page.js');

const TOUCH_QUERY = '(hover: none) and (pointer: coarse)';
// A window whose primary pointer is touch-first or not; width is independent of that (a wide tablet is touch-first).
function windowStub({ touch, width }) {
  return {
    innerWidth: width, innerHeight: 800,
    matchMedia: query => ({ matches: query === TOUCH_QUERY && touch }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {}
  };
}

async function composerFixture(testContext, { touch = false, width = 1280 } = {}) {
  const document = createDocument(), root = document.createElement('div'), sends = [];
  document.defaultView = windowStub({ touch, width });
  const fetch = async (path, options) => {
    if (path.endsWith('/send')) sends.push(options);
    const body = path.includes('session-mode') ? { data: { sessionMode: 'multi' } }
      : path.includes('/messages') ? { items: [], nextCursor: null, afterCursor: 'after' }
      : path.includes('/status') ? { items: [] }
      : /conversations\/[^/]+$/.test(path) ? { draft: false, stored: false, deliveryState: null, retryAllowed: true, preserveInput: false, pendingContent: null, error: null, conversation: { id: 'g:AA', state: 'active', displayName: 'Example', pendingContent: null } }
      : path.endsWith('/send') ? { stored: true, deliveryState: 'queued', conversationId: 'g:AA' }
      : { items: [{ id: 'g:AA', display_name: 'Example', draft: false }], nextCursor: null };
    return { ok: true, status: 200, json: async () => body };
  };
  const page = mountConversationPage({ root, document, t: key => key, fetch, endpoint: path => path });
  testContext.after(() => page.destroy());
  await page.open();
  allNodes(root).find(node => node.dataset.conversationId)?.dispatch('click');
  await tick(); await tick();
  const input = allNodes(root).find(node => node.tagName === 'TEXTAREA');
  input.value = 'hello'; input.dispatch('input');
  const button = action => allNodes(root).find(node => node.dataset.action === action);
  // Press a key in the composer; reports whether the page took over the key and how many sends it made.
  const press = async init => {
    let prevented = false;
    input.dispatch('keydown', { key: 'Enter', ...init, preventDefault() { prevented = true; } });
    await tick(); await tick();
    return { prevented, sends: sends.length };
  };
  return { root, input, button, press };
}

test('Enter sends, Shift+Enter starts a new line, and ⌘/Ctrl+Enter still sends', () => {
  assert.equal(composerKeySends({ key: 'Enter' }), true);
  assert.equal(composerKeySends({ key: 'Enter', shiftKey: true }), false);
  assert.equal(composerKeySends({ key: 'Enter', ctrlKey: true }), true);
  assert.equal(composerKeySends({ key: 'Enter', metaKey: true }), true);
  assert.equal(composerKeySends({ key: 'a' }), false);
});

test('an Enter that commits an input method composition never sends', () => {
  assert.equal(composerKeySends({ key: 'Enter', isComposing: true }), false);
  assert.equal(composerKeySends({ key: 'Enter', keyCode: 229 }), false, 'keyCode 229: browsers that do not set isComposing');
  assert.equal(composerKeySends({ key: 'Enter', isComposing: true, ctrlKey: true }), false);
  assert.equal(composerKeySends({ key: 'Enter', keyCode: 229, metaKey: true }), false);
});

test('on a touch-first device Enter starts a new line; a hardware ⌘/Ctrl+Enter still sends', () => {
  assert.equal(composerKeySends({ key: 'Enter' }, { touch: true }), false);
  assert.equal(composerKeySends({ key: 'Enter', ctrlKey: true }, { touch: true }), true);
  assert.equal(composerKeySends({ key: 'Enter', metaKey: true }, { touch: true }), true);
});

test('touch-first means a coarse primary pointer that cannot hover', () => {
  assert.equal(touchFirst(windowStub({ touch: true })), true);
  assert.equal(touchFirst(windowStub({ touch: false })), false);
  assert.equal(touchFirst({}), false, 'no matchMedia: treated as a keyboard device');
  assert.equal(touchFirst(undefined), false);
});

test('in the page, Enter sends the typed message', async testContext => {
  const f = await composerFixture(testContext);
  assert.deepEqual(await f.press({}), { prevented: true, sends: 1 });
});

test('in the page, Shift+Enter neither sends nor blocks the new line', async testContext => {
  const f = await composerFixture(testContext);
  assert.deepEqual(await f.press({ shiftKey: true }), { prevented: false, sends: 0 });
});

test('in the page, Enter during input method composition neither sends nor is swallowed', async testContext => {
  const f = await composerFixture(testContext);
  assert.deepEqual(await f.press({ isComposing: true }), { prevented: false, sends: 0 });
  assert.deepEqual(await f.press({ keyCode: 229 }), { prevented: false, sends: 0 });
});

for (const modifier of ['ctrlKey', 'metaKey']) test(`in the page, ${modifier === 'ctrlKey' ? 'Ctrl' : '⌘'}+Enter sends`, async testContext => {
  const f = await composerFixture(testContext);
  assert.deepEqual(await f.press({ [modifier]: true }), { prevented: true, sends: 1 });
});

test('in the page on a touch-first device, Enter starts a new line and the send button sends', async testContext => {
  const f = await composerFixture(testContext, { touch: true, width: 1024 });
  assert.deepEqual(await f.press({}), { prevented: false, sends: 0 });
  // The send button is the form's submit button; the injected DOM has no implicit submission, so submit directly.
  assert.equal(f.button('send').type, 'submit');
  f.root.querySelector('form.conversation-composer').dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  assert.deepEqual(await f.press({ key: 'a' }), { prevented: false, sends: 1 });
});

test('attach and send are icon buttons with an accessible name and a tooltip', async testContext => {
  const f = await composerFixture(testContext);
  const attach = f.button('attach'), send = f.button('send');
  assert.ok(attach.classList.contains('wb-icon-btn'));
  assert.ok(attach.children.some(child => child.classList.contains('wb-ico-paperclip')));
  assert.equal(attach.attributes['aria-label'], 'chat.attach');
  assert.match(attach.title, /^chat\.attach\b/);
  assert.ok(send.classList.contains('conversation-send'));
  assert.ok(send.children.some(child => child.classList.contains('wb-ico-send')));
  assert.equal(send.attributes['aria-label'], 'chat.send');
  assert.equal(send.title, 'chat.send');
});

test('placeholder and hint state the keys on a keyboard device and leave them out on a touch-first one', async testContext => {
  const desk = await composerFixture(testContext);
  assert.equal(desk.input.placeholder, 'chat.page.placeholder');
  assert.ok(visibleText(desk.root).includes('chat.page.keyHint'));
  const tablet = await composerFixture(testContext, { touch: true, width: 1024 });
  assert.equal(tablet.input.placeholder, 'chat.page.mobilePlaceholder');
  assert.equal(visibleText(tablet.root).includes('chat.page.keyHint'), false);
});

test('both languages describe Enter to send and Shift+Enter for a new line', () => {
  for (const locale of ['zh', 'en']) {
    const pack = JSON.parse(readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    for (const key of ['chat.page.placeholder', 'chat.page.keyHint']) {
      assert.match(pack[key], /Enter/, `${locale} ${key}`);
      assert.match(pack[key], /Shift \+ Enter/, `${locale} ${key}`);
      assert.doesNotMatch(pack[key], /Ctrl|⌘/, `${locale} ${key} no longer names the old send shortcut`);
    }
    assert.ok(pack['chat.attach'] && pack['chat.send'], `${locale} labels for the icon buttons`);
  }
});
