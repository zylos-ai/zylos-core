import { element } from './plain-text.js?v=94';
import { createChatState, messageState, receiptState } from './chat-state.js?v=91';
import { parseC4Content } from '../../chat-schema.js?v=90';
import { renderChatContent } from './chat-blocks.js?v=94';
import { renderQuestion } from './chat-questions.js?v=94';

export function messageText(content, t = key => key) {
  const parsed = parseC4Content(content);
  if (parsed.kind === 'text') return parsed.text;
  if (parsed.kind === 'envelope') return parsed.envelope.fallbackText;
  return t('chat.invalidContent');
}

export function errorKey(code) {
  if (['chat_auth_required', 'chat_conversation_forbidden', 'insufficient_scope'].includes(code)) return 'chat.error.forbidden';
  if (code === 'chat_requires_multi') return 'chat.error.requiresMulti';
  if (code === 'chat_conversation_started') return 'chat.error.conversationStarted';
  if (['chat_conversation_not_found', 'chat_message_not_found'].includes(code)) return 'chat.error.notFound';
  if (['chat_core_unavailable', 'chat_history_unavailable', 'chat_conversation_unavailable'].includes(code)) return 'chat.error.unavailable';
  if (code === 'chat_send_unknown') return 'chat.error.sendUnknown';
  return 'chat.error.requestFailed';
}

