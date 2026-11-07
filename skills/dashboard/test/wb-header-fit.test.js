import test from 'node:test';
import assert from 'node:assert/strict';
import { fitHeader, watchHeader, NAV_ROW } from '../public/js/wb/header-fit.js';

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

test('header watching refits on resize, locale and detail changes and releases its listeners', () => {
  const f = fixture({ content: 900, width: 1100 });
  const windowListeners = new Map(), documentListeners = new Map(), frames = [], observed = [];
  const window = {
    requestAnimationFrame: fn => { frames.push(fn); return frames.length; }, cancelAnimationFrame: () => {},
    addEventListener: (name, fn) => windowListeners.set(name, fn), removeEventListener: name => windowListeners.delete(name),
    MutationObserver: class { constructor(fn) { this.fn = fn; } observe(node, options) { observed.push(options.attributeFilter); } disconnect() { observed.length = 0; } },
  };
  const document = { documentElement: f.root, addEventListener: (name, fn) => documentListeners.set(name, fn), removeEventListener: name => documentListeners.delete(name) };
  const watcher = watchHeader({ header: f.header, document, window });
  assert.equal(f.classes.has(NAV_ROW), false);
  assert.deepEqual(observed, [['hidden'], ['data-detail', 'lang']]);
  f.resize(760); windowListeners.get('resize')(); documentListeners.get('dashboard-locale-change')();
  assert.equal(frames.length, 1, 'one refit per frame');
  frames[0]();
  assert.equal(f.classes.has(NAV_ROW), true);
  watcher.destroy();
  assert.equal(windowListeners.size, 0); assert.equal(documentListeners.size, 0); assert.equal(observed.length, 0);
});
