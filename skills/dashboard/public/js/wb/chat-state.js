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
  if (receipt.stored === false) return receipt.preserveInput || receipt.error || receipt.deliveryState ? 'not_stored' : null;
  return ['pending', 'running', 'delivered', 'stored', 'auth_rejected', 'suppressed', 'failed', 'switch_absorbed'].includes(receipt.deliveryState)
    ? receipt.deliveryState : 'stored_pending_reconciliation';
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
  const blank = () => ({ conversation: null, ownershipResolved: false, messages: [], messageCursor: null, afterCursor: null, input: '', receipt: null, sending: false, retryRequired: false, error: null, historyVersion: 0,
    questions: [], questionCursor: null, questionsReady: false, questionsLoading: false, questionError: null, questionVersion: 0, questionForms: new Map() });
  const snapshot = () => ({ tab, mode, items: [...items], nextCursor, selectedId, ...(cell() || blank()), loading, error: error || cell()?.error || cell()?.questionError, blocked,
    canRetry: active && !!cell()?.retryRequired && cell()?.receipt?.retryAllowed === true && !cell()?.sending,
    canWrite: active && !blocked && tab === 'mine' && mode === 'multi' && !!selectedId && cell()?.ownershipResolved === true,
    canCreate: active && !blocked && tab === 'mine' && mode === 'multi' });
  const emit = () => { if (!destroyed) for (const listener of listeners) listener(snapshot()); };
  const valid = e => active && !destroyed && epoch === e && !blocked;
  function failure(err, e, target = null) {
    if (!valid(e)) return;
    const code = err?.code || err?.payload?.error || err?.message || 'chat_request_failed';
    if (code === 'remote_chat_disabled') {
      epoch++; blocked = true; cells.clear(); items = []; nextCursor = null; selectedId = null; mode = null; loading = false; error = null;
    } else if (target) { target.error = typeof code === 'string' ? code : 'chat_request_failed'; }
    else { error = typeof code === 'string' ? code : 'chat_request_failed'; }
    emit();
  }
  async function run(fn, apply, e = epoch, target = null) {
    if (!valid(e)) return;
    try { const result = await fn(); if (valid(e)) await apply(result); }
    catch (err) { failure(err, e, target); }
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
    selectedId = id; selectedVersion++;
    if (!cells.has(key(id))) cells.set(key(id), blank());
    const current = cell(), currentTab = tab, e = epoch;
    const version = selectedVersion;
    current.error = null;
    current.questionsReady = false;
    current.conversation ||= items.find(item => item.id === id) || null;
    emit();
    if (currentTab === 'mine') {
      current.ownershipResolved = false; emit();
      await run(() => request(pathFor(id)), data => {
        current.conversation = data.conversation; current.ownershipResolved = !!data.conversation; current.receipt = data;
        current.retryRequired = data.stored === null;
        if (data.preserveInput && data.stored !== true && !current.input && data.conversation?.pendingContent) current.input = data.conversation.pendingContent;
        current.error = data.error || null;
        if (data.conversationId && data.conversationId !== id) {
          cells.set(`${currentTab}:${data.conversationId}`, current);
          if (version === selectedVersion && selectedId === id) selectedId = data.conversationId;
          id = data.conversationId;
        }
        emit();
      }, e, current);
    }
    if (!valid(e) || version !== selectedVersion || currentTab !== tab || id.startsWith('d:')) return;
    await Promise.all([history(current, id, currentTab, 'initial', e), questions(current, id, currentTab, false, e)]);
  }
  async function questions(current, id, currentTab, more = false, e = epoch) {
    if (currentTab !== 'mine' || id.startsWith('d:') || !valid(e) || (more && !current.questionCursor)) return;
    const version = ++current.questionVersion, cursor = more ? current.questionCursor : null, queryError = { error: null };
    current.questionsLoading = true; current.questionError = null;
    if (!more) current.questionsReady = false;
    emit();
    await run(async () => {
      try { return await request(`${pathFor(id)}/questions?${query({ limit: 50, cursor })}`); }
      catch (err) {
        if (version === current.questionVersion || err?.code === 'remote_chat_disabled' || err?.payload?.error === 'remote_chat_disabled') throw err;
        return null;
      }
    }, data => {
      if (version !== current.questionVersion) return;
      if (!Array.isArray(data?.items)) throw { code: 'chat_invalid_response' };
      const rows = new Map((more ? current.questions : []).map(row => [row.interrupt_id, row]));
      for (const row of data.items) rows.set(row.interrupt_id, row);
      current.questions = [...rows.values()]; current.questionCursor = data.nextCursor ?? null;
      current.questionsReady = true;
      for (const row of current.questions) {
        const formKey = `${row.c4_id}:${row.interrupt_id}`;
        if (!current.questionForms.has(formKey) && row.status === 'answered' && row.action?.id === row.answer_id && !row.actionError) current.questionForms.set(formKey, {});
        const form = current.questionForms.get(formKey);
        if (form && !form.sending) {
          form.receipt = row.delivery ?? null;
          // Restore only the server's saved action, never reconstruct an intent
          // from displayed text or labels after a page reload.
          if (row.status === 'answered' && row.action?.id === row.answer_id && !row.actionError) {
            form.action = JSON.parse(JSON.stringify(row.action)); form.locked = true;
          } else if (row.answer_id && (form.action?.id !== row.answer_id || row.actionError)) form.action = null;
        }
      }
      emit();
    }, e, queryError);
    if (valid(e) && version === current.questionVersion) { current.questionsLoading = false; current.questionError = queryError.error; emit(); }
  }
  async function answer(interruptId, action, { retry = false, conversationId = selectedId, questionC4Id } = {}) {
    const current = cell(), s = snapshot();
    if (!s.canWrite || conversationId !== selectedId || !current?.questionsReady || current.questionsLoading) return;
    const question = current.questions.find(row => row.interrupt_id === interruptId);
    if (!question || (questionC4Id !== undefined && String(question.c4_id) !== String(questionC4Id))) return;
    const formKey = `${question.c4_id}:${interruptId}`;
    const form = current.questionForms.get(formKey);
    if (!form || form.sending || (form.locked && !retry) || !action || (question.status !== 'paused' &&
        !(question.status === 'answered' && retry && question.answer_id === action.id))) return;
    if (retry && (question.status !== 'answered' || form.action?.id !== action.id || form.receipt?.retryAllowed !== true)) return;
    if (!retry && question.status !== 'paused') return;
    const e = epoch, id = selectedId, sendIdentity = openedIdentity;
    const submitted = JSON.parse(JSON.stringify(action));
    // Freeze the accepted intent across network errors and explicit retries.
    if (form.action && JSON.stringify(form.action) !== JSON.stringify(submitted)) return;
    form.action = submitted; form.sending = true; form.error = null; current.error = null;
    current.questionVersion++; current.questionsLoading = false; emit();
    try {
      const result = await request(`${pathFor(id)}/answers`, { method: 'POST', body: { interruptId, action: submitted, ...(retry ? { retry: true } : {}) } });
      if (!result?.answer || !result?.delivery || result.answer.answerId !== submitted.id || ![true, false, null].includes(result.delivery.stored)) throw { code: 'chat_invalid_response' };
      if (destroyed || blocked || sendIdentity !== openedIdentity) return;
      form.receipt = result.delivery; form.error = result.delivery.error ?? null;
      form.locked = true;
      current.questionVersion++; current.questionsLoading = false;
      current.questionsReady = true;
      current.questions = current.questions.map(row => String(row.c4_id) === String(question.c4_id) && row.interrupt_id === interruptId ? { ...row, status: 'answered', answer_id: result.answer.answerId, delivery: result.delivery } : row);
    } catch (err) {
      if (sendIdentity !== openedIdentity || blocked || destroyed) return;
      if (err?.code === 'remote_chat_disabled' || err?.payload?.error === 'remote_chat_disabled') { failure(err, e); return; }
      form.error = err?.code || err?.payload?.error || 'chat_request_failed';
      // The server may have accepted before a response was lost. A manual
      // question refresh must establish authority before another submission.
      if ([400, 422].includes(err?.status)) { form.action = null; form.locked = false; form.receipt = null; }
      else { form.receipt = { stored: null, needsReconciliation: true, retryAllowed: false }; form.locked = true; current.questionsReady = false; }
    } finally { form.sending = false; if (active && sendIdentity === openedIdentity && !blocked) emit(); }
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
    }, e, current);
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
    }, epoch, current);
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
        await run(() => request(pathFor(canonical)), data => { current.conversation = data.conversation; emit(); }, e, current);
        if (!valid(e) || tab !== currentTab) return;
        await list();
        if (!valid(e) || tab !== currentTab) return;
        if (!canonical.startsWith('d:')) await history(current, canonical, currentTab, 'initial', e);
      }
    } catch (err) {
      if (valid(e) && err?.payload?.conversationId && err.payload.preserveInput) {
        const canonical = err.payload.conversationId;
        current.receipt = null; current.retryRequired = false;
        cells.set(`${currentTab}:${canonical}`, current);
        if (selectedId === id && tab === currentTab) selectedId = canonical;
        const navigation = selectedVersion;
        await run(() => request(pathFor(canonical)), data => { current.conversation = data.conversation; current.ownershipResolved = !!data.conversation; emit(); }, e, current);
        if (valid(e) && tab === currentTab && selectedVersion === navigation) {
          await list();
          if (valid(e) && tab === currentTab && selectedVersion === navigation) await history(current, canonical, currentTab, 'initial', e);
        }
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
    select, createDraft, rename, send, refresh, answer,
    loadMoreQuestions() { return cell() && questions(cell(), selectedId, tab, true); },
    refreshQuestions() { return cell() && questions(cell(), selectedId, tab); },
    setInput(value) { if (cell()) { cell().input = value; emit(); } },
    loadMore: () => list(true),
    loadOlder() { return cell() && history(cell(), selectedId, tab, 'before'); },
    refreshMessages() { return cell() && Promise.all([history(cell(), selectedId, tab, 'after'), questions(cell(), selectedId, tab)]); },
    async refreshStatus() {
      const current = cell(), id = selectedId;
      if (!current || blocked) return;
      const e = epoch, currentTab = tab;
      if (tab === 'mine') { current.ownershipResolved = false; emit(); await run(() => request(pathFor(id)), data => {
        current.receipt = data; current.conversation = data.conversation; current.ownershipResolved = !!data.conversation;
        current.retryRequired = data.stored === null; emit();
      }, e, current); }
      if (!valid(e)) return;
      const ids = current.messages.slice(-100).map(row => row.id).join(',');
      if (ids) await run(() => request(`${pathFor(id)}/status?${query({ tab: currentTab, ids })}`), data => { const updates = new Map((data.items || []).map(row => [row.id, row])); current.messages = current.messages.map(row => ({ ...row, ...updates.get(row.id) })); emit(); }, e, current);
      if (valid(e)) await questions(current, id, currentTab, false, e);
    },
  };
}
