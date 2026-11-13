// Phone conversation rows: a clearly horizontal leftward drag reveals the row's delete button, which
// still needs its own tap. Vertical scrolling never reveals it, and only one row is revealed at a time.
export const SWIPE_REVEAL_PX = 88;
const DECIDE_PX = 10;

// The drag direction once it has moved far enough to tell: horizontal only when it clearly is.
export function swipeAxis(dx, dy) {
  if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.5 ? 'horizontal' : 'vertical';
}

export function createRowSwipe({ document, enabled = () => true, width = SWIPE_REVEAL_PX } = {}) {
  let open = null, drag = null, swallow = null, swallowedBy = null;
  const offset = (row, value) => value === null ? row.style.removeProperty('--conversation-swipe-offset')
    : row.style.setProperty('--conversation-swipe-offset', `${value}px`);
  function close(row = open) {
    if (!row) return;
    row.classList.remove('conversation-swipe-open', 'conversation-swiping');
    offset(row, null);
    if (open === row) open = null;
  }
  // A press outside the revealed row only puts it back: when it lands on another row, that row's tap is consumed.
  const outside = event => {
    if (!open || open.contains(event.target)) return;
    const row = event.target.closest?.('.conversation-list-row') ?? null;
    close();
    swallow = row;
    swallowedBy = event;
  };
  document.addEventListener?.('pointerdown', outside, true);
  function attach(row) {
    row.addEventListener('pointerdown', event => {
      // A consumed tap that never produced a click must not swallow the next real one.
      if (swallowedBy !== event) swallow = null;
      if (event.pointerType === 'mouse' || !enabled() || event.target.closest?.('.conversation-delete')) return;
      drag = { row, id: event.pointerId, x: event.clientX, y: event.clientY, base: open === row ? -width : 0, axis: null, at: null };
    });
    row.addEventListener('pointermove', event => {
      if (drag?.row !== row || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      drag.axis ??= swipeAxis(dx, dy);
      if (drag.axis !== 'horizontal') return;
      if (drag.at === null) row.setPointerCapture?.(event.pointerId);
      drag.at = Math.max(-width, Math.min(0, drag.base + dx));
      row.classList.add('conversation-swiping');
      offset(row, drag.at);
    });
    const end = event => {
      if (drag?.row !== row || event.pointerId !== drag.id) return;
      const { axis, at } = drag;
      drag = null;
      row.classList.remove('conversation-swiping');
      offset(row, null);
      if (axis !== 'horizontal' || at === null) return;
      // The click that may follow a drag must not open the conversation.
      swallow = row;
      swallowedBy = null;
      if (event.type === 'pointerup' && at <= -width / 2) {
        open = row;
        row.classList.add('conversation-swipe-open');
      } else close(row);
    };
    row.addEventListener('pointerup', end);
    row.addEventListener('pointercancel', end);
  }
  return {
    attach,
    close,
    isOpen: row => open === row,
    // True when this tap on the row only ends a drag or puts the revealed button back.
    consumeTap(row) {
      if (swallow === row) { swallow = null; return true; }
      swallow = null;
      if (open !== row) return false;
      close(row);
      return true;
    },
    destroy() {
      document.removeEventListener?.('pointerdown', outside, true);
      open = drag = swallow = swallowedBy = null;
    }
  };
}
