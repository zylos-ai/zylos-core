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

export function watchHeader({ header, document = header?.ownerDocument, window = globalThis.window } = {}) {
  if (!header) return { fit: () => false, destroy() {} };
  let frame = null;
  const fit = () => fitHeader(header, document.documentElement);
  const schedule = () => {
    if (frame != null) return;
    frame = window.requestAnimationFrame(() => { frame = null; fit(); });
  };
  // Labels change with locale, the machine name arrives late and the technical switch adds the observer tab.
  const mutations = window.MutationObserver ? new window.MutationObserver(schedule) : null;
  mutations?.observe(header, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden'] });
  mutations?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-detail', 'lang'] });
  window.addEventListener('resize', schedule);
  document.addEventListener('dashboard-locale-change', schedule);
  document.fonts?.ready?.then(schedule);
  fit();
  return {
    fit,
    destroy() {
      mutations?.disconnect();
      window.removeEventListener('resize', schedule);
      document.removeEventListener('dashboard-locale-change', schedule);
      if (frame != null) window.cancelAnimationFrame(frame);
    },
  };
}
