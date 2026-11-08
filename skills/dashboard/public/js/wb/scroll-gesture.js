/**
 * Whether the user is scrolling a list by hand: a finger or pointer is down on it, the wheel is turning, or the
 * list is still moving after either (touch momentum). While it is, the page must not write the scroll position:
 * a write interrupts the gesture and can lock an upward swipe. `onSettle` runs once the list has been still for
 * `settleMs`, so the page can then decide whether to keep following new content.
 */
export function createScrollGesture(target, { setTimeout: delay = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout, settleMs = 180, onSettle } = {}) {
  let active = false, holding = false, timer = null;
  const doc = target.ownerDocument;
  const settle = () => {
    if (timer !== null) cancel(timer);
    timer = delay(() => {
      timer = null;
      if (holding) return;
      active = false;
      onSettle?.();
    }, settleMs);
  };
  const press = () => { active = true; holding = true; if (timer !== null) cancel(timer); timer = null; };
  const release = () => { if (!holding) return; holding = false; settle(); };
  const pointerDown = event => { if (event.pointerType !== 'touch' && event.button === 0) press(); };
  const wheel = () => { active = true; settle(); };
  const scroll = () => { if (active && !holding) settle(); };
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
