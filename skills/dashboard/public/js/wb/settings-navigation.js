// A phone section opened from the list borrows one history entry from the settings page.
export function createSettingsNavigation({ layout, select, showList, window = layout.ownerDocument.defaultView }) {
  const media = window?.matchMedia?.('(max-width: 760px)');
  const phone = () => Boolean(media?.matches);
  const onSectionEntry = () => Boolean(window?.history?.state?.settingsSection);
  let pageUrl = null, entryUrl = null;

  function open(section) {
    pageUrl = window?.location?.href;
    entryUrl = null;
    select(section ?? (phone() ? null : 'account'));
  }

  function pick(section) {
    if (phone()) {
      if (!onSectionEntry()) {
        window.history.pushState({ ...window.history.state, settingsSection: true }, '', window.location.href);
      }
      entryUrl = window.location.href;
    }
    select(section, { focus: phone() });
  }

  function backToList() {
    if (!phone()) return false;
    if (onSectionEntry()) window.history.back();
    else showList({ focus: true });
    return true;
  }

  // Both edges of an old section entry belong to the same settings page.
  // Forward onto it leaves the list open and preserves the mounted controls.
  function popstate() {
    const url = window.location.href;
    const samePage = !layout.closest('[hidden]') && url === pageUrl && (entryUrl === url || onSectionEntry());
    entryUrl = samePage && onSectionEntry() ? url : null;
    if (!samePage) return false;
    if (phone()) showList({ focus: true });
    return true;
  }

  function leave() {
    entryUrl = null;
    return onSectionEntry();
  }

  media?.addEventListener('change', () => {
    if (phone() || layout.closest('[hidden]')) return;
    if (onSectionEntry()) window.history.back();
    if (layout.classList.contains('wb-set-list')) select('account');
  });

  return { open, pick, backToList, popstate, leave };
}
