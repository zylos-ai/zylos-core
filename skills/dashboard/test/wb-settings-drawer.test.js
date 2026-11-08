import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsDrawer } from '../public/js/wb/settings-drawer.js';
import { documentFixture, node } from './fixtures/settings-dom.js';

// The phone settings drawer's state, focus, inert background and history entry, driven through the real module
// with an injected DOM and window. Rendering (sizes, sliding, the real Back button) is in workbench-browser.test.js.
function setup({ phone = true } = {}) {
  const document = documentFixture();
  const docListeners = new Map();
  document.addEventListener = (name, fn) => docListeners.set(name, fn);
  document.removeEventListener = name => docListeners.delete(name);
  const header = node(document, 'header'), panel = node(document, 'section', 'tab-settings'), other = node(document, 'section', 'tab-memory');
  const page = node(document, 'main'); page.append(header, panel, other);
  const layout = node(document, 'div'); layout.className = 'wb-set';
  const nav = node(document, 'nav', 'settings-nav'), scrim = node(document, 'div'), body = node(document, 'div');
  const closeButton = node(document, 'button'); nav.append(closeButton);
  const sections = ['defaults', 'pricing', 'keys'].map(name => { const button = node(document, 'button'); button.dataset.settingsSection = name; button.setAttribute('aria-current', String(name === 'pricing')); nav.append(button); return button; });
  const toggle = node(document, 'button'); body.append(toggle);
  layout.append(nav, scrim, body); panel.append(layout);

  const entries = [{ state: { tab: 'overview' }, url: 'https://host/' }, { state: { tab: 'settings' }, url: 'https://host/settings' }];
  let index = 1, backs = 0, mediaListener = null;
  const media = { matches: phone, addEventListener: (_, fn) => { mediaListener = fn; }, removeEventListener: () => { mediaListener = null; } };
  const window = {
    matchMedia: () => media,
    location: { get href() { return entries[index].url; } },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _, url) { entries.splice(index + 1); entries.push({ state: structuredClone(state), url: url ?? entries[index].url }); index++; },
      replaceState(state, _, url) { entries[index] = { state, url: url ?? entries[index].url }; },
      back() { backs++; },
    },
  };
  // Back as the browser does it: the entry moves first, then the page hears popstate.
  const goBack = () => { index--; return drawer.popstate(); };
  const drawer = createSettingsDrawer({ layout, nav, toggle, closeButton, scrim, window });
  return { document, docListeners, header, panel, other, layout, nav, scrim, body, toggle, closeButton, sections, drawer, entries,
    window, media, goBack, backs: () => backs, index: () => index, setMedia(on) { media.matches = on; mediaListener?.(); } };
}
const isOpen = page => page.layout.classList.contains('wb-set-drawer-open');

