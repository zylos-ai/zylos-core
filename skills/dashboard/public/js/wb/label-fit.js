// Rows of short labels (the board head's state counts, the instance strip) never break inside a label. A row that
// does not fit on one line first takes its compact form, which takes words off the screen but keeps them in the
// accessible text and in a title (a count's own title; the cost item's title for the strip's scope); only if that
// does not fit either do whole labels wrap to the next line.
// Labels differ per locale and per count, so this measures instead of guessing a breakpoint.
export const COMPACT = 'wb-compact';

const shown = node => node.getClientRects().length > 0;

/** True when every shown child of the row starts on the row's first line. */
export function fitsOneLine(row) {
  const boxes = [...row.children].filter(shown).map(node => node.getBoundingClientRect());
  if (!boxes.length) return true;
  const firstBottom = Math.min(...boxes.map(box => box.bottom));
  return boxes.every(box => box.top < firstBottom);
}

/** Full form when it fits on one line, compact form otherwise. Returns whether the row is compact. */
export function fitRow(row) {
  if (!row) return false;
  row.classList.remove(COMPACT);
  const compact = !fitsOneLine(row);
  row.classList.toggle(COMPACT, compact);
  return compact;
}

/** Refit the rows now, whenever their width changes (window resized, drawer opened) and once fonts are ready. */
export function watchRows(rows, { document = globalThis.document, window = globalThis.window } = {}) {
  const list = rows.filter(Boolean);
  const fit = () => list.map(fitRow);
  // A width change refits in the next frame: refitting inside the observer's callback would change the size of
  // an observed row while the browser delivers its notifications, which it reports as a ResizeObserver loop error.
  let frame = null;
  const schedule = () => {
    if (frame != null || !window?.requestAnimationFrame) return;
    frame = window.requestAnimationFrame(() => { frame = null; fit(); });
  };
  const widths = new Map();
  // Each row and its parent: the strip changes width with the drawer, the count row's cell with the grid column.
  const targets = [...new Set(list.flatMap(row => [row, row.parentElement].filter(Boolean)))];
  const observer = window?.ResizeObserver ? new window.ResizeObserver(entries => {
    let changed = false;
    for (const entry of entries) {
      if (widths.get(entry.target) !== entry.contentRect.width) changed = true;
      widths.set(entry.target, entry.contentRect.width);
    }
    if (changed) schedule();
  }) : null;
  for (const target of targets) observer?.observe(target);
  document?.fonts?.ready?.then(fit);
  fit();
  return {
    fit,
    destroy() {
      observer?.disconnect();
      if (frame != null) window.cancelAnimationFrame?.(frame);
      frame = null;
    },
  };
}
