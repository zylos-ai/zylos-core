import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPACT, fitRow, fitsOneLine, watchRows } from '../public/js/wb/label-fit.js';

// A row of labels whose layout depends on its compact class: `full` and `compact` give each child's [top, bottom]
// (null = not shown), the way a browser would lay the row out in each form.
function stubRow({ full, compact = full }) {
  const classes = new Set();
  const row = {
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) },
    measured: [],
  };
  row.children = full.map((_, index) => ({
    getClientRects: () => ((classes.has(COMPACT) ? compact : full)[index] ? [{}] : []),
    getBoundingClientRect: () => {
      row.measured.push(classes.has(COMPACT) ? 'compact' : 'full');
      const [top, bottom] = (classes.has(COMPACT) ? compact : full)[index];
      return { top, bottom };
    },
  }));
  return row;
}

test('a row is on one line when every shown label starts before the first line ends', () => {
  assert.equal(fitsOneLine(stubRow({ full: [[0, 20], [2, 18], [0, 20]] })), true);
  assert.equal(fitsOneLine(stubRow({ full: [[0, 20], [24, 44]] })), false);
  assert.equal(fitsOneLine(stubRow({ full: [[0, 20], null, [0, 20]] })), true, 'labels not shown do not count');
  assert.equal(fitsOneLine(stubRow({ full: [] })), true);
});

test('fitRow keeps the full form while it fits and goes compact only when the full form wraps', () => {
  const fits = stubRow({ full: [[0, 20], [0, 20]], compact: [[0, 20], [0, 20]] });
  fits.classList.add(COMPACT);
  assert.equal(fitRow(fits), false);
  assert.equal(fits.classList.contains(COMPACT), false, 'a compact row that fits again returns to the full form');
  assert.deepEqual([...new Set(fits.measured)], ['full'], 'the full form is what gets measured');

  const wraps = stubRow({ full: [[0, 20], [24, 44]], compact: [[0, 20], [0, 20]] });
  wraps.classList.add(COMPACT);
  assert.equal(fitRow(wraps), true);
  assert.equal(wraps.classList.contains(COMPACT), true);
  assert.deepEqual([...new Set(wraps.measured)], ['full'], 'measuring the stale compact form would wrongly keep it');
  assert.equal(fitRow(null), false);
});

test('watchRows refits now, in the frame after width changes of a row or its parent, and when fonts are ready', async () => {
  let callback, observed = [], disconnected = false, fontsReady;
  class ResizeObserver {
    constructor(handler) { callback = handler; }
    observe(target) { observed.push(target); }
    disconnect() { disconnected = true; }
  }
  const frames = new Map();
  let nextFrame = 0;
  const window = {
    ResizeObserver,
    requestAnimationFrame: run => { nextFrame += 1; frames.set(nextFrame, run); return nextFrame; },
    cancelAnimationFrame: id => { frames.delete(id); },
  };
  const runFrames = () => { const due = [...frames.values()]; frames.clear(); for (const run of due) run(); };
  const document = { fonts: { ready: new Promise(resolve => { fontsReady = resolve; }) } };
  const parent = { name: 'parent' };
  const row = stubRow({ full: [[0, 20], [24, 44]], compact: [[0, 20], [0, 20]] });
  row.parentElement = parent;
  const fits = [];
  const original = row.classList.toggle;
  row.classList.toggle = (c, on) => { fits.push(on); original(c, on); };
  const watcher = watchRows([row, null], { document, window });
  assert.deepEqual(fits, [true], 'fitted on start');
  assert.deepEqual(observed, [row, parent]);
  callback([{ target: row, contentRect: { width: 800 } }, { target: parent, contentRect: { width: 180 } }]);
  assert.equal(fits.length, 1, 'nothing changes inside the observer callback');
  callback([{ target: parent, contentRect: { width: 170 } }]);
  assert.equal(frames.size, 1, 'changes before the frame share one refit');
  runFrames();
  assert.equal(fits.length, 2, 'first sizes refit in the next frame');
  callback([{ target: row, contentRect: { width: 800 } }]);
  assert.equal(frames.size, 0, 'a height-only change does not refit');
  callback([{ target: parent, contentRect: { width: 160 } }]);
  runFrames();
  assert.equal(fits.length, 3, 'a narrower parent refits');
  fontsReady();
  await document.fonts.ready; await null;
  assert.equal(fits.length, 4, 'refit once fonts are ready');
  assert.deepEqual(watcher.fit(), [true]);
  callback([{ target: parent, contentRect: { width: 150 } }]);
  assert.equal(frames.size, 1);
  watcher.destroy();
  assert.equal(disconnected, true);
  assert.equal(frames.size, 0, 'destroy cancels a refit still waiting for its frame');
  assert.equal(fits.length, 5);
});
