/** Authoritative C4 row states; operation actions never override a row. */
export function messageState(row) {
  if (!row) return 'pending_reconciliation';
  if (row.direction === 'out') return row.status === 'delivered' ? 'stored' : 'pending_reconciliation';
  if (['pending', 'running', 'delivered', 'switch_absorbed'].includes(row.status)) return row.status;
  if (row.status === 'failed') return ['auth_rejected', 'suppressed'].includes(row.delivery_action) ? row.delivery_action : 'failed';
  return 'pending_reconciliation';
}
export function receiptState(receipt) {
  if (!receipt || receipt.stored === null) return 'pending_reconciliation';
  if (receipt.stored === false) return 'not_stored';
  return ['pending', 'running', 'delivered', 'stored', 'auth_rejected', 'suppressed', 'failed', 'switch_absorbed'].includes(receipt.deliveryState)
    ? receipt.deliveryState : 'pending_reconciliation';
}
const merge = (old, rows) => [...new Map([...old, ...rows].map(row => [row.id, row])).values()];
const base = '/api/chat/conversations';
const pathFor = id => `${base}/${encodeURIComponent(id)}`;
const query = values => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== null && v !== undefined)).toString();

export function createChatState({ request, identity = null, onChange } = {}) {
  let openedIdentity, active = false, destroyed = false, epoch = 0, listVersion = 0, selectedVersion = 0, refreshVersion = 0;
  let tab = 'mine', mode = null, items = [], nextCursor = null, selectedId = null, blocked = false, error = null, loading = false;
  const cells = new Map(), listeners = new Set(onChange ? [onChange] : []);
  const key = id => `${tab}:${id}`;
  const cell = () => cells.get(key(selectedId));
  const blank = () => ({ conversation: null, ownershipResolved: false, messages: [], messageCursor: null, afterCursor: null, input: '', receipt: null, sending: false, retryRequired: false, error: null, historyVersion: 0 });
  const snapshot = () => ({ tab, mode, items: [...items], nextCursor, selectedId, ...(cell() || blank()), loading, error: cell()?.error || error, blocked,
    canRetry: active && !!cell()?.retryRequired && cell()?.receipt?.retryAllowed === true && !cell()?.sending,
    canWrite: active && !blocked && tab === 'mine' && mode === 'multi' && !!selectedId && cell()?.ownershipResolved === true,
    canCreate: active && !blocked && tab === 'mine' && mode === 'multi' });
  const emit = () => { if (!destroyed) for (const listener of listeners) listener(snapshot()); };
  const valid = e => active && !destroyed && epoch === e && !blocked;
  function failure(err, e) {
    if (!valid(e)) return;
    const code = err?.code || err?.payload?.error || err?.message || 'chat_request_failed';
    if (code === 'remote_chat_disabled') {
      epoch++; blocked = true; cells.clear(); items = []; nextCursor = null; selectedId = null; mode = null; loading = false; error = null;
    } else { error = typeof code === 'string' ? code : 'chat_request_failed'; }
    emit();
  }
  async function run(fn, apply, e = epoch) {
    if (!valid(e)) return;
    try { const result = await fn(); if (valid(e)) await apply(result); }
    catch (err) { failure(err, e); }
  }
  async function list(more = false) {
    if (!active || blocked || (more && !nextCursor)) return;
    const e = epoch, version = ++listVersion, currentTab = tab;
    const cursor = more ? nextCursor : null;
    loading = true; error = null; emit();
    await run(() => request(`${base}?${query({ tab: currentTab, limit: 50, cursor })}`), data => {
      if (version !== listVersion || currentTab !== tab) return;
      items = more ? merge(items, data.items || []) : data.items || [];
      nextCursor = data.nextCursor ?? null;
    }, e);
    if (valid(e) && version === listVersion) { loading = false; emit(); }
  }
  async function select(id) {
    if (!active || blocked) return;
    selectedId = id; selectedVersion++; error = null;
    if (!cells.has(key(id))) cells.set(key(id), blank());
    const current = cell(), currentTab = tab, e = epoch;
    const version = selectedVersion;
    current.conversation ||= items.find(item => item.id === id) || null;
    emit();
    if (currentTab === 'mine') {
      current.ownershipResolved = false; emit();
      await run(() => request(pathFor(id)), data => {
        current.conversation = data.conversation; current.ownershipResolved = !!data.conversation; current.receipt = data;
        current.retryRequired = data.stored === null;
        if (current.retryRequired && !current.input && data.conversation?.pendingContent) current.input = data.conversation.pendingContent;
        if (data.conversationId && data.conversationId !== id) {
          cells.set(`${currentTab}:${data.conversationId}`, current);
          if (version === selectedVersion && selectedId === id) selectedId = data.conversationId;
          id = data.conversationId;
        }
        emit();
      }, e);
    }
    if (!valid(e) || version !== selectedVersion || currentTab !== tab || id.startsWith('d:')) return;
    await history(current, id, currentTab, 'initial', e);
  }
  async function history(current, id, currentTab, direction, e = epoch) {
    const cursor = direction === 'after' ? current.afterCursor : direction === 'before' ? current.messageCursor : null;
    if (direction !== 'initial' && !cursor) return;
    const version = ++current.historyVersion;
    await run(() => request(`${pathFor(id)}/messages?${query({ tab: currentTab, limit: 50, direction: direction === 'initial' ? 'before' : direction, cursor })}`), data => {
      if (version !== current.historyVersion) return;
      current.messages = (direction === 'initial' ? data.items || [] : merge(current.messages, data.items || [])).sort((a, b) => a.id - b.id);
      if (direction !== 'after') current.messageCursor = data.nextCursor ?? null;
      if (direction !== 'before') current.afterCursor = data.afterCursor ?? null;
      emit();
    }, e);
  }
  async function refresh() {
    if (!active) return;
    if (blocked) { blocked = false; epoch++; }
    const e = epoch, version = ++refreshVersion;
    nextCursor = null; emit();
    await Promise.all([list(), run(() => request('/api/session-mode'), data => { if (version === refreshVersion) { const actual = data.data?.sessionMode;
        mode = actual === null ? 'single' : ['single', 'multi'].includes(actual) ? actual : null;
        if (mode === null) error = 'chat_mode_unavailable'; emit(); } }, e)]);
    if (valid(e) && version === refreshVersion && selectedId) await select(selectedId);
  }
  async function createDraft(displayName) {
    if (!snapshot().canCreate) return;
    const e = epoch, navigation = selectedVersion, currentTab = tab;
    await run(() => request('/api/chat/drafts', { method: 'POST', body: displayName === undefined ? {} : { displayName } }), async data => {
      const row = data.conversation;
      if (tab !== currentTab || selectedVersion !== navigation) return;
      await list(); if (valid(e) && tab === currentTab && selectedVersion === navigation) await select(row.id);
    }, e);
  }
  async function rename(displayName) {
    if (!snapshot().canWrite) return;
    const current = cell(), id = selectedId;
    await run(() => request(pathFor(id), { method: 'PATCH', body: { displayName } }), data => {
      current.conversation = data.conversation;
      items = items.map(row => row.id === id ? { ...row, display_name: data.conversation.displayName } : row); emit();
    });
  }
  async function send({ retry = false } = {}) {
    const current = cell();
    if (!snapshot().canWrite || !current || current.sending || !current.input.trim() || (current.retryRequired && (!retry || current.receipt?.retryAllowed !== true))) return;
    const e = epoch, id = selectedId, currentTab = tab, text = current.input;
    current.sending = true; current.error = null; error = null; emit();
    const sendIdentity = openedIdentity;
    try {
      const result = await request(`${pathFor(id)}/send`, { method: 'POST', body: { content: text, ...(retry ? { retry: true } : {}) } });
      if (!result || ![true, false, null].includes(result.stored)) throw { code: 'chat_invalid_response' };
      if (destroyed || sendIdentity !== openedIdentity || blocked) return;
      current.receipt = result;
      current.retryRequired = result.stored === null;
      if (!result.preserveInput && result.stored === true && current.input === text) current.input = '';
      if (result.error) current.error = result.error;
      const canonical = result.conversationId || id;
      cells.set(`${currentTab}:${canonical}`, current);
      if (selectedId === id && tab === currentTab) selectedId = canonical;
      if (valid(e)) {
        await run(() => request(pathFor(canonical)), data => { current.conversation = data.conversation; emit(); }, e);
        if (!valid(e) || tab !== currentTab) return;
        await list();
        if (!valid(e) || tab !== currentTab) return;
        if (!canonical.startsWith('d:')) await history(current, canonical, currentTab, 'initial', e);
      }
    } catch (err) {
      if (valid(e) && err?.payload?.conversationId && err.payload.preserveInput) {
        const canonical = err.payload.conversationId;
        cells.set(`${currentTab}:${canonical}`, current);
        if (selectedId === id && tab === currentTab) selectedId = canonical;
      } else if (sendIdentity === openedIdentity && !blocked) {
        if (!err?.status || err?.code === 'chat_invalid_response') { current.retryRequired = true; current.receipt = { stored: null, needsReconciliation: true, retryAllowed: false, preserveInput: true }; }
      }
      if ((err?.code || err?.payload?.error) === 'remote_chat_disabled') failure(err, e);
      else if (sendIdentity === openedIdentity && !blocked) { current.error = err?.code || err?.payload?.error || err?.message || 'chat_request_failed'; if (valid(e)) emit(); }
    } finally { current.sending = false; if (active && sendIdentity === openedIdentity && !blocked) emit(); }
  }
  return {
    snapshot, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async open() {
      if (destroyed) return;
      const nextIdentity = typeof identity === 'function' ? identity() : identity;
      if (nextIdentity !== openedIdentity) {
        openedIdentity = nextIdentity; cells.clear(); items = []; nextCursor = null; selectedId = null; mode = null; blocked = false; error = null; loading = false;
      }
      active = true; epoch++; emit(); await refresh();
    },
    close() { active = false; epoch++; loading = false; },
    destroy() { active = false; destroyed = true; epoch++; cells.clear(); listeners.clear(); },
    async setTab(value) { if (!['mine', 'external'].includes(value) || blocked) return; tab = value; selectedId = null; selectedVersion++; items = []; nextCursor = null; emit(); await list(); },
    select, createDraft, rename, send, refresh,
    setInput(value) { if (cell()) { cell().input = value; emit(); } },
    loadMore: () => list(true),
    loadOlder() { return cell() && history(cell(), selectedId, tab, 'before'); },
    refreshMessages() { return cell() && history(cell(), selectedId, tab, 'after'); },
    async refreshStatus() {
      const current = cell(), id = selectedId;
      if (!current || blocked) return;
      const e = epoch, currentTab = tab;
      if (tab === 'mine') { current.ownershipResolved = false; emit(); await run(() => request(pathFor(id)), data => {
        current.receipt = data; current.conversation = data.conversation; current.ownershipResolved = !!data.conversation;
        current.retryRequired = data.stored === null; emit();
      }); }
      if (!valid(e)) return;
      const ids = current.messages.slice(-100).map(row => row.id).join(',');
      if (ids) await run(() => request(`${pathFor(id)}/status?${query({ tab: currentTab, ids })}`), data => { const updates = new Map((data.items || []).map(row => [row.id, row])); current.messages = current.messages.map(row => ({ ...row, ...updates.get(row.id) })); emit(); }, e);
    },
  };
}
