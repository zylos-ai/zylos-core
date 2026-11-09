// One header row while brand, navigation and tools fit; otherwise the navigation moves to its own
// scrollable row (the same layout phones always use). Labels differ per locale and the observer tab
// comes and goes, so this measures instead of guessing a breakpoint.
export const NAV_ROW = 'wb-nav-row';

export function fitHeader(header, root = header.ownerDocument.documentElement) {
  root.classList.remove(NAV_ROW);
  const overflow = header.scrollWidth > header.clientWidth + 1;
  if (overflow) root.classList.add(NAV_ROW);
  // Sticky board head and drawer sit right under the real header height (borders included).
  root.style.setProperty('--wb-header-measured', header.getBoundingClientRect().height + 'px');
  return overflow;
}

const visible = node => node.getClientRects().length > 0;

/** The section the page is on: the active tab, or the "Settings" entry the stylesheet shows while settings is open. */
export function currentTab(nav) {
  return [...nav.querySelectorAll('.tab')].find(tab => visible(tab) && (tab.classList.contains('active') || tab.classList.contains('wb-tab-here'))) ?? null;
}

/** Fade the edge of a sideways-scrolling navigation row that has more sections behind it. */
export function fadeNav(nav) {
  const hidden = nav.scrollWidth - nav.clientWidth;
  nav.classList.toggle('wb-fade-l', hidden > 1 && nav.scrollLeft > 1);
  nav.classList.toggle('wb-fade-r', hidden > 1 && nav.scrollLeft < hidden - 1);
}

/** Scroll the row just enough that the current section is fully visible, clear of the faded edges. */
export function revealTab(nav, tab, edge = 32) {
  if (!tab || nav.scrollWidth <= nav.clientWidth) return;
  const box = tab.getBoundingClientRect(), row = nav.getBoundingClientRect();
  if (box.left < row.left + edge) nav.scrollLeft -= row.left + edge - box.left;
  else if (box.right > row.right - edge) nav.scrollLeft += box.right - (row.right - edge);
}

export function watchHeader({ header, document = header?.ownerDocument, window = globalThis.window } = {}) {
  if (!header) return { fit: () => false, destroy() {} };
  let frame = null, shown = null;
  const nav = header.querySelector('.tab-bar');
  const fit = () => {
    const overflow = fitHeader(header, document.documentElement);
    if (nav) {
      // Only a change of section moves the row, so a person scrolling it is not pulled back.
      const current = currentTab(nav);
      if (current !== shown) { shown = current; revealTab(nav, current); }
      fadeNav(nav);
    }
    return overflow;
  };
  const schedule = () => {
    if (frame != null) return;
    frame = window.requestAnimationFrame(() => { frame = null; fit(); });
  };
  // Labels change with locale, the machine name arrives late and the technical switch adds the observer tab.
  // Changing section moves the tabs' `active` class (settings marks its panel active instead).
  const mutations = window.MutationObserver ? new window.MutationObserver(records => {
    if (records.some(record => record.attributeName !== 'class' || record.target !== nav)) schedule();
  }) : null;
  mutations?.observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class'] });
  mutations?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-detail', 'lang'] });
  const settings = document.getElementById?.('tab-settings');
  if (settings) mutations?.observe(settings, { attributes: true, attributeFilter: ['class'] });
  const scrolled = () => fadeNav(nav);
  nav?.addEventListener('scroll', scrolled, { passive: true });
  window.addEventListener('resize', schedule);
  document.addEventListener('dashboard-locale-change', schedule);
  document.fonts?.ready?.then(schedule);
  fit();
  return {
    fit,
    destroy() {
      mutations?.disconnect();
      nav?.removeEventListener('scroll', scrolled);
      window.removeEventListener('resize', schedule);
      document.removeEventListener('dashboard-locale-change', schedule);
      if (frame != null) window.cancelAnimationFrame(frame);
    },
  };
}
