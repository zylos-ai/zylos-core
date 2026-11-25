import { conversationStampMs } from './api-time.js';
import { countLabel } from '../count-label.js';
import { workingParts, workingText } from './working-display.js';
import { createUploadTray } from './chat-upload-tray.js';
import { createChatAttachment } from './chat-attachments.js';
import { copyText, element, icon } from './plain-text.js';
import { asDate } from './conversation-time.js';
import { formatZoned } from './instance-zone.js';
import { channelIcon, channelIcons } from './board.js';
import { createConversationState, isOriginConversation, isOwnChatMessage } from './conversation-state.js';
import { messageState, receiptState } from './chat-delivery-state.js';
import { renderQuestion } from './chat-questions.js';
import { conversationErrorKey, renderConversationContent } from './conversation-content.js';
import { createGroupSide } from './group-side.js';
import { createConversationConfig } from './conversation-config.js';
import { createLiveArea, livePresentation } from './conversation-activity.js';
import { createScrollGesture } from './scroll-gesture.js';
import { createConversationDeletion, deletionPath } from './conversation-delete.js';
import { createRowSwipe } from './conversation-swipe.js';
import { renderInternalMessage } from './conversation-internal.js';
import { composeContent, contentBytes, displayRow, previewLine, readableText, shortStamp, storedContent, MAX_CONTENT_BYTES } from './chat-compose-text.js';
import { createQuoteGesture } from './chat-quote-gesture.js';
import { createAnnotationUi, quoteAuthor } from './chat-annotations.js';
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
 * Whether a keydown in the composer sends the message. Enter sends and Shift+Enter starts a new line;
 * ⌘/Ctrl+Enter also sends. An Enter that commits an input method's composition never sends. On a
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
  composeDrafts = null,
  groupLinks = null,
  technicalDetails = () => false,
  local = () => false,
  confirm = async () => false,
  onStreamSubscription = () => {},
  // The viewed instance refused remote access (its switch is off); the host hides this page's tab.
  onRemoteDisabled = () => {},
  storage = globalThis.localStorage
} = {}) {
  let autoSelectPending = false, opened = false, selectionIdentity;
  let destroyed = false,
    currentSnapshot,
    selectedKey = null,
    timelineRevision = null,
    maxSeenId = null,
    renaming = false,
    creationPending = false;
  let fitFrame = null,
    fitObserver = null,
    fittedHeight = null;
  // The live activity area (created on first use) and the clock tick that keeps its running times current.
  let liveArea = null, liveItem = null;
  let settleTimer = null;
  let searchTimer = null, readTimer = null, readCandidate = null, reading = false, attemptedRead = 0;
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
        code: payload.error?.code ?? 'chat_request_failed',
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
    composeDrafts,
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
  const swipe = createRowSwipe({ document, enabled: () => view?.innerWidth <= 760 });
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
    conversationId: s.selectedId, uploadsUrl: endpoint(`/api/conversations/${encodeURIComponent(s.selectedId)}/uploads`) } : null;
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
  // The Origin conversation shows every row recorded under Origin, in single mode also other conversations' and
  // external chats' rows, so each of its rows names its own channel: an external chat's row as the external page
  // labels it, a Dashboard row with its conversation's name.
  const originPage = s => s.tab === 'mine' && isOriginConversation(s.selectedId);
  const externalRow = (row, s) => s.tab === 'external' || (originPage(s) && row.channel !== 'dashboard');
  // Only the Origin conversation's own rows can be quoted or answered on its page.
  const foreignRow = (row, s) => originPage(s) && !(row.channel === 'dashboard' && row.endpoint_id === 'origin');
  const messageAuthor = (row, s) => externalRow(row, s)
    ? t(row.direction === 'in' ? 'chat.external.received' : 'chat.external.sent', { channel: channelLabel(row.channel ?? '') })
    : originPage(s) ? t('chat.page.dashboardRow', { channel: channelLabel('dashboard'), name: row.conversationName ?? t('chat.unnamed') })
      : t(row.direction === 'in' ? 'chat.page.you' : 'chat.page.ai');
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
    if (destroyed || !autoSelectPending) return;
    if (current.blocked || current.selectedId || !(view?.innerWidth > 760)) {
      autoSelectPending = false;
      return;
    }
    if (!current.items.length) return;
    // A stream catch-up may provide the first list after open() has already returned.
    autoSelectPending = false;
    // The most recently active conversation: Origin is pinned first but opens only when it is the latest,
    // except in single, where Origin is the only conversation that can be written to.
    const latest = current.items.reduce((best, item) => (conversationStampMs(item.stamp) || 0) > (conversationStampMs(best.stamp) || 0) ? item : best, current.items[0]);
    const origin = current.mode === 'single' && current.tab === 'mine' ? current.items.find(item => isOriginConversation(item.id)) : null;
    await state.select((origin ?? latest).id);
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
      autoSelectPending = true;
      await state.setTab(tab);
      await selectFirstDesktop();
    }, tab === 'mine' ? 'monitor' : 'msg');
    button.setAttribute('role', 'tab');
    tabButtons[tab] = button;
    tabs.append(button);
  }
  const externalTabLabel = node('span', t('chat.external'), 'conversation-mobile-label');
  tabButtons.external.append(externalTabLabel);
  const reload = action('refresh', () => state.refresh(), 'restart', 'wb-icon-btn conversation-reload');
  listToolbar.append(tabs, reload);
  const create = action('create', async () => {
    if (creationPending || state.snapshot().creatingDraft || !state.snapshot().canCreate) {
      return;
    }
    creationPending = true;
    redraw();
    try {
      await state.createDraft();
      if (!state.snapshot().error) mobileDetail(true);
    } finally {
      creationPending = false;
      redraw();
    }
  }, 'plus', 'wb-btn wb-btn-primary conversation-create');
  const externalSection = node('div', undefined, 'conversation-external-section');
  externalSection.append(icon(document, 'lock'), node('span', t('chat.page.externalSection')));
  const searchInput = node('input', undefined, 'wb-input conversation-search');
  searchInput.type = 'search';
  searchInput.autocomplete = 'off';
  searchInput.addEventListener('input', () => {
    clearSearchTimer();
    searchTimer = view.setTimeout(() => {
      searchTimer = null;
      list.scrollTop = 0;
      void state.setSearch(searchInput.value);
    }, 300);
  });
  const newConversations = action('chat.page.newConversations', () => {
    list.scrollTop = 0;
    return state.refreshList();
  }, undefined, 'wb-btn conversation-list-update');
  const list = node('div', undefined, 'conversation-items');
  list.addEventListener('scroll', () => {
    if (opened && list.clientHeight > 0 && list.scrollHeight - list.scrollTop - list.clientHeight <= 24) {
      void state.loadMore();
    }
  }, { passive: true });
  const listNotice = node('p', undefined, 'chat-notice conversation-list-notice');
  const deletionNotice = node('p', undefined, 'chat-notice conversation-deletion-notice');
  deletionNotice.setAttribute('role', 'status');
  deletionNotice.hidden = true;
  sidebar.append(listToolbar, create, externalSection, searchInput, newConversations, list, deletionNotice, listNotice);
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
  const running = node('button', undefined, 'conversation-running wi-ind');
  running.type = 'button';
  running.addEventListener('click', () => {
    const current = currentSnapshot.conversation ?? currentSnapshot.items.find(item => item.id === currentSnapshot.selectedId);
    showGroupSide(current?.sessionGroup ?? current?.session_group, currentSnapshot.selectedId, { tab: 'timeline' });
  });
  const toggleRename = () => {
    renaming = !renaming;
    renameForm.hidden = !renaming;
    if (renaming) {
      renameInput.value = nameOf(currentSnapshot.conversation);
      renameInput.focus();
      renameInput.select();
    }
  };
  const renameToggle = action('rename', toggleRename, 'edit', 'wb-icon-btn');
  const connectionDot = node('span', undefined, 'conversation-connection-dot');
  connectionDot.setAttribute('aria-hidden', 'true');
  titleLine.append(title, connectionDot, renameToggle);
  const titleRow = node('div', undefined, 'conversation-title-row');
  heading.append(titleRow, subtitle);
  const streamHint = node('span', undefined, 'conversation-push-status');
  streamHint.setAttribute('role', 'status');
  const headerActions = node('div', undefined, 'conversation-header-actions');
  const group = action('chat.page.groupInfo', () => toggleGroupSide(), 'chev');
  const menuToggle = action('chat.page.menu', () => openConversationMenu(), 'more', 'wb-icon-btn conversation-menu-toggle');
  menuToggle.setAttribute('aria-haspopup', 'dialog');
  menuToggle.setAttribute('aria-expanded', 'false');
  headerActions.append(running, streamHint, group, menuToggle);
  titleRow.append(titleLine, headerActions);
  // Collapses the conversation list on wider screens; remembered like the dashboard's other view preferences.
  const listToggle = action('chat.page.hideList', () => toggleList(), 'menu', 'wb-icon-btn conversation-list-toggle');
  listToggle.dataset.action = 'listToggle';
  const listEntry = actions.at(-1);
  let listCollapsed = false;
  try { listCollapsed = storage?.getItem(LIST_KEY) === 'collapsed'; } catch {}
  header.append(listToggle, back, headerIcon, heading);
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
    (view?.innerWidth <= 760 ? menuToggle : renameToggle).focus();
  });
  renameForm.append(renameInput, renameSave, renameCancel);
  renameForm.addEventListener('submit', event => {
    event.preventDefault();
    if (currentSnapshot.canRename) {
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
  const historyStart = node('div', undefined, 'conversation-history-start');
  historyStart.setAttribute('role', 'status');
  const historyStartLabel = node('span', undefined, 'conversation-history-start-label');
  const olderRetry = action('chat.page.olderRetry', () => state.loadOlder(), undefined, 'wb-link-btn');
  olderRetry.dataset.action = 'retryOlder';
  historyStart.append(historyStartLabel, olderRetry);
  const gap = node('div', undefined, 'conversation-gap');
  const gapLabel = node('span', t('chat.page.historyGap'));
  const gapLoad = action('chat.page.loadGap', () => state.loadGap());
  gap.append(gapLabel, gapLoad);
  const messageList = node('div', undefined, 'conversation-message-list');
  const unreadDivider = node('div', undefined, 'conversation-unread-divider');
  const historyNotice = node('p', undefined, 'chat-notice conversation-history-notice');
  stream.append(historyStart, gap, historyNotice, messageList);
  const latest = action('chat.page.newMessages', () => state.jumpToLatest(), 'chev', 'wb-btn conversation-new-messages');
  latest.dataset.action = 'latest';
  history.append(stream, latest);
  const composer = node('form', undefined, 'conversation-composer chat-composer');
  const receipt = node('div', undefined, 'conversation-receipt chat-message-status');
  receipt.setAttribute('role', 'status');
  const receiptText = node('span');
  const receiptCheck = action('refreshStatus', () => state.refreshStatus(), 'check');
  receipt.append(receiptText, receiptCheck);
  const configFooter = node('div', undefined, 'conversation-config-footer');
  configFooter.hidden = true;
  const composeBox = node('div', undefined, 'conversation-compose-box');
  const input = node('textarea', undefined, 'conversation-input chat-input');
  input.rows = 1;
  input.setAttribute('aria-label', t('chat.input'));
  updateInputPlaceholder();
  const send = action('send', () => {}, 'send', 'wb-btn wb-btn-primary conversation-send');
  send.type = 'submit';
  const hint = node('p', t('chat.page.sendHint'), 'conversation-compose-hint');
  const mobileRetryHint = node('p', undefined, 'conversation-mobile-retry-hint');
  mobileRetryHint.hidden = true;
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
  // The quote bar: one quoted message above the input; its text goes to the message, × removes it.
  const quoteBar = node('div', undefined, 'conversation-quote-bar');
  quoteBar.hidden = true;
  const quoteBarIcon = icon(document, 'reply');
  quoteBarIcon.classList.add('conversation-quote-bar-icon');
  const quoteBarBody = node('button', undefined, 'conversation-quote-bar-body');
  quoteBarBody.type = 'button';
  quoteBarBody.dataset.action = 'quoteJump';
  const quoteBarWho = node('span', undefined, 'conversation-quote-bar-who'), quoteBarText = node('span', undefined, 'conversation-quote-bar-text');
  quoteBarBody.append(quoteBarWho, quoteBarText);
  const quoteBarClose = node('button', undefined, 'wb-icon-btn conversation-quote-bar-close');
  quoteBarClose.type = 'button';
  quoteBarClose.dataset.action = 'quoteCancel';
  quoteBarClose.append(icon(document, 'x'));
  quoteBar.append(quoteBarIcon, quoteBarBody, quoteBarClose);
  quoteBarBody.addEventListener('click', () => { const quote = currentSnapshot?.quote; if (quote) void locate(quote.id); });
  quoteBarClose.addEventListener('click', () => { if (state.setQuote(null)) input.focus({ preventScroll: true }); });
  const composeNotice = node('p', '', 'chat-notice conversation-compose-notice');
  composeNotice.setAttribute('role', 'status');
  composeNotice.hidden = true;
  let locateNotice = null;
  const annotations = createAnnotationUi({ document, t, root: page, composer, composeBox,
    narrow: () => (view?.innerWidth ?? 1280) <= 760, snapshot: () => state.snapshot(),
    author: id => { const row = state.snapshot().messages.find(item => String(item.id) === String(id)); return row ? { direction: row.direction, timestamp: String(row.timestamp ?? row.created_at ?? row.createdAt ?? '') } : null; },
    onAdd: item => { locateNotice = null; return state.addAnnotation(item); },
    onUpdate: (key, comment) => state.updateAnnotation(key, comment),
    onRemove: key => state.removeAnnotation(key),
    onLocate: id => locate(id) });
  composeBox.append(attach, annotations.count, input, send, fileInput);
  composer.append(receipt, trayLabel, tray, uploadNotice, composeNotice, quoteBar, mobileRetryHint, composeBox, hint);
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
  detail.append(header, renameForm, notices, history, composer, configFooter);
  page.append(sidebar, detail);
  const menuScrim = node('button', undefined, 'conversation-menu-scrim');
  menuScrim.type = 'button';
  menuScrim.hidden = true;
  menuScrim.setAttribute('aria-label', t('chat.page.cancel'));
  menuScrim.tabIndex = -1;
  menuScrim.addEventListener('click', () => closeConversationMenu());
  const menuSheet = node('section', undefined, 'conversation-menu-sheet');
  menuSheet.hidden = true;
  menuSheet.tabIndex = -1;
  menuSheet.setAttribute('role', 'dialog');
  menuSheet.setAttribute('aria-modal', 'true');
  menuSheet.setAttribute('aria-label', t('chat.page.menu'));
  const menuSource = node('span'), menuConnection = node('span');
  const menuInfo = (symbol, contents) => {
    const row = node('div', undefined, 'conversation-menu-info');
    row.append(icon(document, symbol), contents);
    return row;
  };
  const menuRename = action('rename', () => { closeConversationMenu(false); toggleRename(); }, 'edit', 'conversation-menu-item conversation-menu-rename');
  menuRename.dataset.action = 'page.menuRename';
  const menuGroup = action('chat.page.groupInfo', () => { closeConversationMenu(false); toggleGroupSide(); }, 'activity', 'conversation-menu-item conversation-menu-group');
  menuGroup.dataset.action = 'page.menuGroup';
  const menuGroupCopy = node('span', undefined, 'conversation-menu-copy');
  const menuGroupSummary = node('span', t('chat.page.groupSummary'), 'conversation-menu-summary');
  menuGroup.label.replaceWith(menuGroupCopy);
  menuGroupCopy.append(menuGroup.label, menuGroupSummary);
  const menuGroupChevron = icon(document, 'chev');
  menuGroupChevron.classList.add('conversation-menu-chevron');
  menuGroup.append(menuGroupChevron);
  // The non-gesture way to delete on phones: the open conversation, through the same confirmation.
  const menuDelete = action('chat.delete.button', () => {
    const item = deletableItem(currentSnapshot, currentSnapshot?.selectedId);
    closeConversationMenu(false);
    if (!item) return;
    // Back on the list, where the row shows how the deletion went.
    mobileDetail(false);
    return removeConversation(item);
  }, 'trash', 'conversation-menu-item conversation-menu-delete');
  menuDelete.dataset.action = 'page.menuDelete';
  const menuDeliveryHint = node('span', t('chat.page.sendHint'));
  menuSheet.append(node('div', undefined, 'conversation-menu-grab'), menuInfo('monitor', menuSource),
    menuInfo('wifi', menuConnection), node('div', undefined, 'conversation-menu-divider'), menuRename, menuGroup, menuDelete,
    menuInfo('info', menuDeliveryHint));
  page.append(menuScrim, menuSheet);
  function closeConversationMenu(focus = true) {
    if (menuSheet.hidden) return;
    menuSheet.hidden = menuScrim.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
    if (focus) menuToggle.focus();
  }
  function openConversationMenu() {
    if (!currentSnapshot?.selectedId || view?.innerWidth > 760) return;
    menuSheet.hidden = menuScrim.hidden = false;
    menuToggle.setAttribute('aria-expanded', 'true');
    ([menuRename, menuGroup, menuDelete].find(button => !button.hidden && !button.disabled) ?? menuSheet).focus();
  }
  const menuKeydown = event => {
    if (menuSheet.hidden) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeConversationMenu();
    } else if (event.key === 'Tab') {
      const buttons = [menuRename, menuGroup, menuDelete].filter(button => !button.hidden && !button.disabled);
      const first = buttons[0], last = buttons.at(-1);
      if (!first || event.shiftKey && document.activeElement === first || !event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        ((event.shiftKey ? last : first) ?? menuSheet).focus();
      }
    }
  };
  menuSheet.addEventListener('keydown', menuKeydown);
  const rowMenuScrim = node('button', undefined, 'conversation-row-menu-scrim');
  rowMenuScrim.type = 'button';
  rowMenuScrim.tabIndex = -1;
  rowMenuScrim.hidden = true;
  rowMenuScrim.addEventListener('click', () => closeRowMenu());
  const rowMenu = node('section', undefined, 'conversation-row-menu');
  rowMenu.hidden = true;
  rowMenu.tabIndex = -1;
  const rowMenuGrab = node('div', undefined, 'conversation-menu-grab');
  const rowPin = action('chat.page.pin', () => {
    const id = menuRow.id;
    closeRowMenu();
    return state.togglePin(id);
  }, 'pin', 'conversation-menu-item');
  const rowDelete = action('chat.page.rowDelete', () => {
    const item = deletableItem(currentSnapshot, menuRow.id);
    closeRowMenu();
    if (item) return removeConversation(item);
  }, 'trash', 'conversation-menu-item conversation-menu-delete');
  const rowMenuButtons = () => [rowPin, rowDelete].filter(button => !button.hidden && !button.disabled);
  rowMenu.append(rowMenuGrab, rowPin, rowDelete);
  page.append(rowMenuScrim, rowMenu);
  let menuRow = null;
  let rowPress = null, ignoreRowHoldClick = false, touchRowPress = false;
  const isContact = event => event.pointerType === 'touch' || event.pointerType === 'pen';
  function cancelRowPress() {
    if (rowPress) view.clearTimeout(rowPress.timer);
    rowPress = null;
  }
  page.addEventListener('pointerdown', event => {
    ignoreRowHoldClick = false;
    touchRowPress = isContact(event);
  }, true);
  list.addEventListener('pointerdown', event => {
    cancelRowPress();
    if (!event.isPrimary || event.button !== 0 || !isContact(event)) return;
    const row = listRows.get(event.target.closest?.('.conversation-list-item')?.dataset.conversationId);
    if (!row) return;
    rowPress = {
      id: event.pointerId, x: event.clientX, y: event.clientY,
      timer: view.setTimeout(() => {
        rowPress = null;
        if (!opened || !row.wrapper.isConnected) return;
        ignoreRowHoldClick = true;
        if (!row.menuToggle.hidden) openRowMenu(row, true);
      }, 500)
    };
  });
  list.addEventListener('pointermove', event => {
    if (rowPress?.id === event.pointerId && Math.hypot(event.clientX - rowPress.x, event.clientY - rowPress.y) > 10) {
      cancelRowPress();
    }
  });
  function endRowPress(event) {
    if (rowPress?.id === event.pointerId) cancelRowPress();
  }
  list.addEventListener('pointerup', endRowPress);
  list.addEventListener('pointercancel', endRowPress);
  list.addEventListener('contextmenu', event => {
    if ((isContact(event) || touchRowPress) && event.target.closest?.('.conversation-list-item')) event.preventDefault();
  });
  // A touch release can send mouse events to the scrim now covering the row.
  page.addEventListener('mousedown', event => {
    if (ignoreRowHoldClick) event.preventDefault();
  }, true);
  page.addEventListener('click', event => {
    if (!ignoreRowHoldClick || event.detail === 0) return;
    ignoreRowHoldClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
  function closeOutsideRowMenu(event) {
    if (ignoreRowHoldClick && event.detail > 0 && page.contains(event.target)) return;
    if (!rowMenu.contains(event.target) && !menuRow?.menuToggle.contains(event.target)) closeRowMenu();
  }
  function closeRowMenu(focus = true) {
    if (!menuRow) return;
    const { menuToggle } = menuRow;
    menuRow = null;
    rowMenu.hidden = rowMenuScrim.hidden = true;
    menuToggle.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', closeOutsideRowMenu, true);
    if (focus) menuToggle.focus({ preventScroll: true });
  }
  function updateRowMenu(row) {
    rowPin.hidden = !row.canPin;
    rowPin.disabled = currentSnapshot.savingPins;
    const pinLabel = t(row.isPinned ? 'chat.page.unpin' : 'chat.page.pin');
    text(rowPin.label, pinLabel);
    rowPin.setAttribute('aria-label', pinLabel);
    rowDelete.hidden = row.remove.hidden || !row.notice.hidden;
    rowDelete.disabled = row.remove.disabled;
    rowMenu.setAttribute('aria-label', row.menuToggle.getAttribute('aria-label'));
    rowMenuScrim.setAttribute('aria-label', t('chat.page.cancel'));
  }
  function openRowMenu(row, fromHold = false) {
    if (menuRow === row) {
      closeRowMenu();
      return;
    }
    closeRowMenu(false);
    swipe.close();
    const mobile = view?.innerWidth <= 760;
    menuRow = row;
    updateRowMenu(row);
    row.menuToggle.setAttribute('aria-expanded', 'true');
    rowMenu.setAttribute('role', mobile ? 'dialog' : 'menu');
    if (mobile) rowMenu.setAttribute('aria-modal', 'true');
    else rowMenu.removeAttribute('aria-modal');
    for (const button of [rowPin, rowDelete]) {
      if (mobile) button.removeAttribute('role');
      else button.setAttribute('role', 'menuitem');
    }
    rowMenu.hidden = false;
    rowMenuGrab.hidden = rowMenuScrim.hidden = !mobile;
    if (mobile) {
      rowMenu.style.removeProperty('left');
      rowMenu.style.removeProperty('top');
    } else {
      const anchor = (fromHold ? row.button : row.menuToggle).getBoundingClientRect();
      const { width, height } = rowMenu.getBoundingClientRect();
      rowMenu.style.left = Math.max(4, anchor.right - width) + 'px';
      const below = anchor.bottom + 4;
      rowMenu.style.top = (below + height <= view.innerHeight ? below : Math.max(4, anchor.top - height - 4)) + 'px';
      document.addEventListener('click', closeOutsideRowMenu, true);
    }
    (rowMenuButtons()[0] ?? rowMenu).focus({ preventScroll: true });
  }
  rowMenu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeRowMenu();
      return;
    }
    const buttons = rowMenuButtons();
    const index = buttons.indexOf(document.activeElement);
    const mobile = !rowMenuScrim.hidden;
    if (event.key === 'Tab' && !mobile) {
      closeRowMenu();
    } else if (event.key === 'Tab' || ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const backward = event.key === 'ArrowUp' || event.key === 'Tab' && event.shiftKey;
      const last = buttons.length - 1;
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? last
        : backward ? (index <= 0 ? last : index - 1) : (index >= last ? 0 : index + 1);
      (buttons[next] ?? rowMenu).focus();
    }
  });
  const dismissRowMenu = () => {
    cancelRowPress();
    closeRowMenu();
  };
  list.addEventListener('scroll', dismissRowMenu);
  function resizeRowMenu() {
    dismissRowMenu();
    for (const row of listRows.values()) {
      row.menuToggle.setAttribute('aria-haspopup', view.innerWidth <= 760 ? 'dialog' : 'menu');
    }
  }
  view?.addEventListener('resize', resizeRowMenu);
  // The group's detail opens beside the conversation (over it on narrow screens), never on the overview.
  let groupSideFor = null;
  const groupSide = groupLinks ? createGroupSide({ document, t, fetch: fetcher, endpoint, identity: () => typeof identity === 'function' ? identity() : identity,
    ...groupLinks, isVisible: () => !destroyed && !page.hidden && document.visibilityState !== 'hidden',
    // The panel only shows the open conversation's group, whose conversation is this one: going to it just closes.
    onConversation: () => groupSide.close(),
    onConfigSaved: key => quickConfig.reload(key),
    onClose: ({ focus, hide }) => {
      groupSideFor = null;
      // Hiding inside the preserved change keeps the reading position (or the pin to the bottom) as the column widens.
      preserveAttachmentLayout(() => { hide(); page.classList.toggle('conversation-has-side', false); });
      group.setAttribute('aria-expanded', 'false');
      if (focus && !group.hidden) (view?.innerWidth <= 760 ? menuToggle : group).focus();
    } }) : null;
  const quickConfig = groupLinks ? createConversationConfig({ document, t,
    request: (path, options) => fetcher(endpoint(path), options),
    identity: () => typeof identity === 'function' ? identity() : identity,
    writable: groupLinks.writable ?? (() => true), detail: groupLinks.detail ?? (() => 'plain'),
    onConfigSaved: key => groupSide.reloadConfig(key),
  }) : null;
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
  function updateWorkingIndicator(s) {
    const rateWait = s.groupWait?.kind === 'rate_wait';
    const healthLabel = { rate_limited: 'rateLimited', recovering: 'recovering', auth_failed: 'authFailed',
      unavailable: 'unavailable', down: 'down' }[s.groupHealth];
    // A session being started is the group waking: it shows working, like the work it starts for.
    const waking = !healthLabel && s.groupWait?.kind === 'starting';
    const waitLabel = { rate_wait: 'rateLimited', auth_wait: 'authFailed', fenced: 'paused', pool_wait: 'queueing',
      start_failed: 'startFailed', unknown: 'healthUnknown' }[s.groupWait?.kind];
    const waiting = s.groupHealth === 'ok' && ['unknown', 'pool_wait'].includes(s.groupWait?.kind);
    const headerLabel = waking ? 'running' : healthLabel ?? (waiting && s.groupWait?.kind === 'unknown' ? 'waiting' : waitLabel) ?? (s.groupHealth === 'ok' ? 'running' : 'healthUnknown');
    const restricted = headerLabel !== 'running' && !waiting;
    const exceptional = headerLabel !== 'running';
    const origin = s.tab === 'mine' && isOriginConversation(s.selectedId);
    // Origin starts on demand in both modes. Only multi shows the Asleep label.
    const asleep = origin && s.mode === 'multi' && s.groupPresence === false && !healthLabel && !s.groupWait;
    const working = !exceptional && !waking && s.groupPresence === true ? s.groupWorking : null;
    const busy = waking || !!working?.on;
    running.hidden = asleep || waking ? false : exceptional ? s.groupPresence !== true && !healthLabel && !s.groupWait : !working;
    running.classList.toggle('conversation-restricted', !asleep && exceptional && restricted);
    running.classList.toggle('conversation-waiting', asleep || exceptional && waiting);
    const wasBusy = running.dataset.state === 'busy';
    running.dataset.state = asleep ? 'asleep' : exceptional ? restricted ? 'restricted' : 'waiting' : busy ? 'busy' : 'idle';
    // Asleep shows one word; the explanation (a message wakes it, the first reply is slower) is in the tooltip.
    const description = asleep ? t('chat.page.origin.asleepShort') : waking ? t('chat.page.waking') : exceptional ? t('chat.page.' + headerLabel
      + (rateWait && ['rateLimited', 'recovering'].includes(headerLabel) ? 'Pending' : ''))
      : workingText(working, { t, scheduled: origin && s.groupProcessing === 'scheduled_task' });
    const mark = asleep ? node('span', undefined, 'wi-dot') : exceptional ? icon(document, 'activity') : busy ? icon(document, 'loader') : node('span', undefined, 'wi-dot');
    if (busy) mark.classList.add('wi-spin');
    const captionParts = !asleep && !exceptional && !waking ? workingParts(working, { t,
      scheduled: origin && s.groupProcessing === 'scheduled_task' }) : null;
    const caption = node('span', captionParts?.main ?? description, 'wi-ind-text wi-ind-desktop');
    if (captionParts?.children) caption.append(node('span', ' · ' + captionParts.children, 'wi-ind-sub'));
    const mobileCaption = waking ? { main: description } : working?.on ? workingParts(working, { t,
      scheduled: origin && s.groupProcessing === 'scheduled_task', compact: true }) : null;
    const compact = mobileCaption ? node('span', mobileCaption.main, 'wi-ind-text wi-ind-mobile') : null;
    const chevron = icon(document, 'chev'); chevron.classList.add('wi-ind-chev');
    const existingComet = [...running.children].find(child => child.classList.contains('wi-comet'));
    if (busy && existingComet) {
      // Snapshot updates refresh the caption without restarting the border animation.
      for (const child of [...running.children]) if (child !== existingComet) child.remove();
      running.append(mark, caption, ...(compact ? [compact] : []), chevron);
    } else {
      running.replaceChildren(mark, caption, ...(compact ? [compact] : []), chevron);
    }
    if (busy && !existingComet) {
      const comet = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      comet.setAttribute('class', 'wi-comet');
      comet.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < 7; i++) {
        const trail = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        trail.setAttribute('pathLength', '100');
        comet.append(trail);
      }
      running.prepend(comet);
    }
    const accessible = t('chat.working.timeline', { state: asleep ? t('chat.page.origin.asleep') : description });
    running.setAttribute('aria-label', accessible); running.title = accessible;
    if (wasBusy && working && !working.on) {
      running.classList.add('wi-settle');
      if (settleTimer !== null) view?.clearTimeout(settleTimer);
      settleTimer = view?.setTimeout?.(() => { settleTimer = null; running.classList.remove('wi-settle'); }, 1200) ?? null;
    } else if (!working || working.on) {
      running.classList.remove('wi-settle');
    }
  }
  function toggleGroupSide() {
    if (!groupSide) return;
    if (groupSide.open) { groupSide.close(); return; }
    const current = currentSnapshot.conversation ?? currentSnapshot.items.find(item => item.id === currentSnapshot.selectedId);
    showGroupSide(current?.sessionGroup ?? current?.session_group, currentSnapshot.selectedId);
  }
  function showGroupSide(key, conversationId, options) {
    if (!key) return;
    groupSideFor = conversationId;
    // The panel appears inside the preserved change, so the position measured before is the one before it opened.
    preserveAttachmentLayout(() => { void groupSide.show(key, options); page.classList.toggle('conversation-has-side', true); });
    group.setAttribute('aria-expanded', 'true');
  }
  root.replaceChildren(page);
  function updateInputPlaceholder(mode = currentSnapshot?.mode) {
    const key = mode === 'single' && !isOriginConversation(currentSnapshot?.selectedId) ? 'chat.page.singlePlaceholder'
      : currentSnapshot?.annotations?.length ? 'chat.page.annotationPlaceholder'
      : currentSnapshot?.quote ? 'chat.page.replyPlaceholder'
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
      updateUnread();
      reportVisibleRead();
    }
    // Only when nothing else took the focus meanwhile (the disabled editor leaves it on the page body).
    const focusFree = !document.activeElement || document.activeElement === document.body || document.activeElement === input;
    if (refocus && focusFree && !destroyed && selectedKey === selected && !input.disabled) input.focus();
  }
  const canDeleteItem = (s, item) => s?.canDelete && s.tab === 'mine' && local() && !!deletionPath(item);
  function deletableItem(s, id) {
    const item = s?.items.find(row => row.id === id);
    return canDeleteItem(s, item) ? item : null;
  }
  function removeConversation(item) {
    swipe.close();
    return deletion.remove(item);
  }
  function mobileDetail(open) {
    closeRowMenu(false);
    page.classList.toggle('conversation-detail-open', open);
    if (!open) quickConfig?.close();
    closeConversationMenu(false);
    syncMobileFocus();
    scheduleFit();
  }
  function syncMobileFocus() {
    const focus = opened && !page.hidden && !currentSnapshot?.blocked && !!currentSnapshot?.selectedId
      && page.classList.contains('conversation-detail-open') && view?.innerWidth <= 760;
    if (document.documentElement.dataset.conversationFocus !== String(focus)) {
      document.documentElement.dataset.conversationFocus = String(focus);
    }
    if (!focus) closeConversationMenu(false);
    reportVisibleRead();
  }
  function clearSearchTimer() {
    if (searchTimer !== null) view?.clearTimeout(searchTimer);
    searchTimer = null;
  }
  const atBottom = () => stream.scrollHeight - stream.scrollTop - stream.clientHeight <= 2;
  function updateUnread(s = currentSnapshot) {
    const count = s?.tab === 'mine' ? s.unreadCount || 0 : 0;
    const displayCount = count >= 100 ? '99+' : String(count);
    const loadedUnread = count ? s.messages.filter(row => row.id > s.readUpTo && !isOwnChatMessage(row)).length : 0;
    latest.hidden = !s?.historyLoaded || atBottom() && (!s.positionAtUnread || count <= loadedUnread);
    latest.label.hidden = !count;
    text(latest.label, displayCount);
    latest.setAttribute('aria-label', count
      ? countLabel(t, 'chat.page.newMessages', count, {}).replace('{count}', displayCount)
      : t('chat.history'));
  }
  function visibleReadPosition() {
    const s = currentSnapshot;
    if (!opened || page.hidden || s?.tab !== 'mine' || !s.historyLoaded || s.blocked
        || !Number.isSafeInteger(s.unreadCount) || document.visibilityState === 'hidden'
        || document.hasFocus?.() === false || !stream.clientHeight) return null;
    const bounds = stream.getBoundingClientRect();
    for (let index = s.messages.length - 1; index >= 0; index--) {
      const row = s.messages[index];
      if (row.id <= Math.max(s.readUpTo, attemptedRead)) break;
      const bottom = messages.get(String(row.id))?.node.getBoundingClientRect().bottom;
      if (bottom > bounds.top && bottom <= bounds.bottom && !isOwnChatMessage(row)) return row.id;
    }
    return null;
  }
  function cancelReadTimer() {
    if (readTimer !== null) view?.clearTimeout(readTimer);
    readTimer = null;
    readCandidate = null;
  }
  function reportVisibleRead() {
    if (reading) return;
    const upTo = visibleReadPosition();
    if (upTo === readCandidate) return;
    cancelReadTimer();
    if (!upTo) return;
    readCandidate = upTo;
    readTimer = view.setTimeout(async () => {
      readTimer = null;
      readCandidate = null;
      if (visibleReadPosition() !== upTo) return;
      attemptedRead = upTo;
      reading = true;
      try { await state.markRead(upTo); }
      finally { reading = false; reportVisibleRead(); }
    }, 700);
  }
  const readVisibilityChanged = () => { attemptedRead = currentSnapshot?.readUpTo ?? 0; reportVisibleRead(); };
  document.addEventListener?.('visibilitychange', readVisibilityChanged);
  view?.addEventListener('focus', readVisibilityChanged);
  view?.addEventListener('blur', cancelReadTimer);
  function maybeLoadOlder(underfilled = false) {
    const s = state.snapshot();
    if (destroyed || !opened || page.hidden || document.hidden || document.visibilityState === 'hidden'
      || !s.selectedId || s.blocked || !s.historyLoaded || isDraft(s)
      || !s.messageCursor || s.olderLoading || s.olderError || stream.clientHeight <= 0) return;
    if (underfilled ? messageList.scrollHeight >= stream.clientHeight : stream.scrollTop >= stream.clientHeight / 2) return;
    void state.loadOlder();
  }
  stream.addEventListener('scroll', () => {
    updateUnread();
    reportVisibleRead();
    maybeLoadOlder();
  }, {
    passive: true
  });
  // While the user drags, swipes or wheels the history, the page never writes its scroll position. Once the list
  // is still, it follows new content only if the user stayed at the bottom; a user who left it is not pulled back,
  // but the content that moved under them meanwhile (an older page, an opened attachment) is moved back by the same
  // amount, so what they were reading stays in view.
  const phone = () => view?.matchMedia?.('(max-width: 760px)')?.matches === true;
  const copyMenu = node('div', undefined, 'conversation-copy-menu');
  const copyMenuPanel = node('div', undefined, 'conversation-copy-menu-panel');
  const copyMenuButton = node('button');
  const selectTextButton = node('button');
  copyMenuButton.type = selectTextButton.type = 'button';
  copyMenuButton.append(icon(document, 'copy'), node('span'));
  selectTextButton.append(icon(document, 'file'), node('span'));
  copyMenuPanel.append(copyMenuButton, selectTextButton);
  copyMenu.append(copyMenuPanel);
  copyMenu.hidden = true;
  page.append(copyMenu);
  let menuRecord = null;
  let ignoreHoldClick = false;
  function closeCopyMenu() {
    copyMenu.hidden = true;
    menuRecord = null;
  }
  function showCopyMenu(article, target) {
    const record = messages.get(article.dataset.messageId);
    if (!record) return;
    menuRecord = record;
    ignoreHoldClick = true;
    text(copyMenuButton.lastElementChild, t('chat.copy.button'));
    text(selectTextButton.lastElementChild, t('chat.copy.select'));
    const bubble = target.closest('.chat-message-content').getBoundingClientRect();
    copyMenu.hidden = false;
    const panel = copyMenuPanel.getBoundingClientRect();
    const space = 8;
    const top = bubble.bottom + space + panel.height <= view.innerHeight
      ? bubble.bottom + space : bubble.top - panel.height - space;
    copyMenuPanel.style.top = `${Math.max(space, top)}px`;
    copyMenuPanel.style.right = `${Math.max(space, view.innerWidth - bubble.right)}px`;
  }
  copyMenu.addEventListener('pointerdown', () => { ignoreHoldClick = false; });
  copyMenu.addEventListener('click', event => {
    // The release that follows a long press can synthesize a click on the newly opened popup.
    if (ignoreHoldClick && event.detail > 0) {
      event.stopPropagation();
      return;
    }
    if (event.target === copyMenu) closeCopyMenu();
  }, true);
  copyMenuButton.addEventListener('click', () => {
    const record = menuRecord;
    closeCopyMenu();
    if (record) void copyMessage(record, true);
  });

  const selectTextDialog = node('dialog', undefined, 'conversation-select-text');
  const selectTextHeader = node('header', undefined, 'conversation-select-text-header');
  const selectTextBack = node('button', undefined, 'conversation-select-text-back');
  const selectTextTitle = node('h2');
  const selectTextBody = node('div', undefined, 'conversation-select-text-body');
  selectTextBack.type = 'button';
  selectTextBack.append(icon(document, 'back'));
  selectTextTitle.id = 'conversation-select-text-title';
  selectTextDialog.setAttribute('aria-labelledby', selectTextTitle.id);
  selectTextHeader.append(selectTextBack, selectTextTitle);
  selectTextDialog.append(selectTextHeader, selectTextBody);
  page.append(selectTextDialog);
  let selectionEntry = null;
  function leaveTextSelection() {
    if (selectTextDialog.open) selectTextDialog.close();
    selectTextBody.replaceChildren();
    selectionEntry = null;
  }
  function backFromTextSelection() {
    if (selectionEntry && view.history.state?.conversationSelectText === selectionEntry.id) view.history.back();
    else leaveTextSelection();
  }
  selectTextBack.addEventListener('click', backFromTextSelection);
  selectTextDialog.addEventListener('cancel', event => {
    event.preventDefault();
    backFromTextSelection();
  });
  selectTextButton.addEventListener('click', () => {
    const record = menuRecord;
    closeCopyMenu();
    if (!record) return;
    selectionEntry = {
      id: view.crypto.getRandomValues(new Uint32Array(1))[0],
      url: view.location.href,
    };
    view.history.pushState({ ...view.history.state, conversationSelectText: selectionEntry.id }, '', selectionEntry.url);
    selectTextBack.setAttribute('aria-label', t('chat.page.backToConversation'));
    text(selectTextTitle, t('chat.copy.select'));
    const messageText = record.resource.querySelectorAll('.chat-message-text');
    selectTextBody.replaceChildren(...Array.from(messageText, part => part.cloneNode(true)));
    // Keep links readable in the selection view without navigating away.
    for (const link of selectTextBody.querySelectorAll('a[href]')) link.removeAttribute('href');
    selectTextBody.scrollTop = 0;
    selectTextDialog.showModal();
  });
  const quoteGesture = createQuoteGesture({ list: messageList, document, enabled: () => quotable(currentSnapshot),
    onQuote: id => quoteMessage(id),
    canHold: (article, target) => phone() && touchFirst(view) && !page.hidden && Boolean(
      article.matches('.chat-in:not(.conversation-internal)') && target.closest('.chat-message-content')
      && !target.closest('a, button, input, textarea, select, summary, [contenteditable]')),
    onHold: showCopyMenu,
    setTimeout: (fn, ms) => view?.setTimeout ? view.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms),
    clearTimeout: id => view?.clearTimeout ? view.clearTimeout(id) : globalThis.clearTimeout(id) });
  const gesture = createScrollGesture(stream, {
    setTimeout: (fn, ms) => view?.setTimeout ? view.setTimeout(fn, ms) : globalThis.setTimeout(fn, ms),
    clearTimeout: id => view?.clearTimeout ? view.clearTimeout(id) : globalThis.clearTimeout(id),
    onSettle: () => {
      if (destroyed) return;
      if (followAfterGesture && stream.scrollHeight - stream.scrollTop - stream.clientHeight <= growthDuringGesture + 2) {
        stream.scrollTop = stream.scrollHeight;
        updateUnread();
        reportVisibleRead();
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
  function messageAvatar(row, s) {
    if (row.direction !== 'in') return 'bot';
    return externalRow(row, s)
      ? Object.hasOwn(channelIcons, row.channel) ? channelIcons[row.channel] : 'msg'
      : 'monitor';
  }
  function makeMessage(row, s) {
    if (row.channel === 'internal') {
      const date = asDate(row.timestamp ?? row.created_at ?? row.createdAt);
      const resource = renderInternalMessage({ document, row, t,
        onOpenPeer: (sessionGroup, channel) => openGroup(sessionGroup, { channel }),
        timeText: date ? clockText(date) : null, timeIso: date?.toISOString(),
        showTechnicalDetails: technicalDetails() === true, external: s.tab === 'external' });
      const quoteButton = quoteAction(row);
      resource.node.querySelector('.conversation-message-meta')?.append(quoteButton);
      return { node: resource.node, resource, content: row.content, quoteKey: JSON.stringify(row.quote ?? null), internal: true,
        attachmentKey: JSON.stringify(row.attachments || []), time: resource.time, date, quoteButton };
    }
    const article = node('article', undefined, 'chat-message conversation-message ' + (row.direction === 'in' ? 'chat-in' : 'chat-out'));
    article.dataset.messageId = String(row.id);
    const avatar = node('span', undefined, 'conversation-avatar');
    const avatarSymbol = messageAvatar(row, s);
    avatar.append(icon(document, avatarSymbol));
    const body = node('div', undefined, 'conversation-message-body');
    const meta = node('div', undefined, 'conversation-message-meta'),
      author = node('span', messageAuthor(row, s), 'chat-message-author');
    meta.append(author);
    const date = asDate(row.timestamp ?? row.created_at ?? row.createdAt);
    let timeNode = null;
    if (date) {
      timeNode = node('time', clockText(date));
      timeNode.dateTime = date.toISOString();
      meta.append(timeNode);
    }
    const quoteButton = quoteAction(row);
    const copyButton = node('button', undefined, 'conversation-copy-button');
    copyButton.type = 'button';
    copyButton.dataset.action = 'copy';
    const copyAction = node('span', undefined, 'conversation-copy-action');
    copyAction.append(copyButton);
    const copyFeedback = node('span', undefined, 'conversation-copy-feedback');
    const copyBubbleFeedback = node('span', undefined, 'conversation-copy-feedback conversation-copy-bubble-feedback');
    copyFeedback.setAttribute('role', 'status');
    copyBubbleFeedback.setAttribute('role', 'status');
    meta.append(quoteButton, copyAction, copyFeedback);
    const questions = [];
    const content = renderConversationContent({
      document,
      row: displayRow(row),
      t,
      showTechnicalDetails: technicalDetails() === true,
      chartTimeZone: () => instanceTimeZone,
      attachmentContext: { conversationId: s.selectedId, endpoint, fetch: fetcher, external: externalRow(row, s), onLayout: preserveAttachmentLayout },
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
    if (row.quote) content.prepend(quoteBlock(row.quote, s));
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
    body.append(meta, content, copyBubbleFeedback, status);
    article.append(avatar, body);
    const record = {
      node: article,
      avatar,
      avatarSymbol,
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
      quoteKey: JSON.stringify(row.quote ?? null),
      quoteButton,
      copyButton,
      copyFeedback,
      copyBubbleFeedback,
      time: timeNode,
      date
    };
    copyButton.addEventListener('click', () => { void copyMessage(record); });
    patchMessage(record, row, s);
    return record;
  }
  function renderCopyFeedback(record) {
    const { copyButton, copyResult, copyFromMenu } = record;
    const copied = copyResult === 'copied';
    const copyLabel = t(copied ? 'chat.copy.copied' : 'chat.copy.button');
    const title = copied ? copyLabel : t('chat.copy.title');
    copyButton.title = title;
    copyButton.setAttribute('aria-label', title);
    if (copyButton.dataset.copied !== String(copied)) {
      copyButton.dataset.copied = String(copied);
      copyButton.replaceChildren(icon(document, copied ? 'check' : 'copy'), node('span'));
    }
    text(copyButton.lastElementChild, copyLabel);
    const feedback = copyResult === 'failed' ? t('chat.copy.failed') : copied ? copyLabel : '';
    text(record.copyFeedback, copyFromMenu ? '' : feedback);
    record.copyFeedback.classList.toggle('conversation-copy-feedback-announcement', copied);
    text(record.copyBubbleFeedback, copyFromMenu ? feedback : '');
  }
  async function copyMessage(record, fromMenu = false) {
    const result = await copyText(readableText(record.row), view) ? 'copied' : 'failed';
    if (!record.node.isConnected) return;
    view.clearTimeout(record.copyTimer);
    record.copyResult = result;
    record.copyFromMenu = fromMenu;
    renderCopyFeedback(record);
    record.copyTimer = view.setTimeout(() => {
      record.copyResult = null;
      if (record.node.isConnected) renderCopyFeedback(record);
    }, result === 'copied' ? 2000 : 4000);
  }
  // Quoting: the hover button beside the time, a left swipe (touch, pen, trackpad) or a click on the history's quote.
  const quotable = s => !!s && s.tab === 'mine' && s.canWrite && !s.sending && !s.pending && !isDraft(s);
  function quoteAction(row) {
    const button = node('button', undefined, 'conversation-quote-button');
    button.type = 'button';
    button.dataset.action = 'quote';
    button.append(icon(document, 'reply'), node('span', t('chat.quote.button')));
    button.title = t('chat.quote.buttonTitle');
    button.setAttribute('aria-label', t('chat.quote.buttonTitle'));
    button.addEventListener('click', () => quoteMessage(row.id));
    return button;
  }
  function quoteMessage(id) {
    const s = state.snapshot();
    const row = s.messages.find(item => String(item.id) === String(id));
    if (!row || !quotable(s) || foreignRow(row, s)) return;
    locateNotice = null;
    if (!state.setQuote({ id: String(row.id), direction: row.direction === 'out' ? 'out' : 'in',
      timestamp: String(row.timestamp ?? row.created_at ?? row.createdAt ?? ''), text: previewLine(readableText(row)),
      internal: row.channel === 'internal' })) return;
    quoteBar.classList.remove('conversation-bump');
    void quoteBar.offsetWidth;
    quoteBar.classList.add('conversation-bump');
    if ((view?.innerWidth ?? 1280) > 760) input.focus({ preventScroll: true });
  }
  /** The history's quote block: who and when, the first two lines; a click shows the original message. */
  function quoteBlock(quote, s) {
    const block = node('button', undefined, 'conversation-quote-block');
    block.type = 'button';
    block.dataset.action = 'quoteOpen';
    block.dataset.quoteId = String(quote.id);
    if (quote.available !== true) {
      block.disabled = true;
      block.append(node('span', t('chat.quote.unavailable'), 'conversation-quote-block-who'));
      return block;
    }
    block.title = t('chat.quote.jump');
    block.append(node('span', `${quoteAuthor(quote, t)} · ${shortStamp(quote.timestamp, s.tz)}`, 'conversation-quote-block-who'),
      node('span', String(quote.preview ?? ''), 'conversation-quote-block-text'));
    block.addEventListener('click', event => { event.stopPropagation(); void locate(quote.id); });
    return block;
  }
  /** Shows a message; one that is not loaded yet is older, so earlier pages load until it appears. */
  async function locate(id) {
    const target = String(id), selected = selectedKey;
    if (!/^[1-9][0-9]{0,18}$/.test(target)) return;
    const find = () => messageList.querySelector(`article[data-message-id="${target}"]`);
    let article = find();
    while (!article && !destroyed && selectedKey === selected) {
      const before = state.snapshot();
      if (!before.messageCursor || before.olderError) break;
      // At the top, the loading notice and a failed page's retry notice are in view while earlier pages load.
      stream.scrollTop = 0;
      await state.loadOlder();
      // A page already loading (an earlier jump, the top-of-list loader) makes this call start nothing; wait for it.
      await state.olderSettled();
      article = find();
      const after = state.snapshot();
      if (after.olderError || after.messages[0]?.id === before.messages[0]?.id) break;
    }
    if (destroyed || selectedKey !== selected) return;
    if (!article) {
      // Only a history read to its start proves the original is gone. A failed page shows the existing retry notice at
      // the top instead; a page dropped by a refresh or reselection leaves the jump for another click.
      const after = state.snapshot();
      if (!after.olderError && !after.messageCursor) { locateNotice = 'chat.quote.missing'; redraw(); }
      return;
    }
    if (locateNotice === 'chat.quote.missing') { locateNotice = null; redraw(); }
    // Instant: the page's next fit keeps the visible message in place by writing scrollTop, which would cut a smooth
    // scroll short; once the original is the visible message, the fit keeps it there. The flash marks it.
    article.scrollIntoView({ block: 'center' });
    article.classList.remove('conversation-flash');
    void article.offsetWidth;
    article.classList.add('conversation-flash');
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
      readOnlyOther: foreignRow(record.row, s),
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
    if (record.quoteButton) {
      const quoted = s.tab === 'mine' && String(s.quote?.id ?? '') === String(row.id);
      record.quoteButton.hidden = !(quotable(s) && !foreignRow(row, s)) && !quoted;
      record.quoteButton.disabled = !quotable(s) || foreignRow(row, s);
      record.quoteButton.dataset.quoted = String(quoted);
      text(record.quoteButton.lastElementChild, t('chat.quote.button'));
      record.quoteButton.title = t('chat.quote.buttonTitle');
      record.quoteButton.setAttribute('aria-label', t('chat.quote.buttonTitle'));
    }
    if (record.internal) {
      record.resource.update(row, { showTechnicalDetails: technicalDetails() === true, external: s.tab === 'external' });
      return;
    }
    record.row = row;
    renderCopyFeedback(record);
    const avatarSymbol = messageAvatar(row, s);
    if (record.avatarSymbol !== avatarSymbol) {
      record.avatar.replaceChildren(icon(document, avatarSymbol));
      record.avatarSymbol = avatarSymbol;
    }
    const delivery = s.tab === 'mine' && !externalRow(row, s) && row.direction === 'in' ? messageState(row) : null;
    const status = delivery ? t(delivery === 'pending' && s.groupWait?.kind === 'rate_wait'
      ? s.groupHealth === 'recovering' ? 'chat.page.delivery.recovering' : 'chat.page.delivery.rateLimited'
      : 'chat.page.delivery.' + delivery) : '';
    text(record.author, messageAuthor(row, s));
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
      q.node.dataset.lifecycle = fresh.dataset.lifecycle;
      // Keep the live header and accepted answer in sync without replacing focused editing controls.
      const previousStatus = [...q.node.children].find(child => child.classList.contains('chat-question-status'));
      const currentStatus = [...fresh.children].find(child => child.classList.contains('chat-question-status'));
      if (currentStatus) {
        currentStatus.setAttribute('role', 'status'); currentStatus.setAttribute('aria-live', 'polite');
        if (previousStatus) previousStatus.replaceWith(currentStatus);
        else q.node.prepend(currentStatus);
      } else previousStatus?.remove();
      const previousAnswer = q.node.querySelector('.chat-question-answer');
      const currentAnswer = fresh.querySelector('.chat-question-answer');
      if (currentAnswer) {
        if (previousAnswer) previousAnswer.replaceWith(currentAnswer);
        else q.node.append(currentAnswer);
      } else previousAnswer?.remove();
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
        if (child !== announcement && child !== currentStatus && !child.classList.contains('chat-form-draft-status') && !child.classList.contains('chat-form-error') && child.matches('p.chat-question-status,p.chat-notice,p.chat-message-status')) {
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
      announcement.hidden = !joined && !retry;
    }
  }
  function captureHistory() {
    const oldTop = stream.scrollTop,
      bounds = stream.getBoundingClientRect();
    const previousHeight = stream.scrollHeight;
    const previousClientHeight = stream.clientHeight;
    const pinned = previousHeight - oldTop - previousClientHeight <= 2;
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
  function bindPinOrder(button, wrapper, id) {
    let pointer = null;
    let suppressClick = false;
    const canReorder = () => wrapper.dataset.pinId && !currentSnapshot.savingPins;
    function trackPointer(event) {
      if (pointer?.id !== event.pointerId) return;
      pointer.dragged ||= Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) >= 6;
    }
    button.addEventListener('pointerdown', event => {
      suppressClick = false;
      if (event.pointerType !== 'mouse' || event.button !== 0 || !canReorder()) return;
      pointer = { id: event.pointerId, x: event.clientX, y: event.clientY, dragged: false };
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', trackPointer);
    button.addEventListener('pointerup', event => {
      if (pointer?.id !== event.pointerId) return;
      trackPointer(event);
      suppressClick = pointer.dragged;
      pointer = null;
      if (!suppressClick || !canReorder()) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-pin-id]');
      if (target && target.dataset.pinId !== id) void state.reorderPin(id, target.dataset.pinId);
    });
    button.addEventListener('lostpointercapture', () => { pointer = null; });
    button.addEventListener('click', event => {
      if (!suppressClick || event.detail === 0) return;
      suppressClick = false;
      event.stopImmediatePropagation();
    });
    button.addEventListener('keydown', event => {
      if (!canReorder() || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      const pinned = currentSnapshot.items.filter(row => Number.isInteger(row.pinOrder));
      const index = pinned.findIndex(row => row.id === id) + (event.key === 'ArrowUp' ? -1 : 1);
      if (!pinned[index]) return;
      event.preventDefault();
      void state.reorderPin(id, pinned[index].id);
    });
  }
  function reconcileMessages(s, switched, before) {
    instanceTimeZone = s.tz ?? null;
    const {
      oldTop,
      previousHeight,
      previousClientHeight,
      pinned,
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
      if (record && (record.content !== row.content || record.quoteKey !== JSON.stringify(row.quote ?? null))) {
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
          record.resource.updateAttachments?.(row.attachments || []);
          record.attachmentKey = attachmentKey;
        }
        patchMessage(record, row, s);
      }
      if (id === String(s.unreadDividerId)) ordered.push(unreadDivider);
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
    if (!ordered.includes(unreadDivider)) unreadDivider.remove();
    positionChildren(messageList, ordered);
    for (const record of messages.values()) record.resource?.mount?.();
    const openedTimeline = s.historyLoaded && s.timelineRevision !== timelineRevision;
    const follow = switched || openedTimeline || !maxSeenId && s.messages.length || added && pinned && !s.gap
      || pinned && (stream.scrollHeight !== previousHeight || stream.clientHeight !== previousClientHeight);
    if (openedTimeline) timelineRevision = s.timelineRevision;
    if (openedTimeline && s.positionAtUnread && s.unreadDividerId !== null && unreadDivider.isConnected) {
      stream.scrollTop += unreadDivider.getBoundingClientRect().top - stream.getBoundingClientRect().top - 12;
    } else if (!holdScroll(follow, stream.scrollHeight - previousHeight, anchorShift(anchor?.node, anchorTop))) {
      if (follow) stream.scrollTop = stream.scrollHeight;
      else if (anchor?.node.isConnected && anchorTop !== undefined) {
        stream.scrollTop = oldTop + anchor.node.getBoundingClientRect().top - anchorTop;
      } else stream.scrollTop = oldTop;
    }
    if (s.messages.length) maxSeenId = String(s.messages[s.messages.length - 1].id);
    updateUnread(s);
    reportVisibleRead();
  }
  const serverNow = s => Date.now() + (s?.activity?.offset ?? 0);
  function liveOptions(s) {
    return { now: serverNow(s), open: s.activity?.open, details: s.activity?.details };
  }
  /** What the AI is doing now sits right below the latest message, a user message or a reply. */
  function placeActivity(s, ordered) {
    const shown = s.messages.filter(row => row.channel !== 'internal')
      .map(row => ({ id: row.id, direction: row.direction, at: asDate(row.timestamp ?? row.created_at ?? row.createdAt)?.getTime() ?? null }));
    const presentation = s.tab === 'mine' && s.activity && !s.activity.unsupported
      ? livePresentation(shown, s.activity.data, { presence: s.activity.data?.presence ?? null }) : null;
    const anchor = presentation ? messages.get(String(presentation.anchor))?.node : null;
    const at = anchor ? ordered.indexOf(anchor) : -1;
    if (!presentation || at < 0) {
      liveItem?.remove();
      liveItem = null;
    } else {
      if (!liveArea) liveArea = createLiveArea({ document, t, locale: document.documentElement?.lang || undefined,
        onToggle: key => { void state.toggleSubtask(key); }, onDetails: groupSide ? () => {
          const current = currentSnapshot.conversation ?? currentSnapshot.items.find(item => item.id === currentSnapshot.selectedId);
          if (!groupSide.open) showGroupSide(current?.sessionGroup ?? current?.session_group, currentSnapshot.selectedId);
        } : null });
      if (!liveItem) {
        liveItem = node('div', undefined, 'conversation-activity-message');
        const row = { direction: 'out' };
        const avatar = node('span', undefined, 'conversation-avatar');
        avatar.append(icon(document, messageAvatar(row, s)));
        const body = node('div', undefined, 'conversation-message-body');
        const meta = node('div', undefined, 'conversation-message-meta');
        meta.append(node('span', messageAuthor(row, s), 'chat-message-author'), node('time'));
        body.append(meta, liveArea.node);
        liveItem.append(avatar, body);
      }
      const data = s.activity.data;
      // Keep the recorded start, but never place an earlier time below the anchor message.
      const started = data.working?.main?.since ?? data.working?.since ?? presentation.since
        ?? presentation.subtasks[0]?.start ?? data.awaiting?.since;
      let date = asDate(started);
      const anchorTime = shown.find(row => String(row.id) === String(presentation.anchor))?.at ?? null;
      if (anchorTime !== null && (!date || date.getTime() < anchorTime)) date = new Date(anchorTime);
      const time = liveItem.querySelector('.conversation-message-meta time');
      time.hidden = !date;
      if (date) { text(time, clockText(date)); time.dateTime = date.toISOString(); }
      liveItem.dataset.under = presentation.under;
      liveArea.update(presentation, liveOptions(s));
      ordered.splice(at + 1, 0, liveItem);
    }
    const live = !!presentation && !presentation.handled;
    if (live && activityTimer === null && view?.setInterval) activityTimer = view.setInterval(tickActivity, 1000);
    if (!live && activityTimer !== null) { view?.clearInterval(activityTimer); activityTimer = null; }
  }
  function tickActivity() {
    if (destroyed || !liveArea?.view || !liveItem?.isConnected) return;
    liveArea.update(liveArea.view, liveOptions(currentSnapshot));
  }
  function fitPage() {
    fitFrame = null;
    syncMobileFocus();
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
    const mobileTabs = view.innerWidth <= 760 ? document.querySelector('#wb-mobile-nav') : null;
    const bottomNavigation = mobileTabs?.getBoundingClientRect().height ?? 0;
    const available = Math.max(0, Math.floor(view.innerHeight - page.getBoundingClientRect().top - bottomNavigation));
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
    maybeLoadOlder(true);
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
    for (const selector of ['.app-header', '.wb-mobile-topbar', '#wb-mobile-nav']) {
      const element = document.querySelector(selector);
      if (element) fitObserver.observe(element, { box: 'border-box' });
    }
    if (root.parentElement) {
      fitObserver.observe(root.parentElement);
    }
  }
  const blockedNotice = node('div', undefined, 'chat-notice conversation-blocked-notice');
  const blockedTitle = node('strong');
  blockedNotice.append(icon(document, 'lock'), blockedTitle);
  function redraw() {
    if (destroyed) {
      return;
    }
    const before = captureHistory();
    const s = state.snapshot();
    currentSnapshot = s;
    syncMobileFocus();
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
    text(externalTabLabel, t('chat.external'));
    text(menuDeliveryHint, t('chat.page.sendHint'));
    text(menuGroupSummary, t('chat.page.groupSummary'));
    menuSheet.setAttribute('aria-label', t('chat.page.menu'));
    menuScrim.setAttribute('aria-label', t('chat.page.cancel'));
    text(updateNotice, t('chat.page.updateRetry'));
    sidebar.setAttribute('aria-label', t('chat.conversations'));
    detail.setAttribute('aria-label', t('chat.history'));
    stream.setAttribute('aria-label', t('chat.history'));
    input.setAttribute('aria-label', t('chat.input'));
    renameInput.setAttribute('aria-label', t('chat.name'));
    searchInput.placeholder = t('chat.page.searchNames');
    searchInput.setAttribute('aria-label', searchInput.placeholder);
    if (searchTimer === null && document.activeElement !== searchInput && searchInput.value !== s.search) searchInput.value = s.search;
    text(unreadDivider, t('chat.page.unreadDivider'));
    if (s.blocked) {
      closeCopyMenu();
      closeRowMenu(false);
      leaveTextSelection();
      annotations.hide();
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
      // Only a fallback: the host hides the tab and returns to the overview.
      text(blockedTitle, t('chat.remoteDisabled'));
      root.replaceChildren(blockedNotice);
      onRemoteDisabled();
      return;
    }
    if (page.parentNode !== root) {
      root.replaceChildren(page);
    }
    const key = `${s.tab}:${s.selectedId ?? ''}`;
    const switched = selectedKey !== key;
    if (switched || s.blocked) {
      closeCopyMenu();
      leaveTextSelection();
      closeConversationMenu(false);
      closeRowMenu(false);
      selectedKey = key;
      cancelReadTimer();
      attemptedRead = 0;
      timelineRevision = null;
      annotations.hide();
      locateNotice = null;
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
    create.hidden = s.tab !== 'mine' || !s.canCreate && s.mode !== 'single';
    create.disabled = !s.canCreate || !!s.loading || !!s.creatingDraft || creationPending;
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
        const pinBadge = node('span', undefined, 'conversation-pin-badge');
        pinBadge.setAttribute('role', 'img');
        symbol.append(pinBadge);
        const body = node('span', undefined, 'conversation-list-body'),
          top = node('span', undefined, 'conversation-list-title');
        const name = node('strong'),
          channel = node('span', undefined, 'conversation-list-channel'),
          draft = node('span', t('chat.draft'), 'conversation-draft'),
          time = node('time', undefined, 'conversation-list-time');
        const previewLine = node('span', undefined, 'conversation-list-preview');
        const preview = node('span', undefined, 'chat-preview');
        const unreadDot = node('span', undefined, 'conversation-unread-dot');
        unreadDot.setAttribute('aria-hidden', 'true');
        top.append(name, channel, draft, time);
        previewLine.append(preview, unreadDot);
        body.append(top, previewLine);
        button.append(symbol, body);
        bindPinOrder(button, wrapper, item.id);
        button.addEventListener('click', event => {
          // A tap that ends a swipe or puts a revealed delete button back does not open the conversation.
          if (swipe.consumeTap(wrapper, event)) { event.preventDefault?.(); return; }
          mobileDetail(true);
          autoSelectPending = false;
          void state.select(item.id);
        });
        const rowToggle = node('button', undefined, 'wb-icon-btn conversation-row-menu-toggle');
        rowToggle.type = 'button';
        rowToggle.append(icon(document, 'more'));
        rowToggle.setAttribute('aria-expanded', 'false');
        rowToggle.addEventListener('pointerdown', event => event.stopPropagation());
        rowToggle.addEventListener('click', event => {
          if (!swipe.consumeTap(wrapper, event)) openRowMenu(row);
        });
        const remove = action('chat.delete.button', () => {
          const target = deletableItem(currentSnapshot, item.id);
          if (target) return removeConversation(target);
        }, 'trash', 'wb-icon-btn conversation-delete');
        // The phone's revealed button reads the short word; its accessible name stays the full action.
        const short = node('span', t('chat.delete.short'), 'conversation-delete-short');
        short.setAttribute('aria-hidden', 'true');
        remove.append(short);
        const notice = node('span', undefined, 'conversation-delete-status');
        notice.setAttribute('role', 'status');
        wrapper.append(button, rowToggle, remove, notice);
        swipe.attach(wrapper);
        row = {
          id: item.id, wrapper, remove, short, notice, pinBadge, unreadDot, menuToggle: rowToggle,
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
      // A row with a deletion status keeps its delete or retry button shown on desktop and inline on phones.
      const shownState = ['deleting', 'pending', 'error', 'stale', 'preview_error'].includes(deletionState?.state)
        ? deletionState.state : null;
      if (shownState) row.wrapper.dataset.deletionState = shownState;
      else delete row.wrapper.dataset.deletionState;
      row.remove.hidden = !canDeleteItem(s, item);
      row.remove.disabled = deletionState?.busy === true;
      const deletionLabel = deletionState?.state === 'pending' || deletionState?.state === 'error' ? 'chat.delete.retry' : 'chat.delete.button';
      text(row.remove.label, t(deletionLabel));
      row.remove.setAttribute('aria-label', t(deletionLabel) + ': ' + nameOf(item));
      row.remove.setAttribute('title', t(deletionLabel));
      text(row.short, t(deletionLabel === 'chat.delete.retry' ? 'chat.delete.retry' : 'chat.delete.short'));
      row.notice.hidden = !shownState;
      text(row.notice, shownState ? t(deletionState.errorKey ?? 'chat.delete.' + shownState) : '');
      const itemChannel = channelOf(item);
      row.channel.hidden = s.tab === 'mine' || !itemChannel;
      text(row.channel, channelLabel(itemChannel));
      text(row.name, nameOf(item));
      const origin = s.tab === 'mine' && isOriginConversation(item.id);
      const pinned = Number.isInteger(item.pinOrder);
      row.canPin = !origin && !item.id.startsWith('d:');
      row.isPinned = pinned;
      row.menuToggle.hidden = !row.canPin && (row.remove.hidden || !!shownState);
      row.menuToggle.setAttribute('aria-haspopup', view?.innerWidth <= 760 ? 'dialog' : 'menu');
      row.menuToggle.setAttribute('aria-label', t('chat.page.rowMenu', { name: nameOf(item) }));
      row.pinBadge.hidden = !origin && !pinned;
      row.pinBadge.setAttribute('aria-label', t('chat.page.pinned'));
      if (row.canPin && pinned && !s.search) row.wrapper.dataset.pinId = item.id;
      else delete row.wrapper.dataset.pinId;
      row.unreadDot.hidden = s.tab !== 'mine' || item.unread !== true;
      const preview = item.preview || t(item.draft ? 'chat.page.blankPreview' : 'chat.page.noMessages');
      let previewPrefix = '';
      if (item.preview && item.previewDirection === 'in') {
        previewPrefix = t(s.tab === 'external' ? 'chat.external.previewReceived' : 'chat.page.previewYou');
      } else if (item.preview && item.previewDirection === 'out' && s.tab === 'external') {
        previewPrefix = t('chat.external.previewSent');
      }
      text(row.preview, previewPrefix + preview);
      text(row.draft, t('chat.draft'));
      row.draft.hidden = !(item.draft || item.state === 'draft');
      row.button.classList.toggle('selected', item.id === s.selectedId);
      row.button.setAttribute('aria-current', item.id === s.selectedId ? 'true' : 'false');
      const date = asDate(Number.isFinite(conversationStampMs(item.stamp)) ? conversationStampMs(item.stamp) : null);
      text(row.time, date ? relativeTime(date) : '');
      if (date) {
        row.time.dateTime = date.toISOString();
      }
      ordered.push(row.wrapper);
    }
    for (const [id, row] of listRows) {
      if (!live.has(id)) {
        if (menuRow === row) closeRowMenu(false);
        row.wrapper.remove();
        listRows.delete(id);
      }
    }
    const focusedRowControl = document.activeElement?.closest?.('.conversation-list-item, .conversation-row-menu-toggle');
    positionChildren(list, ordered);
    if (focusedRowControl?.isConnected && document.activeElement !== focusedRowControl) {
      focusedRowControl.focus({ preventScroll: true });
    }
    if (menuRow?.menuToggle.hidden) closeRowMenu(false);
    else if (menuRow) updateRowMenu(menuRow);
    newConversations.hidden = !s.listUpdates;
    text(newConversations.label, countLabel(t, 'chat.page.newConversations', s.listUpdates, {}).replace('{count}', String(s.listUpdates)));
    newConversations.setAttribute('aria-label', newConversations.label.textContent);
    listNotice.hidden = !!s.items.length && !s.loading;
    text(listNotice, t(s.loading ? 'chat.loading' : s.search ? 'wb.list.noMatch'
      : s.tab === 'mine' ? 'chat.page.emptyMine' : 'chat.page.emptyExternal'));
    const completionText = [];
    if (deletionResult?.retainedMessages > 0 && deletionResult.groupDataRetained === true) {
      completionText.push(countLabel(t, 'chat.delete.retained', deletionResult.retainedMessages));
    }
    if (deletionResult?.countsEstimated === true) completionText.push(t('chat.delete.estimated'));
    deletionNotice.hidden = !local() || !completionText.length || deletionResult.identity !== (typeof identity === 'function' ? identity() : identity);
    text(deletionNotice, deletionNotice.hidden ? '' : completionText.join(document.documentElement?.lang?.startsWith('zh') ? '' : ' '));
    const origin = s.tab === 'mine' && isOriginConversation(s.selectedId);
    accessNotice.hidden = s.mode !== 'single' || s.tab !== 'mine' || origin;
    text(accessText, t('chat.single'));
    const outcome = receiptState(s.receipt);
    const showReceipt = !!s.receipt && ['not_stored', 'pending_reconciliation'].includes(outcome);
    const duplicateSendError = showReceipt && ['chat.error.requestFailed', 'chat.error.sendUnknown'].includes(conversationErrorKey(s.error));
    errorNotice.hidden = !s.error || duplicateSendError || s.receipt?.stored === true && s.error === s.receipt.error;
    text(errorNotice, s.error ? t(conversationErrorKey(s.error)) : '');
    updateNotice.hidden = !s.updateError;
    streamHint.dataset.streamState = s.streamState;
    text(streamHint, t('chat.page.push.' + s.streamState));
    streamHint.title = streamHint.textContent;
    connectionDot.dataset.streamState = s.streamState;
    connectionDot.title = t('chat.page.push.' + s.streamState);
    text(menuConnection, t('chat.page.push.' + s.streamState));
    const current = s.conversation ?? s.items.find(item => item.id === s.selectedId);
    text(title, nameOf(current, s.tab === 'external'));
    updateWorkingIndicator(s);
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
    text(subtitle, channelLabel(channel) + ' · ' + t(origin ? 'chat.page.originPinned' : s.tab === 'mine' ? 'chat.page.selfCreated' : 'chat.page.readOnly'));
    text(menuSource, subtitle.textContent);
    renameToggle.hidden = !s.canRename;
    menuRename.hidden = !s.canRename;
    menuRename.disabled = s.loading || s.sending;
    renameSave.disabled = s.loading || s.sending;
    // In single, Origin's workbench row has no group key, so there is no group detail to open beside it.
    const sessionGroup = current?.sessionGroup ?? current?.session_group;
    group.hidden = !groupSide || !sessionGroup || isDraft(s) || origin && s.mode === 'single';
    menuGroup.hidden = group.hidden;
    const menuItem = deletableItem(s, s.selectedId);
    menuDelete.hidden = !menuItem;
    menuDelete.disabled = !!menuItem && deletion.status(menuItem)?.busy === true;
    // The side panel belongs to the conversation it was opened from.
    if (groupSide?.open && (group.hidden || s.selectedId !== groupSideFor)) groupSide.close({ focus: false });
    historyStart.hidden = !s.selectedId || isDraft(s) || !s.historyLoaded
      || !!s.messageCursor && !s.olderLoading && !s.olderError;
    historyStart.classList.toggle('conversation-history-start-active', !!s.olderLoading || !!s.olderError);
    text(historyStartLabel, s.olderLoading ? t('chat.page.olderLoading') : !s.messageCursor ? t('chat.page.olderEnd') : '');
    historyStartLabel.hidden = !!s.olderError;
    olderRetry.hidden = !s.olderError;
    olderRetry.disabled = !!s.olderLoading;
    gap.hidden = !s.gap;
    gapLoad.disabled = !!s.loading;
    questionNotice.hidden = s.tab !== 'mine' || !s.selectedId || isDraft(s) || !s.questionsLoading && !s.questionError && s.questionsReady;
    text(questionNotice, t(s.questionsLoading ? 'chat.questions.loading' : 'chat.questions.unavailable'));
    questionMore.hidden = !s.questionCursor;
    questionMore.disabled = !!s.questionsLoading;
    historyNotice.hidden = !!s.messages.length || !!s.blocked;
    text(historyNotice, t(!s.selectedId ? 'chat.select' : s.loading ? 'chat.loading' : isDraft(s) ? 'chat.page.draftExplanation'
      : origin ? 'chat.page.originEmpty' : 'chat.page.noMessages'));
    const showComposer = !!s.selectedId && s.tab === 'mine' && (s.canWrite || s.mode === 'single');
    if (!s.canRename) {
      renameForm.remove();
    } else if (renameForm.parentNode !== detail) {
      detail.insertBefore(renameForm, notices);
    }
    if (!showComposer) {
      composer.remove();
    } else if (composer.parentNode !== detail) {
      detail.insertBefore(composer, configFooter);
    }
    composer.hidden = !showComposer;
    if (quickConfig) {
      const container = showComposer ? composeBox : configFooter;
      if (quickConfig.anchor.parentNode !== container) container.insertBefore(quickConfig.anchor, showComposer ? send : null);
      quickConfig.update(group.hidden || page.hidden ? null : sessionGroup);
      configFooter.hidden = showComposer || group.hidden;
    }
    composer.classList.toggle('conversation-composer-disabled', s.mode === 'single' && !origin);
    updateInputPlaceholder(s.mode);
    input.disabled = !s.canWrite || !!s.sending;
    // While a send's outcome is open the draft is read-only: a retry sends exactly what was sent.
    input.readOnly = !!s.pending;
    if (input.value !== s.input) {
      input.value = s.input;
    }
    page.classList.toggle('conversation-quotable', quotable(s));
    const quote = s.tab === 'mine' ? s.quote : null;
    quoteBar.hidden = !quote;
    if (quote) {
      text(quoteBarWho, t('chat.quote.bar', { who: quoteAuthor(quote, t), time: shortStamp(quote.timestamp, s.tz) }));
      text(quoteBarText, quote.text);
      quoteBarBody.title = t('chat.quote.jump');
      quoteBarClose.title = t('chat.quote.cancel');
      quoteBarClose.setAttribute('aria-label', t('chat.quote.cancel'));
      quoteBarClose.disabled = !quotable(s);
    }
    const outgoing = s.pending?.content ?? composeContent({ text: s.input, annotations: s.annotations, timeZone: s.tz, t });
    const outgoingBytes = contentBytes(storedContent(outgoing, s.pending ? s.pending.quote : quote?.id ?? null));
    const tooLarge = outgoingBytes > MAX_CONTENT_BYTES;
    const composeMessages = [
      tooLarge ? t('chat.compose.tooLarge', { bytes: outgoingBytes.toLocaleString('en-US') }) : null,
      s.draftUnsaved ? t('chat.compose.unsaved') : null,
      locateNotice ? t(locateNotice) : null,
    ].filter(Boolean);
    composeNotice.hidden = !composeMessages.length;
    text(composeNotice, composeMessages.join(' '));
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
    mobileRetryHint.hidden = !s.retryRequired;
    text(mobileRetryHint, s.retryRequired ? t('chat.page.retryHint') : '');
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
    text(trayLabel, countLabel(t, 'chat.upload.trayCount', upload.items.length, {}).replace('{count}', String(upload.items.length)));
    const uploadError = upload.error || (s.error === 'chat_attachment_unavailable' ? s.error : null);
    uploadNotice.hidden = !uploadError;
    text(uploadNotice, uploadError ? t('chat.upload.' + uploadError).replace('{count}', String(upload.config?.maxAttachments || 20)) : '');
    // A quote alone is not a message: the text, an annotation or an attachment makes it sendable.
    send.disabled = !s.canWrite || !!s.sending || s.retryRequired && !s.canRetry || tooLarge
      || !uploadTray.isSendable(s.pending || s.annotations.length ? outgoing : s.input);
    receipt.hidden = !showReceipt;
    receipt.dataset.deliveryState = outcome || '';
    const receiptKey = outcome === 'not_stored' && s.mode === 'single' && !origin
      ? 'chat.page.receipt.notStoredReadOnly' : 'chat.page.receipt.' + outcome;
    text(receiptText, outcome ? t(receiptKey) : '');
    for (const reference of root.querySelectorAll('.chat-block-reference')) {
      reference.hidden = technicalDetails() !== true;
    }
    reconcileMessages(s, switched, before);
    annotations.update(s);
    scheduleFit();
  }
  let streamSubscriptionKey = 'null';
  const notifyStreamSubscription = () => {
    const subscription = state.streamSubscription(), next = JSON.stringify(subscription);
    if (next === streamSubscriptionKey) return;
    streamSubscriptionKey = next;
    onStreamSubscription(subscription);
  };
  const unsubscribe = state.subscribe(() => { redraw(); notifyStreamSubscription(); void selectFirstDesktop(); });
  redraw();
  async function openGroup(sessionGroup, {
    channel, groupDetail = false
  } = {}) {
    if (typeof sessionGroup !== 'string' || !sessionGroup) {
      return false;
    }
    autoSelectPending = false;
    opened = true;
    selectionIdentity = typeof identity === 'function' ? identity() : identity;
    page.hidden = false;
    await state.open();
    // Origin's conversation is the fixed address `dashboard origin`, listed in "mine".
    const tab = sessionGroup === 'origin' || (channel ?? sessionGroup.split(':')[0]) === 'dashboard' ? 'mine' : 'external';
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
    // Back from observing the group: its detail opens beside the conversation again.
    if (groupDetail && groupSide && !groupSide.open) showGroupSide(sessionGroup, state.snapshot().selectedId);
    return !state.snapshot().error;
  }
  return {
    blockRemote: state.blockRemote,
    streamSubscription: state.streamSubscription,
    streamStatus: state.streamStatus,
    streamEvent: state.streamEvent,
    async open(...args) {
      const nextIdentity = typeof identity === 'function' ? identity() : identity;
      if (!opened || nextIdentity !== selectionIdentity) autoSelectPending = true;
      opened = true;
      selectionIdentity = nextIdentity;
      page.hidden = false;
      scheduleFit();
      await state.open(...args);
      await selectFirstDesktop();
    },
    openGroup,
    popstate() {
      if (!selectionEntry) return false;
      const sameConversationPage = view.location.href === selectionEntry.url && !page.hidden;
      leaveTextSelection();
      return sameConversationPage;
    },
    close() {
      closeCopyMenu();
      cancelRowPress();
      closeRowMenu(false);
      leaveTextSelection();
      autoSelectPending = false;
      opened = false;
      clearSearchTimer();
      cancelReadTimer();
      deletion.invalidate();
      deletionResult = null;
      groupSide?.close({ focus: false });
      quickConfig?.update(null);
      annotations.hide();
      page.hidden = true;
      syncMobileFocus();
      state.close();
    },
    redraw() { redraw(); groupSide?.redraw(); quickConfig?.redraw(); },
    clearDrafts(scope) { uploadTray.clearForAuthentication(scope?.instance ? { instance: scope.instance } : undefined); state.clearDrafts(scope); },
    destroy() {
      closeCopyMenu();
      cancelRowPress();
      closeRowMenu(false);
      view?.removeEventListener('resize', resizeRowMenu);
      leaveTextSelection();
      closeConversationMenu(false);
      document.documentElement.dataset.conversationFocus = 'false';
      deletion.invalidate();
      groupSide?.destroy();
      quickConfig?.destroy();
      destroyed = true;
      clearSearchTimer();
      cancelReadTimer();
      document.removeEventListener?.('visibilitychange', readVisibilityChanged);
      view?.removeEventListener('focus', readVisibilityChanged);
      view?.removeEventListener('blur', cancelReadTimer);
      uploadTray.destroy();
      for (const resource of trayResources.values()) resource.destroy();
      trayResources.clear();
      view?.removeEventListener('resize', scheduleFit);
      gesture.destroy();
      quoteGesture.destroy();
      swipe.destroy();
      annotations.destroy();
      if (settleTimer !== null) view?.clearTimeout(settleTimer);
      settleTimer = null;
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
