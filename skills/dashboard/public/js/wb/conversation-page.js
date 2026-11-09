import { createUploadTray } from './chat-upload-tray.js?v=2';
import { createChatAttachment } from './chat-attachments.js?v=4';
import { element, icon } from './plain-text.js?v=104';
import { asDate } from './conversation-time.js?v=99';
import { formatZoned } from './instance-zone.js?v=100';
import { channelIcon } from './board.js?v=115';
import { createConversationState } from './conversation-state.js?v=131';
import { messageState, receiptState } from './chat-delivery-state.js?v=100';
import { renderQuestion } from './chat-questions.js?v=106';
import { conversationErrorKey, renderConversationContent } from './conversation-content.js?v=114';
import { createGroupSide } from './group-side.js?v=3';
import { activityPlacement, createActivityArea } from './conversation-activity.js?v=103';
import { createScrollGesture } from './scroll-gesture.js?v=102';
import { createConversationDeletion, deletionPath } from './conversation-delete.js?v=4';
const laterThan = (left, right) => {
  const a = String(left),
    b = String(right);
  return a.length === b.length ? a > b : a.length > b.length;
};
/** Release message DOM and resources when the current snapshot no longer owns its id. */
export function disposeMissingMessages(messages, ids) {
  for (const [id, record] of messages) {
    if (!ids.has(id)) {
      record.resource?.destroy?.();
      record.node.remove();
      messages.delete(id);
    }
  }
}
/**
 * Whether a keydown in the composer sends the message. Enter sends and Shift+Enter starts a new line, as in the
 * Web Console; ⌘/Ctrl+Enter also sends. An Enter that commits an input method's composition never sends. On a
 * touch-first device Enter keeps starting a new line and only the send button sends: on-screen keyboards have no
 * Shift. A hardware keyboard's ⌘/Ctrl+Enter still sends there.
 */
