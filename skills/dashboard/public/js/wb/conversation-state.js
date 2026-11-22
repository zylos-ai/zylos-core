import { instantMs, conversationStampMs, activityTimes } from './api-time.js';
import { parseC4Content, evaluateFormState } from '../../chat-schema.js';
import { messageState } from './chat-delivery-state.js';
import { asDate } from './conversation-time.js';
import { normalizeChatSubscription, chatSubscriptionKey, matchesChatEvent } from './conversation-push.js';
import { answerDisplay } from './chat-answer.js';
import { composeContent, storedContent, contentBytes, MAX_ANNOTATIONS, MAX_CONTENT_BYTES } from './chat-compose-text.js';
const merge = (old, rows) => [...new Map([...old, ...rows].map(row => [row.id, row])).values()];
const base = '/api/conversations';
const pathFor = id => `${base}/${encodeURIComponent(id)}`;
/** The fixed Origin conversation: group `origin` encoded like every other group ID. */
export const ORIGIN_CONVERSATION_ID = 'g:6F726967696E';
export const isOriginConversation = id => id === ORIGIN_CONVERSATION_ID;
const sortTime = row => conversationStampMs(row.stamp) || 0;
const activityOrder = (a, b) => sortTime(b) - sortTime(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const received = row => row.direction === 'in' && row.channel && !['void', 'control'].includes(row.channel);
export const isOwnChatMessage = row => row.direction === 'in' && row.channel === 'dashboard';
const errorCode = error => error?.code || error?.payload?.error?.code;
const query = values => new URLSearchParams(Object.entries(values).filter(([, v]) => v !== null && v !== undefined)).toString();
export function createConversationState({
  request,
  identity = null,
  draftStore = null,
  draftScope = () => null,
  composeDrafts = null,
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
    listLoadingVersion = 0,
    selectedVersion = 0,
    refreshVersion = 0;
  let timer = null,
    pollAt = null,
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
  let search = '', listLoaded = false, loadingMore = false, savingPins = false, readWrite = null;
  const listUpdates = new Set();
  let groupPresenceRead = null, workingTimer = null, storedWorkingTimer = null;
  let deletionAllowed = false;
  let streamState = 'polling', streamTimer = null, streamScope = null, readDirty = false, retryAt = 0;
  const cells = new Map(),
    listeners = new Set(onChange ? [onChange] : []);
  const key = id => `${tab}:${id}`;
  const cell = () => cells.get(key(selectedId));
  const composeScope = id => {
    const scope = draftScope();
    return scope && typeof id === 'string' && id ? { authRoot: scope.authRoot, instance: scope.instance, conversationId: id } : null;
  };
  /** Stores the conversation's composer draft; when it cannot be stored, it stays in memory and the page says so. */
  function persistCompose(current) {
    const scope = composeScope(current.draftId);
    if (!scope || !composeDrafts) return;
    const result = composeDrafts.save(scope, { text: current.input, quote: current.quote, annotations: current.annotations,
      seq: current.annotationSeq, pending: current.pending });
    current.draftUnsaved = result.saved !== true;
  }
  function restoreCompose(current, id) {
    current.draftId = id;
    const saved = composeDrafts?.load(composeScope(id));
    if (!saved) return;
    current.input = saved.text;
    current.quote = saved.quote;
    current.annotations = saved.annotations;
    current.annotationSeq = saved.seq;
    current.pending = saved.pending;
  }
  /** A draft conversation's first send gives it its canonical id; the draft moves with it. */
  function moveCompose(current, id) {
    if (!current.draftId || current.draftId === id) return;
    const previous = composeScope(current.draftId);
    current.draftId = id;
    if (previous) composeDrafts?.remove(previous);
    persistCompose(current);
  }
  function clearCompose(current) {
    current.input = '';
    current.quote = null;
    current.annotations = [];
    current.pending = null;
    current.draftUnsaved = false;
    const scope = composeScope(current.draftId);
    if (scope) composeDrafts?.remove(scope);
  }
  /**
   * A status read settles a send whose outcome was open: stored clears the draft (unless the request may never have
   * reached the server, when the read describes an earlier message), not stored makes it editable again.
   */
  function settleCompose(current, receipt) {
    if (!current.pending || current.sending || receipt?.stored === null || receipt?.stored === undefined) return;
    if (receipt.stored === true && current.pending.answered) clearCompose(current);
    else { current.pending = null; persistCompose(current); }
  }
  const composeEditable = current => !!current && snapshot().canWrite && !current.sending && !current.pending;
  const blank = () => ({
    groupPresence: null,
    groupWorking: null,
    groupHealth: null,
    groupWait: null,
    groupProcessing: null,
    groupPresenceReadAt: null,
    groupPresenceVersion: 0,
    conversation: null,
    ownershipResolved: false,
    messages: [],
    messageCursor: null,
    historyLoaded: false,
    olderLoading: false,
    olderError: null,
    afterCursor: null,
    readUpTo: 0,
    unreadCount: null,
    unreadDividerId: null,
    timelineRevision: 0,
    positionAtUnread: false,
    input: '',
    // The composer draft besides the text: one quote, the annotations, and the content and quote sent while the
    // outcome is open (the composer is read-only then and a retry sends exactly these).
    quote: null,
    annotations: [],
    annotationSeq: 0,
    pending: null,
    draftId: null,
    draftUnsaved: false,
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
    questionLoadingVersion: 0,
    questionError: null,
    questionVersion: 0,
    questionForms: new Map(),
    // What the AI is doing now (the last read); `offset` turns browser time into server time. `open` holds the
    // subtask rows the user expanded and `details` their steps: only those are read. `unsupported` is set when the
    // instance has no activity route (an older remote), so the page stops asking.
    activity: { data: null, offset: 0, reading: false, unsupported: false, open: new Set(), details: new Map() }
  });
  // The instance time zone (its .env TZ) comes with the list and each message page; an older instance without it
  // reads as unknown.
  let instanceTz = null;
  const readZone = data => { instanceTz = typeof data?.tz === 'string' && data.tz ? data.tz : null; };
  // Origin is the single session itself, so it stays writable in single; other conversations need multi.
  const writable = () => active && !blocked && tab === 'mine' && (mode === 'multi' || isOriginConversation(selectedId))
    && !!selectedId && cell()?.ownershipResolved === true;
  const snapshot = () => ({
    tab,
    mode,
    items: [...items],
    nextCursor,
    search,
    listUpdates: listUpdates.size,
    savingPins,
    selectedId,
    ...(cell() || blank()),
    tz: instanceTz,
    loading,
    error: error || cell()?.error,
    blocked,
    updateError,
    streamState,
    creatingDraft,
    canDelete: active && !blocked && mode === 'multi' && deletionAllowed,
    canRetry: active && !!cell()?.retryRequired && cell()?.receipt?.retryAllowed === true && !cell()?.sending,
    canWrite: writable(),
    // Origin keeps its name in both views.
    canRename: writable() && !isOriginConversation(selectedId),
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
    pollAt = null;
  };
  function schedule(wait) {
    stopTimer();
    if (!active || destroyed || blocked || !visible()) return;
    if (wait === undefined && updateError && retryAt > now()) wait = retryAt - now();
    const current = cell(),
      hasHistory = !!current && !!selectedId && !selectedId.startsWith('d:');
    // Live work, or a message just sent or arrived that the AI has neither started on nor answered: read often.
    const interval = hasHistory && (activityLive(current) || fastUntil > now()) ? 2000
      : streamState === 'live' ? 30000 : hasHistory ? 5000 : 30000;
    const listWait = Math.max(0, lastListAt + 30000 - now());
    const waitMs = wait ?? Math.min(interval, listWait);
    pollAt = now() + waitMs;
    timer = delay(() => {
      timer = null;
      pollAt = null;
      void poll();
    }, waitMs);
    timer?.unref?.();
  }
  // Until a reply arrives (or two minutes pass), even reads that find no work yet keep the fast pace.
  const accelerate = () => {
    fastUntil = now() + 120000;
    schedule(2000);
  };
  const preview = content => {
    const parsed = parseC4Content(content);
    if (parsed.kind === 'envelope' && parsed.envelope.kind === 'answer') return answerDisplay(parsed.envelope).answer;
    return parsed.kind === 'text' ? parsed.text : parsed.kind === 'envelope' ? parsed.envelope.fallbackText : parsed.fallbackText ?? t('chat.invalidContent');
  };
  function noteListUpdate(row, index, currentRows) {
    // Fixed rows never move because of activity unless they are search results.
    if (!search && (row.origin || isOriginConversation(row.id) || Number.isInteger(row.pinOrder))) return;
    if (currentRows.slice(0, index).some(previous => (search
      || !previous.origin && !isOriginConversation(previous.id) && !Number.isInteger(previous.pinOrder))
      && activityOrder(row, previous) < 0)) listUpdates.add(row.id);
  }
  function updateCurrentItem(id, newer) {
    const latest = newer.at(-1);
    if (!latest) return;
    const timestamp = asDate(newer.findLast(received)?.timestamp);
    const stamp = timestamp ? timestamp.getTime() / 86400000 + 2440587.5 : null;
    items = items.map((row, index) => {
      if (row.id !== id) return row;
      const next = {
        ...row,
        previewDirection: latest.direction,
        preview: typeof latest.preview === 'string' ? latest.preview : Array.from(preview(latest.internal?.content ?? latest.content)).slice(0, 160).join(''),
        ...(timestamp && timestamp.getTime() >= sortTime(row) ? { stamp } : {})
      };
      if (sortTime(next) > sortTime(row)) noteListUpdate(next, index, items);
      return next;
    });
  }
  function streamSubscription() {
    if (!valid(epoch)) return null;
    return normalizeChatSubscription({ tab, conversationId: selectedId });
  }
  function clearStreamTimer() {
    if (streamTimer !== null) cancel(streamTimer);
    streamTimer = null;
  }
  function resetStream() {
    clearStreamTimer();
    streamScope = null;
    streamState = 'polling';
  }
  function streamStatus(value, subscription = streamSubscription()) {
    if (!valid(epoch) || chatSubscriptionKey(subscription) !== chatSubscriptionKey(streamSubscription())) return;
    const wasLive = streamState === 'live';
    clearStreamTimer();
    streamScope = chatSubscriptionKey(subscription);
    streamState = value === 'connecting' ? 'connecting' : 'polling';
    if (value === 'connecting') {
      const e = epoch, scope = streamScope;
      streamTimer = delay(() => {
        streamTimer = null;
        if (valid(e) && streamScope === scope && streamState === 'connecting') { streamState = 'polling'; emit(); }
      }, 3000);
      streamTimer?.unref?.();
    }
    emit();
    if (wasLive || timer === null) schedule();
  }
  function streamEvent(name, data, subscription = streamSubscription()) {
    if (!valid(epoch) || !matchesChatEvent(data, subscription)
      || chatSubscriptionKey(subscription) !== chatSubscriptionKey(streamSubscription())) return;
    if (name === 'chat_unavailable') {
      streamStatus('disconnected', subscription);
      return;
    }
    const admitted = name === 'chat_ready' && streamState !== 'live';
    if (name === 'chat_ready') {
      clearStreamTimer();
      streamState = 'live';
      streamScope = chatSubscriptionKey(subscription);
      emit();
    } else if (!['chat_messages_changed', 'chat_delivery_changed'].includes(name)) return;
    void poll({ dirty: true, admitted });
  }
  async function poll({ dirty = false, admitted = false } = {}) {
    const e = epoch, navigation = selectedVersion, scope = streamScope, subscription = chatSubscriptionKey(streamSubscription());
    readDirty ||= dirty;
    while (polling) {
      await polling;
      if (!admitted || !valid(e) || selectedVersion !== navigation || streamScope !== scope || streamState !== 'live') return;
    }
    if (!valid(e)) return;
    if (admitted) retryAt = 0;
    if (!visible()) return;
    if (updateError && retryAt > now()) {
      schedule(retryAt - now());
      return;
    }
    stopTimer();
    let passDirty = false;
    // Install the lock before even an empty pass can finish.
    const task = Promise.resolve().then(async () => {
      try {
        const force = readDirty;
        passDirty = force;
        readDirty = false;
        const refreshMetadata = force || now() - lastListAt >= 30000;
        const listedRows = refreshMetadata ? await list(false, true) : null;
        if (!valid(e) || !visible() || selectedVersion !== navigation) return;
        const current = cell(), currentTab = tab;
        let id = selectedId;
        if (current && currentTab === 'mine' && !current.sending && refreshMetadata) {
          const metadataListVersion = listVersion;
          const metadataRow = items.find(row => row.id === id);
          const data = await request(pathFor(id));
          if (!valid(e) || !visible() || selectedVersion !== navigation) return;
          if (current.retryRequired) {
            current.receipt = data;
            current.retryRequired = data.stored === null;
            settleCompose(current, data);
          }
          const hasName = row => row && (Object.hasOwn(row, 'displayName') || Object.hasOwn(row, 'display_name'));
          const nameOf = row => row.displayName ?? row.display_name ?? null;
          const listed = listedRows?.find(row => row.id === id);
          const latest = items.find(row => row.id === id);
          // This pass's list owns names it returned. A newer list also wins over
          // a detail request that was already in flight. Off-page details are
          // read after the list and may fill that page's cached row only when
          // they explicitly supply a name and no later list has started.
          const listOwnsName = hasName(listed) || listVersion !== metadataListVersion || latest !== metadataRow;
          const detailName = hasName(data.conversation);
          let name;
          if (hasName(latest) && (listOwnsName || !detailName)) name = nameOf(latest);
          else if (detailName) name = nameOf(data.conversation);
          else if (hasName(current.conversation)) name = nameOf(current.conversation);
          current.conversation = data.conversation && { ...data.conversation,
            ...(name !== undefined ? { displayName: name, display_name: name } : {}) };
          current.ownershipResolved = !!data.conversation;
          if (!listOwnsName && detailName) items = items.map(row => row.id === id
            ? { ...row, display_name: name, displayName: name } : row);
          if (data.conversationId && data.conversationId !== id) {
            id = data.conversationId;
            cells.set(`${currentTab}:${id}`, current);
            selectedId = id;
          }
        }
        if (current && id && !id.startsWith('d:')) {
          await syncCurrent(current, id, currentTab, e);
          if (currentTab === 'mine' && current.historyLoaded) {
            await readUnread(current, id, e);
          }
        }
        if (valid(e)) {
          updateError = null;
          retryAt = 0;
          retryDelay = 5000;
          emit();
        }
      } catch (err) {
        if (!valid(e)) return;
        if ((err?.code || err?.payload?.error?.code) === 'remote_chat_disabled') {
          failure(err, e);
        } else {
          updateError = err?.code || 'chat_request_failed';
          readDirty ||= passDirty;
          emit();
        }
      } finally {
        if (polling === task) {
          // A same-conversation refresh can supersede this pass's navigation
          // while metadata is in flight. It did not satisfy the consumed hint:
          // preserve it for the selected subscription's next immediate pass.
          if (valid(e) && selectedVersion !== navigation && subscription === chatSubscriptionKey(streamSubscription())) readDirty ||= passDirty;
          polling = null;
          if (valid(epoch)) {
            if (updateError) {
              const wait = retryDelay;
              retryAt = now() + wait;
              retryDelay = Math.min(60000, retryDelay * 2);
              schedule(wait);
            } else if (readDirty && visible()) schedule(0);
            else schedule();
          }
        }
      }
    });
    polling = task;
    return task;
  }
  const visibilityChanged = () => {
    stopTimer();
    cancelGroupPresenceRead();
    if (visible()) {
      if (cell()) readGroupPresence(cell(), tab, epoch);
      void poll();
    }
  };
  document?.addEventListener?.('visibilitychange', visibilityChanged);
  function blockRemote() {
    if (destroyed || blocked) return;
    stopTimer();
    resetStream();
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
    emit();
  }
  function failure(err, e, target = null) {
    if (!valid(e)) return;
    const code = err?.code || err?.payload?.error?.code || err?.message || 'chat_request_failed';
    if (code === 'remote_chat_disabled') {
      blockRemote();
      return;
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
  const localeHeaders = () => ({ 'X-Zylos-Locale': document?.documentElement?.lang?.startsWith('en') ? 'en' : 'zh' });
  const listPage = (currentTab, q, cursor) => request(`${base}?${query({ tab: currentTab, q: q || null, limit: 50, cursor })}`,
    { headers: localeHeaders() });
  async function list(more = false, quiet = false) {
    if (!active || blocked || quiet && loadingMore || more && (loading || !nextCursor)) return;
    const e = epoch, version = ++listVersion, currentTab = tab, q = search;
    const ownsList = () => valid(e) && version === listVersion && currentTab === tab && q === search;
    if (!quiet) {
      listLoadingVersion = version;
      loadingMore = more;
      loading = true;
      error = null;
      emit();
    }
    try {
      const data = await listPage(currentTab, q, more ? nextCursor : null);
      if (!ownsList()) return;
      if (!Array.isArray(data?.items)) throw { code: 'chat_invalid_response' };
      readZone(data);
      deletionAllowed = data.deletionAllowed === true;
      let rows = data.items;
      if (quiet && listLoaded) {
        // Refresh the pages already shown, while keeping their displayed order
        // and their original scroll frontier. New rows wait behind the notice.
        let cursor = data.nextCursor;
        const seen = new Set();
        for (let depth = 1; depth < listDepth && cursor && !seen.has(cursor); depth++) {
          seen.add(cursor);
          const next = await listPage(currentTab, q, cursor);
          if (!ownsList()) return;
          if (!Array.isArray(next?.items)) throw { code: 'chat_invalid_response' };
          rows = merge(rows, next.items);
          cursor = next.nextCursor;
        }
        const incoming = new Map(rows.map(row => [row.id, row]));
        const previous = items;
        const known = new Set(previous.map(row => row.id));
        items = previous.map(row => {
          const fresh = incoming.get(row.id);
          if (fresh) return fresh;
          if (q || !Number.isInteger(row.pinOrder)) return row;
          const { pinOrder, ...unpinned } = row;
          return unpinned;
        });
        for (const [index, row] of items.entries()) {
          if (sortTime(row) > sortTime(previous[index])) noteListUpdate(row, index, items);
        }
        const isPin = row => Number.isInteger(row.pinOrder);
        if (!q) {
          const oldPins = previous.filter(isPin).map(row => row.id);
          const newPins = rows.filter(isPin);
          if (oldPins.length !== newPins.length || newPins.some((row, index) => row.id !== oldPins[index])) {
            const origin = items.find(row => isOriginConversation(row.id));
            const ordinary = items.filter(row => !isOriginConversation(row.id) && !isPin(row));
            for (const id of oldPins) {
              const index = ordinary.findIndex(row => row.id === id);
              if (index === -1) continue;
              const [unpinned] = ordinary.splice(index, 1);
              const lower = ordinary.findIndex(row => activityOrder(unpinned, row) < 0);
              ordinary.splice(lower < 0 ? ordinary.length : lower, 0, unpinned);
            }
            items = [...(origin ? [origin] : []), ...newPins, ...ordinary];
            for (const row of newPins) listUpdates.delete(row.id);
          }
        }
        const displayed = new Set(items.map(row => row.id));
        for (const row of rows) if (!known.has(row.id) && !displayed.has(row.id)) listUpdates.add(row.id);
      } else if (more) {
        items = merge(items, rows);
        for (const row of rows) listUpdates.delete(row.id);
      } else {
        items = rows;
        listDepth = 1;
        listLoaded = true;
        listUpdates.clear();
      }
      if (currentTab === 'external') for (const row of rows) {
        const cached = cells.get(`external:${row.id}`);
        if (cached?.conversation && Object.hasOwn(row, 'display_name')) cached.conversation = { ...cached.conversation, display_name: row.display_name };
      }
      if (more) listDepth++;
      if (!quiet || !listUpdates.size && listDepth === 1) nextCursor = data.nextCursor ?? null;
      if (!more) lastListAt = now();
      if (quiet && listLoadingVersion && listLoadingVersion < version) {
        listLoadingVersion = 0;
        loading = false;
      }
      emit();
      return rows;
    } catch (err) {
      if (!ownsList()) return;
      if (errorCode(err) === 'invalid_cursor' && (more || quiet)) {
        // A restarted Dashboard no longer accepts this paging position.
        loading = false;
        listDepth = 1;
        nextCursor = null;
        return list();
      }
      if (quiet) throw err;
      failure(err, e);
    } finally {
      if (valid(e) && listLoadingVersion === version && !quiet) {
        listLoadingVersion = 0;
        loadingMore = false;
        loading = false;
        emit();
      }
    }
  }
  async function replacePin(id, beforeId = null, reorder = false) {
    if (!active || blocked || savingPins || isOriginConversation(id) || id.startsWith('d:')) return;
    const e = epoch, currentTab = tab;
    savingPins = true;
    emit();
    try {
      const { items: firstPage } = await listPage(currentTab, '', null);
      if (!valid(e) || currentTab !== tab) return;
      const ids = firstPage.filter(row => Number.isInteger(row.pinOrder)).sort((a, b) => a.pinOrder - b.pinOrder).map(row => row.id);
      if (reorder && (!ids.includes(id) || !ids.includes(beforeId) || id === beforeId)) return;
      const order = ids.filter(value => value !== id);
      if (reorder) order.splice(ids.indexOf(beforeId), 0, id);
      else if (!ids.includes(id)) order.push(id);
      await request(`${base}/pins?${query({ tab: currentTab })}`, { method: 'PUT', body: { ids: order } });
      if (valid(e) && currentTab === tab) await list();
    } catch (err) {
      failure(err, e);
    } finally {
      savingPins = false;
      if (valid(e)) emit();
    }
  }
  async function select(id, fallbackMetadata) {
    if (!active || blocked) return;
    cancelGroupPresenceRead();
    selectedId = id;
    selectedVersion++;
    if (!cells.has(key(id))) {
      cells.set(key(id), blank());
      if (tab === 'mine') restoreCompose(cells.get(key(id)), id);
    }
    const current = cell(),
      currentTab = tab,
      e = epoch;
    const version = selectedVersion;
    current.error = null;
    current.olderError = null;
    current.historyLoaded = false;
    current.unreadDividerId = null;
    current.conversation ||= items.find(item => item.id === id)
      || (fallbackMetadata?.id === id ? {
        id, session_group: fallbackMetadata.session_group, channel: fallbackMetadata.channel,
      } : null);
    current.groupPresence = null;
    current.groupWorking = null;
    current.groupHealth = null;
    current.groupWait = null;
    current.groupProcessing = null;
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
        settleCompose(current, data);
        if (data.preserveInput && data.stored !== true && !current.input && data.conversation?.pendingContent) current.input = data.conversation.pendingContent;
        current.error = data.error || null;
        if (data.conversationId && data.conversationId !== id) {
          cells.set(`${currentTab}:${data.conversationId}`, current);
          moveCompose(current, data.conversationId);
          if (version === selectedVersion && selectedId === id) selectedId = data.conversationId;
          id = data.conversationId;
        }
        emit();
      }, e, current);
    }
    if (!valid(e) || version !== selectedVersion || currentTab !== tab || id.startsWith('d:')) return;
    readGroupPresence(current, currentTab, e);
    await Promise.all([history(current, id, currentTab, 'initial', e, false, currentTab === 'mine'), questions(current, id, currentTab, false, e)]);
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
      current.questionLoadingVersion = version;
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
      if (quiet && current.questionLoadingVersion && current.questionLoadingVersion < version) {
        current.questionLoadingVersion = 0;
        current.questionsLoading = false;
      }
      emit();
      return true;
    } catch (err) {
      if (!valid(e) || version !== current.questionVersion) return;
      if (quiet) throw err;
      current.questionError = err?.code || 'chat_request_failed';
      if (err?.code === 'remote_chat_disabled') failure(err, e);
    } finally {
      if (valid(e) && current.questionLoadingVersion === version && !quiet) {
        current.questionLoadingVersion = 0;
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
      if (err?.code === 'remote_chat_disabled' || err?.payload?.error?.code === 'remote_chat_disabled') {
        failure(err, e);
        return;
      }
      form.error = err?.code || err?.payload?.error?.code || 'chat_request_failed';
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
  async function readPage(current, id, currentTab, direction, cursor, e, anchor = false, limit = 50) {
    if (!valid(e)) return null;
    const unavailable = currentTab === 'mine' && direction === 'after' ? current.messages.filter(row => row.attachments?.some(item => !item.available)) : [];
    let start = unavailable.findIndex(row => row.id > (current.attachmentRecheckAfter ?? 0));
    if (start < 0) start = 0;
    const rechecking = unavailable.slice(start, start + 100);
    const data = await request(`${pathFor(id)}/messages?${query({
      tab: currentTab,
      limit,
      direction,
      cursor,
      anchor: anchor ? 'read' : null,
      ...(rechecking.length ? { recheckIds: rechecking.map(row => row.id).join(',') } : {})
    })}`, { headers: localeHeaders() });
    if (!valid(e)) return null;
    if (!Array.isArray(data?.items)) throw {
      code: 'chat_invalid_response'
    };
    if (rechecking.length) current.attachmentRecheckAfter = rechecking.at(-1).id;
    return data;
  }
  function applyMessages(current, id, data, trackQuestions = false, updatePreview = false) {
    readZone(data);
    const previousNewest = current.messages.at(-1)?.id ?? 0;
    const known = new Set(current.messages.map(row => row.id));
    const added = data.items.filter(row => !known.has(row.id));
    current.messages = merge(current.messages, data.items).sort((a, b) => a.id - b.id);
    const attachmentUpdates = new Map((data.attachmentUpdates || []).map(row => [row.id, row.attachments]));
    current.messages = current.messages.map(row => attachmentUpdates.has(row.id) ? { ...row, attachments: attachmentUpdates.get(row.id) } : row);
    const newer = added.filter(row => row.id > previousNewest);
    // A new user message (sent from another tab too) reads fast like one sent here; a reply ends that.
    const newest = previousNewest ? newer.findLast(row => row.channel !== 'internal') : null;
    if (newer.some(row => row.channel !== 'internal' && row.direction === 'out')) fastUntil = 0;
    if (newest?.direction === 'in') fastUntil = now() + 120000;
    if (trackQuestions && newer.some(row => row.channel !== 'internal')) current.pendingQuestionRefresh = true;
    if (updatePreview) updateCurrentItem(id, newer);
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
    current.historyLoaded = true;
    const first = data.items[0]?.id;
    current.gap = oldLatest && first > oldLatest && data.nextCursor && !data.items.some(row => oldIds.has(row.id)) ? {
      afterId: oldLatest,
      beforeId: first,
      cursor: data.nextCursor
    } : null;
    emit();
    return added;
  }
  function applyUnread(current, id, data) {
    if (!Number.isSafeInteger(data.readUpTo) || data.readUpTo < current.readUpTo) return;
    current.readUpTo = data.readUpTo;
    if (Number.isSafeInteger(data.unreadCount)) {
      current.unreadCount = data.unreadCount;
      items = items.map(row => row.id === id && row.unread !== (data.unreadCount > 0)
        ? { ...row, unread: data.unreadCount > 0 } : row);
    }
  }
  async function readUnread(current, id, e) {
    if (!valid(e) || current !== cell() || id !== selectedId || tab !== 'mine'
        || !Number.isSafeInteger(current.unreadCount)) return;
    const data = await readPage(current, id, 'mine', 'before', null, e, true, 1);
    if (data && current === cell() && id === selectedId && tab === 'mine') {
      applyUnread(current, id, data);
      emit();
    }
  }
  async function markRead(upTo) {
    const current = cell(), id = selectedId, e = epoch;
    if (!active || blocked || tab !== 'mine' || !current?.historyLoaded || !id || id.startsWith('d:')
        || !Number.isSafeInteger(current.unreadCount) || !Number.isSafeInteger(upTo) || upTo <= current.readUpTo || readWrite) return;
    const task = request(`${pathFor(id)}/read`, { method: 'PUT', body: { upTo } });
    readWrite = task;
    try {
      const data = await task;
      if (!valid(e) || !Number.isSafeInteger(data.readUpTo) || data.readUpTo <= current.readUpTo) return;
      const previous = current.readUpTo;
      current.readUpTo = data.readUpTo;
      if (current.unreadCount < 100) {
        const read = current.messages.filter(row => row.id > previous && row.id <= data.readUpTo && !isOwnChatMessage(row)).length;
        current.unreadCount = Math.max(0, current.unreadCount - read);
      }
      await readUnread(current, id, e);
    } catch (err) {
      if (errorCode(err) === 'remote_chat_disabled') failure(err, e);
    } finally {
      readWrite = null;
      if (valid(e)) emit();
    }
  }
  async function jumpToLatest() {
    const current = cell(), id = selectedId, currentTab = tab, e = epoch;
    if (!current?.historyLoaded) return false;
    const version = ++current.historyVersion;
    try {
      const data = await readPage(current, id, currentTab, 'before', null, e);
      if (!data || version !== current.historyVersion || current !== cell() || id !== selectedId || currentTab !== tab) return false;
      current.messages = [];
      current.messageCursor = data.nextCursor ?? null;
      current.afterCursor = data.afterCursor ?? null;
      current.gap = null;
      current.recoveryOlder = false;
      applyMessages(current, id, data);
      current.positionAtUnread = false;
      current.timelineRevision++;
      emit();
      return true;
    } catch (err) {
      failure(err, e, current);
      return false;
    }
  }
  async function history(current, id, currentTab, direction, e = epoch, quiet = false, anchor = false) {
    let cursor = direction === 'after' ? current.afterCursor : direction === 'before' ? current.messageCursor : null;
    if (direction !== 'initial' && !cursor) return 0;
    const version = ++current.historyVersion;
    try {
      let data;
      try {
        data = await readPage(current, id, currentTab, direction === 'initial' ? 'before' : direction, cursor, e, anchor);
      } catch (err) {
        if (errorCode(err) === 'invalid_cursor') return await recoverCursor(current, id, currentTab, e);
        throw err;
      }
      if (!data || version !== current.historyVersion || current !== cell() || id !== selectedId || currentTab !== tab) return 0;
      if (anchor && Number.isSafeInteger(data.readUpTo)) {
        applyUnread(current, id, data);
        current.messages = [];
        current.gap = null;
        current.recoveryOlder = false;
        current.unreadDividerId = current.unreadCount > 0
          ? data.items.find(row => row.id > data.readUpTo && !isOwnChatMessage(row))?.id ?? null : null;
        current.positionAtUnread = true;
        current.timelineRevision++;
      }
      const recent = direction === 'after';
      const added = applyMessages(current, id, data, recent && currentTab === 'mine', recent || !anchor && direction === 'initial');
      if (direction !== 'after') {
        current.messageCursor = data.nextCursor ?? null;
        current.historyLoaded = true;
      }
      if (direction !== 'before') current.afterCursor = data.afterCursor ?? null;
      emit();
      // Newer pages are followed by the poll's own activity read.
      if (direction !== 'after') void readActivity(current, id, currentTab, e);
      return added;
    } catch (err) {
      if (quiet) throw err;
      failure(err, e, current);
      return 0;
    }
  }
  async function statuses(current, id, currentTab, e) {
    if (currentTab !== 'mine') return;
    const ids = current.messages.filter(row => row.channel !== 'internal' && row.direction === 'in' && ['pending', 'running', 'pending_reconciliation'].includes(messageState(row))).slice(-100).map(row => row.id);
    if (!ids.length) return;
    const data = await request(`${pathFor(id)}/status?${query({
      tab: currentTab,
      ids: ids.join(',')
    })}`);
    if (!valid(e) || current !== cell() || id !== selectedId || currentTab !== tab) return;
    const updates = new Map((data.items || []).map(row => [row.id, row]));
    current.messages = current.messages.map(row => updates.has(row.id) ? {
      ...row,
      ...updates.get(row.id)
    } : row);
    emit();
  }
  function cancelGroupPresenceRead() {
    if (workingTimer !== null) cancel(workingTimer);
    if (storedWorkingTimer !== null) cancel(storedWorkingTimer);
    workingTimer = storedWorkingTimer = null;
    if (!groupPresenceRead) return;
    const record = groupPresenceRead;
    groupPresenceRead = null;
    record.current.groupPresenceVersion++;
    record.controller.abort();
  }
  function readGroupPresence(current, currentTab, e) {
    if (!valid(e) || !visible()) return;
    const sessionGroup = current.conversation?.sessionGroup ?? current.conversation?.session_group;
    if (currentTab !== 'mine' || typeof sessionGroup !== 'string' || !sessionGroup) {
      current.groupPresence = null;
      current.groupWorking = null;
      current.groupHealth = null;
      current.groupWait = null;
      current.groupProcessing = null;
      current.groupPresenceReadAt = null;
      return;
    }
    // Deduplicate only the selected conversation's optional status request.
    // Navigation must not wait for the old transport to acknowledge its abort.
    // This optional read has its own cadence and never joins message polling.
    if (groupPresenceRead?.current === current) return;
    cancelGroupPresenceRead();
    const version = ++current.groupPresenceVersion, navigation = selectedVersion;
    const record = { current, controller: new AbortController(), promise: null };
    groupPresenceRead = record;
    const stillCurrent = () => valid(e) && navigation === selectedVersion && version === current.groupPresenceVersion;
    record.promise = (async () => {
      try {
        const data = await request('/api/groups/' + encodeURIComponent(sessionGroup) + '?include=', { signal: record.controller.signal });
        if (!stillCurrent()) return;
        const origin = sessionGroup === 'origin';
        const group = data;
        const instance = await request('/api/instance', { signal: record.controller.signal });
        if (!stillCurrent()) return;
        const trusted = (group?.sessionGroup ?? group?.id) === sessionGroup && group?.state && ['running', 'not_running'].includes(group.presence) && Number.isFinite(instantMs(data.readAt));
        current.groupProcessing = trusted && origin && group?.processing === 'scheduled_task' ? 'scheduled_task' : null;
        applyGroupReading(current, trusted ? { readAt: instantMs(data.readAt), presence: group?.presence ?? null,
          wait: group?.wait ?? null, health: instance?.runtimeHealth?.[group?.target?.runtime]?.health ?? null,
          working: group?.working ?? null } : null);
      } catch {
        if (!stillCurrent()) return;
        // GROUP_NOT_FOUND is normal for a new conversation not yet present in
        // the group snapshot: no reading, and retry on the normal cadence.
        // Other unreadable optional sources also clear a stale running marker.
        current.groupPresence = null;
        current.groupWorking = null;
        current.groupHealth = null;
        current.groupWait = null;
        current.groupProcessing = null;
        current.groupPresenceReadAt = null;
      } finally {
        if (groupPresenceRead === record) groupPresenceRead = null;
        if (stillCurrent()) {
          emit();
          if (visible()) {
            workingTimer = delay(() => { workingTimer = null; readGroupPresence(current, currentTab, e); }, current.groupWorking?.on ? 5000 : 30000);
            workingTimer?.unref?.();
          }
        }
      }
    })();
  }
  /**
   * The header's reading of the group (whether its session runs, why it waits, its runtime's health and whether it
   * works), from the group list or from an activity read, which carries the same snapshot's reading for this group.
   * An older reading than the one shown is ignored; an untrusted one (null) clears it.
   */
  function applyGroupReading(current, reading) {
    if (reading) reading = { ...reading, readAt: instantMs(reading.readAt) };
    if (reading && Number.isFinite(reading.readAt) && Number.isFinite(current.groupPresenceReadAt) && reading.readAt < current.groupPresenceReadAt) return;
    current.groupPresence = reading?.presence === 'running' ? true : reading?.presence === 'not_running' ? false : null;
    current.groupHealth = reading?.health ?? null;
    current.groupWait = reading?.wait ?? null;
    current.groupWorking = reading?.presence === 'running' && typeof reading.working?.on === 'boolean' ? reading.working : null;
    current.groupPresenceReadAt = reading && Number.isFinite(reading.readAt) ? reading.readAt : null;
  }
  /** The live area can change soon: the group works, a user message waits for it or its work settles, or a subtask runs. */
  function activityLive(current) {
    const data = current?.activity?.unsupported ? null : current?.activity?.data;
    return !!data && (data.working?.on === true || ['queued', 'thinking', 'settling'].includes(data.awaiting?.state) || data.subtasks?.length > 0);
  }
  /** Activity is optional: a failed read keeps what is shown and never raises an update error. */
  async function readActivity(current, id, currentTab, e) {
    if (currentTab !== 'mine' || typeof id !== 'string' || !id.startsWith('g:') || current.activity.reading || current.activity.unsupported) return;
    current.activity.reading = true;
    try {
      const data = activityTimes(await request(`${pathFor(id)}/activity?${query({ tab: currentTab })}`));
      if (!valid(e) || !Array.isArray(data?.steps) || !Array.isArray(data?.subtasks)) return;
      if (Number.isFinite(data.now)) current.activity.offset = data.now - now();
      current.activity.data = data;
      // The header follows the same reading at the same pace as the area.
      if (data.header && typeof data.header === 'object') applyGroupReading(current, { ...data.header, working: data.working ?? null });
      const running = new Set(data.subtasks.map(subtask => subtask.id));
      for (const key of [...current.activity.open]) if (!running.has(key)) current.activity.open.delete(key);
      for (const key of [...current.activity.details.keys()]) if (!current.activity.open.has(key)) current.activity.details.delete(key);
      await Promise.all([...current.activity.open].map(key => readSubtask(current, id, key, e)));
      emit();
      // An activity read can discover live work after the stream already chose its slow fallback.
      // Only shorten that outstanding wait; keep an earlier poll or an error's retry deadline.
      if (current === cell() && id === selectedId && currentTab === tab && activityLive(current)
          && pollAt !== null && pollAt > now() + 2000 && !updateError) schedule(2000);
    } catch (err) {
      // Keep the last activity; the next poll asks again, unless this instance has no activity route at all.
      if (err?.code === 'remote_chat_disabled') failure(err, e);
      else if (err?.status === 404 && valid(e)) current.activity.unsupported = true;
    } finally {
      current.activity.reading = false;
    }
  }
  /** One open subtask's steps; a failed read keeps the ones shown. */
  async function readSubtask(current, id, key, e) {
    try {
      const data = activityTimes(await request(`${pathFor(id)}/activity?${query({ tab: 'mine', subtask: key })}`));
      if (valid(e) && current.activity.open.has(key) && Array.isArray(data?.steps)) current.activity.details.set(key, data);
    } catch { /* the next poll asks again */ }
  }
  async function syncCurrent(current, id, currentTab, e) {
    if (current.syncing) return current.syncing;
    current.syncing = (async () => {
      await history(current, id, currentTab, current.afterCursor ? 'after' : 'initial', e, true);
      if (!valid(e) || !visible() || current !== cell() || id !== selectedId || currentTab !== tab) return;
      await statuses(current, id, currentTab, e);
      if (!valid(e) || !visible()) return;
      await readActivity(current, id, currentTab, e);
      if (!valid(e) || !visible()) return;
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
    const initialized = !current.afterCursor;
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
      if (currentTab === 'mine') await readUnread(current, id, e);
      if (valid(e)) {
        updateError = null;
        retryDelay = 5000;
        if (initialized) schedule();
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
          if (errorCode(err) === 'invalid_cursor' && !recovered) {
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
        void readActivity(current, id, currentTab, e);
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
  // The older page in flight per conversation, so a caller that needs its messages (jumping to a quoted original) can
  // wait for it instead of reading the list before it lands. A concurrent loadOlder() still starts nothing.
  const olderRuns = new WeakMap();
  function loadOlder() {
    const current = cell();
    if (current?.olderLoading) return Promise.resolve();
    const run = readOlder(current);
    if (current?.olderLoading) olderRuns.set(current, run);
    return run;
  }
  /** Resolves once the selected conversation has no older page loading. */
  function olderSettled() {
    const current = cell();
    return current?.olderLoading ? olderRuns.get(current) ?? Promise.resolve() : Promise.resolve();
  }
  async function readOlder(current) {
    const id = selectedId,
      currentTab = tab,
      e = epoch;
    if (!current?.messageCursor || blocked || !active) return;
    current.olderLoading = true;
    current.olderError = null;
    emit();
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
          if (errorCode(err) === 'invalid_cursor' && !recovered) {
            recovered = true;
            await recoverCursor(current, id, currentTab, e);
            continue;
          }
          throw err;
        }
        if (!data || !valid(e) || navigation !== selectedVersion || selectedId !== id || tab !== currentTab) return;
        const min = data.items[0]?.id ?? -Infinity;
        if (data.nextCursor && (!data.items.length || data.nextCursor === cursor || min >= priorMin)) throw {
          code: 'chat_invalid_response'
        };
        priorMin = min;
        applyMessages(current, id, data);
        void readActivity(current, id, currentTab, e);
        current.messageCursor = data.nextCursor ?? null;
        if (current.gap && (data.items.some(row => row.id <= current.gap.afterId) || !data.nextCursor)) current.gap = null;
        emit();
        if (!current.recoveryOlder || data.items.some(row => row.id < oldest) || !data.nextCursor) {
          current.recoveryOlder = false;
          break;
        }
      }
    } catch (err) {
      if (err?.code === 'remote_chat_disabled') failure(err, e, current);
      else if (valid(e)) current.olderError = err?.code || 'chat_request_failed';
    } finally {
      current.olderLoading = false;
      if (valid(e)) emit();
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
    await Promise.all([list(), run(() => request('/api/instance'), data => {
      if (version === refreshVersion) {
        const actual = data.session_mode?.sessionMode;
        mode = ['single', 'multi'].includes(actual) ? actual : null;
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
      await run(() => request('/api/conversations/drafts', {
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
    if (!snapshot().canRename) return;
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
        display_name: data.conversation.displayName,
        displayName: data.conversation.displayName
      } : row);
      emit();
    }, epoch, current);
  }
  async function send({
    retry = false, attachments = []
  } = {}) {
    const current = cell();
    if (!snapshot().canWrite || !current || current.sending || current.retryRequired && (!retry || current.receipt?.retryAllowed !== true)) return;
    // A quote alone is not a message; text, an annotation or an attachment is.
    if (!current.pending && !current.input.trim() && !current.annotations.length && !attachments.length) return;
    // An open outcome is retried with the same content and quote; otherwise the annotations follow the user's words.
    const payload = current.pending ?? { content: composeContent({ text: current.input, annotations: current.annotations, timeZone: instanceTz, now: new Date(now()) }),
      quote: current.quote?.id ?? null };
    if (contentBytes(storedContent(payload.content, payload.quote)) > MAX_CONTENT_BYTES) return;
    const e = epoch,
      id = selectedId,
      currentTab = tab,
      navigation = selectedVersion,
      text = current.input,
      attachmentIds = [...attachments];
    current.pending = { content: payload.content, quote: payload.quote, answered: false };
    persistCompose(current);
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
          content: payload.content,
          ...(payload.quote ? { quote: Number(payload.quote) } : {}),
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
      if (result.stored === true && Number.isSafeInteger(result.messageId) && result.messageId > current.readUpTo) {
        current.readUpTo = result.messageId;
        current.unreadCount = 0;
      }
      current.retryRequired = result.stored === null;
      if (!result.preserveInput && result.stored === true && current.input === text) clearCompose(current);
      else if (result.stored === null) current.pending = { ...current.pending, answered: true };
      else current.pending = null;
      if (result.error) current.error = result.error;
      const canonical = result.conversationId || id;
      // A committed draft becomes this canonical conversation; keep quiet list merges from retaining its old row.
      if (result.stored === true && id.startsWith('d:') && canonical !== id) items = items.filter(row => row.id !== id);
      cells.set(`${currentTab}:${canonical}`, current);
      moveCompose(current, canonical);
      persistCompose(current);
      if (selectedId === id && tab === currentTab) selectedId = canonical;
      if (valid(e)) {
        await run(() => request(pathFor(canonical)), data => {
          current.conversation = data.conversation;
          emit();
        }, e, current);
        if (!valid(e) || tab !== currentTab) return outcome;
        if (result.stored === true && navigation === selectedVersion) {
          // A read started before storage cannot describe the newly queued message.
          cancelGroupPresenceRead();
          if (visible()) {
            readGroupPresence(current, currentTab, e);
          }
        }
        await list(false, canonical === id);
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
        current.pending = null;
        cells.set(`${currentTab}:${canonical}`, current);
        moveCompose(current, canonical);
        persistCompose(current);
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
        } else current.pending = null;
        persistCompose(current);
      }
      if ((err?.code || err?.payload?.error?.code) === 'remote_chat_disabled') {
        failure(err, e);
      } else if (sendIdentity === openedIdentity && !blocked) {
        current.error = err?.code || err?.payload?.error?.code || err?.message || 'chat_request_failed';
        if (valid(e)) emit();
      }
    } finally {
      current.sending = false;
      if (active && sendIdentity === openedIdentity && !blocked) emit();
    }
    return outcome;
  }
  return {
    blockRemote,
    snapshot,
    /** Expands or folds a subtask row; only expanded rows have their steps read, from now on every poll. */
    async toggleSubtask(key) {
      const current = cell(), id = selectedId, e = epoch;
      if (!current || typeof key !== 'string') return;
      if (current.activity.open.delete(key)) { current.activity.details.delete(key); emit(); return; }
      current.activity.open.add(key);
      emit();
      await readSubtask(current, id, key, e);
      if (current === cell()) emit();
    },
    streamSubscription,
    streamStatus,
    streamEvent,
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
      resetStream();
      readDirty = false;
      if (nextIdentity !== openedIdentity) {
        cancelGroupPresenceRead();
        openedIdentity = nextIdentity;
        cells.clear();
        items = [];
        nextCursor = null;
        selectedId = null;
        search = '';
        listLoaded = false;
        listUpdates.clear();
        mode = null;
        deletionAllowed = false;
        blocked = false;
        error = null;
        loading = false;
      }
      active = true;
      epoch++;
      updateError = null;
      retryAt = 0;
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
      resetStream();
      readDirty = false;
      emit();
    },
    destroy() {
      cancelGroupPresenceRead();
      active = false;
      destroyed = true;
      epoch++;
      stopTimer();
      resetStream();
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
      listLoaded = false;
      listUpdates.clear();
      emit();
      await list();
      schedule();
    },
    async setSearch(value) {
      if (!active || blocked || value.trim() === search) return;
      search = value.trim();
      items = [];
      nextCursor = null;
      listLoaded = false;
      listUpdates.clear();
      listDepth = 1;
      await list();
      schedule();
    },
    refreshList: () => list(),
    togglePin: id => replacePin(id),
    reorderPin: (id, targetId) => replacePin(id, targetId, true),
    markRead,
    jumpToLatest,
    select: async (id, fallbackMetadata) => {
      stopTimer();
      fastUntil = 0;
      updateError = null;
      retryDelay = 5000;
      await select(id, fallbackMetadata);
      schedule();
    },
    async deleted(id) {
      items = items.filter(item => item.id !== id);
      const removed = cells.get(key(id));
      for (const form of removed?.questionForms?.values() ?? []) clearQuestionDraft(null, null, form);
      cells.delete(key(id));
      if (selectedId === id) { selectedId = null; selectedVersion++; }
      emit();
      await list();
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
        persistCompose(cell());
        emit();
      }
    },
    /** One quote at a time: a new one replaces the old; null removes it. */
    setQuote(quote) {
      const current = cell();
      if (!composeEditable(current)) return false;
      current.quote = quote ? { id: String(quote.id), direction: quote.direction, timestamp: String(quote.timestamp), text: quote.text,
        ...(quote.internal ? { internal: true } : {}) } : null;
      persistCompose(current);
      emit();
      return true;
    },
    addAnnotation(item) {
      const current = cell();
      if (!composeEditable(current) || current.annotations.length >= MAX_ANNOTATIONS) return false;
      current.annotationSeq += 1;
      current.annotations = [...current.annotations, { ...item, key: current.annotationSeq }];
      persistCompose(current);
      emit();
      return true;
    },
    updateAnnotation(itemKey, comment) {
      const current = cell();
      if (!composeEditable(current)) return false;
      current.annotations = current.annotations.map(item => item.key === itemKey ? { ...item, comment } : item);
      persistCompose(current);
      emit();
      return true;
    },
    removeAnnotation(itemKey) {
      const current = cell();
      if (!composeEditable(current)) return false;
      current.annotations = itemKey === undefined ? [] : current.annotations.filter(item => item.key !== itemKey);
      persistCompose(current);
      emit();
      return true;
    },
    loadMore: () => list(true),
    loadOlder,
    olderSettled,
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
        settleCompose(current, data);
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