test('opening on a phone adds one history entry, focuses the current section and makes everything else inert', async () => {
  const page = setup();
  await page.toggle.dispatch('click');
  assert.equal(isOpen(page), true);
  assert.equal(page.toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(page.entries.length, 3); assert.deepEqual(page.entries[2], { state: { tab: 'settings', settingsDrawer: true }, url: 'https://host/settings' });
  assert.equal(page.sections[1].focused, true, 'the current section has focus');
  assert.deepEqual([page.body.inert, page.header.inert, page.other.inert], [true, true, true], 'the settings body and the rest of the page are inert');
  assert.deepEqual([page.nav.inert, page.scrim.inert, page.layout.inert, page.panel.inert], [undefined, undefined, undefined, undefined], 'the drawer, its backdrop and their ancestors are not');
  page.drawer.open();
  assert.equal(page.entries.length, 3, 'opening twice adds nothing');
});

test('a wider screen has no drawer: opening does nothing', async () => {
  const page = setup({ phone: false });
  await page.toggle.dispatch('click');
  assert.equal(isOpen(page), false); assert.equal(page.entries.length, 2); assert.equal(page.body.inert, undefined);
});

test('closing from the page (close button, backdrop, Escape) removes the drawer entry, lifts inert and returns focus', async () => {
  for (const [way, close] of [
    ['close button', page => page.closeButton.dispatch('click')],
    ['backdrop', page => page.scrim.dispatch('click')],
    ['Escape', page => { let prevented = false; page.docListeners.get('keydown')({ key: 'Escape', preventDefault: () => { prevented = true; } }); assert.equal(prevented, true); }],
    ['the button again', page => page.toggle.dispatch('click')],
  ]) {
    const page = setup();
    await page.toggle.dispatch('click');
    page.toggle.focused = false;
    await close(page);
    assert.equal(isOpen(page), false, way);
    assert.equal(page.toggle.getAttribute('aria-expanded'), 'false', way);
    assert.equal(page.backs(), 1, `${way}: one step back removes the drawer entry`);
    assert.deepEqual([page.body.inert, page.header.inert, page.other.inert], [false, false, false], `${way}: nothing stays inert`);
    assert.equal(page.toggle.focused, true, `${way}: focus returns to the button`);
    // The popstate that step back causes belongs to the drawer; the page stays where it is.
    assert.equal(page.goBack(), true, way);
    assert.equal(page.window.history.state.settingsDrawer, undefined);
    // The next unrelated popstate is the page's again.
    assert.equal(page.goBack(), false, `${way}: only one popstate is the drawer's`);
  }
  const page = setup();
  page.docListeners.get('keydown')({ key: 'Escape', preventDefault: () => assert.fail('a closed drawer leaves Escape alone') });
});

test('Back while open closes the drawer and keeps the page; Back to another page lets the page navigate', async () => {
  const page = setup();
  await page.toggle.dispatch('click');
  assert.equal(page.goBack(), true, 'same page: the page does nothing');
  assert.equal(isOpen(page), false); assert.equal(page.backs(), 0, 'Back already removed the entry');
  assert.equal(page.toggle.focused, true);
  assert.equal(page.goBack(), false, 'one more Back is ordinary navigation');

  const far = setup();
  await far.toggle.dispatch('click');
  far.entries[1].url = 'https://host/memory';
  assert.equal(far.goBack(), false, 'arriving on another page is the page\'s navigation');
  assert.equal(isOpen(far), false); assert.equal(far.body.inert, false);
});

test('switching page while open closes without a step back and says the drawer entry can be replaced', async () => {
  const page = setup();
  await page.toggle.dispatch('click');
  page.toggle.focused = false;
  assert.equal(page.drawer.leave(), true);
  assert.equal(isOpen(page), false); assert.equal(page.backs(), 0); assert.equal(page.header.inert, false);
  assert.equal(page.toggle.focused, false, 'focus moves with the new page, not to the hidden button');
  page.window.history.replaceState({ tab: 'memory' }, '', 'https://host/memory');
  assert.equal(page.drawer.leave(), false, 'an ordinary entry is not replaced');
});

test('leaving the phone layout while open closes the drawer and removes its entry', async () => {
  const page = setup();
  await page.toggle.dispatch('click');
  page.setMedia(false);
  assert.equal(isOpen(page), false); assert.equal(page.backs(), 1); assert.equal(page.body.inert, false);
  assert.equal(page.toggle.focused, undefined, 'no focus jump to a button that wide screens hide');
  assert.equal(page.goBack(), true, 'that step back is the drawer\'s');
});

test('forward onto an old drawer entry keeps settings as it is only while settings is showing', () => {
  const page = setup();
  page.window.history.pushState({ tab: 'settings', settingsDrawer: true }, '');
  assert.equal(page.drawer.popstate(), true, 'settings showing: nothing to do');
  page.panel.setAttribute('hidden', '');
  assert.equal(page.drawer.popstate(), false, 'from another page: the page navigates to settings');
});

test('destroy closes the drawer and stops listening', async () => {
  const page = setup();
  await page.toggle.dispatch('click');
  page.drawer.destroy();
  assert.equal(isOpen(page), false); assert.equal(page.docListeners.has('keydown'), false); assert.equal(page.body.inert, false);
});

test('in the settings page, choosing a section from the open drawer switches to it and closes the drawer', async () => {
  const { composeSettings } = await import('../public/js/wb/settings.js');
  const document = documentFixture();
  document.addEventListener = () => {}; document.removeEventListener = () => {};
  const entries = [{ tab: 'settings' }];
  document.defaultView = {
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    location: { href: 'https://host/settings' },
    history: { get state() { return entries.at(-1); }, pushState(state) { entries.push(state); }, back() { entries.pop(); } },
  };
  const root = document.createElement('div');
  const page = composeSettings(root, { settings: document.createElement('div'), fleet: document.createElement('div'), actions: document.createElement('div'), document, t: key => key });
  const toggle = root.querySelector('.wb-set-drawer-btn'), layout = root.querySelector('.wb-set');
  await toggle.dispatch('click');
  assert.equal(page.drawer.isOpen(), true); assert.equal(layout.classList.contains('wb-set-drawer-open'), true);
  await root.querySelector('[data-settings-section="keys"]').dispatch('click');
  assert.equal(page.sections.keys.hidden, false);
  assert.equal(page.drawer.isOpen(), false); assert.equal(entries.length, 1, 'the drawer entry is gone');
  assert.equal(toggle.textContent, 'wb.settings.section.keys');
});
