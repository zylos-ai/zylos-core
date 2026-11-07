import { parseC4Content, CONTENT_PREFIX, validateAnswer } from '../../chat-schema.js?v=90';
import { element } from './plain-text.js?v=85';
import { receiptState } from './chat-state.js?v=91';

const clone = value => JSON.parse(JSON.stringify(value));
const referenceMatches = (question, envelope, block, row) => question && !question.questionError && row?.direction === 'out'
  && /^[1-9][0-9]*$/.test(String(row.id))
  && String(question.c4Id) === String(row.id)
  && question.messageId === envelope.messageId && question.interruptId === envelope.interruptId
  && question.questionSummary === envelope.questionSummary && envelope.interrupt?.blockId === block.id;

/** A question uses its immutable message for fields and Dashboard for its current lifecycle. */
export function renderQuestion({ document, envelope, block, row, question, canWrite = false, stateAvailable = true, statePendingPage = false, readOnlyExternal = false,
  t = key => key, onSubmit = null, formState = {} } = {}) {
  const node = (tag, text, cls) => element(document, tag, text, cls);
  const root = node('div', undefined, 'chat-question');
  const validEnvelope = parseC4Content(CONTENT_PREFIX + JSON.stringify(envelope));
  const valid = validEnvelope.kind === 'envelope' && referenceMatches(question, envelope, block, row);
  const lifecycle = valid && ['paused', 'answered', 'stopped', 'superseded'].includes(question.status)
    ? question.status : 'unavailable';
  root.dataset.interruptId = envelope?.interruptId || '';
  if (readOnlyExternal) root.append(node('p', t('chat.question.externalReadOnly'), 'chat-question-status'));
  else {
    if (statePendingPage && !question) root.append(node('p', t('chat.question.stateNotLoaded'), 'chat-question-status'));
    else if (valid || stateAvailable) root.append(node('p', t('chat.question.' + lifecycle), 'chat-question-status'));
    if (!stateAvailable) root.append(node('p', t(valid ? 'chat.question.stateUnavailable' : 'chat.questions.unavailable'), 'chat-notice'));
  }
  const receipt = formState.receipt ?? (valid ? question.delivery : null);
  if (receipt) {
    const deliveryState = receipt.stored === false ? 'not_stored' : receiptState(receipt);
    const label = node('p', t('chat.state.' + deliveryState), 'chat-message-status');
    label.setAttribute('role', 'status'); root.append(label);
  }
  const ended = ['chat_question_not_paused', 'chat_answer_conflict'].includes(formState.error);
  if (formState.error && (ended || receipt?.stored !== true)) {
    const errorKey = ended ? 'chat.question.ended'
      : formState.error === 'chat_question_unavailable' ? 'chat.question.invalidData' : 'chat.question.submitFailed';
    const error = node('p', t(errorKey), 'chat-error');
    error.setAttribute('role', 'alert'); root.append(error);
  }
  const actionUnavailable = lifecycle === 'answered' && (question.actionError ||
    (question.action && (question.action.id !== question.answerId || !validateAnswer(question.action, envelope))) ||
    (formState.action && (formState.action.id !== question.answerId || !validateAnswer(formState.action, envelope))));
  if (actionUnavailable) root.append(node('p', t('chat.question.actionUnavailable'), 'chat-error'));
  const writable = canWrite && !readOnlyExternal && valid && !actionUnavailable && typeof onSubmit === 'function';
  const controls = [];
  let submitting = false;
  const status = node('p', '', 'chat-error'); status.setAttribute('role', 'alert');
  function button(text, handler, action) {
    const result = node('button', text, 'action-btn'); result.type = 'button';
    result.dataset.action = action; result.disabled = !!formState.sending;
    result.addEventListener('click', () => { if (!result.disabled) handler(); });
    controls.push(result); return result;
  }
  function disable() { for (const control of controls) control.disabled = true; }
  async function submit(action, retry = false) {
    if (formState.sending || submitting || !writable || (!retry && formState.locked) || !validateAnswer(action, envelope)) {
      if (!formState.sending && !submitting) status.textContent = t('chat.question.invalidAnswer');
      return;
    }
    formState.action = action; submitting = true; disable();
    try { await onSubmit(action, { retry }); }
    catch { formState.error = 'chat_answer_failed'; status.textContent = t('chat.question.submitFailed'); }
    finally { submitting = false; for (const control of controls) control.disabled = !!(formState.locked || formState.sending); }
  }
  const answer = payload => {
    const previous = formState.action;
    const action = previous && JSON.stringify(previous.payload) === JSON.stringify(payload) ? previous
      : { id: 'answer-' + globalThis.crypto.randomUUID(), protocolVersion: '0.1',
        type: block.data.action.type, target: block.data.action.target,
        context: { messageId: envelope.messageId, blockId: block.id }, payload };
    void submit(action);
  };
  const retryAccepted = lifecycle === 'answered' && question.answerId === formState.action?.id && receipt?.retryAllowed === true;
  if (writable && formState.action && validateAnswer(formState.action, envelope) && retryAccepted) {
    root.append(button(t('chat.retry'), () => { void submit(formState.action, true); }, 'retryAnswer'), status);
    return root;
  }
  if (!writable || lifecycle !== 'paused' || formState.locked) {
    if (lifecycle === 'paused') root.append(node('p', t('chat.question.readOnly'), 'chat-notice'));
    return root;
  }
  const data = block.data;
  if (block.type === 'choice') {
    root.dataset.choiceControls = 'true';
    formState.selected ??= [];
    const group = node('div', undefined, 'chat-question-options');
    for (const option of data.options) {
      const label = node('label', undefined, 'chat-question-option');
      const input = node('input'); input.type = data.selection === 'multiple' ? 'checkbox' : 'radio';
      input.name = 'choice-' + envelope.interruptId; input.value = option.id;
      input.checked = formState.selected.includes(option.id); input.disabled = !!formState.sending;
      input.addEventListener('change', () => {
        formState.selected = data.selection === 'multiple'
          ? input.checked ? [...new Set([...formState.selected, option.id])] : formState.selected.filter(id => id !== option.id)
          : input.checked ? [option.id] : [];
      });
      controls.push(input); label.append(input, node('span', option.label));
      if (option.description) label.append(node('span', option.description, 'chat-notice'));
      group.append(label);
    }
    root.append(group, button(t('chat.question.submit'), () => answer({ selected: [...formState.selected] }), 'answer'));
  } else if (block.type === 'confirmation') {
    root.append(button(data.confirmLabel || t('chat.question.confirm'), () => answer({ outcome: 'confirm' }), 'confirmAnswer'),
      button(data.cancelLabel || t('chat.question.cancel'), () => answer({ outcome: 'cancel' }), 'cancelAnswer'));
  } else if (block.type === 'form_intent') {
    formState.values ??= {};
    const form = node('div', undefined, 'chat-question-fields');
    for (const field of data.fields) {
      if (!Object.hasOwn(formState.values, field.key) && field.defaultValue !== undefined) formState.values[field.key] = clone(field.defaultValue);
      if (!Object.hasOwn(formState.values, field.key) && field.type === 'boolean' && field.required === true) formState.values[field.key] = false;
      const label = node('label', undefined, 'chat-question-field'); label.append(node('span', field.label));
      let input;
      const value = formState.values[field.key];
      if (field.type === 'single_select' || field.type === 'multi_select') {
        input = node('select'); input.multiple = field.type === 'multi_select';
        if (!input.multiple) { const empty = node('option', t('chat.question.choose')); empty.value = ''; input.append(empty); }
        for (const option of field.options) {
          const item = node('option', option.label); item.value = option.id;
          item.selected = input.multiple ? (value ?? []).includes(option.id) : value === option.id;
          input.append(item);
        }
        if (!input.multiple) input.value = value ?? '';
      } else {
        input = node(field.type === 'multiline_text' ? 'textarea' : 'input');
        input.type = field.type === 'boolean' ? 'checkbox' : ['number', 'integer'].includes(field.type) ? 'number'
          : field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : 'text';
        if (field.type === 'boolean') input.checked = value === true;
        else if (field.type === 'datetime' && value) {
          const d = new Date(value);
          input.value = Number.isFinite(d.getTime()) ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
        } else input.value = value ?? '';
        if (field.min !== undefined) input.min = field.min;
        if (field.max !== undefined) input.max = field.max;
        if (field.type === 'integer') input.step = '1';
        else if (field.type === 'number') input.step = 'any';
        if (field.maxLength !== undefined) input.maxLength = field.maxLength * 2;
        if (field.placeholder) input.placeholder = field.placeholder;
      }
      input.setAttribute('aria-label', field.label); input.disabled = !!formState.sending;
      const save = () => {
        if (field.type === 'boolean') formState.values[field.key] = input.checked;
        else if (field.type === 'multi_select') formState.values[field.key] = [...input.selectedOptions].map(option => option.value);
        else if (input.value === '' && !['text', 'multiline_text'].includes(field.type)) delete formState.values[field.key];
        else if (['number', 'integer'].includes(field.type)) formState.values[field.key] = Number(input.value);
        else if (field.type === 'datetime') { const d = new Date(input.value); formState.values[field.key] = Number.isFinite(d.getTime()) ? d.toISOString() : input.value; }
        else formState.values[field.key] = input.value;
      };
      input.addEventListener('input', save); input.addEventListener('change', save);
      controls.push(input); label.append(input);
      if (field.help) label.append(node('span', field.help, 'chat-notice'));
      form.append(label);
    }
    root.append(form, button(data.submitLabel || t('chat.question.submit'), () => answer({ values: clone(formState.values) }), 'answer'));
  }
  if (envelope.interrupt.otherInput !== false) {
    const label = node('label', t('chat.question.otherAnswer'), 'chat-question-other');
    const input = node('textarea'); input.value = formState.freeText ?? ''; input.maxLength = 1000;
    input.setAttribute('aria-label', t('chat.question.otherAnswer')); input.disabled = !!formState.sending;
    input.addEventListener('input', () => { formState.freeText = input.value; });
    controls.push(input); label.append(input);
    root.append(label, button(t('chat.question.submitOther'), () => answer({ freeText: formState.freeText ?? '' }), 'answerOther'));
  }
  root.append(status);
  return root;
}
