// "Allow remote access to conversations and terminal" as seen from a remote view: the viewed machine's
// /api/state says the switch is off (`chat_allow_remote: false`), or one of its conversation or observer
// requests was refused with `remote_chat_disabled`. An older machine without the field shows both tabs and
// lets its own backend decide. The local machine never depends on the switch.
export const REMOTE_ACCESS_REFUSED = 'remote_chat_disabled';
const GATED_TABS = ['chat', 'observer'];

export function createRemoteAccess({
  viewingRemote,
  dashboardState,
  chatTab,
  activeTab,
  openTab,
  onChange = () => {},
  defer = queueMicrotask
}) {
  let refused = false;
  const closed = () => viewingRemote() && (refused || dashboardState()?.chat_allow_remote === false);
  // Hides the conversation tab (the observer entry follows `closed` through onChange) and leaves either for the overview.
  function sync() {
    const hide = closed();
    const tab = chatTab();
    if (tab && tab.hidden !== hide) tab.hidden = hide;
    onChange();
    if (hide && GATED_TABS.includes(activeTab())) openTab('overview');
  }
  // A refusal seen on a request; deferred, since it may be reported from inside the conversation page's own redraw.
  function refuse() {
    if (!viewingRemote() || refused) return;
    refused = true;
    defer(sync);
  }
  return {
    closed,
    // Whether a requested tab must give way to the overview.
    blocks: name => GATED_TABS.includes(name) && closed(),
    refuse,
    // Reports whether an error code is the refusal, noting it if so.
    noteError(code) {
      if (code !== REMOTE_ACCESS_REFUSED) return false;
      refuse();
      return true;
    },
    // A state read or pushed after a refusal, with the switch on, means remote access was turned back on.
    noteState(data) {
      if (data?.chat_allow_remote === true) refused = false;
    },
    // Switching machines forgets a refusal.
    reset() { refused = false; },
    sync
  };
}
