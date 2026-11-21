/**
 * Marks a sideways-scrolling box with `data-more-right` while part of its content is still hidden to the right;
 * scrolled to the end (or when everything fits) the mark is removed. The box's CSS draws the hint.
 * Rechecks on scroll, when the box changes size (a hidden section opening) and when its content is replaced.
 */
export function watchScrollHint(box, { window = box.ownerDocument?.defaultView } = {}) {
  const update = () => box.toggleAttribute('data-more-right', box.scrollLeft + box.clientWidth < box.scrollWidth - 1);
  box.addEventListener('scroll', update, { passive: true });
  const resize = window?.ResizeObserver ? new window.ResizeObserver(update) : null;
  const mutation = window?.MutationObserver ? new window.MutationObserver(update) : null;
  resize?.observe(box);
  mutation?.observe(box, { childList: true, subtree: true });
  update();
  return () => { box.removeEventListener('scroll', update); resize?.disconnect(); mutation?.disconnect(); };
}
