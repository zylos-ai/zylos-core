import test from 'node:test';
import assert from 'node:assert/strict';
import { createSettingsNavigation } from '../public/js/wb/settings-navigation.js';

function setup(phone = true) {
  const entries = [{ url: '/', state: null }, { url: '/settings', state: { tab: 'settings' } }];
  let index = 1, section, backs = 0, hidden = false;
  const media = { matches: phone, addEventListener() {} };
  const window = {
    matchMedia: () => media,
    location: { get href() { return entries[index].url; } },
    history: {
      get state() { return entries[index].state; },
      pushState(state, _, url) { entries.splice(++index, Infinity, { state, url }); },
      back() { backs++; },
    },
  };
  const navigation = createSettingsNavigation({
    layout: { closest: () => hidden ? {} : null }, window,
    select: value => { section = value; },
    showList: () => { section = null; },
  });
  return {
    navigation, entries, window, section: () => section, backs: () => backs,
    back() { index--; return navigation.popstate(); },
    forward() { index++; return navigation.popstate(); },
    hide() { hidden = true; },
  };
}

test('opening a section from the phone list gives it one entry and both Back and Forward keep the same settings page', () => {
  const page = setup();
  page.navigation.open();
  assert.equal(page.section(), null);
  page.navigation.pick('defaults');
  assert.equal(page.section(), 'defaults');
  assert.deepEqual(page.entries.at(-1), { url: '/settings', state: { tab: 'settings', settingsSection: true } });
  page.navigation.backToList();
  assert.equal(page.backs(), 1);
  assert.equal(page.back(), true);
  assert.equal(page.section(), null);
  assert.equal(page.forward(), true);
  assert.equal(page.section(), null);
  page.navigation.pick('pricing');
  assert.equal(page.entries.length, 3, 'the current entry is reused');
  assert.equal(page.back(), true);
  assert.equal(page.back(), false, 'the next Back belongs to the previous page');
});

test('a shortcut opens its section without an extra entry and its in-page arrow opens the list', () => {
  const page = setup();
  page.navigation.open('machine');
  assert.equal(page.section(), 'machine');
  assert.equal(page.entries.length, 2);
  page.navigation.backToList();
  assert.equal(page.section(), null);
  assert.equal(page.backs(), 0);
  assert.equal(page.back(), false);
});

test('leaving a phone section allows replacement, while a desktop selection adds no entry', () => {
  const page = setup();
  page.navigation.open();
  page.navigation.pick('pricing');
  assert.equal(page.navigation.leave(), true);
  assert.equal(page.backs(), 0);
  assert.equal(page.back(), false);
  page.hide();
  assert.equal(page.forward(), false, 'arriving from another page belongs to the page router');

  const desktop = setup(false);
  desktop.navigation.open();
  assert.equal(desktop.section(), 'account');
  desktop.navigation.pick('pricing');
  assert.equal(desktop.section(), 'pricing');
  assert.equal(desktop.entries.length, 2);
  assert.equal(desktop.navigation.leave(), false);
});
