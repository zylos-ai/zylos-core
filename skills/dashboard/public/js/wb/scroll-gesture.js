/**
 * Whether the user is scrolling a list by hand: a finger is down on it, the wheel is turning, a mouse button held on
 * it is moving the list (the scrollbar or a drag), or the list is still moving after either (touch momentum). While
 * it is, the page must not write the scroll position: a write interrupts the gesture and can lock an upward swipe.
 * A press on a control (a button, link, field or label) is a click, not a gesture, until the list actually moves
 * under it. `onSettle` runs once the list has been still for `settleMs`, so the page can then catch up on the
 * scroll changes it held back.
 */
const CONTROLS = 'button, a, input, textarea, select, label, summary, [role="button"], [contenteditable]';
const onControl = event => typeof event?.target?.closest === 'function' && event.target.closest(CONTROLS) !== null;

export function createScrollGesture(target, { setTimeout: delay = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout, settleMs = 180, onSettle } = {}) {
  // `held`: a finger or button is down; `armed`: it is down but has not moved the list yet (a click so far).
  let active = false, held = false, armed = false, timer = null;
  const doc = target.ownerDocument;
  const settle = () => {
    if (timer !== null) cancel(timer);
    timer = delay(() => {
      timer = null;
      if (held) return;
      active = false;
      onSettle?.();
    }, settleMs);
  };
  const press = event => {
    held = true;
    if (onControl(event)) { armed = true; return; }
    armed = false; active = true;
    if (timer !== null) cancel(timer);
    timer = null;
  };
  const release = () => {
    if (!held) return;
    held = false;
    if (armed) { armed = false; return; }
    settle();
  };
  // A mouse press only arms: it becomes a gesture when the list scrolls while the button is held.
  const pointerDown = event => {
    if (event.pointerType === 'touch' || event.button !== 0) return;
    held = true; armed = true;
  };
  const wheel = () => { active = true; settle(); };
  const scroll = () => {
    if (armed) { armed = false; active = true; if (timer !== null) cancel(timer); timer = null; return; }
    if (active && !held) settle();
  };
  const listeners = [
    [target, 'touchstart', press], [target, 'touchend', release], [target, 'touchcancel', release],
    [target, 'pointerdown', pointerDown], [doc, 'pointerup', release], [doc, 'pointercancel', release],
    [target, 'wheel', wheel], [target, 'scroll', scroll],
  ];
  for (const [node, type, listener] of listeners) node?.addEventListener?.(type, listener, { passive: true });
  return {
    get active() { return active; },
    destroy() {
      if (timer !== null) cancel(timer);
      timer = null;
      for (const [node, type, listener] of listeners) node?.removeEventListener?.(type, listener, { passive: true });
    }
  };
}
