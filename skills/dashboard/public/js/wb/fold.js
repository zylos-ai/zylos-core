import { element } from './plain-text.js';

/**
 * Long content folded to the height its CSS sets on `box` (`.wb-fold`), with the cut edge fading out. By default
 * the start shows; with `keepEnd` the end shows and content added at the end slides in from below. A click (or
 * Enter/Space) on folded content unfolds it, and the returned `collapse` button, placed by the caller under the
 * content, folds it again. Content that fits shows whole, with neither. `box` holds one child, the content.
 */
export function createFold({ document, box, t = key => key, expandKey, collapseKey, keepEnd = false }) {
  box.classList.add('wb-fold');
  box.classList.toggle('wb-fold-end', keepEnd);
  const collapse = element(document, 'button', t(collapseKey), 'wb-link-btn wb-fold-collapse');
  collapse.type = 'button';
  collapse.hidden = true;
  let open = false;
  const content = () => box.firstElementChild;
  const full = () => content()?.getBoundingClientRect().height ?? 0;
  function measure() {
    const cut = !open && full() > box.clientHeight + 1;
    if (box.classList.contains('is-cut') === cut) return;
    box.classList.toggle('is-cut', cut);
    if (cut) {
      box.setAttribute('role', 'button');
      box.tabIndex = 0;
      box.setAttribute('aria-expanded', 'false');
      box.setAttribute('aria-label', t(expandKey));
    } else {
      for (const name of ['role', 'tabindex', 'aria-expanded', 'aria-label']) box.removeAttribute(name);
    }
  }
  function set(next) {
    open = next;
    box.classList.toggle('is-open', open);
    collapse.hidden = !open;
    measure();
  }
  function unfold(event) {
    if (!box.classList.contains('is-cut')) return;
    if (event.type === 'keydown' && event.key !== 'Enter' && event.key !== ' ') return;
    // A text selection made inside folded content is not a request to unfold it.
    if (event.type === 'click' && String(document.defaultView?.getSelection?.() ?? '')) return;
    event.preventDefault();
    set(true);
  }
  box.addEventListener('click', unfold);
  box.addEventListener('keydown', unfold);
  collapse.addEventListener('click', () => {
    set(false);
    if (box.getBoundingClientRect().top < 0) box.scrollIntoView?.({ block: 'nearest' });
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
    collapse,
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
