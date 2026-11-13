// Phone conversation rows: a clearly horizontal leftward drag reveals the row's delete button, which
// still needs its own tap. Vertical scrolling never reveals it, and only one row is revealed at a time.
export const SWIPE_REVEAL_PX = 88;
const DECIDE_PX = 10;

// The drag direction once it has moved far enough to tell: horizontal only when it clearly is.
export function swipeAxis(dx, dy) {
  if (Math.abs(dx) < DECIDE_PX && Math.abs(dy) < DECIDE_PX) return null;
  return Math.abs(dx) > Math.abs(dy) * 1.5 ? 'horizontal' : 'vertical';
}

// Only a row whose delete button is offered, and that is not showing a deletion status, can be swiped open.
const revealable = row => {
  const button = row.querySelector?.('.conversation-delete');
  return Boolean(button) && !button.hidden && !('deletionState' in (row.dataset ?? {}));
};

export function createRowSwipe({ document, enabled = () => true, width = SWIPE_REVEAL_PX } = {}) {
  // `consume`: the row whose next pointer click only ends a drag or puts a revealed button back.
  let open = null, drag = null, consume = null;
  const offset = (row, value) => value === null ? row.style.removeProperty('--conversation-swipe-offset')
    : row.style.setProperty('--conversation-swipe-offset', `${value}px`);
  function close(row = open) {
    if (!row) return;
    row.classList.remove('conversation-swipe-open', 'conversation-swiping');
    offset(row, null);
    if (open === row) open = null;
  }
  // Every press starts afresh; one outside the revealed row only puts it back, and when it lands on
  // another row that row's tap is consumed.
  const press = event => {
    consume = null;
    if (!open || open.contains(event.target)) return;
    consume = event.target.closest?.('.conversation-list-row') ?? null;
    close();
  };
  document.addEventListener?.('pointerdown', press, true);
  function attach(row) {
    row.addEventListener('pointerdown', event => {
      if (event.pointerType === 'mouse' || !enabled() || !revealable(row) || event.target.closest?.('.conversation-delete')) return;
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
    // A horizontal drag is the row's own gesture, not a fling: otherwise the browser suppresses the
    // tap that follows a quick swipe, and the revealed button misses it.
    row.addEventListener('touchmove', event => {
      if (drag?.row === row && drag.axis === 'horizontal' && event.cancelable !== false) event.preventDefault();
    }, { passive: false });
    const end = event => {
      if (drag?.row !== row || event.pointerId !== drag.id) return;
      const { axis, at } = drag;
      drag = null;
      row.classList.remove('conversation-swiping');
      offset(row, null);
      if (axis !== 'horizontal' || at === null) return;
      // The click that may follow a drag must not open the conversation.
      consume = row;
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
    // True when this click on the row only ends a drag or puts the revealed button back. A keyboard
    // activation (detail 0) is never taken for the end of a drag.
    consumeTap(row, event) {
      const pending = consume;
      consume = null;
      if (pending === row && event?.detail !== 0) return true;
      if (open !== row) return false;
      close(row);
      return true;
    },
    destroy() {
      document.removeEventListener?.('pointerdown', press, true);
      open = drag = consume = null;
    }
  };
}
