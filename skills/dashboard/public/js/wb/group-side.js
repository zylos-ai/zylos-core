import { createGroupDetail } from './detail.js?v=167';
import { boardController } from './board.js?v=153';
import { element, icon } from './plain-text.js?v=106';

/**
 * The overview's group detail, opened as a side panel on another page. It is the same component; the panel reads
 * the group list itself (the overview's snapshot endpoint, refreshed like the board), so it works when the
 * overview has never been opened. Esc closes it; the caller decides where the focus goes back to, and hides it
 * through `onClose({ hide })` so that it can keep the page's reading position across the layout change.
 */
export function createGroupSide({ document, t = key => key, fetch = globalThis.fetch, endpoint = path => path,
  identity = () => '', writable = () => true, detail = () => 'plain', isVisible = () => true,
  onMemory = () => {}, onObserve = () => {}, observable = () => false, onConversation, onClose = ({ hide }) => hide(),
  setTimer = setInterval, clearTimer = clearInterval } = {}) {
  const aside = element(document, 'aside', undefined, 'wb-group-side');
  aside.hidden = true;
  aside.tabIndex = -1;
  const bar = element(document, 'div', undefined, 'wb-group-side-bar');
  const back = element(document, 'button', undefined, 'wb-icon-btn wb-group-side-back');
  back.type = 'button';
  back.append(icon(document, 'back'));
  back.addEventListener('click', () => close());
  const mobileTitle = element(document, 'span', t('wb.detail.title'), 'wb-group-side-mobile-title');
  bar.append(back, mobileTitle);
  const body = element(document, 'div', undefined, 'wb-group-side-detail');
  aside.append(bar, body);
  let key = null, snapshot = null, timer = null, opening = false, restoreFocus = true, generation = 0, stopped = false, initialTab = 'overview';
  const visible = () => !stopped && !aside.hidden && isVisible();
  const read = async path => {
    const response = await fetch(endpoint(path));
    if (!response.ok) throw Error('read_failed');
    return response.json();
  };
  const groupDetail = createGroupDetail({ root: body, document, t,
    fetch: (path, options) => fetch(endpoint(path), options), identity, writable, detail, isVisible: visible,
    onMemory, onObserve, observable, onConversation, showLastReceived: false, onClose: closed });
  const controller = boardController({ visible,
    fetchSnapshot: async () => ({ snapshot: await read('/api/workbench/groups') }),
    onSnapshot: value => {
      snapshot = value.snapshot;
      if (!groupDetail.state.row) return;
      // The detail opens before the first read (or after one that failed) without the list; once the list arrives,
      // show the listed row, or the group as not running when the list is known and it is not on it.
      const listed = snapshot.rows?.some(row => row.sessionGroup === key);
      const firstKnown = snapshot.listKnown && !groupDetail.state.snapshot?.listKnown;
      if (groupDetail.state.historical && (listed || firstKnown)) void openDetail();
      else void groupDetail.updateSnapshot(snapshot);
    },
    onError: () => {},
  });
  function label() {
    aside.setAttribute('aria-label', t('wb.detail.title'));
    back.setAttribute('aria-label', t('chat.page.backToConversation'));
    back.title = t('chat.page.backToConversation');
    mobileTitle.textContent = t('wb.detail.title');
  }
  function openDetail() {
    // Opening first closes the previous selection; that close is not the panel closing.
    opening = true;
    try { return groupDetail.open(key, snapshot ?? { rows: [], listKnown: false }, { tab: initialTab }); } finally { opening = false; }
  }
  function closed() {
    if (opening || aside.hidden) return;
    clearTimer(timer); timer = null;
    controller.invalidate();
    generation++;
    key = null; snapshot = null;
    const focus = restoreFocus;
    restoreFocus = true;
    const hide = () => { aside.hidden = true; };
    onClose({ focus, hide });
    hide();
  }
  /** Closes the panel; `focus: false` when the caller is navigating away rather than the user closing it. */
  function close({ focus = true } = {}) {
    if (aside.hidden) return;
    restoreFocus = focus;
    // Closing the detail closes the panel through its onClose.
    groupDetail.close();
  }
  const keydown = event => {
    if (event.key !== 'Escape' || event.defaultPrevented || !visible()) return;
    event.preventDefault?.();
    // The detail's own Esc leaves its name editor first, then closes the detail and with it the panel.
    if (!groupDetail.escape()) close();
  };
  document.addEventListener('keydown', keydown);
  label();
  return {
    element: aside,
    get open() { return !aside.hidden; },
    get group() { return key; },
    /** Shows the panel synchronously (so a caller can measure the layout around it), then reads the group list. */
    async show(sessionGroup, { tab = 'overview' } = {}) {
      if (stopped) return;
      if (!aside.hidden && key === sessionGroup) {
        initialTab = tab === 'timeline' ? 'timeline' : 'overview';
        await groupDetail.selectTab(initialTab);
        return;
      }
      initialTab = tab === 'timeline' ? 'timeline' : 'overview';
      if (!aside.hidden) close({ focus: false });
      key = sessionGroup;
      const gen = ++generation;
      aside.hidden = false;
      label();
      aside.focus?.();
      // The group shows at once, as after a failed first read, and becomes the listed row when the list arrives.
      const opened = openDetail();
      await controller.refresh();
      if (gen !== generation || stopped) return;
      timer = setTimer(() => { void controller.refresh(); }, 5000);
      await opened;
    },
    close,
    redraw() { label(); groupDetail.setViewDetail(); },
    destroy() {
      close({ focus: false });
      stopped = true;
      groupDetail.destroy();
      document.removeEventListener('keydown', keydown);
    },
  };
}
