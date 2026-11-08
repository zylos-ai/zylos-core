import { element, icon } from './plain-text.js?v=94';
import { asDate } from './conversation-time.js?v=99';
import { channelIcon } from './board.js?v=98';
import { createConversationState } from './conversation-state.js?v=102';
import { messageState, receiptState } from './chat-delivery-state.js?v=100';
import { renderQuestion } from './chat-questions.js?v=102';
import { conversationErrorKey, renderConversationContent } from './conversation-content.js?v=102';
const laterThan = (left, right) => {
  const a = String(left),
    b = String(right);
  return a.length === b.length ? a > b : a.length > b.length;
};
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
  onOpenGroup,
  technicalDetails = () => false
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
  const view = document.defaultView;
  const listRows = new Map(),
    messages = new Map(),
    days = new Map(),
    actions = [];
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
      ...(options.body === undefined ? {} : {
        headers: {
          'Content-Type': 'application/json'
        },
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
      return date.toLocaleTimeString(document.documentElement?.lang || undefined, { hour: '2-digit', minute: '2-digit' });
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
  const more = action('loadMore', () => state.loadMore());
  more.classList.add('conversation-load-more');
  sidebar.append(listToolbar, create, createForm, externalSection, list, listNotice, more);
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
  const headerActions = node('div', undefined, 'conversation-header-actions');
  const readNew = action('refreshMessages', () => state.refreshMessages(), 'restart');
  const statusCheck = action('refreshStatus', () => state.refreshStatus(), 'check');
  const group = action('chat.page.groupInfo', () => onOpenGroup?.(currentSnapshot.conversation ?? currentSnapshot.items.find(item => item.id === currentSnapshot.selectedId)), 'chev');
  headerActions.append(readNew, statusCheck, group);
  header.append(back, headerIcon, heading, headerActions);
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
  const send = action('send', () => {}, 'send', 'wb-btn wb-btn-primary');
  send.type = 'submit';
  const hint = node('p', t('chat.page.sendHint'), 'conversation-compose-hint');
  composeBox.append(input, send);
  composer.append(receipt, composeBox, hint);
  input.addEventListener('input', () => state.setInput(input.value));
  input.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      if (!send.disabled) {
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
  root.replaceChildren(page);
  function updateInputPlaceholder(mode = currentSnapshot?.mode) {
    const key = mode === 'single' ? 'chat.page.singlePlaceholder'
      : view?.innerWidth <= 760 ? 'chat.page.mobilePlaceholder' : 'chat.page.placeholder';
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
    await state.send({
      retry: currentSnapshot.retryRequired
    });
    if (!destroyed && selectedKey === selected && state.snapshot().receipt?.stored === true) {
      stream.scrollTop = stream.scrollHeight;
      unread = 0;
      updateUnread();
    }
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
  function positionChildren(parent, ordered) {
    for (let i = 0; i < ordered.length; i++) {
      if (parent.children[i] !== ordered[i]) {
        parent.insertBefore(ordered[i], parent.children[i] ?? null);
      }
    }
  }
  function dateLabel(row) {
    const date = asDate(row.timestamp ?? row.created_at ?? row.createdAt);
    return date ? date.toLocaleDateString(document.documentElement?.lang || undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    }) : null;
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
    if (date) {
      const time = node('time', date.toLocaleTimeString(document.documentElement?.lang || undefined, {
        hour: '2-digit',
        minute: '2-digit'
      }));
      time.dateTime = date.toISOString();
      meta.append(time);
    }
    const questions = [];
    const content = renderConversationContent({
      document,
      row,
      t,
      showTechnicalDetails: technicalDetails() === true,
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
    body.append(meta, content, status);
    article.append(avatar, body);
    const record = {
      node: article,
      status,
      statusIcon,
      statusText,
      statusButton,
      statusButtonLabel,
      author,
      questions,
      resource: content,
      content: row.content
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
    const delivery = s.tab === 'mine' && row.direction === 'in' ? messageState(row) : null;
    const status = delivery ? t('chat.page.delivery.' + delivery) : '';
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
      if (form.draftCleared) q.node.clearEditableValues?.();
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
  function reconcileMessages(s, switched, before) {
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
        patchMessage(record, row, s);
      }
      ordered.push(record.node);
    }
    for (const [id, record] of messages) {
      if (!ids.has(id)) {
        record.resource?.destroy?.();
        record.node.remove();
        messages.delete(id);
      }
    }
    const liveDays = new Set(ordered.filter(el => el.classList.contains('conversation-day')));
    for (const [day, divider] of days) {
      if (!liveDays.has(divider)) {
        divider.remove();
        days.delete(day);
      }
    }
    positionChildren(messageList, ordered);
    for (const record of messages.values()) record.resource?.mount?.();
    if (switched || !maxSeenId && s.messages.length || added && near && !s.gap
      || pinned && (stream.scrollHeight !== previousHeight || stream.clientHeight !== previousClientHeight)) {
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
        row = {
          button,
          name,
          channel,
          draft,
          time,
          preview
        };
        listRows.set(item.id, row);
      }
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
      ordered.push(row.button);
    }
    for (const [id, row] of listRows) {
      if (!live.has(id)) {
        row.button.remove();
        listRows.delete(id);
      }
    }
    positionChildren(list, ordered);
    more.hidden = !s.nextCursor;
    more.disabled = !!s.loading;
    listNotice.hidden = !!s.items.length && !s.loading;
    text(listNotice, t(s.loading ? 'chat.loading' : s.tab === 'mine' ? 'chat.page.emptyMine' : 'chat.page.emptyExternal'));
    accessNotice.hidden = s.mode !== 'single' || s.tab !== 'mine';
    text(accessText, t('chat.single'));
    const outcome = receiptState(s.receipt);
    const showReceipt = !!s.receipt && ['not_stored', 'pending_reconciliation'].includes(outcome);
    const duplicateSendError = showReceipt && ['chat.error.requestFailed', 'chat.error.sendUnknown'].includes(conversationErrorKey(s.error));
    errorNotice.hidden = !s.error || duplicateSendError || s.receipt?.stored === true && s.error === s.receipt.error;
    text(errorNotice, s.error ? t(conversationErrorKey(s.error)) : '');
    updateNotice.hidden = !s.updateError;
    const current = s.conversation ?? s.items.find(item => item.id === s.selectedId);
    text(title, nameOf(current, s.tab === 'external'));
    running.hidden = s.groupPresence !== true;
    text(running.lastElementChild, t('chat.page.running'));
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
    group.hidden = typeof onOpenGroup !== 'function' || !(current?.sessionGroup ?? current?.session_group) || isDraft(s);
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
    send.disabled = !s.canWrite || !!s.sending || s.retryRequired && !s.canRetry || !s.input.trim();
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
  const unsubscribe = state.subscribe(redraw);
  redraw();
  return {
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
      page.hidden = true;
      state.close();
    },
    redraw,
    clearDrafts(scope) { state.clearDrafts(scope); },
    destroy() {
      destroyed = true;
      view?.removeEventListener('resize', scheduleFit);
      if (fitFrame !== null) {
        view?.cancelAnimationFrame(fitFrame);
      }
      fitObserver?.disconnect();
      unsubscribe();
      state.destroy();
      listRows.clear();
      for (const record of messages.values()) record.resource?.destroy?.();
      messages.clear();
      days.clear();
      root.replaceChildren();
    }
  };
}
