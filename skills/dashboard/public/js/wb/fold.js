import { element, icon } from './plain-text.js';

/**
 * Long content folded to the height its CSS sets on `box` (`.wb-fold`), with the cut edge fading out and a
 * worded `toggle`, which the caller places, so a glance shows there is more. A click (or Enter/Space) on folded
 * content also unfolds it. Content that fits shows whole, with no toggle. `box` holds one child, the content.
 *
 * By default the start shows; the toggle goes under the content and reads `expandKey` ▾, then `collapseKey` ▴ in
 * the same place. With `keepEnd` the end shows and content added at the end slides in from below; the toggle goes
 * above the content as a muted row saying what is hidden (`hiddenLabel` with how many of the content's children
 * are mostly cut off, else `expandKey`) ▸, then `collapseKey` ▾.
 */
export function createFold({ document, box, t = key => key, expandKey, collapseKey, keepEnd = false, hiddenLabel }) {
  box.classList.add('wb-fold');
  box.classList.toggle('wb-fold-end', keepEnd);
  const toggle = element(document, 'button', undefined, `wb-link-btn wb-fold-toggle${keepEnd ? ' is-top' : ''}`);
  toggle.type = 'button';
  toggle.hidden = true;
  const words = element(document, 'span');
  const chevron = icon(document, 'chev');
  if (keepEnd) toggle.append(chevron, words); else toggle.append(words, chevron);
  let open = false;
  const content = () => box.firstElementChild;
  const full = () => content()?.getBoundingClientRect().height ?? 0;
  /**
   * Children of the content mostly above the cut, so unreadable: a sliver at the top edge counts as hidden, the
   * row fading at the cut as shown. A `display: contents` child is measured by its own children.
   */
  function hiddenCount() {
    const top = content()?.getBoundingClientRect().top ?? 0;
    const cut = full() - box.clientHeight;
    let hidden = 0;
    for (const item of content()?.children ?? []) {
      const rects = [item, ...item.children].map(node => node.getBoundingClientRect()).filter(rect => rect.height);
      if (!rects.length) continue;
      const middle = (Math.min(...rects.map(rect => rect.top)) + Math.max(...rects.map(rect => rect.bottom))) / 2;
      if (middle - top <= cut) hidden++;
    }
    return hidden;
  }
  function label() {
    if (open) return t(collapseKey);
    return keepEnd && hiddenLabel ? hiddenLabel(hiddenCount()) : t(expandKey);
  }
  function measure() {
    const cut = !open && full() > box.clientHeight + 1;
    toggle.hidden = !open && !cut;
    toggle.setAttribute('aria-expanded', String(open));
    if (!toggle.hidden) {
      const text = label();
      if (words.textContent !== text) words.textContent = text;
    }
    if (box.classList.contains('is-cut') === cut) return;
    box.classList.toggle('is-cut', cut);
    // The toggle is the keyboard path; the click on folded content is a pointer shortcut.
    box.title = cut ? t(expandKey) : '';
  }
  function set(next) {
    open = next;
    box.classList.toggle('is-open', open);
    toggle.classList.toggle('is-open', open);
    measure();
  }
  box.addEventListener('click', event => {
    if (!box.classList.contains('is-cut')) return;
    // A text selection made inside folded content is not a request to unfold it.
    if (String(document.defaultView?.getSelection?.() ?? '')) return;
    set(true);
  });
  toggle.addEventListener('click', () => {
    set(!open);
    if (!open && box.getBoundingClientRect().top < 0) (keepEnd ? toggle : box).scrollIntoView?.({ block: 'nearest' });
  });
  const View = document.defaultView?.ResizeObserver;
  const observer = View ? new View(() => measure()) : null;
  let observed = null;
  function watch() {
    const child = content();
    if (child === observed) return;
    if (observed) observer?.unobserve(observed);
    observed = child;
    if (child) observer?.observe(child);
  }
  return {
    toggle,
    /** Measures again after the content changed outside `grow`. */
    update() { watch(); measure(); },
    /** Runs `change`, which replaces or extends the content; new end content slides in while folded. */
    grow(change) {
      const before = keepEnd && !open && box.classList.contains('is-cut') ? full() : null;
      change();
      watch();
      measure();
      const shift = before === null ? 0 : full() - before;
      const still = document.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      if (shift > 0 && !still) content()?.animate?.([{ transform: `translateY(${shift}px)` }, { transform: 'none' }], { duration: 220, easing: 'ease-out' });
    },
    /** Folds again (new content of the same place). */
    reset() { if (open) set(false); },
    destroy() { observer?.disconnect(); },
  };
}
