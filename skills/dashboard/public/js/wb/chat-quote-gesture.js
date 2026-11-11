import { icon } from './plain-text.js?v=106';

/** Swiping a message left by this far quotes it; the row follows the finger up to SWIPE_MAX. */
export const SWIPE_DISTANCE = 56;
export const SWIPE_MAX = 80;
/** A trackpad has no "fingers lifted" event: a pause this long (momentum included) ends its swipe. */
export const WHEEL_IDLE_MS = 160;
// Controls, attachment cards, code and tables keep their own gestures.
const NO_SWIPE = 'button, a, input, textarea, select, label, summary, [contenteditable], .chat-attachment, pre, table';
const MESSAGE = 'article[data-message-id]';

/**
 * Swipe-to-quote on the message list. Touch and pen swipe at any width (vertical scrolling stays with the browser:
 * messages are `touch-action: pan-y`); a mouse drag is never a swipe, it selects text. A trackpad's two-finger
 * horizontal swipe arrives as wheel events: their deltaX is summed, and only the events that belong to the swipe
 * are prevented, so vertical scrolling and sideways-scrollable content are untouched.
 */
export function createQuoteGesture({ list, document = list.ownerDocument, enabled = () => true, onQuote,
  setTimeout: delay = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout, wheelIdleMs = () => WHEEL_IDLE_MS }) {
  const view = document.defaultView;
  const selecting = () => view?.getSelection?.()?.isCollapsed === false;
  const messageOf = target => typeof target?.closest === 'function' ? target.closest(MESSAGE) : null;
  function blocked(target, article) {
    if (typeof target?.closest !== 'function' || target.closest(NO_SWIPE)) return true;
    for (let node = target; node && node !== article; node = node.parentElement) {
      const overflow = view?.getComputedStyle?.(node).overflowX;
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollWidth > node.clientWidth + 1) return true;
    }
    return false;
  }
  const parts = article => [...article.children].filter(child => !child.classList.contains('conversation-swipe-cue'));
  function dragTo(article, dx) {
    let cue = article.querySelector(':scope > .conversation-swipe-cue');
    if (!cue) {
      cue = document.createElement('span');
      cue.className = 'conversation-swipe-cue';
      cue.setAttribute('aria-hidden', 'true');
      cue.append(icon(document, 'reply'));
      article.append(cue);
    }
    if (!article.classList.contains('conversation-swiping')) {
      // The cue sits in the space the bubble leaves on its right.
      const left = article.getBoundingClientRect().left;
      const right = Math.max(...parts(article).map(part => part.getBoundingClientRect().right));
      cue.style.left = `${right - left - 38}px`;
    }
    for (const part of parts(article)) part.style.transform = `translateX(${dx}px)`;
    article.style.setProperty('--conversation-swipe', String(Math.min(1, -dx / SWIPE_DISTANCE)));
    article.classList.add('conversation-swiping');
    article.classList.toggle('conversation-swipe-ready', dx <= -SWIPE_DISTANCE);
  }
  function reset(article) {
    if (!article) return;
    for (const part of parts(article)) part.style.transform = '';
    article.querySelector(':scope > .conversation-swipe-cue')?.remove();
    article.classList.remove('conversation-swiping', 'conversation-swipe-ready');
    article.style.removeProperty('--conversation-swipe');
  }
  const quote = article => { if (article.isConnected && enabled() && !selecting()) onQuote(article.dataset.messageId); };

  // Touch and pen.
  let touch = null;
  const pointerDown = event => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    const article = messageOf(event.target);
    if (!article || !list.contains(article) || !enabled() || blocked(event.target, article)) return;
    touch = { article, id: event.pointerId, x: event.clientX, y: event.clientY, active: false, dx: 0 };
  };
  const pointerMove = event => {
    if (!touch || event.pointerId !== touch.id) return;
    const mx = event.clientX - touch.x, my = event.clientY - touch.y;
    if (!touch.active) {
      // Mostly vertical: a scroll, never a swipe. Clearly horizontal and leftwards: a swipe.
      if (Math.abs(my) > 10 && Math.abs(my) > Math.abs(mx)) { touch = null; return; }
      if (!(mx < -10 && Math.abs(mx) > Math.abs(my) * 1.5)) return;
      touch.active = true;
      try { touch.article.setPointerCapture(event.pointerId); } catch {}
    }
    if (selecting() || !enabled()) { reset(touch.article); touch = null; return; }
    touch.dx = Math.max(-SWIPE_MAX, Math.min(0, mx));
    dragTo(touch.article, touch.dx);
  };
  const pointerUp = event => {
    if (!touch || event.pointerId !== touch.id) return;
    const { article, active, dx } = touch;
    touch = null;
    reset(article);
    if (active && dx <= -SWIPE_DISTANCE) quote(article);
  };
  const pointerCancel = event => {
    if (!touch || event.pointerId !== touch.id) return;
    reset(touch.article);
    touch = null;
  };
  // Touch gives the touched element implicit capture; moving it to the message ends that one, which is no cancel.
  const lostCapture = event => { if (touch && event.target === touch.article) pointerCancel(event); };

  // Trackpad. deltaX > 0 moves content to the left (with macOS natural scrolling: fingers moving left).
  let wheel = null;
  const finishWheel = () => {
    if (!wheel) return;
    cancel(wheel.timer);
    const { article, sum } = wheel;
    wheel = null;
    reset(article);
    if (sum >= SWIPE_DISTANCE) quote(article);
  };
  const dropWheel = () => { if (wheel) { cancel(wheel.timer); reset(wheel.article); wheel = null; } };
  const onWheel = event => {
    // Pinch zoom arrives with ctrlKey; Shift+wheel is a mouse wheel turned sideways.
    if (event.ctrlKey || event.shiftKey) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const dx = event.deltaX * unit, dy = event.deltaY * unit;
    if (Math.abs(dx) <= Math.abs(dy)) {
      // Vertical scrolling goes on; turning vertical cancels a swipe.
      if (wheel && Math.abs(dy) > 4) dropWheel();
      return;
    }
    if (!wheel) {
      const article = messageOf(event.target);
      if (!article || !list.contains(article) || dx <= 0 || Math.abs(dx) < Math.abs(dy) * 1.5 || !enabled() || selecting()
        || blocked(event.target, article)) return;
      wheel = { article, sum: 0, timer: null };
    }
    event.preventDefault();
    if (selecting() || !enabled()) { dropWheel(); return; }
    wheel.sum = Math.max(0, Math.min(SWIPE_MAX, wheel.sum + dx));
    dragTo(wheel.article, -wheel.sum);
    cancel(wheel.timer);
    wheel.timer = delay(finishWheel, wheelIdleMs());
  };

  const listeners = [['pointerdown', pointerDown], ['pointermove', pointerMove], ['pointerup', pointerUp],
    ['pointercancel', pointerCancel], ['lostpointercapture', lostCapture]];
  for (const [type, listener] of listeners) list.addEventListener(type, listener);
  list.addEventListener('wheel', onWheel, { passive: false });
  return {
    destroy() {
      dropWheel();
      if (touch) reset(touch.article);
      touch = null;
      for (const [type, listener] of listeners) list.removeEventListener(type, listener);
      list.removeEventListener('wheel', onWheel, { passive: false });
    }
  };
}
