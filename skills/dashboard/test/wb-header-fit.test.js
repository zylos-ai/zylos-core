import test from 'node:test';
import assert from 'node:assert/strict';
import { currentTab, fadeNav, fitHeader, revealTab, watchHeader, NAV_ROW } from '../public/js/wb/header-fit.js';

// Header layout: pure measurement with an injected header and root; no browser,
// network, timers beyond an injected animation frame, or child processes.
function fixture({ content = 900, width = 800 } = {}) {
  const classes = new Set(), props = {};
  const root = { classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    style: { setProperty: (name, value) => { props[name] = value; } } };
  // One row: the content is wider than the header; nav row: everything wraps inside it and the header grows.
  const header = { get clientWidth() { return width; }, get scrollWidth() { return classes.has(NAV_ROW) ? width : content; },
    getBoundingClientRect: () => ({ height: classes.has(NAV_ROW) ? 69 : 48 }) };
  return { root, header, classes, props, resize: next => { width = next; } };
}

test('the navigation gets its own row only while one header row would overflow, at the measured height', () => {
  const f = fixture({ content: 900, width: 800 });
  assert.equal(fitHeader(f.header, f.root), true);
  assert.equal(f.classes.has(NAV_ROW), true);
  assert.equal(f.props['--wb-header-measured'], '69px');
  f.resize(1100);
  assert.equal(fitHeader(f.header, f.root), false);
  assert.equal(f.classes.has(NAV_ROW), false);
  assert.equal(f.props['--wb-header-measured'], '48px', 'board head and drawer follow the real header height, not a guessed one');
});

const classList = () => { const set = new Set(); return { set, add: n => set.add(n), remove: n => set.delete(n), contains: n => set.has(n), toggle: (n, on) => { if (on) set.add(n); else set.delete(n); } }; };
// A sideways-scrolling row: tabs of fixed width laid out from x=0, the row showing `width` pixels from scrollLeft.
function navFixture({ tabs = [80, 80, 100, 60, 110, 90], width = 390, active = 0, here = false } = {}) {
  const listeners = new Map();
  const nav = { classList: classList(), scrollLeft: 0, clientWidth: width, get scrollWidth() { return tabs.reduce((a, b) => a + b, 0); },
    getBoundingClientRect: () => ({ left: 0, right: width }),
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name), listeners };
  let x = 0;
  nav.tabs = tabs.map((w, index) => {
    const left = x; x += w;
    const tab = { classList: classList(), shown: true, getClientRects: () => (tab.shown ? [{}] : []),
      getBoundingClientRect: () => ({ left: left - nav.scrollLeft, right: left + w - nav.scrollLeft }) };
    if (index === active) tab.classList.add('active');
    return tab;
  });
  // The last tab is the settings entry: present in the markup, shown only while settings is open.
  const settingsEntry = nav.tabs.at(-1); settingsEntry.classList.add('wb-tab-here'); settingsEntry.shown = here;
  nav.querySelectorAll = selector => (selector === '.tab' ? nav.tabs : []);
  return nav;
}

test('the current section is the visible active tab, or the settings entry while settings is open', () => {
  const nav = navFixture({ active: 2 });
  assert.equal(currentTab(nav), nav.tabs[2]);
  nav.tabs[2].classList.remove('active');
  assert.equal(currentTab(nav), null, 'a hidden settings entry is not a position');
  nav.tabs.at(-1).shown = true;
  assert.equal(currentTab(nav), nav.tabs.at(-1), 'settings, which has no tab of its own, still shows where you are');
});

test('the navigation row fades the edges that have sections behind them', () => {
  const nav = navFixture({ width: 390 }); // 520px of tabs in a 390px row
  fadeNav(nav);
  assert.deepEqual([nav.classList.contains('wb-fade-l'), nav.classList.contains('wb-fade-r')], [false, true], 'at the start only the right edge fades');
  nav.scrollLeft = 60; fadeNav(nav);
  assert.deepEqual([nav.classList.contains('wb-fade-l'), nav.classList.contains('wb-fade-r')], [true, true]);
  nav.scrollLeft = 130; fadeNav(nav);
  assert.deepEqual([nav.classList.contains('wb-fade-l'), nav.classList.contains('wb-fade-r')], [true, false], 'at the end only the left edge fades');
  const wide = navFixture({ width: 800 }); fadeNav(wide);
  assert.deepEqual([wide.classList.contains('wb-fade-l'), wide.classList.contains('wb-fade-r')], [false, false], 'a row that fits does not fade');
});

test('revealing the current section scrolls it clear of the faded edge, and only as far as needed', () => {
  const nav = navFixture({ width: 390 });
  revealTab(nav, nav.tabs.at(-2)); // 320..430: past the right edge
  assert.equal(nav.scrollLeft, 430 - (390 - 32));
  revealTab(nav, nav.tabs.at(-2));
  assert.equal(nav.scrollLeft, 72, 'already in view: no movement');
  revealTab(nav, nav.tabs[0]); // 0..80, now 72px left of the row
  assert.equal(nav.scrollLeft, 72 - (32 + 72), 'the left edge asks for the same 32px margin (a browser clamps the result at 0)');
  const wide = navFixture({ width: 800 }); revealTab(wide, wide.tabs.at(-1));
  assert.equal(wide.scrollLeft, 0, 'a row that fits never scrolls');
});

test('header watching refits on resize, locale, detail and section changes and releases its listeners', () => {
  const f = fixture({ content: 900, width: 1100 });
  const nav = navFixture({ width: 390, active: 4 });
  f.header.querySelector = selector => (selector === '.tab-bar' ? nav : null);
  const windowListeners = new Map(), documentListeners = new Map(), frames = [], observed = [];
  const window = {
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame: () => {},
    addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe(node, options) { observed.push(options.attributeFilter); } disconnect() { observed.length = 0; } },
  };
  const settingsPanel = {};
  const document = { documentElement: f.root, getElementById: id => (id === 'tab-settings' ? settingsPanel : null),
    addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) };
  const watcher = watchHeader({ header: f.header, document, window });
  assert.equal(f.classes.has(NAV_ROW), false);
  // The header's own class changes (a tab becoming active) and the settings panel opening both refit.
  assert.deepEqual(observed, [['hidden', 'class'], ['data-detail', 'lang'], ['class']]);
  assert.equal(nav.scrollLeft, 430 - (390 - 32), 'the first fit brings the current section into view');
  assert.equal(nav.classList.contains('wb-fade-l'), true);
  nav.scrollLeft = 0; nav.listeners.get('scroll')();
  assert.equal(nav.classList.contains('wb-fade-l'), false, 'scrolling by hand updates the fades');
  watcher.fit();
  assert.equal(nav.scrollLeft, 0, 'a refit without a change of section leaves the row where the person put it');
  f.resize(760); windowListeners.get('resize')(); documentListeners.get('dashboard-locale-change')();
  assert.equal(frames.length, 1, 'one refit per frame');
  frames[0]();
  assert.equal(f.classes.has(NAV_ROW), true);
  watcher.destroy();
  assert.equal(windowListeners.size, 0); assert.equal(documentListeners.size, 0); assert.equal(observed.length, 0);
  assert.equal(nav.listeners.size, 0, 'the scroll listener is released');
});
