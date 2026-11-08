// Phone settings drawer: the section list slides in from the left over the page.
// Opens from the button at the top of the settings body; closes on a section, the close button, the backdrop,
// Escape or Back. While it is open the rest of the page is inert, so focus and taps stay in the drawer.
// Opening adds one history entry so Back closes the drawer instead of leaving the page; every other way of
// closing removes that entry again. Leaving the phone layout closes it the same way. A removed entry stays on
// the browser's forward side: Forward onto it and Back off it again are the same settings page, never a reload.
export const drawerQuery = '(max-width: 760px)';

export function createSettingsDrawer({ layout, nav, toggle, closeButton, scrim, window = layout?.ownerDocument?.defaultView, query = drawerQuery }) {
  const media = window?.matchMedia?.(query);
  const document = layout?.ownerDocument;
  let open = false, entryUrl = null, popsToIgnore = 0, inerted = [], oldEntryUrl = null;

  const phone = () => Boolean(media?.matches);
  const onEntry = () => Boolean(window?.history?.state?.settingsDrawer);

  // Everything outside the drawer and its backdrop becomes inert: each ancestor's other children, up to the body.
  function setBackground(on) {
    if (!on) { for (const node of inerted) node.inert = false; inerted = []; return; }
    for (let node = nav; node?.parentElement && node !== document?.body; node = node.parentElement) {
      for (const sibling of node.parentElement.children) {
        if (sibling === node || sibling === scrim || sibling.inert) continue;
        sibling.inert = true; inerted.push(sibling);
      }
    }
  }

  function render() {
    layout.classList.toggle('wb-set-drawer-open', open);
    toggle.setAttribute('aria-expanded', String(open));
  }

  function show() {
    if (open || !phone()) return;
    open = true; render(); setBackground(true); oldEntryUrl = null;
    // Standing on an old drawer entry (reached with Forward): that entry becomes this drawer's again.
    try { if (!onEntry()) window.history.pushState({ ...(window.history.state ?? {}), settingsDrawer: true }, '', window.location.href); entryUrl = window.location.href; } catch { entryUrl = null; }
    const sections = [...nav.querySelectorAll('[data-settings-section]')].filter(button => !button.hidden);
    (sections.find(button => button.getAttribute('aria-current') === 'true') ?? sections[0])?.focus();
  }

  // history: 'back' removes the drawer's entry (any close the user makes in the page); 'keep' leaves history
  // alone (Back already removed it, or the caller is about to replace the entry with another page).
  function hide({ history = 'back', focus = true } = {}) {
    if (!open) return;
    open = false; render(); setBackground(false);
    if (history === 'back' && onEntry()) { popsToIgnore++; try { window.history.back(); } catch { popsToIgnore--; } }
    entryUrl = null;
    if (focus && phone()) toggle.focus();
  }

  /** For the page's popstate handler: true when the event only concerned the drawer and the page should stay as it is. */
  function popstate() {
    const leftOldEntry = oldEntryUrl; oldEntryUrl = null;
    if (popsToIgnore) { popsToIgnore--; return true; }
    if (open) {
      const url = entryUrl;
      hide({ history: 'keep' });
      return window.location.href === url;
    }
    const showing = !layout.closest?.('[hidden]');
    // Forward onto an old drawer entry while settings is showing: same page, the drawer stays closed.
    // Arriving on one from another page is ordinary navigation back to settings.
    if (onEntry() && showing) { oldEntryUrl = window.location.href; return true; }
    // Back off that old entry lands on the settings entry it was added over: still the same page, so unsaved
    // edits stay and nothing is read again.
    return leftOldEntry !== null && showing && window.location.href === leftOldEntry;
  }

  /** Before the page switches away from settings: closes the drawer; true when the current entry is the drawer's and should be replaced, not pushed after. */
  function leave() {
    oldEntryUrl = null;
    hide({ history: 'keep', focus: false });
    return onEntry();
  }

  function onKey(event) { if (open && event.key === 'Escape') { event.preventDefault(); hide(); } }
  function onMedia() { if (!phone()) hide({ focus: false }); }

  toggle.addEventListener('click', () => (open ? hide() : show()));
  closeButton.addEventListener('click', () => hide());
  scrim.addEventListener('click', () => hide());
  document?.addEventListener?.('keydown', onKey);
  media?.addEventListener?.('change', onMedia);

  return { open: show, close: hide, popstate, leave, isOpen: () => open };
}
