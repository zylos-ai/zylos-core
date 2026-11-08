import { parseC4Content, evaluateFormState } from '../../chat-schema.js?v=102';
import { messageState } from './chat-delivery-state.js?v=100';
import { asDate } from './conversation-time.js?v=99';
const merge = (old, rows) => [...new Map([...old, ...rows].map(row => [row.id, row])).values()];
const base = '/api/chat/conversations';
const pathFor = id => `${base}/${encodeURIComponent(id)}`;
const query = values => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== null && v !== undefined)).toString();
export function createConversationState({
  request,
  identity = null,
  draftStore = null,
  draftScope = () => null,
  onChange,
  t = key => key,
  document = globalThis.document,
  setTimeout: delay = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout,
  now = Date.now
} = {}) {
  let openedIdentity,
    active = false,
    destroyed = false,
    epoch = 0,
    listVersion = 0,
    selectedVersion = 0,
    refreshVersion = 0;
  let timer = null,
    polling = null,
    updateError = null,
    retryDelay = 5000,
    fastUntil = 0,
    lastListAt = 0,
    listDepth = 1;
  let tab = 'mine',
    mode = null,
    items = [],
    nextCursor = null,
    selectedId = null,
    blocked = false,
    error = null,
    loading = false,
    creatingDraft = false;
  let groupPresenceRead = null;
  const cells = new Map(),
    listeners = new Set(onChange ? [onChange] : []);
  const key = id => `${tab}:${id}`;
  const cell = () => cells.get(key(selectedId));
  const blank = () => ({
    groupPresence: null,
    groupHealth: null,
    groupPresenceReadAt: null,
    groupPresenceVersion: 0,
    conversation: null,
    ownershipResolved: false,
    messages: [],
    messageCursor: null,
    afterCursor: null,
    input: '',
    receipt: null,
    sending: false,
    retryRequired: false,
    error: null,
    historyVersion: 0,
    gap: null,
    recoveryOlder: false,
    syncing: null,
    pendingQuestionRefresh: false,
    questions: [],
    questionCursor: null,
    questionPages: new Map(),
    questionPageCursors: [null],
    questionsReady: false,
    questionsLoading: false,
    questionError: null,
    questionVersion: 0,
    questionForms: new Map()
  });
  const snapshot = () => ({
    tab,
    mode,
    items: [...items],
    nextCursor,
    selectedId,
    ...(cell() || blank()),
    loading,
    error: error || cell()?.error,
    blocked,
    updateError,
    creatingDraft,
    canRetry: active && !!cell()?.retryRequired && cell()?.receipt?.retryAllowed === true && !cell()?.sending,
    canWrite: active && !blocked && tab === 'mine' && mode === 'multi' && !!selectedId && cell()?.ownershipResolved === true,
    canCreate: active && !blocked && tab === 'mine' && mode === 'multi'
  });
  const emit = () => {
    if (!destroyed) for (const listener of listeners) listener(snapshot());
  };
  const identityValue = () => typeof identity === 'function' ? identity() : identity;
  const valid = e => active && !destroyed && epoch === e && !blocked && identityValue() === openedIdentity;
  const visible = () => document?.visibilityState !== 'hidden' && document?.hidden !== true;
  const stopTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };
  function schedule(wait) {
    stopTimer();
    if (!active || destroyed || blocked || !visible()) return;
    const current = cell(),
      hasHistory = current?.afterCursor && !selectedId?.startsWith('d:');
    const interval = hasHistory ? fastUntil > now() ? 2000 : 5000 : 30000;
    const listWait = Math.max(0, lastListAt + 30000 - now());
    timer = delay(() => {
      timer = null;
      void poll();
    }, wait ?? Math.min(interval, listWait));
    timer?.unref?.();
  }
  const accelerate = () => {
    fastUntil = now() + 120000;
    schedule(2000);
  };
  const preview = content => {
    const parsed = parseC4Content(content);
    return parsed.kind === 'text' ? parsed.text : parsed.kind === 'envelope' ? parsed.envelope.fallbackText : t('chat.invalidContent');
  };
  function updateCurrentItem(current, id) {
    const latest = current.messages.at(-1);
    if (!latest) return;
    const timestamp = asDate(latest.timestamp);
    const stamp = timestamp ? timestamp.getTime() / 86400000 + 2440587.5 : null;
    items = items.map(row => row.id === id ? {
      ...row,
      previewDirection: latest.direction,
      preview: typeof latest.preview === 'string' ? latest.preview : Array.from(preview(latest.content)).slice(0, 160).join(''),
      ...(stamp === null ? {} : {
        stamp
      })
    } : row).sort((a, b) => Number(b.stamp || 0) - Number(a.stamp || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  async function poll() {
    if (polling) return polling;
    if (!valid(epoch) || !visible()) return;
    const e = epoch;
    polling = (async () => {
      try {
        if (now() - lastListAt >= 30000) await list(false, true);
        if (!valid(e) || !visible()) return;
        const current = cell(),
          id = selectedId,
          currentTab = tab;
        if (current?.afterCursor && !id.startsWith('d:')) await syncCurrent(current, id, currentTab, e);
        if (valid(e)) {
          updateError = null;
          retryDelay = 5000;
          emit();
        }
      } catch (err) {
        if (!valid(e)) return;
        if ((err?.code || err?.payload?.error) === 'remote_chat_disabled') {
          failure(err, e);
        } else {
          updateError = err?.code || 'chat_request_failed';
          emit();
        }
      } finally {
        polling = null;
        if (valid(epoch)) {
          if (updateError) {
            const wait = retryDelay;
            retryDelay = Math.min(60000, retryDelay * 2);
            schedule(wait);
          } else schedule();
        }
      }
    })();
    return polling;
  }
  const visibilityChanged = () => {
    stopTimer();
    if (visible()) void poll();
  };
  document?.addEventListener?.('visibilitychange', visibilityChanged);
  function failure(err, e, target = null) {
    if (!valid(e)) return;
    const code = err?.code || err?.payload?.error || err?.message || 'chat_request_failed';
    if (code === 'remote_chat_disabled') {
      stopTimer();
      cancelGroupPresenceRead();
      updateError = null;
      epoch++;
      blocked = true;
      cells.clear();
      items = [];
      nextCursor = null;
      selectedId = null;
      mode = null;
      loading = false;
      error = null;
    } else if (target) {
      target.error = typeof code === 'string' ? code : 'chat_request_failed';
    } else {
      error = typeof code === 'string' ? code : 'chat_request_failed';
    }
    emit();
  }
  async function run(fn, apply, e = epoch, target = null) {
    if (!valid(e)) return;
    try {
      const result = await fn();
      if (valid(e)) await apply(result);
    } catch (err) {
      failure(err, e, target);
    }
  }
  async function list(more = false, quiet = false) {
    if (!active || blocked || more && !nextCursor) return;
    const e = epoch,
      version = ++listVersion,
      currentTab = tab,
      cursor = more ? nextCursor : null;
    if (!quiet) {
      loading = true;
      error = null;
      emit();
    }
    try {
      const data = await request(`${base}?${query({
        tab: currentTab,
        limit: 50,
        cursor
      })}`, { headers: { 'X-Zylos-Locale': document?.documentElement?.lang?.startsWith('en') ? 'en' : 'zh' } });
      if (!valid(e) || version !== listVersion || currentTab !== tab) return;
      if (!Array.isArray(data?.items)) throw {
        code: 'chat_invalid_response'
      };
      items = more || quiet ? merge(items, data.items) : data.items;
      items.sort((a, b) => Number(b.stamp || 0) - Number(a.stamp || 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (more) listDepth++;
      if (!quiet || listDepth === 1) nextCursor = data.nextCursor ?? null;
      if (!more) lastListAt = now();
      if (quiet && !more && cell()) readGroupPresence(cell(), currentTab, e);
      emit();
    } catch (err) {
      if (quiet) throw err;
      failure(err, e);
    } finally {
      if (valid(e) && version === listVersion && !quiet) {
        loading = false;
        emit();
      }
    }
  }
  async function select(id, fallbackMetadata) {
    if (!active || blocked) return;
    cancelGroupPresenceRead();
    selectedId = id;
    selectedVersion++;
    if (!cells.has(key(id))) cells.set(key(id), blank());
    const current = cell(),
      currentTab = tab,
      e = epoch;
    const version = selectedVersion;
    current.error = null;
    current.conversation ||= items.find(item => item.id === id)
      || (fallbackMetadata?.id === id ? {
        id, session_group: fallbackMetadata.session_group, channel: fallbackMetadata.channel,
      } : null);
    current.groupPresence = null;
    current.groupHealth = null;
    current.groupPresenceReadAt = null;
    emit();
    if (currentTab === 'mine') {
      current.ownershipResolved = false;
      emit();
      await run(() => request(pathFor(id)), data => {
        current.conversation = data.conversation;
        current.ownershipResolved = !!data.conversation;
        current.receipt = data;
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
    readGroupPresence(current, currentTab, e);
    await Promise.all([history(current, id, currentTab, 'initial', e), questions(current, id, currentTab, false, e)]);
  }
  function questionDraftScope(id, row) {
    const block = row?.constraints?.block, scope = draftScope();
    if (!scope || !id || typeof row?.messageId !== 'string' || block?.type !== 'form_intent'
      || typeof block.id !== 'string' || ![1, 2].includes(block.schemaVersion)) return null;
    return { ...scope, conversationId: id, messageId: row.messageId, blockId: block.id, schemaVersion: block.schemaVersion };
  }
  function clearQuestionDraft(id, row, form, { preserveVisible = false } = {}) {
    const scope = form?.draftScope || questionDraftScope(id, row);
    if (scope) draftStore?.remove(scope);
    if (form) {
      if (preserveVisible) {
        const block = row?.constraints?.block;
        if (block?.type === 'form_intent' && block.schemaVersion === 2) {
          const active = new Set(evaluateFormState(block.data?.fields, form.values || {}).activeKeys);
          form.values = Object.fromEntries(Object.entries(form.values || {}).filter(([key]) => active.has(key)));
        }
      } else { form.values = {}; form.freeText = ''; }
      form.fieldErrors = []; form.formError = null;
      form.draftStatus = null; form.draftCleared = true;
    }
  }
  function applyQuestions(current, rows, cursor, id) {
    const existing = new Map(current.questions.map(row => [row.interruptId, row]));
    for (const row of rows) {
      existing.set(row.interruptId, row);
      current.questionPages.set(row.interruptId, cursor);
      const formKey = `${row.c4Id}:${row.interruptId}`;
      if (!current.questionForms.has(formKey) && row.status === 'answered' && row.action?.id === row.answerId && !row.actionError) current.questionForms.set(formKey, {});
      const form = current.questionForms.get(formKey);
      if (row.status !== 'paused') clearQuestionDraft(id, row, form, { preserveVisible: true });
      if (form && !form.sending) {
        const reconciling = form.receipt?.needsReconciliation === true;
        form.receipt = row.delivery ?? null;
        if (!form.authCleared && reconciling && row.status === 'paused' && !row.answerId) {
          if (form.locked) form.error = null;
          form.locked = false;
        }
        if (row.status === 'answered' && row.action?.id === row.answerId && !row.actionError) {
          form.action = JSON.parse(JSON.stringify(row.action));
          form.locked = true;
        } else if (row.answerId && (form.action?.id !== row.answerId || row.actionError)) form.action = null;
      }
    }
    current.questions = [...existing.values()];
    current.questionsReady = true;
  }
  async function questions(current, id, currentTab, more = false, e = epoch, targetId = null, quiet = false, allPages = false) {
    if (currentTab !== 'mine' || id.startsWith('d:') || !valid(e) || more && !current.questionCursor) return;
    const version = ++current.questionVersion;
    const cursor = targetId ? current.questionPages.get(targetId) ?? null : more ? current.questionCursor : null;
    if (!quiet) {
      current.questionsLoading = true;
      current.questionError = null;
      emit();
    }
    try {
      const pageCount = allPages ? current.questionPageCursors.length : 1;
      const refreshed = [];
      let token = allPages ? null : cursor,
        nextCursor = null;
      for (let page = 0; page < pageCount; page++) {
        const data = await request(`${pathFor(id)}/questions?${query({
          limit: 50,
          cursor: token
        })}`);
        if (!valid(e) || version !== current.questionVersion) return;
        if (!Array.isArray(data?.items)) throw {
          code: 'chat_invalid_response'
        };
        applyQuestions(current, data.items, token, id);
        refreshed.push(token);
        nextCursor = data.nextCursor ?? null;
        if (!allPages) break;
        if (nextCursor === null) break;
        if (refreshed.includes(nextCursor)) throw {
          code: 'chat_invalid_response'
        };
        token = nextCursor;
      }
      if (allPages) {
        current.questionPageCursors = refreshed;
      } else if (!current.questionPageCursors.includes(cursor)) {
        current.questionPageCursors.push(cursor);
      }
      if (!targetId) current.questionCursor = nextCursor;
      current.questionError = null;
      emit();
      return true;
    } catch (err) {
      if (quiet) throw err;
      current.questionError = err?.code || 'chat_request_failed';
      if (err?.code === 'remote_chat_disabled') failure(err, e);
    } finally {
      if (valid(e) && version === current.questionVersion && !quiet) {
        current.questionsLoading = false;
        emit();
      }
    }
  }
  async function answer(interruptId, action, {
    retry = false,
    conversationId = selectedId,
    questionC4Id
  } = {}) {
    const current = cell(),
      s = snapshot();
    if (!s.canWrite || conversationId !== selectedId || !current?.questionsReady) return;
    const question = current.questions.find(row => row.interruptId === interruptId);
    if (!question || question.questionError || questionC4Id !== undefined && String(question.c4Id) !== String(questionC4Id)) return;
    const formKey = `${question.c4Id}:${interruptId}`;
    const form = current.questionForms.get(formKey);
    if (!form || form.authCleared || form.sending || form.locked && !retry || !action || question.status !== 'paused' && !(question.status === 'answered' && retry && question.answerId === action.id)) return;
    if (retry && (question.status !== 'answered' || form.action?.id !== action.id || form.receipt?.retryAllowed !== true)) return;
    const e = epoch,
      id = selectedId,
      currentTab = tab,
      sendIdentity = openedIdentity;
    const submitted = JSON.parse(JSON.stringify(action));
    // Freeze the accepted intent across network errors and explicit retries.
    if (form.action && (retry || form.locked) && JSON.stringify(form.action) !== JSON.stringify(submitted)) return;
    accelerate();
    form.action = submitted;
    form.sending = true;
    form.error = null;
    form.fieldErrors = []; form.formError = null;
    current.error = null;
    current.questionVersion++;
    current.questionsLoading = false;
    emit();
    try {
      const result = await request(`${pathFor(id)}/answers`, {
        method: 'POST',
        body: {
          interruptId,
          action: submitted,
          ...(retry ? {
            retry: true
          } : {})
        }
      });
      if (!result?.answer || !result?.delivery || result.answer.answerId !== submitted.id || ![true, false, null].includes(result.delivery.stored)) throw {
        code: 'chat_invalid_response'
      };
      if (destroyed || blocked || form.authCleared || sendIdentity !== openedIdentity) return;
      clearQuestionDraft(id, question, form);
      form.receipt = result.delivery;
      form.error = result.delivery.error ?? null;
      form.locked = true;
      current.questionVersion++;
      current.questionsLoading = false;
      current.questionsReady = true;
      current.questions = current.questions.map(row => String(row.c4Id) === String(question.c4Id) && row.interruptId === interruptId ? {
        ...row,
        status: 'answered',
        answerId: result.answer.answerId,
        delivery: result.delivery
      } : row);
    } catch (err) {
      if (sendIdentity !== openedIdentity || blocked || destroyed || form.authCleared) return;
      if (err?.code === 'remote_chat_disabled' || err?.payload?.error === 'remote_chat_disabled') {
        failure(err, e);
        return;
      }
      form.error = err?.code || err?.payload?.error || 'chat_request_failed';
      if ([400, 422].includes(err?.status)) {
        // Field errors belong only to this immutable form and its submitted active keys.
        const fields = question.constraints?.block?.data?.fields;
        if (question.constraints?.block?.type === 'form_intent' && question.constraints.block.schemaVersion === 2
          && Array.isArray(fields) && Array.isArray(err?.payload?.fields)) {
          const allowed = new Set(evaluateFormState(fields, submitted.payload?.values || {}).activeKeys);
          form.fieldErrors = err.payload.fields.slice(0, fields.length).filter(item => item
            && allowed.has(item.key)
            && ['required', 'type', 'range', 'inactive', 'unknown'].includes(item.reason))
            .map(({ key, reason }) => ({ key, reason }));
        }

        form.action = null;
        form.locked = false;
        form.receipt = null;
      } else if (err?.status === 409) {
        // A rejected answer is not an unknown delivery. Read the current
        // lifecycle once; other questions keep their own eligibility.
        form.receipt = null;
        form.locked = true;
        form.sending = false;
        await questions(current, id, currentTab, false, e, interruptId);
      } else {
        // Only this intent is uncertain. A later authoritative paused/no-answer
        // read unlocks normal same-intent submission, never a delivery retry.
        form.receipt = {
          stored: null,
          needsReconciliation: true,
          retryAllowed: false
        };
        form.locked = true;
      }
    } finally {
      form.sending = false;
      if (active && sendIdentity === openedIdentity && !blocked) emit();
    }
  }
  async function readPage(current, id, currentTab, direction, cursor, e) {
    if (!valid(e)) return null;
    const unavailable = currentTab === 'mine' && direction === 'after' ? current.messages.filter(row => row.attachments?.some(item => !item.available)) : [];
    let start = unavailable.findIndex(row => row.id > (current.attachmentRecheckAfter ?? 0));
    if (start < 0) start = 0;
    const rechecking = unavailable.slice(start, start + 100);
    const data = await request(`${pathFor(id)}/messages?${query({
      tab: currentTab,
      limit: 50,
      direction,
      cursor,
      ...(rechecking.length ? { recheckIds: rechecking.map(row => row.id).join(',') } : {})
    })}`, { headers: { 'X-Zylos-Locale': document?.documentElement?.lang?.startsWith('en') ? 'en' : 'zh' } });
    if (!valid(e)) return null;
    if (!Array.isArray(data?.items)) throw {
      code: 'chat_invalid_response'
    };
    if (rechecking.length) current.attachmentRecheckAfter = rechecking.at(-1).id;
    return data;
  }
  function applyMessages(current, id, data, trackQuestions = false) {
    const previousNewest = current.messages.at(-1)?.id ?? 0;
    const known = new Set(current.messages.map(row => row.id));
    const added = data.items.filter(row => !known.has(row.id));
    current.messages = merge(current.messages, data.items).sort((a, b) => a.id - b.id);
    const attachmentUpdates = new Map((data.attachmentUpdates || []).map(row => [row.id, row.attachments]));
    current.messages = current.messages.map(row => attachmentUpdates.has(row.id) ? { ...row, attachments: attachmentUpdates.get(row.id) } : row);
    const newer = added.filter(row => row.id > previousNewest);
    if (newer.some(row => row.direction === 'out')) fastUntil = 0;
    if (trackQuestions && newer.length) current.pendingQuestionRefresh = true;
    updateCurrentItem(current, id);
    return added.length;
  }
  async function recoverCursor(current, id, currentTab, e) {
    const oldLatest = current.messages.at(-1)?.id,
      oldIds = new Set(current.messages.map(row => row.id));
    const data = await readPage(current, id, currentTab, 'before', null, e);
    if (!data) return 0;
    const added = applyMessages(current, id, data, currentTab === 'mine');
    current.afterCursor = data.afterCursor ?? null;
    current.messageCursor = data.nextCursor ?? null;
    current.recoveryOlder = true;
    const first = data.items[0]?.id;
    current.gap = oldLatest && first > oldLatest && data.nextCursor && !data.items.some(row => oldIds.has(row.id)) ? {
      afterId: oldLatest,
      beforeId: first,
      cursor: data.nextCursor
    } : null;
    emit();
    return added;
  }
  async function history(current, id, currentTab, direction, e = epoch, quiet = false) {
    let cursor = direction === 'after' ? current.afterCursor : direction === 'before' ? current.messageCursor : null;
    if (direction !== 'initial' && !cursor) return 0;
    const version = ++current.historyVersion;
    try {
      let data;
      try {
        data = await readPage(current, id, currentTab, direction === 'initial' ? 'before' : direction, cursor, e);
      } catch (err) {
        if (err?.code === 'invalid_chat_cursor') return await recoverCursor(current, id, currentTab, e);
        throw err;
      }
      if (!data || version !== current.historyVersion) return 0;
      let added = applyMessages(current, id, data, direction === 'after' && currentTab === 'mine');
      if (direction !== 'after') current.messageCursor = data.nextCursor ?? null;
      if (direction !== 'before') current.afterCursor = data.afterCursor ?? null;
      emit();
      return added;
    } catch (err) {
      if (quiet) throw err;
      failure(err, e, current);
      return 0;
    }
  }
  async function statuses(current, id, currentTab, e) {
    if (currentTab !== 'mine') return;
    const ids = current.messages.filter(row => row.direction === 'in' && ['pending', 'running', 'pending_reconciliation'].includes(messageState(row))).slice(-100).map(row => row.id);
    if (!ids.length) return;
    const data = await request(`${pathFor(id)}/status?${query({
      tab: currentTab,
      ids: ids.join(',')
    })}`);
    if (!valid(e)) return;
    const updates = new Map((data.items || []).map(row => [row.id, row]));
    current.messages = current.messages.map(row => updates.has(row.id) ? {
      ...row,
      ...updates.get(row.id)
    } : row);
    emit();
  }
  function cancelGroupPresenceRead() {
    if (!groupPresenceRead) return;
    const record = groupPresenceRead;
    groupPresenceRead = null;
    record.current.groupPresenceVersion++;
    record.controller.abort();
  }
  function readGroupPresence(current, currentTab, e) {
    const sessionGroup = current.conversation?.sessionGroup ?? current.conversation?.session_group;
    if (currentTab !== 'mine' || typeof sessionGroup !== 'string' || !sessionGroup) {
      current.groupPresence = null;
      current.groupHealth = null;
      current.groupPresenceReadAt = null;
      return;
    }
    // Deduplicate only the selected conversation's optional status request.
    // Navigation must not wait for the old transport to acknowledge its abort.
    // This read never joins message reading or creates a timer.
    if (groupPresenceRead?.current === current) return;
    cancelGroupPresenceRead();
    const version = ++current.groupPresenceVersion, navigation = selectedVersion;
    const record = { current, controller: new AbortController(), promise: null };
    groupPresenceRead = record;
    const stillCurrent = () => valid(e) && navigation === selectedVersion && version === current.groupPresenceVersion;
    record.promise = (async () => {
      try {
        const data = await request('/api/workbench/groups', { signal: record.controller.signal });
        if (!stillCurrent()) return;
        const group = Array.isArray(data?.rows) ? data.rows.find(row => row.sessionGroup === sessionGroup) : null;
        const trusted = data?.listKnown === true && data?.sources?.status?.ok === true;
        current.groupPresence = trusted && group?.presence === 'running' ? true : trusted && group?.presence === 'not_running' ? false : null;
        current.groupHealth = trusted ? data.instance?.runtimeHealth?.[group?.target?.runtime]?.health ?? null : null;
        current.groupPresenceReadAt = trusted && Number.isFinite(data.sources.status.readAt) ? data.sources.status.readAt : null;
      } catch {
        if (!stillCurrent()) return;
        // An unreadable optional source must not leave a stale running marker.
        current.groupPresence = null;
        current.groupHealth = null;
        current.groupPresenceReadAt = null;
      } finally {
        if (groupPresenceRead === record) groupPresenceRead = null;
        if (stillCurrent()) emit();
      }
    })();
  }
  async function syncCurrent(current, id, currentTab, e) {
    if (current.syncing) return current.syncing;
    current.syncing = (async () => {
      await history(current, id, currentTab, 'after', e, true);
      if (!valid(e)) return;
      await statuses(current, id, currentTab, e);
      if (current.pendingQuestionRefresh) {
        const refreshed = await questions(current, id, currentTab, false, e, null, true, true);
        if (refreshed && valid(e)) current.pendingQuestionRefresh = false;
      }
    })();
    try {
      return await current.syncing;
    } finally {
      current.syncing = null;
    }
  }
  async function syncAfterSend(current, id, currentTab, e) {
    try {
      if (current.afterCursor) {
        await syncCurrent(current, id, currentTab, e);
      } else {
        await history(current, id, currentTab, 'initial', e);
        if (valid(e) && currentTab === 'mine') {
          current.pendingQuestionRefresh = true;
          const refreshed = await questions(current, id, currentTab, false, e, null, true, true);
          if (refreshed && valid(e)) current.pendingQuestionRefresh = false;
        }
      }
      if (valid(e)) {
        updateError = null;
        retryDelay = 5000;
      }
    } catch (err) {
      if (!valid(e)) return;
      if (err?.code === 'remote_chat_disabled') {
        failure(err, e);
      } else {
        updateError = err?.code || 'chat_request_failed';
        emit();
        const wait = retryDelay;
        retryDelay = Math.min(60000, retryDelay * 2);
        schedule(wait);
      }
    }
  }
  async function loadGap() {
    const current = cell(),
      id = selectedId,
      currentTab = tab,
      e = epoch,
      navigation = selectedVersion;
    if (!current?.gap) return;
    const stillCurrent = () => valid(e) && navigation === selectedVersion && tab === currentTab && selectedId === id;
    let priorMin = Infinity,
      recovered = false;
    try {
      while (stillCurrent() && current.gap) {
        const gap = current.gap;
        let data;
        try {
          data = await readPage(current, id, currentTab, 'before', gap.cursor, e);
        } catch (err) {
          if (err?.code === 'invalid_chat_cursor' && !recovered) {
            recovered = true;
            await recoverCursor(current, id, currentTab, e);
            priorMin = Infinity;
            continue;
          }
          throw err;
        }
        if (!data || !stillCurrent() || current.gap !== gap) return;
        const min = data.items[0]?.id ?? -Infinity;
        if (data.nextCursor && (!data.items.length || min >= priorMin || data.nextCursor === gap.cursor)) throw {
          code: 'chat_invalid_response'
        };
        priorMin = min;
        applyMessages(current, id, data);
        current.gap = data.items.some(row => row.id <= gap.afterId) || !data.nextCursor ? null : {
          ...gap,
          cursor: data.nextCursor
        };
        emit();
      }
    } catch (err) {
      failure(err, e, current);
    }
  }
  async function loadOlder() {
    const current = cell(),
      id = selectedId,
      currentTab = tab,
      e = epoch;
    if (!current?.messageCursor) return;
    const oldest = current.messages[0]?.id,
      navigation = selectedVersion;
    let priorMin = Infinity,
      recovered = false;
    try {
      while (valid(e) && navigation === selectedVersion && selectedId === id && tab === currentTab && current.messageCursor) {
        const cursor = current.messageCursor;
        let data;
        try {
          data = await readPage(current, id, currentTab, 'before', cursor, e);
        } catch (err) {
          if (err?.code === 'invalid_chat_cursor' && !recovered) {
            recovered = true;
            await recoverCursor(current, id, currentTab, e);
            continue;
          }
          throw err;
        }
        if (!data) return;
        const min = data.items[0]?.id ?? -Infinity;
        if (min >= priorMin && data.nextCursor) throw {
          code: 'chat_invalid_response'
        };
        priorMin = min;
        applyMessages(current, id, data);
        current.messageCursor = data.nextCursor ?? null;
        if (current.gap && (data.items.some(row => row.id <= current.gap.afterId) || !data.nextCursor)) current.gap = null;
        emit();
        if (!current.recoveryOlder || data.items.some(row => row.id < oldest) || !data.nextCursor) {
          current.recoveryOlder = false;
          break;
        }
      }
    } catch (err) {
      failure(err, e, current);
    }
  }
  async function refresh() {
    if (!active) return;
    if (blocked) {
      blocked = false;
      epoch++;
    }
    const e = epoch,
      version = ++refreshVersion;
    listDepth = 1;
    nextCursor = null;
    emit();
    await Promise.all([list(), run(() => request('/api/session-mode'), data => {
      if (version === refreshVersion) {
        const actual = data.data?.sessionMode;
        mode = actual === null ? 'single' : ['single', 'multi'].includes(actual) ? actual : null;
        if (mode === null) error = 'chat_mode_unavailable';
        emit();
      }
    }, e)]);
    if (valid(e) && version === refreshVersion && selectedId) await select(selectedId);
  }
  async function createDraft(displayName) {
    if (!snapshot().canCreate || creatingDraft) return;
    const e = epoch,
      navigation = selectedVersion,
      currentTab = tab;
    creatingDraft = true;
    emit();
    try {
      await run(() => request('/api/chat/drafts', {
        method: 'POST',
        body: displayName === undefined ? {} : {
          displayName
        }
      }), async data => {
        const row = data.conversation;
        if (tab !== currentTab || selectedVersion !== navigation) return;
        await list();
        if (valid(e) && tab === currentTab && selectedVersion === navigation) await select(row.id);
      }, e);
    } finally {
      creatingDraft = false;
      if (valid(e)) emit();
    }
  }
  async function rename(displayName) {
    if (!snapshot().canWrite) return;
    const current = cell(),
      id = selectedId;
    await run(() => request(pathFor(id), {
      method: 'PATCH',
      body: {
        displayName
      }
    }), data => {
      current.conversation = data.conversation;
      items = items.map(row => row.id === id ? {
        ...row,
        display_name: data.conversation.displayName
      } : row);
      emit();
    }, epoch, current);
  }
  async function send({
    retry = false, attachments = []
  } = {}) {
    const current = cell();
    if (!snapshot().canWrite || !current || current.sending || (!current.input.trim() && !attachments.length) || current.retryRequired && (!retry || current.receipt?.retryAllowed !== true)) return;
    const e = epoch,
      id = selectedId,
      currentTab = tab,
      text = current.input,
      attachmentIds = [...attachments];
    let outcome = null;
    accelerate();
    current.sending = true;
    current.error = null;
    error = null;
    emit();
    const sendIdentity = openedIdentity;
    try {
      const result = await request(`${pathFor(id)}/send`, {
        method: 'POST',
        body: {
          content: text,
          ...(attachmentIds.length ? { attachments: attachmentIds } : {}),
          ...(retry ? {
            retry: true
          } : {})
        }
      });
      if (!result || ![true, false, null].includes(result.stored)) throw {
        code: 'chat_invalid_response'
      };
      if (destroyed || sendIdentity !== openedIdentity || blocked) return outcome;
      outcome = result;
      current.receipt = result;
      current.retryRequired = result.stored === null;
      if (!result.preserveInput && result.stored === true && current.input === text) current.input = '';
      if (result.error) current.error = result.error;
      const canonical = result.conversationId || id;
      cells.set(`${currentTab}:${canonical}`, current);
      if (selectedId === id && tab === currentTab) selectedId = canonical;
      if (valid(e)) {
        await run(() => request(pathFor(canonical)), data => {
          current.conversation = data.conversation;
          emit();
        }, e, current);
        if (!valid(e) || tab !== currentTab) return outcome;
        await list();
        if (!valid(e) || tab !== currentTab) return outcome;
        if (!canonical.startsWith('d:')) await syncAfterSend(current, canonical, currentTab, e);
      }
    } catch (err) {
      if (!destroyed && !blocked && sendIdentity === openedIdentity && identityValue() === openedIdentity
        && err?.payload?.conversationId && err.payload.preserveInput) {
        outcome = err.payload;
        const canonical = err.payload.conversationId;
        current.receipt = null;
        current.retryRequired = false;
        cells.set(`${currentTab}:${canonical}`, current);
        if (selectedId === id && tab === currentTab) selectedId = canonical;
        const navigation = selectedVersion;
        await run(() => request(pathFor(canonical)), data => {
          current.conversation = data.conversation;
          current.ownershipResolved = !!data.conversation;
          emit();
        }, e, current);
        if (valid(e) && tab === currentTab && selectedVersion === navigation) {
          await list();
          if (valid(e) && tab === currentTab && selectedVersion === navigation) await syncAfterSend(current, canonical, currentTab, e);
        }
      } else if (sendIdentity === openedIdentity && !blocked) {
        if (!err?.status || err?.code === 'chat_invalid_response') {
          current.retryRequired = true;
          current.receipt = {
            stored: null,
            needsReconciliation: true,
            retryAllowed: false,
            preserveInput: true
          };
        }
      }
      if ((err?.code || err?.payload?.error) === 'remote_chat_disabled') {
        failure(err, e);
      } else if (sendIdentity === openedIdentity && !blocked) {
        current.error = err?.code || err?.payload?.error || err?.message || 'chat_request_failed';
        if (valid(e)) emit();
      }
    } finally {
      current.sending = false;
      if (active && sendIdentity === openedIdentity && !blocked) emit();
    }
    return outcome;
  }
  return {
    snapshot,
    clearDrafts(scope) {
      for (const current of cells.values()) for (const form of current.questionForms.values()) {
        const own = form.draftScope;
        if (own && own.authRoot === scope.authRoot && (!scope.instance || own.instance === scope.instance)) {
          clearQuestionDraft(null, null, form);
          form.locked = true;
          form.authCleared = true;
        }
      }
      emit();
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async open() {
      if (destroyed) return;
      const nextIdentity = identityValue();
      if (active && nextIdentity === openedIdentity) return;
      stopTimer();
      if (nextIdentity !== openedIdentity) {
        cancelGroupPresenceRead();
        openedIdentity = nextIdentity;
        cells.clear();
        items = [];
        nextCursor = null;
        selectedId = null;
        mode = null;
        blocked = false;
        error = null;
        loading = false;
      }
      active = true;
      epoch++;
      updateError = null;
      retryDelay = 5000;
      fastUntil = 0;
      emit();
      await refresh();
      schedule();
    },
    close() {
      cancelGroupPresenceRead();
      active = false;
      epoch++;
      loading = false;
      stopTimer();
    },
    destroy() {
      cancelGroupPresenceRead();
      active = false;
      destroyed = true;
      epoch++;
      stopTimer();
      document?.removeEventListener?.('visibilitychange', visibilityChanged);
      cells.clear();
      listeners.clear();
    },
    async setTab(value) {
      if (!['mine', 'external'].includes(value) || blocked) return;
      cancelGroupPresenceRead();
      tab = value;
      selectedId = null;
      selectedVersion++;
      items = [];
      nextCursor = null;
      listDepth = 1;
      emit();
      await list();
      schedule();
    },
    select: async (id, fallbackMetadata) => {
      stopTimer();
      fastUntil = 0;
      updateError = null;
      retryDelay = 5000;
      await select(id, fallbackMetadata);
      schedule();
    },
    createDraft,
    rename,
    send,
    refresh: async () => {
      await refresh();
      schedule();
    },
    answer,
    loadGap,
    loadMoreQuestions() {
      return cell() && questions(cell(), selectedId, tab, true);
    },
    refreshQuestions() {
      return cell() && questions(cell(), selectedId, tab, false, epoch, null, false, true);
    },
    setInput(value) {
      if (cell()) {
        cell().input = value;
        emit();
      }
    },
    loadMore: () => list(true),
    loadOlder,
    async refreshMessages() {
      if (!cell()?.afterCursor) return;
      try {
        await syncCurrent(cell(), selectedId, tab, epoch);
        updateError = null;
      } catch (err) {
        if (err?.code === 'remote_chat_disabled') {
          failure(err, epoch);
        } else {
          updateError = err?.code || 'chat_request_failed';
          emit();
        }
      }
      schedule();
    },
    async refreshStatus() {
      const current = cell(),
        id = selectedId,
        e = epoch,
        currentTab = tab;
      if (!current || blocked) return;
      if (currentTab === 'mine') await run(() => request(pathFor(id)), data => {
        current.receipt = data;
        current.conversation = data.conversation;
        current.ownershipResolved = !!data.conversation;
        current.retryRequired = data.stored === null;
        emit();
      }, e, current);
      if (!valid(e)) return;
      try {
        await statuses(current, id, currentTab, e);
      } catch (err) {
        failure(err, e, current);
      }
      if (valid(e)) await questions(current, id, currentTab, false, e, null, false, true);
    }
  };
}