export function mountChat({ root, document = root.ownerDocument, t = key => key,
  fetch: fetcher = globalThis.fetch, endpoint = path => path, identity } = {}) {
  let destroyed = false;
  const request = async (path, options = {}) => {
    const response = await fetcher(endpoint(path), { method: options.method ?? 'GET',
      ...(options.body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options.body) }) });
    let payload;
    try { payload = await response.json(); } catch { throw { code: 'chat_invalid_response', status: response.status }; }
    if (!response.ok) throw { code: payload.error ?? 'chat_request_failed', status: response.status, payload };
    return payload;
  };
  const state = createChatState({ request, identity });
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const action = (key, handler, disabled = false) => {
    const button = node('button', t('chat.' + key), 'action-btn');
    button.type = 'button'; button.disabled = disabled;
    button.dataset.action = key;
    button.addEventListener('click', () => { if (!button.disabled) void handler(); });
    return button;
  };
  const nameOf = row => row?.displayName ?? row?.display_name ?? t('chat.unnamed');
  function redraw() {
    if (destroyed) return;
    const s = state.snapshot();
    if (s.blocked) { root.replaceChildren(node('p', t('chat.remoteDisabled'), 'chat-notice')); return; }
    const toolbar = node('div', undefined, 'chat-toolbar');
    const tabs = node('div', undefined, 'chat-tabs'); tabs.setAttribute('role', 'tablist');
    for (const tab of ['mine', 'external']) {
      const button = action(tab, () => state.setTab(tab));
      button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', String(s.tab === tab));
      tabs.append(button);
    }
    toolbar.append(tabs, action('refresh', () => state.refresh(), s.loading));
    const layout = node('div', undefined, 'chat-layout');
    const list = node('aside', undefined, 'chat-list'); list.setAttribute('aria-label', t('chat.conversations'));
    if (s.canCreate) {
      const form = node('form', undefined, 'chat-create');
      const label = node('label', t('chat.name'));
      const input = node('input', undefined, 'chat-name'); input.maxLength = 40; input.setAttribute('aria-label', t('chat.name')); label.append(input);
      const create = node('button', t('chat.create'), 'action-btn'); create.type = 'submit'; create.dataset.action = 'create'; create.disabled = s.loading;
      form.append(label, create);
      form.addEventListener('submit', event => { event.preventDefault(); if (!s.loading) void state.createDraft(input.value || undefined); });
      list.append(form);
    }
    for (const item of s.items) {
      const button = node('button', undefined, 'chat-list-item' + (item.id === s.selectedId ? ' selected' : ''));
      button.type = 'button'; button.dataset.conversationId = item.id;
      button.append(node('strong', nameOf(item)));
      if (item.draft) button.append(node('span', t('chat.draft'), 'chat-message-status'));
      if (item.preview) button.append(node('span', item.preview, 'chat-preview'));
      button.addEventListener('click', () => { void state.select(item.id); }); list.append(button);
    }
    if (!s.items.length && !s.loading) list.append(node('p', t('chat.empty'), 'chat-notice'));
    if (s.nextCursor) list.append(action('loadMore', () => state.loadMore(), s.loading));
    const main = node('section', undefined, 'chat-main'); main.setAttribute('aria-label', t('chat.history'));
    if (s.mode === 'single') main.append(node('p', t('chat.single'), 'chat-notice'));
    if (s.error && !(s.receipt?.stored === true && s.error === s.receipt.error)) { const error = node('p', t(errorKey(s.error)), 'chat-error'); error.setAttribute('role', 'alert'); main.append(error); }
    if (s.loading) main.append(node('p', t('chat.loading'), 'chat-notice'));
    if (!s.selectedId) main.append(node('p', t('chat.select'), 'chat-notice'));
    else {
      const current = s.conversation ?? s.items.find(item => item.id === s.selectedId);
      const header = node('div', undefined, 'chat-header'); header.append(node('h2', nameOf(current)));
      if (s.canWrite) {
        const form = node('form', undefined, 'chat-rename');
        const input = node('input', undefined, 'chat-name'); input.value = current?.displayName ?? current?.display_name ?? ''; input.maxLength = 40; input.setAttribute('aria-label', t('chat.name'));
        const rename = node('button', t('chat.rename'), 'action-btn'); rename.type = 'submit'; rename.disabled = s.loading || s.sending;
        form.append(input, rename); form.addEventListener('submit', event => { event.preventDefault(); if (!rename.disabled) void state.rename(input.value || null); }); header.append(form);
      }
      main.append(header);
      const controls = node('div', undefined, 'chat-toolbar');
      if (s.messageCursor) controls.append(action('loadOlder', () => state.loadOlder(), s.loading));
      if (!(s.receipt?.draft === true || current?.state === 'draft' || current?.draft === true)) controls.append(action('refreshMessages', () => state.refreshMessages(), s.loading), action('refreshStatus', () => state.refreshStatus(), s.loading));
      main.append(controls);
      if (s.tab === 'mine' && !s.selectedId.startsWith('d:')) {
        if (s.questionsLoading || s.questionError || !s.questionsReady) main.append(node('p', t(s.questionsLoading ? 'chat.questions.loading' : 'chat.questions.unavailable'), 'chat-notice'));
        if (s.questionCursor) main.append(action('loadMoreQuestions', () => state.loadMoreQuestions(), s.questionsLoading));
      }
      const messages = node('div', undefined, 'chat-messages');
      for (const row of s.messages) {
        const message = node('article', undefined, 'chat-message ' + (row.direction === 'in' ? 'chat-in' : 'chat-out'));
        message.dataset.messageId = String(row.id);
        const content = renderChatContent({ document, row, t, renderQuestion: ({ envelope, block }) => {
          const question = s.questions.find(item => String(item.c4Id) === String(row.id) && item.interruptId === envelope.interruptId);
          const formKey = `${row.id}:${envelope.interruptId}`;
          if (!s.questionForms.has(formKey)) s.questionForms.set(formKey, {});
          return renderQuestion({ document, envelope, block, row, question, t,
            stateAvailable: s.questionsReady && !s.questionError, readOnlyExternal: s.tab === 'external',
            statePendingPage: !!s.questionCursor,
            canWrite: s.canWrite && s.questionsReady,
            formState: s.questionForms.get(formKey),
            onSubmit: (answer, options) => state.answer(envelope.interruptId, answer, { ...options, conversationId: s.selectedId, questionC4Id: row.id }) });
        } });
        message.append(node('span', t(row.direction === 'in' ? 'chat.user' : 'chat.assistant'), 'chat-message-author'), content,
          node('span', t('chat.state.' + messageState(row)), 'chat-message-status'));
        messages.append(message);
      }
      main.append(messages);
      const receiptLabel = s.sending ? 'sending' : receiptState(s.receipt);
      if ((s.receipt || s.sending) && receiptLabel) { const status = node('p', t('chat.state.' + receiptLabel), 'chat-message-status'); status.setAttribute('role', 'status'); main.append(status); }
      if (s.canWrite) {
        const form = node('form', undefined, 'chat-composer');
        const input = node('textarea', undefined, 'chat-input'); input.value = s.input; input.setAttribute('aria-label', t('chat.input')); input.disabled = s.sending;
        input.addEventListener('input', () => state.setInput(input.value));
        const send = node('button', t('chat.' + (s.retryRequired ? 'retry' : 'send')), 'action-btn'); send.type = 'submit'; send.dataset.action = s.retryRequired ? 'retry' : 'send'; send.disabled = s.sending || (s.retryRequired && !s.canRetry) || !s.input.trim();
        // Input events update state without replacing the focused textarea.
        input.addEventListener('input', () => { send.disabled = s.sending || (s.retryRequired && !s.canRetry) || !input.value.trim(); });
        form.addEventListener('submit', event => { event.preventDefault(); if (!send.disabled) void state.send({ retry: s.retryRequired }); });
        form.append(input, send); main.append(form);
      }
    }
    layout.append(list, main); root.replaceChildren(toolbar, layout);
  }
  let inputOnly = false;
  const unsubscribe = state.subscribe(() => { if (!inputOnly) redraw(); });
  // setInput notifications must not rebuild a live editing control.
  const setInput = state.setInput;
  state.setInput = value => { inputOnly = true; try { return setInput(value); } finally { inputOnly = false; } };
  redraw();
  return { open: (...args) => state.open(...args), close: () => state.close(), redraw,
    destroy() { destroyed = true; unsubscribe(); state.destroy(); root.replaceChildren(); } };
}
