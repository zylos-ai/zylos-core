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
// Upload transport held by the test: an upload stays in progress until the test replies.
class Upload extends EventTarget {
  upload = new EventTarget();
  open(method, url) { this.method = method; this.url = url; }
  send(body) { this.body = body; }
  abort() { this.aborted = true; this.dispatchEvent(new Event('abort')); }
  reply(status, body) { this.status = status; this.responseText = JSON.stringify(body); this.dispatchEvent(new Event('load')); }
}
// A window whose primary pointer is touch-first or not; width is independent of that (a wide tablet is touch-first).
function windowStub({ touch, width, uploads = [] }) {
  return {
    innerWidth: width, innerHeight: 800, FormData, URL,
    XMLHttpRequest: class { constructor() { const xhr = new Upload(); uploads.push(xhr); return xhr; } },
    matchMedia: query => ({ matches: query === TOUCH_QUERY && touch }),
    requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    addEventListener() {}, removeEventListener() {}
  };
}

async function composerFixture(testContext, { touch = false, width = 1280, unparseableSend = false, holdSend = false, retryPending = false } = {}) {
  const document = createDocument(), root = document.createElement('div'), sends = [], uploads = [];
  // With holdSend, the send request stays in flight until the test calls releaseSend().
  let releaseSend = () => {};
  const sendHeld = holdSend ? new Promise(resolve => { releaseSend = resolve; }) : null;
  document.defaultView = windowStub({ touch, width, uploads });
  // With retryPending, the conversation opens with an earlier send whose outcome is unknown and may be retried.
  const conversation = { id: 'g:AA', state: 'active', displayName: 'Example', pendingContent: retryPending ? 'hello' : null };
  const opened = retryPending
    ? { draft: false, stored: null, deliveryState: null, retryAllowed: true, preserveInput: true, pendingContent: 'hello', error: null, conversation }
    : { draft: false, stored: false, deliveryState: null, retryAllowed: true, preserveInput: false, pendingContent: null, error: null, conversation };
  const fetch = async (path, options) => {
    if (path.endsWith('/send')) sends.push(options);
    if (path.endsWith('/send') && sendHeld) await sendHeld;
    if (path.endsWith('/send') && unparseableSend) return { ok: true, status: 200, json: async () => { throw new SyntaxError('invalid JSON'); } };
    const body = path.endsWith('/uploads/config') ? { maxUploadBytes: 20 * 1024 * 1024, maxAttachments: 10 }
      : path.includes('session-mode') ? { data: { sessionMode: 'multi' } }
      : path.includes('/messages') ? { items: [], nextCursor: null, afterCursor: 'after' }
      : path.includes('/status') ? { items: [] }
      : /conversations\/[^/]+$/.test(path) ? opened
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
  const button = action => allNodes(root).find(node => node.dataset.action === action);
  // As in a browser, disabling the focused editor or send button moves the focus off it.
  for (const node of [input, button('send') || button('retry')]) {
    let disabled = !!node.disabled;
    Object.defineProperty(node, 'disabled', { get: () => disabled, set(value) {
      disabled = !!value;
      if (disabled && document.activeElement === node) document.activeElement = null;
    } });
  }
  input.value = 'hello'; input.dispatch('input');
  // Press a key in the composer; reports whether the page took over the key and how many sends it made.
  const press = async init => {
    let prevented = false;
    input.dispatch('keydown', { key: 'Enter', ...init, preventDefault() { prevented = true; } });
    await tick(); await tick();
    return { prevented, sends: sends.length };
  };
  const chooseFile = async name => {
    const chooser = root.querySelector('[data-action="chooseFiles"]');
    chooser.files = [new File([name], name)]; chooser.dispatch('change');
    await tick(); await tick();
  };
  return { root, document, input, button, press, uploads, chooseFile, releaseSend, sends: () => sends };
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

test('after Enter sends, the editor has the focus again so typing can go on', async testContext => {
  const f = await composerFixture(testContext);
  f.input.focus();
  const sent = await f.press({});
  assert.equal(sent.sends, 1);
  assert.equal(f.input.disabled, false);
  assert.ok(f.document.activeElement === f.input, 'the editor has the focus');
});

test('a send that did not start from the editor does not take the focus', async testContext => {
  const f = await composerFixture(testContext);
  const other = f.button('attach');
  other.focus();
  f.root.querySelector('form.conversation-composer').dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  assert.ok(f.document.activeElement === other, 'the focus stays where it was');
});

test('when something else takes the focus while the send is in flight, the editor does not take it back', async testContext => {
  const f = await composerFixture(testContext, { holdSend: true });
  f.input.focus();
  f.input.dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await tick();
  assert.equal(f.input.disabled, true, 'the send is in flight');
  const other = f.button('attach');
  other.focus();
  f.releaseSend();
  await tick(); await tick();
  assert.equal(f.input.disabled, false);
  assert.ok(f.document.activeElement === other, 'the focus stays on the element that took it');
});

test('a send from the send button does not move the focus into the editor', async testContext => {
  const f = await composerFixture(testContext);
  const send = f.button('send');
  send.focus();
  // A click on the submit button submits the form; sending then disables the button, which drops its focus.
  f.root.querySelector('form.conversation-composer').dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  assert.equal(f.input.disabled, false);
  assert.ok(f.document.activeElement !== f.input, 'the editor did not take the focus');
});

test('Enter does not send while an attachment is still uploading, and sends once it is ready', async testContext => {
  const f = await composerFixture(testContext);
  await f.chooseFile('notes.txt');
  assert.equal(f.uploads.length, 1, 'the upload started and is held');
  assert.equal(f.button('send').disabled, true);
  assert.deepEqual(await f.press({}), { prevented: true, sends: 0 });
  f.uploads[0].reply(200, { id: 'up-1', name: 'notes.txt', size: 9, mime: 'text/plain', kind: 'file' });
  await tick(); await tick();
  assert.deepEqual(await f.press({}), { prevented: true, sends: 1 });
});

test('when a send must be retried, the button names the retry in its label, tooltip and accessible name', async testContext => {
  const f = await composerFixture(testContext, { unparseableSend: true });
  f.root.querySelector('form.conversation-composer').dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  const retry = f.button('retry');
  assert.ok(retry, 'the send button turned into the retry button');
  assert.equal(retry.attributes['aria-label'], 'chat.retry');
  assert.equal(retry.title, 'chat.retry');
  assert.equal(retry.label.textContent, 'chat.retry');
});

test('when a send must be retried, no key retries it, the hint points to the retry button, and the button retries', async testContext => {
  const f = await composerFixture(testContext, { retryPending: true });
  assert.ok(f.button('retry'), 'the send button is the retry button');
  assert.equal(f.button('retry').disabled, false, 'the retry button can be clicked');
  for (const init of [{}, { metaKey: true }, { ctrlKey: true }]) {
    assert.deepEqual(await f.press(init), { prevented: true, sends: 0 }, `${JSON.stringify(init)} does not retry`);
  }
  const shown = visibleText(f.root);
  assert.ok(shown.includes('chat.page.retryHint'), 'the hint says to click the retry button');
  assert.equal(shown.includes('chat.page.keyHint'), false, 'the hint no longer says Enter sends');
  assert.equal(f.input.placeholder, 'chat.page.mobilePlaceholder', 'the placeholder names no keys');
  f.root.querySelector('form.conversation-composer').dispatch('submit', { preventDefault() {} });
  await tick(); await tick();
  assert.equal(f.sends().length, 1, 'the retry button retries');
  assert.equal(JSON.parse(f.sends()[0].body).retry, true, 'the send is marked as a retry');
});

test('both languages tell the user to check the delivery status, then click the retry button to retry', () => {
  for (const [locale, retry] of [['zh', '明确重试发送'], ['en', 'Retry sending']]) {
    const pack = JSON.parse(readFileSync(new URL(`../public/i18n/wb.${locale}.json`, import.meta.url), 'utf8'));
    assert.ok(pack['chat.page.retryHint'].includes(retry), `${locale} names the button`);
    assert.ok(pack['chat.page.retryHint'].toLowerCase().includes(pack['chat.refreshStatus'].toLowerCase()), `${locale} says to check the delivery status first`);
    assert.equal(pack['chat.retry'], retry);
    assert.doesNotMatch(pack['chat.page.retryHint'], /Enter/, `${locale} does not say Enter sends`);
  }
});