export function composerKeySends(event, { touch = false } = {}) {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false;
  if (event.ctrlKey || event.metaKey) return true;
  return !event.shiftKey && !touch;
}
/** Touch-first: the primary pointer is coarse and cannot hover (phones, tablets), not a touch-screen laptop. */
export function touchFirst(view) {
  return view?.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches === true;
}
const LIST_KEY = 'zylos-dashboard-conversation-list';
/** A persistent page: polling reconciles keyed rows and delivery labels, never the editor. */
export function mountConversationPage({
  root,
  document = root.ownerDocument,
  t = key => key,
  fetch: fetcher = globalThis.fetch,
  endpoint = path => path,
  identity,
  draftStore = null,
  draftScope = () => null,
  groupLinks = null,
  technicalDetails = () => false,
  local = () => false,
  confirm = async () => false,
  onStreamSubscription = () => {},
  storage = globalThis.localStorage
} = {}) {
  let destroyed = false,
    currentSnapshot,
    selectedKey = null,
    unread = 0,
    maxSeenId = null,
    renaming = false,
    creating = false,
    creationPending = false;
  let fitFrame = null,
    fitObserver = null,
    fittedHeight = null;
  // Activity areas: manual open state per part (kept across redraws), the parts after a round's last message, and
  // the clock tick that keeps running times current.
  const activityOpen = new Map(),
    trailingActivity = new Map(),
    activityEntries = new Map();
  let activityTimer = null,
    followAfterGesture = false,
    growthDuringGesture = 0,
    shiftDuringGesture = 0;
  const view = document.defaultView;
  const listRows = new Map(),
    messages = new Map(),
    days = new Map(),
    actions = [];
  // Daily chart points are read in the instance time zone the message history reports (UTC when it does not).
  let instanceTimeZone = null;
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const label = key => t(key.startsWith('chat.') ? key : 'chat.' + key);
  const text = (el, value) => {
    const next = String(value ?? '');
    if (el.textContent !== next) {
      el.textContent = next;
    }
  };
  const action = (key, handler, ico, cls = 'wb-btn') => {
    const button = node('button', undefined, cls);
    button.type = 'button';
    button.dataset.action = key.replace('chat.', '');
    if (ico) {
      button.append(icon(document, ico));
    }
    const title = node('span', label(key));
    button.append(title);
    button.setAttribute('aria-label', label(key));
    button.addEventListener('click', () => {
      if (!button.disabled && !destroyed) {
        void handler();
      }
    });
    button.label = title;
    actions.push({
      button,
      title,
      key
    });
    return button;
  };
  const request = async (path, options = {}) => {
    const response = await fetcher(endpoint(path), {
      method: options.method ?? 'GET',
      ...(options.signal ? { signal: options.signal } : {}),
      headers: {
        ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(options.headers || {})
      },
      ...(options.body === undefined ? {} : {
        body: JSON.stringify(options.body)
      })
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw {
        code: 'chat_invalid_response',
        status: response.status
      };
    }
    if (!response.ok) {
      throw {
        code: payload.error ?? 'chat_request_failed',
        status: response.status,
        payload
      };
    }
    return payload;
  };
  const state = createConversationState({
    request,
    identity,
    draftStore,
    draftScope,
    document,
    t
  });
  let deletionResult = null;
  const deletion = createConversationDeletion({ request, confirm, t, identity,
    available: item => !destroyed && !page.hidden && local() && state.snapshot().canDelete &&
      state.snapshot().items.some(row => row.id === item.id),
    onChange: () => redraw(), onDeleted: (id, result) => {
      deletionResult = { ...result, identity: typeof identity === 'function' ? identity() : identity };
      return state.deleted(id);
    } });
  let uploadRedrawQueued = false;
  const uploadTray = createUploadTray({ fetch: fetcher,
    createXHR: () => new view.XMLHttpRequest(),
    createFormData: () => new view.FormData(),
    url: view?.URL ?? globalThis.URL,
    onUnauthorized: source => { const scope = draftScope(); if (scope) state.clearDrafts({ ...scope, instance: source.instance }); },
    onChange: () => {
      if (uploadRedrawQueued || destroyed) return;
      uploadRedrawQueued = true;
      queueMicrotask(() => { uploadRedrawQueued = false; if (!destroyed) redraw(); });
    }
  });
  const uploadScope = s => s.canWrite ? { instance: draftScope()?.instance ?? String(typeof identity === 'function' ? identity() : identity ?? 'local'),
    conversationId: s.selectedId, uploadsUrl: endpoint(`/api/chat/conversations/${encodeURIComponent(s.selectedId)}/uploads`) } : null;
  const nameOf = (row, external = false) => row?.displayName ?? row?.display_name
    ?? (external ? row?.sessionGroup ?? row?.session_group : null) ?? t('chat.unnamed');
  const channelOf = row => row?.channel ?? (row?.sessionGroup ?? row?.session_group ?? '').split(':')[0] ?? '';
  const isDraft = s => s.selectedId?.startsWith('d:') || s.conversation?.state === 'draft' || s.conversation?.draft === true;
  const channelLabel = channel => {
    const known = {
      dashboard: 'Dashboard',
      telegram: 'Telegram',
      lark: 'Lark',
      feishu: 'Feishu',
      wechat: 'WeChat',
      'web-console': 'Web Console',
      openmax: 'OpenMax'
    };
    return known[channel] ?? channel;
  };
  const relativeTime = date => {
    const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (seconds >= 3600 && seconds < 86400) {
      return formatZoned(date, document.documentElement?.lang, { hour: '2-digit', minute: '2-digit' }, instanceTimeZone);
    }
    const key = seconds < 60 ? 'justNow' : seconds < 3600 ? 'minutesAgo' : 'daysAgo';
    const count = seconds < 3600 ? Math.floor(seconds / 60) : Math.floor(seconds / 86400);
    return t('chat.page.' + key).replace('{count}', String(count));
  };
  async function selectFirstDesktop() {
    const current = state.snapshot();
    if (!destroyed && !current.blocked && !current.selectedId && current.items.length && view?.innerWidth > 760) {
      await state.select(current.items[0].id);
    }
  }
  const page = node('div', undefined, 'conversation-page');
  const sidebar = node('aside', undefined, 'conversation-sidebar');
  sidebar.setAttribute('aria-label', t('chat.conversations'));
  const listToolbar = node('div', undefined, 'conversation-list-toolbar');
  const tabs = node('div', undefined, 'conversation-tabs');
  tabs.setAttribute('role', 'tablist');
  const tabButtons = {};
  for (const tab of ['mine', 'external']) {
    const button = action(tab, async () => {
      mobileDetail(false);
      await state.setTab(tab);
      await selectFirstDesktop();
    }, tab === 'mine' ? 'monitor' : 'msg');
    button.setAttribute('role', 'tab');
    tabButtons[tab] = button;
    tabs.append(button);
  }
  const reload = action('refresh', () => state.refresh(), 'restart', 'wb-icon-btn conversation-reload');
  listToolbar.append(tabs, reload);
  const create = action('create', () => {
    creating = true;
    createForm.hidden = false;
    create.hidden = true;
    createName.focus();
  }, 'plus', 'wb-btn wb-btn-primary conversation-create');
  const createForm = node('form', undefined, 'conversation-create-form');
  createForm.hidden = true;
  const createName = node('input', undefined, 'wb-input');
  createName.maxLength = 40;
  const createSubmit = action('chat.page.createSubmit', () => {}, undefined, 'wb-btn wb-btn-primary');
  createSubmit.type = 'submit';
  createSubmit.dataset.action = 'createDraft';
  const createCancel = action('chat.page.cancel', () => {
    creating = false;
    createForm.hidden = true;
    createName.value = '';
    redraw();
    create.focus();
  });
  createForm.append(createName, createSubmit, createCancel);
  createForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (creationPending || state.snapshot().creatingDraft || !state.snapshot().canCreate) {
      return;
    }
    creationPending = true;
    redraw();
    try {
      await state.createDraft(createName.value.trim() || undefined);
      if (!state.snapshot().error) {
        creating = false;
        createName.value = '';
        mobileDetail(true);
      }
    } finally {
      creationPending = false;
      redraw();
    }
  });
  const externalSection = node('div', undefined, 'conversation-external-section');
  externalSection.append(icon(document, 'lock'), node('span', t('chat.page.externalSection')));
  const list = node('div', undefined, 'conversation-items');
  const listNotice = node('p', undefined, 'chat-notice conversation-list-notice');
  const deletionNotice = node('p', undefined, 'chat-notice conversation-deletion-notice');
  deletionNotice.setAttribute('role', 'status');
  deletionNotice.hidden = true;
  const more = action('loadMore', () => state.loadMore());
  more.classList.add('conversation-load-more');
  sidebar.append(listToolbar, create, createForm, externalSection, list, deletionNotice, listNotice, more);
  const detail = node('section', undefined, 'conversation-detail');
  detail.setAttribute('aria-label', t('chat.history'));
  const header = node('header', undefined, 'conversation-header');
  const back = action('chat.page.back', () => mobileDetail(false), 'back', 'wb-icon-btn conversation-back');
  const headerIcon = node('span', undefined, 'conversation-channel-icon');
  headerIcon.append(icon(document, 'monitor'));
  const heading = node('div', undefined, 'conversation-heading'),
    titleLine = node('div', undefined, 'conversation-title-line');
  const title = node('h2'),
    subtitle = node('span', undefined, 'conversation-subtitle');
  const running = node('span', undefined, 'conversation-running');
  running.append(icon(document, 'activity'), node('span', t('chat.page.running')));
  const renameToggle = action('rename', () => {
    renaming = !renaming;
    renameForm.hidden = !renaming;
    if (renaming) {
      renameInput.value = nameOf(currentSnapshot.conversation);
      renameInput.focus();
      renameInput.select();
    }
  }, 'edit', 'wb-icon-btn');
  titleLine.append(title, renameToggle);
  heading.append(titleLine, subtitle, running);
  const streamHint = node('span', undefined, 'conversation-push-status');
  streamHint.setAttribute('role', 'status');
  heading.append(streamHint);
  const headerActions = node('div', undefined, 'conversation-header-actions');
  const readNew = action('refreshMessages', () => state.refreshMessages(), 'restart');
  const statusCheck = action('refreshStatus', () => state.refreshStatus(), 'check');
  const group = action('chat.page.groupInfo', () => toggleGroupSide(), 'chev');
  headerActions.append(readNew, statusCheck, group);
  // Collapses the conversation list on wider screens; remembered like the dashboard's other view preferences.
  const listToggle = action('chat.page.hideList', () => toggleList(), 'menu', 'wb-icon-btn conversation-list-toggle');
  listToggle.dataset.action = 'listToggle';
  const listEntry = actions.at(-1);
  let listCollapsed = false;
  try { listCollapsed = storage?.getItem(LIST_KEY) === 'collapsed'; } catch {}
  header.append(listToggle, back, headerIcon, heading, headerActions);
  const renameForm = node('form', undefined, 'conversation-rename');
  renameForm.hidden = true;
  const renameInput = node('input', undefined, 'wb-input');
  renameInput.maxLength = 40;
  renameInput.setAttribute('aria-label', t('chat.name'));
  const renameSave = action('rename', () => {});
  renameSave.type = 'submit';
  const renameCancel = action('chat.page.cancel', () => {
    renaming = false;
    renameForm.hidden = true;
    renameToggle.focus();
  });
  renameForm.append(renameInput, renameSave, renameCancel);
  renameForm.addEventListener('submit', event => {
    event.preventDefault();
    if (currentSnapshot.canWrite) {
      void state.rename(renameInput.value || null);
      renaming = false;
      renameForm.hidden = true;
    }
  });
  const notices = node('div', undefined, 'conversation-notices');
  const accessNotice = node('p', undefined, 'chat-notice conversation-single-warning'),
    errorNotice = node('p', undefined, 'chat-error');
  const accessText = node('span', t('chat.single'));
  accessNotice.append(icon(document, 'lock'), accessText);
  errorNotice.setAttribute('role', 'alert');
  const updateNotice = node('p', t('chat.page.updateRetry'), 'conversation-update-error');
  updateNotice.setAttribute('role', 'status');
  const questionNotice = node('p', undefined, 'chat-notice');
  const questionMore = action('loadMoreQuestions', () => state.loadMoreQuestions());
  notices.append(accessNotice, errorNotice, updateNotice, questionNotice, questionMore);
  const history = node('div', undefined, 'conversation-history');
  const stream = node('div', undefined, 'conversation-stream chat-messages');
  stream.setAttribute('role', 'log');
  stream.setAttribute('aria-label', t('chat.history'));
  const older = action('loadOlder', () => state.loadOlder(), undefined, 'wb-link-btn conversation-older');
  const gap = node('div', undefined, 'conversation-gap');
  const gapLabel = node('span', t('chat.page.historyGap'));
  const gapLoad = action('chat.page.loadGap', () => state.loadGap());
  gap.append(gapLabel, gapLoad);
  const messageList = node('div', undefined, 'conversation-message-list');
  const historyNotice = node('p', undefined, 'chat-notice conversation-history-notice');
  stream.append(older, gap, historyNotice, messageList);
  const latest = action('chat.page.newMessages', () => {
    stream.scrollTop = stream.scrollHeight;
    unread = 0;
    updateUnread();
  }, 'in', 'wb-btn conversation-new-messages');
  latest.dataset.action = 'latest';
  history.append(stream, latest);
  const composer = node('form', undefined, 'conversation-composer chat-composer');
  const receipt = node('div', undefined, 'conversation-receipt chat-message-status');
  receipt.setAttribute('role', 'status');
  const receiptText = node('span');
  const receiptCheck = action('refreshStatus', () => state.refreshStatus(), 'check');
  receipt.append(receiptText, receiptCheck);
  const readOnlyFooter = node('p', undefined, 'conversation-read-only');
  readOnlyFooter.append(icon(document, 'lock'), node('span', t('chat.page.externalReadOnly')));
  const composeBox = node('div', undefined, 'conversation-compose-box');
  const input = node('textarea', undefined, 'conversation-input chat-input');
  input.rows = 1;
  input.setAttribute('aria-label', t('chat.input'));
  updateInputPlaceholder();
  const send = action('send', () => {}, 'send', 'wb-btn wb-btn-primary conversation-send');
  send.type = 'submit';
  const hint = node('p', t('chat.page.sendHint'), 'conversation-compose-hint');
  const attach = action('attach', () => fileInput.click(), 'paperclip', 'wb-icon-btn conversation-attach');
  const fileInput = node('input'); fileInput.type = 'file'; fileInput.multiple = true;
  fileInput.hidden = true; fileInput.dataset.action = 'chooseFiles'; fileInput.setAttribute('aria-label', t('chat.attach'));
  const trayLabel = node('p', '', 'conversation-upload-label');
  const tray = node('div', undefined, 'conversation-upload-tray');
  tray.setAttribute('aria-label', t('chat.upload.tray'));
  const uploadNotice = node('p', '', 'chat-notice conversation-upload-notice'); uploadNotice.setAttribute('role', 'status');
  const trayResources = new Map();
  const addFiles = files => {
    if (!currentSnapshot?.canWrite || currentSnapshot.sending || currentSnapshot.retryRequired && !currentSnapshot.canRetry) return;
    void uploadTray.acceptFiles(Array.from(files));
  };
  fileInput.addEventListener('change', () => { addFiles(fileInput.files || []); fileInput.value = ''; });
  input.addEventListener('paste', event => {
    const files = Array.from(event.clipboardData?.files || []);
    if (files.length && currentSnapshot?.canWrite && !currentSnapshot.sending) { event.preventDefault(); addFiles(files); }
  });
  detail.addEventListener('dragover', event => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) event.preventDefault();
  });
  detail.addEventListener('drop', event => {
    if (event.dataTransfer?.files?.length || Array.from(event.dataTransfer?.types || []).includes('Files')) {
      event.preventDefault();
      addFiles(event.dataTransfer.files || []);
    }
  });
  composeBox.append(attach, input, send, fileInput);
  composer.append(receipt, trayLabel, tray, uploadNotice, composeBox, hint);
  input.addEventListener('input', () => state.setInput(input.value));
  input.addEventListener('keydown', event => {
    if (composerKeySends(event, { touch: touchFirst(view) })) {
      event.preventDefault();
      // When the last send's outcome is uncertain, only a click on the retry button retries; keys never do.
      if (!send.disabled && !currentSnapshot?.retryRequired) {
        void requestSend();
      }
    }
  });
  composer.addEventListener('submit', event => {
    event.preventDefault();
    if (!send.disabled) {
      void requestSend();
    }
  });
  detail.append(header, renameForm, notices, history, composer, readOnlyFooter);
  page.append(sidebar, detail);
  // The group's detail opens beside the conversation (over it on narrow screens), never on the overview.
  let groupSideFor = null;
  const groupSide = groupLinks ? createGroupSide({ document, t, fetch: fetcher, endpoint, identity: () => typeof identity === 'function' ? identity() : identity,
    ...groupLinks, isVisible: () => !destroyed && !page.hidden && document.visibilityState !== 'hidden',
    // The panel only shows the open conversation's group, whose conversation is this one: going to it just closes.
    onConversation: () => groupSide.close(),
    onClose: ({ focus, hide }) => {
      groupSideFor = null;
      // Hiding inside the preserved change keeps the reading position (or the pin to the bottom) as the column widens.
      preserveAttachmentLayout(() => { hide(); page.classList.toggle('conversation-has-side', false); });
      group.setAttribute('aria-expanded', 'false');
      if (focus && !group.hidden) group.focus();
    } }) : null;
  if (groupSide) {
    page.append(groupSide.element);
    group.setAttribute('aria-expanded', 'false');
  }
  // The list stays shown while no conversation is open: the button to show it again is in the conversation header.
  function applyList() {
    page.classList.toggle('conversation-list-collapsed', listCollapsed && !header.hidden);
    listEntry.key = listCollapsed ? 'chat.page.showList' : 'chat.page.hideList';
    text(listEntry.title, label(listEntry.key));
    listToggle.setAttribute('aria-label', label(listEntry.key));
    listToggle.title = label(listEntry.key);
    listToggle.setAttribute('aria-expanded', String(!listCollapsed));
  }
  function toggleList() {
    listCollapsed = !listCollapsed;
    try { storage?.setItem(LIST_KEY, listCollapsed ? 'collapsed' : 'shown'); } catch {}
    // The conversation widens or narrows: keep the reading position, as for the side panel.
    preserveAttachmentLayout(applyList);
  }
  function toggleGroupSide() {
    if (!groupSide) return;
    if (groupSide.open) { groupSide.close(); return; }
    const current = currentSnapshot.conversation ?? currentSnapshot.items.find(item => item.id === currentSnapshot.selectedId);
    const key = current?.sessionGroup ?? current?.session_group;
    if (!key) return;
    groupSideFor = currentSnapshot.selectedId;
    // The panel appears inside the preserved change, so the position measured before is the one before it opened.
    preserveAttachmentLayout(() => { void groupSide.show(key); page.classList.toggle('conversation-has-side', true); });
    group.setAttribute('aria-expanded', 'true');
  }
  root.replaceChildren(page);
  function updateInputPlaceholder(mode = currentSnapshot?.mode) {
    const key = mode === 'single' ? 'chat.page.singlePlaceholder'
      : view?.innerWidth <= 760 || touchFirst(view) || currentSnapshot?.retryRequired ? 'chat.page.mobilePlaceholder' : 'chat.page.placeholder';
    input.placeholder = t(key);
  }
  function fitInput() {
    if (!view || !input.isConnected || !input.getClientRects().length) {
      return;
    }
    const oldTop = input.scrollTop;
    const atBottom = input.scrollHeight - oldTop - input.clientHeight <= 2;
    input.style.height = '0px';
    const height = input.value ? input.scrollHeight : parseFloat(view.getComputedStyle(input).minHeight);
    input.style.height = `${Math.min(180, height)}px`;
    input.style.overflowY = input.value && input.scrollHeight > input.clientHeight ? 'auto' : 'hidden';
    input.scrollTop = atBottom ? input.scrollHeight : oldTop;
  }
  async function requestSend() {
    const selected = selectedKey;
    // Sending disables the editor, which takes the focus away; a keyboard send gives it back so typing can go on.
    const refocus = document.activeElement === input;
    const sourceScope = uploadScope(currentSnapshot);
    const captured = uploadTray.capture();
    const sent = await state.send({ retry: currentSnapshot.retryRequired, attachments: captured.ids });
    if (sent?.stored === true && sent.preserveInput !== true) uploadTray.completeStored(captured);
    if (captured.scope && sourceScope && typeof sent?.conversationId === 'string' && sent.conversationId
      && captured.scope.conversationId !== sent.conversationId) {
      const uploadsUrl = sourceScope.uploadsUrl.replace(/\/conversations\/[^/]+\/uploads$/, `/conversations/${encodeURIComponent(sent.conversationId)}/uploads`);
      uploadTray.moveScope(captured.scope, { ...captured.scope, conversationId: sent.conversationId, uploadsUrl });
    }
    if (!destroyed && selectedKey === selected && state.snapshot().receipt?.stored === true) {
      stream.scrollTop = stream.scrollHeight;
      unread = 0;
      updateUnread();
    }
    // Only when nothing else took the focus meanwhile (the disabled editor leaves it on the page body).
    const focusFree = !document.activeElement || document.activeElement === document.body || document.activeElement === input;
    if (refocus && focusFree && !destroyed && selectedKey === selected && !input.disabled) input.focus();
  }
  function mobileDetail(open) {
    page.classList.toggle('conversation-detail-open', open);
  }
  function updateUnread() {
    latest.hidden = !unread;
    const title = t('chat.page.newMessages').replace('{count}', String(unread));
    text(latest.label, title);
    latest.setAttribute('aria-label', title);
  }
  stream.addEventListener('scroll', () => {
    if (stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 2) {
      unread = 0;
      updateUnread();
    }
  }, {
    passive: true
  });
  // While the user drags, swipes or wheels the history, the page never writes its scroll position. Once the list
  // is still, it follows new content only if the user stayed at the bottom; a user who left it is not pulled back,
  // but the content that moved under them meanwhile (an older page, an opened attachment) is moved back by the same
  // amount, so what they were reading stays in view.
  const gesture = createScrollGesture(stream, {
    setTimeout: (fn, ms) => view?.setTimeout ? view.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms),
    clearTimeout: id => view?.clearTimeout ? view.clearTimeout(id) : globalThis.clearTimeout(id),
    onSettle: () => {
      if (destroyed) return;
      if (followAfterGesture && stream.scrollHeight - stream.scrollTop - stream.clientHeight <= growthDuringGesture + 2) {
        stream.scrollTop = stream.scrollHeight;
        unread = 0;
        updateUnread();
      } else if (shiftDuringGesture) {
        stream.scrollTop += shiftDuringGesture;
      }
      followAfterGesture = false;
      growthDuringGesture = 0;
      shiftDuringGesture = 0;
    }
  });
  /**
   * During a gesture a change is not compensated at once: `shift` is how far the content the user was reading
   * moved because of it, applied when the gesture settles.
   */
  function holdScroll(follow, grownBy = 0, shift = 0) {
    if (!gesture.active) return false;
    if (follow) followAfterGesture = true;
    growthDuringGesture += Math.max(0, grownBy);
    if (Number.isFinite(shift)) shiftDuringGesture += shift;
    return true;
  }
  const anchorShift = (anchorNode, anchorTop) => anchorNode?.isConnected && anchorTop !== undefined
    ? anchorNode.getBoundingClientRect().top - anchorTop : 0;
  function positionChildren(parent, ordered) {
    for (let i = 0; i < ordered.length; i++) {
      if (parent.children[i] !== ordered[i]) {
        parent.insertBefore(ordered[i], parent.children[i] ?? null);
      }
    }
  }
  // Message times and days are written in the instance time zone the history reports (UTC when it does not).
  const clockText = date => formatZoned(date, document.documentElement?.lang, { hour: '2-digit', minute: '2-digit' }, instanceTimeZone);
  function dateLabel(row) {
    const date = asDate(row.timestamp ?? row.created_at ?? row.createdAt);
    return date ? formatZoned(date, document.documentElement?.lang, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }, instanceTimeZone) : null;
  }
  function makeMessage(row, s) {
    const article = node('article', undefined, 'chat-message conversation-message ' + (row.direction === 'in' ? 'chat-in' : 'chat-out'));
    article.dataset.messageId = String(row.id);
    const avatar = node('span', undefined, 'conversation-avatar');
    avatar.append(icon(document, row.direction === 'in' ? 'monitor' : 'bot'));
    const body = node('div', undefined, 'conversation-message-body');
    const meta = node('div', undefined, 'conversation-message-meta'),
      author = node('span', t(row.direction === 'in' ? 'chat.page.you' : 'chat.page.ai'), 'chat-message-author');
    meta.append(author);
    const date = asDate(row.timestamp ?? row.created_at ?? row.createdAt);
    let timeNode = null;
    if (date) {
      timeNode = node('time', clockText(date));
      timeNode.dateTime = date.toISOString();
      meta.append(timeNode);
    }
    const questions = [];
    const content = renderConversationContent({
      document,
      row,
      t,
      showTechnicalDetails: technicalDetails() === true,
      chartTimeZone: () => instanceTimeZone,
      attachmentContext: { conversationId: s.selectedId, endpoint, fetch: fetcher, external: s.tab === 'external', onLayout: preserveAttachmentLayout },
      renderQuestion: ({
        envelope,
        block
      }) => {
        const record = {
          envelope,
          block,
          row,
          node: null,
          signature: null
        };
        record.node = questionNode(record, s);
        questions.push(record);
        return record.node;
      }
    });
    if (content.classList.contains('conversation-composed-content') || content.classList.contains('conversation-chart-content')) body.classList.add('conversation-message-body-wide');
    const status = node('span', undefined, 'chat-message-status conversation-message-status');
    status.setAttribute('role', 'status');
    const statusIcon = node('span', undefined, 'conversation-delivery-icon');
    const statusText = node('span');
    const statusButton = node('button', undefined, 'wb-link-btn');
    statusButton.type = 'button';
    statusButton.dataset.action = 'refreshStatus';
    const statusButtonLabel = node('span', t('chat.refreshStatus'));
    statusButton.append(icon(document, 'check'), statusButtonLabel);
    statusButton.addEventListener('click', () => {
      if (!destroyed && !statusButton.disabled) void state.refreshStatus();
    });
    status.append(statusIcon, statusText, statusButton);
    const activitySlot = node('div', undefined, 'conversation-activity-slot');
    const afterActivitySlot = node('div', undefined, 'conversation-activity-slot conversation-activity-after-reply-slot');
    body.append(meta, activitySlot, content, afterActivitySlot, status);
    article.append(avatar, body);
    const record = {
      node: article,
      activitySlot,
      activityAreas: new Map(),
      afterActivitySlot,
      afterActivityAreas: new Map(),
      status,
      statusIcon,
      statusText,
      statusButton,
      statusButtonLabel,
      author,
      questions,
      resource: content,
      attachmentKey: JSON.stringify(row.attachments || []),
      content: row.content,
      time: timeNode,
      date
    };
    patchMessage(record, row, s);
    return record;
  }
  function questionNode(record, s) {
    const question = s.questions.find(item => String(item.c4Id) === String(record.row.id) && item.interruptId === record.envelope.interruptId);
    const key = `${record.row.id}:${record.envelope.interruptId}`;
    if (!s.questionForms.has(key)) {
      s.questionForms.set(key, {});
    }
    const form = s.questionForms.get(key);
    const scope = draftScope();
    const matches = question && !question.questionError && question.messageId === record.envelope.messageId
      && question.interruptId === record.envelope.interruptId && record.envelope.interrupt?.blockId === record.block.id;
    if (scope && matches && record.block.type === 'form_intent' && s.tab === 'mine' && s.questionsReady) {
      const fullScope = { ...scope, conversationId: s.selectedId, messageId: record.envelope.messageId,
        blockId: record.block.id, schemaVersion: record.block.schemaVersion };
      const scopeKey = JSON.stringify(fullScope);
      if (form.draftKey !== scopeKey) {
        form.values = {}; form.draftKey = scopeKey; form.draftScope = fullScope;
        if (question.status === 'paused') {
          const saved = draftStore?.loadEditable ? draftStore.loadEditable(fullScope) : (() => { const values = draftStore?.load(fullScope); return values ? { values, freeText: '' } : null; })();
          if (saved) { form.values = saved.values; form.freeText = saved.freeText; form.draftStatus = 'restored'; }
          form.draftCleared = false;
        } else { draftStore?.remove(fullScope); form.draftCleared = true; }
      }
    }
    const rendered = renderQuestion({
      document,
      timeZone: instanceTimeZone,
      envelope: record.envelope,
      block: record.block,
      row: record.row,
      question,
      t,
      canWrite: s.canWrite && s.questionsReady,
      stateAvailable: s.questionsReady && !s.questionError,
      readOnlyExternal: s.tab === 'external',
      statePendingPage: !!s.questionCursor,
      otherAnswerDisclosure: true,
      formState: form,
      onDraftChange: values => {
        if (!form.draftScope || currentSnapshot?.questionForms !== s.questionForms
          || currentSnapshot?.selectedId !== s.selectedId || question?.status !== 'paused') return null;
        return draftStore?.save(form.draftScope, values, { freeText: form.freeText ?? '' })?.saved ? 'saved' : 'unsaved';
      },
      onSubmit: (answer, options) => state.answer(record.envelope.interruptId, answer, {
        ...options,
        conversationId: s.selectedId,
        questionC4Id: record.row.id
      })
    });
    return rendered;
  }
  function patchMessage(record, row, s) {
    if (record.time) text(record.time, clockText(record.date));
    const delivery = s.tab === 'mine' && row.direction === 'in' ? messageState(row) : null;
    const status = delivery ? t(delivery === 'pending' && s.groupWait?.kind === 'rate_wait'
      ? s.groupHealth === 'recovering' ? 'chat.page.delivery.recovering' : 'chat.page.delivery.rateLimited'
      : 'chat.page.delivery.' + delivery) : '';
    text(record.author, t(row.direction === 'in' ? 'chat.page.you' : 'chat.page.ai'));
    text(record.statusText, status);
    record.status.hidden = !delivery;
    record.status.dataset.deliveryState = delivery || '';
    const statusSymbol = ['delivered', 'stored'].includes(delivery) ? 'check' : ['auth_rejected', 'suppressed', 'failed', 'pending_reconciliation'].includes(delivery) ? 'alert' : 'clock';
    if (record.statusIcon.dataset.icon !== statusSymbol) {
      record.statusIcon.replaceChildren(icon(document, statusSymbol));
      record.statusIcon.dataset.icon = statusSymbol;
    }
    record.statusButton.hidden = delivery !== 'pending_reconciliation';
    text(record.statusButtonLabel, t('chat.refreshStatus'));
    record.statusButton.setAttribute('aria-label', t('chat.refreshStatus'));
    for (const q of record.questions) {
      const question = s.questions.find(item => String(item.c4Id) === String(row.id) && item.interruptId === q.envelope.interruptId);
      const form = s.questionForms.get(`${row.id}:${q.envelope.interruptId}`) ?? {};
      const signature = JSON.stringify([question, s.canWrite, s.questionsReady, s.questionError, s.questionCursor, form.sending, form.locked, form.error, form.receipt, form.fieldErrors, form.formError, form.draftCleared, t('chat.question.paused')]);
      if (q.signature === signature) {
        continue;
      }
      q.signature = signature;
      if (form.draftCleared) q.node.clearRemovedValues?.();
      q.node.updateFormState?.();
      const fresh = questionNode(q, s);
      const choiceDescription = q.node.closest('.chat-block')?.querySelector('.chat-choice-options');
      if (choiceDescription) {
        choiceDescription.hidden = fresh.dataset.choiceControls === 'true' || !!q.node.querySelector('.chat-question-options input');
      }
      const formDescription = q.node.closest('.chat-block')?.querySelector('.chat-question-description>.chat-form-fields');
      if (formDescription) formDescription.hidden = fresh.dataset.formControls === 'true' || !!q.node.querySelector('.chat-question-fields');
      const otherSummary = q.node.querySelector('.conversation-question-other>summary');
      if (otherSummary) {
        text(otherSummary, t('chat.question.otherAnswer'));
      }
      const controls = [...q.node.querySelectorAll('input,textarea,select')];
      if (!controls.length) {
        q.node.replaceWith(fresh);
        q.node = fresh;
        continue;
      }
      // Lifecycle changes announce on the existing card; user's editing controls stay mounted.
      let announcement = q.node.querySelector('.conversation-question-announcement');
      if (!announcement) {
        announcement = node('div', undefined, 'conversation-question-announcement');
        announcement.setAttribute('role', 'status');
        announcement.setAttribute('aria-live', 'polite');
        q.node.prepend(announcement);
      }
      const messages = [...fresh.children].filter(child => !child.classList.contains('chat-form-draft-status') && !child.classList.contains('chat-form-error') && child.matches('p.chat-question-status,p.chat-notice,p.chat-message-status,p.chat-error'));
      const joined = messages.map(child => child.textContent).filter(Boolean).join(' · ');
      text(announcement, joined);
      for (const child of [...q.node.children]) {
        if (child !== announcement && !child.classList.contains('chat-form-draft-status') && !child.classList.contains('chat-form-error') && child.matches('p.chat-question-status,p.chat-notice,p.chat-message-status')) {
          child.hidden = true;
        }
      }
      const enabled = s.canWrite && s.questionsReady && !s.questionError && question?.status === 'paused' && !question.questionError && !form.sending && !form.locked;
      const identityOf = control => [
        control.tagName, control.type, control.name,
        control.closest('.chat-question-other') ? 'other-input' : control.getAttribute('aria-label'),
        control.dataset.action,
        ['radio', 'checkbox'].includes(control.type) ? control.value : ''
      ].join(':');
      const freshControls = new Map([...fresh.querySelectorAll('input,textarea,select,button')].map(control => [identityOf(control), control]));
      for (const control of q.node.querySelectorAll('input,textarea,select,button')) {
        const counterpart = freshControls.get(identityOf(control));
        control.disabled = !enabled || !counterpart || counterpart.disabled;
        if (control.tagName === 'BUTTON' && counterpart) {
          text(control, counterpart.textContent);
        }
        if (counterpart?.getAttribute('aria-label')) {
          control.setAttribute('aria-label', counterpart.getAttribute('aria-label'));
        }
      }
      const retry = fresh.querySelector('[data-action="retryAnswer"]');
      if (retry) {
        announcement.append(retry);
      }
    }
  }
  function captureHistory() {
    const oldTop = stream.scrollTop,
      bounds = stream.getBoundingClientRect();
    const previousHeight = stream.scrollHeight;
    const previousClientHeight = stream.clientHeight;
    const pinned = previousHeight - oldTop - previousClientHeight <= 2;
    const near = previousHeight - oldTop - previousClientHeight < previousClientHeight;
    const anchorNode = [...messageList.children].find(el => el.dataset.messageId && el.getBoundingClientRect().bottom > bounds.top && el.getBoundingClientRect().top < bounds.bottom);
    const anchor = anchorNode ? {
      node: anchorNode
    } : null;
    const anchorTop = anchor?.node.getBoundingClientRect().top;
    return {
      oldTop,
      previousHeight,
      previousClientHeight,
      pinned,
      near,
      anchor,
      anchorTop
    };
  }
  function preserveAttachmentLayout(change) {
    if (destroyed) return;
    const before = captureHistory();
    change();
    if (holdScroll(before.pinned, stream.scrollHeight - before.previousHeight, anchorShift(before.anchor?.node, before.anchorTop))) {
      scheduleFit();
      return;
    }
    if (before.pinned) stream.scrollTop = stream.scrollHeight;
    else if (before.anchor?.node.isConnected) stream.scrollTop = before.oldTop + before.anchor.node.getBoundingClientRect().top - before.anchorTop;
    scheduleFit();
  }
  function reconcileMessages(s, switched, before) {
    instanceTimeZone = s.tz ?? null;
    const {
      oldTop,
      previousHeight,
      previousClientHeight,
      pinned,
      near,
      anchor,
      anchorTop
    } = before;
    let added = 0,
      previousDay = null;
    const ordered = [],
      ids = new Set();
    for (const row of s.messages) {
      const id = String(row.id);
      ids.add(id);
      const day = dateLabel(row);
      if (day && day !== previousDay) {
        let divider = days.get(day);
        if (!divider) {
          divider = node('div', day, 'conversation-day');
          days.set(day, divider);
        }
        ordered.push(divider);
        previousDay = day;
      }
      let record = messages.get(id);
      if (record && record.content !== row.content) {
        record.resource?.destroy?.();
        record.node.remove();
        messages.delete(id);
        record = null;
      }
      if (!record) {
        record = makeMessage(row, s);
        messages.set(id, record);
        if (maxSeenId && laterThan(id, maxSeenId)) {
          added++;
        }
      } else {
        const attachmentKey = JSON.stringify(row.attachments || []);
        if (record.attachmentKey !== attachmentKey) {
          record.resource.updateAttachments(row.attachments || []);
          record.attachmentKey = attachmentKey;
        }
        patchMessage(record, row, s);
      }
      ordered.push(record.node);
    }
    disposeMissingMessages(messages, ids);
    placeActivity(s, ordered);
    const liveDays = new Set(ordered.filter(el => el.classList.contains('conversation-day')));
    for (const [day, divider] of days) {
      if (!liveDays.has(divider)) {
        divider.remove();
        days.delete(day);
      }
    }
    positionChildren(messageList, ordered);
    for (const record of messages.values()) record.resource?.mount?.();
    const follow = switched || !maxSeenId && s.messages.length || added && near && !s.gap
      || pinned && (stream.scrollHeight !== previousHeight || stream.clientHeight !== previousClientHeight);
    if (holdScroll(follow, stream.scrollHeight - previousHeight, anchorShift(anchor?.node, anchorTop))) {
      if (follow) unread = 0;
    } else if (follow) {
      stream.scrollTop = stream.scrollHeight;
      unread = 0;
    } else if (anchor?.node.isConnected && anchorTop !== undefined) {
      stream.scrollTop = oldTop + anchor.node.getBoundingClientRect().top - anchorTop;
    } else {
      stream.scrollTop = oldTop;
    }
    if (!switched && added && (!near || s.gap)) {
      unread += added;
    }
    if (s.messages.length) {
      maxSeenId = String(s.messages[s.messages.length - 1].id);
    }
    updateUnread();
  }
  const serverNow = s => Date.now() + (s?.activity?.offset ?? 0);
  function renderArea(entry, area, s) {
    activityEntries.set(entry.key, { entry, area });
    area.update(entry, { open: activityOpen.get(entry.key) === true, now: serverNow(s) });
  }
  function activityArea() {
    return createActivityArea({ document, t, onToggle: toggleActivity });
  }
  /** Reply work folds above it; follow-up work stays below the last loaded reply or after a later user message. */
  function placeActivity(s, ordered) {
    const placement = activityPlacement(s.messages, s.tab === 'mine' ? s.activity : null);
    activityEntries.clear();
    for (const [id, record] of messages) {
      if (!record.activitySlot) continue;
      for (const [slot, areas, entries] of [
        [record.activitySlot, record.activityAreas, placement.folded.get(Number(id)) ?? []],
        [record.afterActivitySlot, record.afterActivityAreas, placement.afterReply.get(Number(id)) ?? []]
      ]) {
        const keys = new Set(entries.map(entry => entry.key));
        for (const [key, area] of areas) if (!keys.has(key)) { area.node.remove(); areas.delete(key); }
        entries.forEach((entry, index) => {
          let area = areas.get(entry.key);
          if (!area) { area = activityArea(); areas.set(entry.key, area); }
          renderArea(entry, area, s);
          if (slot.children[index] !== area.node) slot.insertBefore(area.node, slot.children[index] ?? null);
        });
        slot.hidden = !entries.length;
      }
    }
    const keys = new Set(placement.trailing.map(entry => entry.key));
    for (const [key, item] of trailingActivity) if (!keys.has(key)) { item.node.remove(); trailingActivity.delete(key); }
    for (const entry of placement.trailing) {
      let item = trailingActivity.get(entry.key);
      if (!item) {
        const article = node('article', undefined, 'chat-message conversation-message chat-out conversation-activity-message');
        const avatar = node('span', undefined, 'conversation-avatar');
        avatar.append(icon(document, 'bot'));
        const body = node('div', undefined, 'conversation-message-body');
        const meta = node('div', undefined, 'conversation-message-meta');
        const author = node('span', t('chat.page.ai'), 'chat-message-author');
        meta.append(author);
        const area = activityArea();
        body.append(meta, area.node);
        article.append(avatar, body);
        item = { node: article, area, author };
        trailingActivity.set(entry.key, item);
      }
      text(item.author, t('chat.page.ai'));
      renderArea(entry, item.area, s);
      const anchor = messages.get(String(entry.anchor))?.node;
      const at = anchor ? ordered.indexOf(anchor) : -1;
      if (at < 0) { item.node.remove(); continue; }
      let position = at + 1;
      while (ordered[position]?.classList?.contains('conversation-activity-message')) position++;
      ordered.splice(position, 0, item.node);
    }
    const live = [...activityEntries.values()].some(({ entry }) => entry.live);
    if (live && activityTimer === null && view?.setInterval) activityTimer = view.setInterval(tickActivity, 1000);
    if (!live && activityTimer !== null) { view?.clearInterval(activityTimer); activityTimer = null; }
  }
  function tickActivity() {
    if (destroyed) return;
    for (const { entry, area } of activityEntries.values()) {
      if (entry.live) area.update(entry, { open: true, now: serverNow(currentSnapshot) });
    }
  }
  /** Opening or closing a part keeps it where it is on screen; nothing else moves under the user. */
  function toggleActivity(key) {
    const found = activityEntries.get(key);
    if (!found || destroyed) return;
    const head = found.area.node.firstElementChild;
    const before = head?.getBoundingClientRect().top;
    activityOpen.set(key, activityOpen.get(key) !== true);
    found.area.update(found.entry, { open: activityOpen.get(key), now: serverNow(currentSnapshot) });
    const shift = anchorShift(head, before);
    if (shift && !holdScroll(false, 0, shift)) stream.scrollTop += shift;
    scheduleFit();
  }
  function fitPage() {
    fitFrame = null;
    if (destroyed || !view || page.hidden || !page.isConnected || !page.getClientRects().length) {
      return;
    }
    const bounds = stream.getBoundingClientRect(),
      oldTop = stream.scrollTop;
    const bottom = stream.scrollHeight - oldTop - stream.clientHeight <= 2;
    const anchor = [...messageList.children].find(el => el.dataset.messageId && el.getBoundingClientRect().bottom > bounds.top && el.getBoundingClientRect().top < bounds.bottom);
    const anchorTop = anchor?.getBoundingClientRect().top;
    updateInputPlaceholder();
    fitInput();
    const available = Math.max(0, Math.floor(view.innerHeight - page.getBoundingClientRect().top));
    if (available !== fittedHeight) {
      fittedHeight = available;
      page.style.height = `${available}px`;
    }
    if (holdScroll(bottom, 0, anchorShift(anchor, anchorTop))) return;
    if (bottom) {
      stream.scrollTop = stream.scrollHeight;
    } else if (anchor?.isConnected) {
      stream.scrollTop = oldTop + anchor.getBoundingClientRect().top - anchorTop;
    } else {
      stream.scrollTop = oldTop;
    }
  }
  function scheduleFit() {
    if (destroyed || !view || fitFrame !== null) {
      return;
    }
    fitFrame = view.requestAnimationFrame(fitPage);
  }
  view?.addEventListener('resize', scheduleFit);
  if (view?.ResizeObserver) {
    fitObserver = new view.ResizeObserver(scheduleFit);
    const header = document.querySelector('.app-header');
    if (header) {
      fitObserver.observe(header);
    }
    if (root.parentElement) {
      fitObserver.observe(root.parentElement);
    }
  }
  const blockedNotice = node('div', undefined, 'chat-notice conversation-blocked-notice');
  const blockedTitle = node('strong'),
    blockedExplanation = node('span');
  blockedNotice.append(icon(document, 'lock'), blockedTitle, blockedExplanation);
  function redraw() {
    if (destroyed) {
      return;
    }
    const before = captureHistory();
    const s = state.snapshot();
    currentSnapshot = s;
    instanceTimeZone = s.tz ?? null;
    for (const {
      button,
      title,
      key
    } of actions) {
      text(title, label(key));
      button.setAttribute('aria-label', label(key));
    }
    text(gapLabel, t('chat.page.historyGap'));
    text(hint, t('chat.page.sendHint'));
    text(updateNotice, t('chat.page.updateRetry'));
    sidebar.setAttribute('aria-label', t('chat.conversations'));
    detail.setAttribute('aria-label', t('chat.history'));
    stream.setAttribute('aria-label', t('chat.history'));
    input.setAttribute('aria-label', t('chat.input'));
    renameInput.setAttribute('aria-label', t('chat.name'));
    if (s.blocked) {
      uploadTray.clear();
      input.value = '';
      renameInput.value = '';
      list.replaceChildren();
      messageList.replaceChildren();
      listRows.clear();
      for (const record of messages.values()) record.resource?.destroy?.();
      messages.clear();
      days.clear();
      selectedKey = null;
      maxSeenId = null;
      unread = 0;
      text(blockedTitle, t('chat.remoteDisabled'));
      text(blockedExplanation, t('chat.page.remoteExplanation'));
      root.replaceChildren(blockedNotice);
      return;
    }
    if (page.parentNode !== root) {
      root.replaceChildren(page);
    }
    const key = `${s.tab}:${s.selectedId ?? ''}`;
    const switched = selectedKey !== key;
    if (switched || s.blocked) {
      selectedKey = key;
      unread = 0;
      maxSeenId = null;
      renaming = false;
      renameForm.hidden = true;
      renameInput.value = '';
      for (const record of messages.values()) record.resource?.destroy?.();
      messages.clear();
      days.clear();
      messageList.replaceChildren();
    }
    if (switched && s.selectedId) {
      mobileDetail(true);
    }
    page.classList.toggle('conversation-blocked', !!s.blocked);
    sidebar.hidden = !!s.blocked;
    header.hidden = !s.selectedId || s.blocked;
    applyList();
    history.hidden = !!s.blocked;
    if (!s.canCreate) {
      creating = false;
      createName.value = '';
    }
    create.hidden = s.tab !== 'mine' || creating || !s.canCreate && s.mode !== 'single';
    create.disabled = !s.canCreate || !!s.loading || !!s.creatingDraft || creationPending;
    createForm.hidden = !creating || !s.canCreate;
    createSubmit.disabled = !s.canCreate || !!s.creatingDraft || creationPending;
    createCancel.disabled = !!s.creatingDraft || creationPending;
    createName.disabled = !!s.creatingDraft || creationPending;
    createName.placeholder = t('chat.page.createName');
    createName.setAttribute('aria-label', t('chat.page.createName'));
    externalSection.hidden = s.tab !== 'external';
    text(externalSection.lastElementChild, t('chat.page.externalSection'));
    reload.disabled = !!s.loading;
    for (const [tab, button] of Object.entries(tabButtons)) {
      button.setAttribute('aria-selected', String(s.tab === tab));
    }
    const live = new Set();
    const ordered = [];
    for (const item of s.items) {
      live.add(item.id);
      let row = listRows.get(item.id);
      if (!row) {
        const wrapper = node('div', undefined, 'conversation-list-row');
        const button = node('button', undefined, 'chat-list-item conversation-list-item');
        button.type = 'button';
        button.dataset.conversationId = item.id;
        const symbol = node('span', undefined, 'conversation-list-icon');
        symbol.append(icon(document, s.tab === 'mine' ? 'monitor' : channelIcon({
          sessionGroup: item.sessionGroup ?? item.session_group,
          c4: {
            componentName: channelOf(item)
          }
        })));
        const body = node('span', undefined, 'conversation-list-body'),
          top = node('span', undefined, 'conversation-list-title');
        const name = node('strong'),
          channel = node('span', undefined, 'conversation-list-channel'),
          draft = node('span', t('chat.draft'), 'conversation-draft'),
          time = node('time', undefined, 'conversation-list-time');
        const preview = node('span', undefined, 'chat-preview');
        top.append(name, channel, draft, time);
        body.append(top, preview);
        button.append(symbol, body);
        button.addEventListener('click', () => {
          mobileDetail(true);
          void state.select(item.id);
        });
        const remove = action('chat.delete.button', () => deletion.remove(item), 'trash', 'wb-icon-btn conversation-delete');
        const notice = node('span', undefined, 'conversation-delete-status');
        notice.setAttribute('role', 'status');
        wrapper.append(button, remove, notice);
        row = {
          wrapper, remove, notice,
          button,
          name,
          channel,
          draft,
          time,
          preview
        };
        listRows.set(item.id, row);
      }
      const deletionState = deletion.status(item);
      row.remove.hidden = !s.canDelete || !local() || !deletionPath(item);
      row.remove.disabled = deletionState?.busy === true;
      const deletionLabel = deletionState?.state === 'pending' || deletionState?.state === 'error' ? 'chat.delete.retry' : 'chat.delete.button';
      text(row.remove.label, t(deletionLabel));
      row.remove.setAttribute('aria-label', t(deletionLabel) + ': ' + nameOf(item));
      row.remove.setAttribute('title', t(deletionLabel));
      row.notice.hidden = !deletionState?.state || !['deleting', 'pending', 'error', 'stale'].includes(deletionState.state);
      text(row.notice, row.notice.hidden ? '' : t('chat.delete.' + deletionState.state));
      const itemChannel = channelOf(item);
      row.channel.hidden = s.tab === 'mine' || !itemChannel;
      text(row.channel, channelLabel(itemChannel));
      text(row.name, nameOf(item));
      const preview = item.preview || t(item.draft ? 'chat.page.blankPreview' : 'chat.page.noMessages');
      text(row.preview, (item.preview && item.previewDirection === 'in' ? t('chat.page.previewYou') : '') + preview);
      text(row.draft, t('chat.draft'));
      row.draft.hidden = !(item.draft || item.state === 'draft');
      row.button.classList.toggle('selected', item.id === s.selectedId);
      row.button.setAttribute('aria-current', item.id === s.selectedId ? 'true' : 'false');
      const date = asDate(Number.isFinite(item.stamp) && item.stamp > 0 ? (item.stamp - 2440587.5) * 86400000 : null);
      text(row.time, date ? relativeTime(date) : '');
      if (date) {
        row.time.dateTime = date.toISOString();
      }
      ordered.push(row.wrapper);
    }
    for (const [id, row] of listRows) {
      if (!live.has(id)) {
        row.wrapper.remove();
        listRows.delete(id);
      }
    }
    positionChildren(list, ordered);
    more.hidden = !s.nextCursor;
    more.disabled = !!s.loading;
    listNotice.hidden = !!s.items.length && !s.loading;
    text(listNotice, t(s.loading ? 'chat.loading' : s.tab === 'mine' ? 'chat.page.emptyMine' : 'chat.page.emptyExternal'));
    const completionText = [];
    if (deletionResult?.retainedMessages > 0 && deletionResult.groupDataRetained === true) {
      completionText.push(t('chat.delete.retained', { count: deletionResult.retainedMessages }));
    }
    if (deletionResult?.countsEstimated === true) completionText.push(t('chat.delete.estimated'));
    deletionNotice.hidden = !local() || !completionText.length || deletionResult.identity !== (typeof identity === 'function' ? identity() : identity);
    text(deletionNotice, deletionNotice.hidden ? '' : completionText.join(document.documentElement?.lang?.startsWith('zh') ? '' : ' '));
    accessNotice.hidden = s.mode !== 'single' || s.tab !== 'mine';
    text(accessText, t('chat.single'));
    const outcome = receiptState(s.receipt);
    const showReceipt = !!s.receipt && ['not_stored', 'pending_reconciliation'].includes(outcome);
    const duplicateSendError = showReceipt && ['chat.error.requestFailed', 'chat.error.sendUnknown'].includes(conversationErrorKey(s.error));
    errorNotice.hidden = !s.error || duplicateSendError || s.receipt?.stored === true && s.error === s.receipt.error;
    text(errorNotice, s.error ? t(conversationErrorKey(s.error)) : '');
    updateNotice.hidden = !s.updateError;
    streamHint.dataset.streamState = s.streamState;
    text(streamHint, t('chat.page.push.' + s.streamState));
    const current = s.conversation ?? s.items.find(item => item.id === s.selectedId);
    text(title, nameOf(current, s.tab === 'external'));
    const rateWait = s.groupWait?.kind === 'rate_wait';
    const healthLabel = { rate_limited: 'rateLimited', recovering: 'recovering', auth_failed: 'authFailed',
      unavailable: 'unavailable', down: 'down' }[s.groupHealth];
    const waitLabel = { rate_wait: 'rateLimited', auth_wait: 'authFailed', fenced: 'paused',
      starting: 'starting', start_failed: 'startFailed', unknown: 'healthUnknown' }[s.groupWait?.kind];
    const waiting = s.groupHealth === 'ok' && s.groupWait?.kind === 'unknown';
    const headerLabel = healthLabel ?? (waiting ? 'waiting' : waitLabel) ?? (s.groupHealth === 'ok' ? 'running' : 'healthUnknown');
    const restricted = headerLabel !== 'running' && !waiting;
    running.hidden = s.groupPresence !== true && (!(restricted || waiting) || !healthLabel && !s.groupWait);
    running.classList.toggle('conversation-restricted', restricted);
    running.classList.toggle('conversation-waiting', waiting);
    text(running.lastElementChild, t('chat.page.' + headerLabel
      + (rateWait && ['rateLimited', 'recovering'].includes(headerLabel) ? 'Pending' : '')));
    const channel = channelOf(current);
    const symbol = s.tab === 'mine' ? 'monitor' : channelIcon({
      sessionGroup: current?.sessionGroup ?? current?.session_group,
      c4: {
        componentName: channel
      }
    });
    if (headerIcon.dataset.icon !== symbol) {
      headerIcon.replaceChildren(icon(document, symbol));
      headerIcon.dataset.icon = symbol;
    }
    text(subtitle, channelLabel(channel) + ' · ' + t(s.tab === 'mine' ? 'chat.page.selfCreated' : 'chat.page.readOnly'));
    renameToggle.hidden = !s.canWrite;
    renameSave.disabled = s.loading || s.sending;
    readNew.hidden = !s.selectedId || isDraft(s);
    statusCheck.hidden = !s.selectedId || isDraft(s) || s.tab === 'external';
    readNew.disabled = !!s.loading;
    statusCheck.disabled = !!s.loading;
    group.hidden = !groupSide || !(current?.sessionGroup ?? current?.session_group) || isDraft(s);
    // The side panel belongs to the conversation it was opened from.
    if (groupSide?.open && (group.hidden || s.selectedId !== groupSideFor)) groupSide.close({ focus: false });
    older.hidden = !s.messageCursor;
    older.disabled = !!s.loading;
    gap.hidden = !s.gap;
    gapLoad.disabled = !!s.loading;
    questionNotice.hidden = s.tab !== 'mine' || !s.selectedId || isDraft(s) || !s.questionsLoading && !s.questionError && s.questionsReady;
    text(questionNotice, t(s.questionsLoading ? 'chat.questions.loading' : 'chat.questions.unavailable'));
    questionMore.hidden = !s.questionCursor;
    questionMore.disabled = !!s.questionsLoading;
    historyNotice.hidden = !!s.messages.length || !!s.blocked;
    text(historyNotice, t(!s.selectedId ? 'chat.select' : s.loading ? 'chat.loading' : isDraft(s) ? 'chat.page.draftExplanation' : 'chat.page.noMessages'));
    const showComposer = !!s.selectedId && s.tab === 'mine' && (s.canWrite || s.mode === 'single');
    if (!s.canWrite) {
      renameForm.remove();
    } else if (renameForm.parentNode !== detail) {
      detail.insertBefore(renameForm, notices);
    }
    if (!showComposer) {
      composer.remove();
    } else if (composer.parentNode !== detail) {
      detail.insertBefore(composer, readOnlyFooter);
    }
    composer.hidden = !showComposer;
    readOnlyFooter.hidden = s.tab !== 'external' || !s.selectedId;
    text(readOnlyFooter.lastElementChild, t('chat.page.externalReadOnly'));
    composer.classList.toggle('conversation-composer-disabled', s.mode === 'single');
    updateInputPlaceholder(s.mode);
    input.disabled = !s.canWrite || !!s.sending;
    if (input.value !== s.input) {
      input.value = s.input;
    }
    fitInput();
    send.dataset.action = s.retryRequired ? 'retry' : 'send';
    text(send.label, t(s.retryRequired ? 'chat.retry' : 'chat.send'));
    send.title = t(s.retryRequired ? 'chat.retry' : 'chat.send');
    send.setAttribute('aria-label', send.title);
    void uploadTray.setScope(uploadScope(s));
    const upload = uploadTray.snapshot();
    const limits = upload.config ? t('chat.upload.limits').replace('{size}', String(upload.config.maxUploadBytes / (1024 * 1024))).replace('{count}', String(upload.config.maxAttachments)) : '';
    attach.title = [t('chat.attach'), limits].filter(Boolean).join(' · ');
    const keys = s.retryRequired ? t('chat.page.retryHint') : touchFirst(view) ? '' : t('chat.page.keyHint');
    text(hint, [keys, t('chat.upload.pasteDrop'), limits, t('chat.page.sendHint')].filter(Boolean).join(' · '));
    attach.hidden = !s.canWrite;
    attach.disabled = !s.canWrite || !!s.sending || s.retryRequired && !s.canRetry;
    fileInput.disabled = attach.disabled;
    const uploadIds = new Set(upload.items.map(item => item.localId));
    for (const [id, resource] of trayResources) if (!uploadIds.has(id)) {
      resource.destroy(); resource.node.remove(); trayResources.delete(id);
    }
    for (const [index, item] of upload.items.entries()) {
      let resource = trayResources.get(item.localId);
      if (!resource) {
        resource = createChatAttachment({ document, attachment: item, t, mode: 'tray', localUrl: item.previewUrl,
          onRemove: () => uploadTray.remove(item.localId), onRetry: () => { void uploadTray.retry(item.localId); } });
        resource.node.dataset.uploadId = item.localId;
        trayResources.set(item.localId, resource);
      }
      resource.update({ attachment: item, localUrl: item.previewUrl, disabled: !!s.sending || s.retryRequired && !s.canRetry });
      if (tray.children[index] !== resource.node) tray.insertBefore(resource.node, tray.children[index] || null);
      resource.mount();
    }
    tray.hidden = trayLabel.hidden = !upload.items.length;
    text(trayLabel, t('chat.upload.trayCount').replace('{count}', String(upload.items.length)));
    const uploadError = upload.error || (s.error === 'chat_attachment_unavailable' ? s.error : null);
    uploadNotice.hidden = !uploadError;
    text(uploadNotice, uploadError ? t('chat.upload.' + uploadError).replace('{count}', String(upload.config?.maxAttachments || 20)) : '');
    send.disabled = !s.canWrite || !!s.sending || s.retryRequired && !s.canRetry || !uploadTray.isSendable(s.input);
    receipt.hidden = !showReceipt;
    receipt.dataset.deliveryState = outcome || '';
    const receiptKey = outcome === 'not_stored' && s.mode === 'single'
      ? 'chat.page.receipt.notStoredReadOnly' : 'chat.page.receipt.' + outcome;
    text(receiptText, outcome ? t(receiptKey) : '');
    for (const reference of root.querySelectorAll('.chat-block-reference')) {
      reference.hidden = technicalDetails() !== true;
    }
    reconcileMessages(s, switched, before);
    scheduleFit();
  }
  let streamSubscriptionKey = 'null';
  const notifyStreamSubscription = () => {
    const subscription = state.streamSubscription(), next = JSON.stringify(subscription);
    if (next === streamSubscriptionKey) return;
    streamSubscriptionKey = next;
    onStreamSubscription(subscription);
  };
  const unsubscribe = state.subscribe(() => { redraw(); notifyStreamSubscription(); });
  redraw();
  return {
    streamSubscription: state.streamSubscription,
    streamStatus: state.streamStatus,
    streamEvent: state.streamEvent,
    async open(...args) {
      page.hidden = false;
      scheduleFit();
      await state.open(...args);
      await selectFirstDesktop();
    },
    async openGroup(sessionGroup, {
      channel
    } = {}) {
      if (typeof sessionGroup !== 'string' || !sessionGroup) {
        return false;
      }
      page.hidden = false;
      await state.open();
      const tab = (channel ?? sessionGroup.split(':')[0]) === 'dashboard' ? 'mine' : 'external';
      if (state.snapshot().tab !== tab) {
        await state.setTab(tab);
      }
      const matched = state.snapshot().items.find(item => (item.sessionGroup ?? item.session_group) === sessionGroup);
      const hex = [...new TextEncoder().encode(sessionGroup)].map(byte => byte.toString(16).padStart(2, '0')).join('').toUpperCase();
      const id = matched?.id ?? 'g:' + hex;
      const fallback = { id, session_group: sessionGroup, channel: channel ?? sessionGroup.split(':')[0] };
      await state.select(id, matched ?? fallback);
      mobileDetail(true);
      scheduleFit();
      return !state.snapshot().error;
    },
    close() {
      deletion.invalidate();
      deletionResult = null;
      groupSide?.close({ focus: false });
      page.hidden = true;
      state.close();
    },
    redraw() { redraw(); groupSide?.redraw(); },
    clearDrafts(scope) { uploadTray.clearForAuthentication(scope?.instance ? { instance: scope.instance } : undefined); state.clearDrafts(scope); },
    destroy() {
      deletion.invalidate();
      groupSide?.destroy();
      destroyed = true;
      uploadTray.destroy();
      for (const resource of trayResources.values()) resource.destroy();
      trayResources.clear();
      view?.removeEventListener('resize', scheduleFit);
      gesture.destroy();
      if (activityTimer !== null) view?.clearInterval(activityTimer);
      activityTimer = null;
      if (fitFrame !== null) {
        view?.cancelAnimationFrame(fitFrame);
      }
      fitObserver?.disconnect();
      unsubscribe();
      onStreamSubscription(null);
      state.destroy();
      listRows.clear();
      for (const record of messages.values()) record.resource?.destroy?.();
      messages.clear();
      days.clear();
      root.replaceChildren();
    }
  };
}
