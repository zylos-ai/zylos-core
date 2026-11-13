import test from 'node:test';
import assert from 'node:assert/strict';
import { createRowSwipe, swipeAxis, SWIPE_REVEAL_PX } from '../public/js/wb/conversation-swipe.js';

// Minimal element tree: the swipe controller only reads classes, a custom property, containment, the
// row's delete button and deletion state, and events.
function element(className, parent = null) {
  const listeners = new Map(), classes = new Set(className.split(' ')), properties = new Map(), children = [];
  const node = {
    parent, children, dataset: {}, hidden: false,
    classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)),
      contains: name => classes.has(name) },
    style: { setProperty: (name, value) => properties.set(name, value), removeProperty: name => properties.delete(name), get: name => properties.get(name) },
    contains: other => { for (let current = other; current; current = current.parent) if (current === node) return true; return false; },
    querySelector: selector => children.find(child => child.classList.contains(selector.slice(1))) ?? null,
    closest: selector => { for (let current = node; current; current = current.parent) if (current.classList.contains(selector.slice(1))) return current; return null; },
    addEventListener: (name, fn) => listeners.set(name, [...(listeners.get(name) ?? []), fn]),
    removeEventListener: (name, fn) => listeners.set(name, (listeners.get(name) ?? []).filter(item => item !== fn)),
    setPointerCapture() {},
    fire(name, event) { for (const fn of listeners.get(name) ?? []) fn(event); }
  };
  parent?.children.push(node);
  return node;
}
function page({ enabled = () => true } = {}) {
  const document = element('document');
  const rows = [0, 1].map(() => {
    const row = element('conversation-list-row');
    return { row, body: element('conversation-list-item', row), remove: element('conversation-delete', row) };
  });
  const swipe = createRowSwipe({ document, enabled }), moves = [];
  for (const { row } of rows) swipe.attach(row);
  // Dispatches the way a browser does: document capture first, then the row the target sits in.
  const dispatch = (target, type, x, y, pointerType = 'touch') => {
    const event = { type, target, pointerId: 1, pointerType, clientX: x, clientY: y };
    if (type === 'pointermove') {
      target.closest('.conversation-list-row')?.fire(type, event);
      // The browser follows each pointer move with its touch move, whose default it may scroll or fling with.
      const touch = { cancelable: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      if (pointerType === 'touch') target.closest('.conversation-list-row')?.fire('touchmove', touch);
      moves.push(touch.defaultPrevented);
      return;
    }
    if (type === 'pointerdown') document.fire('pointerdown', event);
    target.closest('.conversation-list-row')?.fire(type, event);
  };
  const drag = (target, points, pointerType) => {
    dispatch(target, 'pointerdown', 200, 100, pointerType);
    for (const [x, y] of points) dispatch(target, 'pointermove', x, y, pointerType);
    const [x, y] = points.at(-1) ?? [200, 100];
    dispatch(target, 'pointerup', x, y, pointerType);
  };
  return { swipe, rows, dispatch, drag, moves, revealed: row => row.classList.contains('conversation-swipe-open') };
}

test('only a clearly horizontal movement counts as a swipe', () => {
  assert.equal(swipeAxis(-6, 3), null);
  assert.equal(swipeAxis(-30, 10), 'horizontal');
  assert.equal(swipeAxis(-30, 20), 'vertical', 'a diagonal drag is treated as scrolling');
  assert.equal(swipeAxis(4, 40), 'vertical');
});

test('swiping a row left reveals its delete button and the ending tap does not open the conversation', () => {
  const p = page(), [{ row, body }] = p.rows;
  p.drag(body, [[185, 101], [150, 102], [90, 103]]);
  assert.equal(p.revealed(row), true);
  assert.equal(p.swipe.consumeTap(row), true, 'the click that ends the drag is consumed');
  assert.equal(p.revealed(row), true, 'consuming the drag click keeps the button revealed');
});

test('the row follows the finger while dragging and never past the button width', () => {
  const p = page(), [{ row, body }] = p.rows;
  p.dispatch(body, 'pointerdown', 200, 100);
  p.dispatch(body, 'pointermove', 170, 101);
  assert.equal(row.style.get('--conversation-swipe-offset'), '-30px');
  assert.equal(row.classList.contains('conversation-swiping'), true);
  p.dispatch(body, 'pointermove', 20, 101);
  assert.equal(row.style.get('--conversation-swipe-offset'), `-${SWIPE_REVEAL_PX}px`);
  p.dispatch(body, 'pointerup', 20, 101);
  assert.equal(row.style.get('--conversation-swipe-offset'), undefined);
  assert.equal(row.classList.contains('conversation-swiping'), false);
});

test('vertical scrolling never reveals the button and its tap still opens the conversation', () => {
  const p = page(), [{ row, body }] = p.rows;
  p.drag(body, [[198, 130], [190, 220], [120, 260]]);
  assert.equal(p.revealed(row), false);
  assert.equal(row.style.get('--conversation-swipe-offset'), undefined, 'the row did not move');
  assert.equal(p.swipe.consumeTap(row), false);
});

test('a short swipe or a cancelled one springs back', () => {
  const p = page(), [{ row, body }] = p.rows;
  p.drag(body, [[180, 100], [170, 100]]);
  assert.equal(p.revealed(row), false);
  p.dispatch(body, 'pointerdown', 200, 100);
  p.dispatch(body, 'pointermove', 60, 100);
  p.dispatch(body, 'pointercancel', 60, 100);
  assert.equal(p.revealed(row), false);
});

test('mouse drags, desktop widths and presses on the delete button itself do not swipe', () => {
  const desktop = page({ enabled: () => false });
  desktop.drag(desktop.rows[0].body, [[150, 100], [60, 100]]);
  assert.equal(desktop.revealed(desktop.rows[0].row), false);
  const p = page();
  p.drag(p.rows[0].body, [[150, 100], [60, 100]], 'mouse');
  assert.equal(p.revealed(p.rows[0].row), false);
  p.drag(p.rows[0].remove, [[150, 100], [60, 100]]);
  assert.equal(p.revealed(p.rows[0].row), false);
});

test('a tap on the revealed row only puts the button back', () => {
  const p = page(), [{ row, body }] = p.rows;
  p.drag(body, [[150, 100], [60, 100]]); p.swipe.consumeTap(row);
  p.dispatch(body, 'pointerdown', 120, 100); p.dispatch(body, 'pointerup', 120, 100);
  assert.equal(p.swipe.consumeTap(row), true);
  assert.equal(p.revealed(row), false);
  p.dispatch(body, 'pointerdown', 120, 100); p.dispatch(body, 'pointerup', 120, 100);
  assert.equal(p.swipe.consumeTap(row), false, 'the next tap opens the conversation');
});

test('only one row is revealed: a press elsewhere puts it back and that tap is consumed', () => {
  const p = page(), [first, second] = p.rows;
  p.drag(first.body, [[150, 100], [60, 100]]); p.swipe.consumeTap(first.row);
  p.dispatch(second.body, 'pointerdown', 120, 100); p.dispatch(second.body, 'pointerup', 120, 100);
  assert.equal(p.revealed(first.row), false);
  assert.equal(p.swipe.consumeTap(second.row), true, 'the tap that closed the other row does not open this one');
  p.drag(first.body, [[150, 100], [60, 100]]); p.swipe.consumeTap(first.row);
  p.drag(second.body, [[150, 100], [60, 100]]);
  assert.equal(p.revealed(first.row), false);
  assert.equal(p.revealed(second.row), true);
});

test('a drag that produced no click does not swallow the next real tap', () => {
  const p = page(), [{ row, body }] = p.rows;
  p.drag(body, [[180, 100], [170, 100]]);
  p.dispatch(body, 'pointerdown', 120, 100); p.dispatch(body, 'pointerup', 120, 100);
  assert.equal(p.swipe.consumeTap(row), false);
});

test('a row without an offered delete button, or showing a deletion status, does not swipe open', () => {
  const p = page(), [first, second] = p.rows;
  first.remove.hidden = true;
  p.drag(first.body, [[150, 100], [60, 100]]);
  assert.equal(p.revealed(first.row), false, 'Origin, read-only and server-disallowed rows stay put');
  assert.equal(first.row.style.get('--conversation-swipe-offset'), undefined, 'the row did not move');
  assert.equal(p.swipe.consumeTap(first.row, { detail: 1 }), false, 'its tap still opens the conversation');
  second.row.dataset.deletionState = 'error';
  p.drag(second.body, [[150, 100], [60, 100]]);
  assert.equal(p.revealed(second.row), false, 'the inline retry is never covered');
});

test('only a horizontal drag keeps the browser from scrolling or flinging with the touch', () => {
  const p = page(), [{ body }] = p.rows;
  p.drag(body, [[198, 130], [190, 220]]);
  assert.deepEqual(p.moves, [false, false], 'vertical scrolling keeps its default');
  p.moves.length = 0;
  p.drag(body, [[194, 100], [150, 101], [90, 102]]);
  assert.deepEqual(p.moves, [false, true, true], 'undecided moves keep it, horizontal ones do not');
});

test('a keyboard activation is never taken for the end of a drag', () => {
  const p = page(), [{ row, body }] = p.rows;
  p.drag(body, [[180, 100], [170, 100]]);
  assert.equal(p.swipe.consumeTap(row, { detail: 0 }), false, 'Enter on the row after a drag that produced no click opens it');
  p.drag(body, [[180, 100], [170, 100]]);
  assert.equal(p.swipe.consumeTap(row, { detail: 1 }), true, 'the pointer click that ends a drag is still consumed');
});
