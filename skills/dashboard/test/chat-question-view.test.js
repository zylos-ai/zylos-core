import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick, deferred } from './fixtures/workbench-dom.js';
import { CONTENT_PREFIX, parseC4Content, makeQuestionSummary, validateAnswer } from '../../comm-bridge/scripts/c4-content-schema.js';
const browserSchema = new URL('../public/chat-schema.js', import.meta.url).href;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).href === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { renderQuestion } = await import('../public/js/wb/chat-questions.js');
const t = key => key;
function fixture({ type = 'choice', data = {}, status = 'paused', canWrite = true, missing = false,
  mutateQuestion, formState = {}, submit = async () => {} } = {}) {
  const defaults = type === 'choice' ? { prompt: 'Pick one', options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }], action: { type: 'choice.select', target: 'answer.choice' } }
    : type === 'confirmation' ? { title: 'Proceed?', severity: 'normal', action: { type: 'confirmation.respond', target: 'answer.confirm' } }
      : { title: 'Your details', fields: [{ key: 'name', label: 'Name', type: 'text', required: true, maxLength: 10 }], action: { type: 'form.submit', target: 'answer.form' } };
  const block = { id: 'question', type, schemaVersion: 1, fallbackText: 'Question fallback', data: { ...defaults, ...data } };
  const envelope = { version: 1, kind: 'message', messageId: 'message-one', fallbackText: 'Question fallback; waiting',
    blocks: [block], interruptId: 'question-one', interrupt: { blockId: block.id, reason: type === 'confirmation' ? 'confirmation' : 'input_required' } };
  envelope.questionSummary = makeQuestionSummary(envelope);
  assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(envelope)).kind, 'envelope');
  const row = { id: 12, direction: 'out' };
  const question = missing ? null : { c4_id: 12, message_id: envelope.messageId, interrupt_id: envelope.interruptId,
    question_summary: envelope.questionSummary, status };
  mutateQuestion?.(question);
  const document = createDocument(), requests = [];
  const render = () => renderQuestion({ document, row, envelope, block, question, canWrite, t, formState,
    onSubmit: async (action, options) => { requests.push({ action, options }); return submit(action, options); } });
  const root = render();
  return { root, render, requests, question, envelope, formState, nodes: () => allNodes(root),
    button: name => allNodes(root).find(node => node.dataset.action === name) };
}
const change = (input, value) => { input.value = value; input.dispatch('input'); input.dispatch('change'); };

test('paused choice submits one shared-schema answer and binds immutable message and block', async () => {
  const f = fixture();
  const first = f.nodes().find(node => node.tagName === 'INPUT'); first.checked = true; first.dispatch('change');
  f.button('answer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 1);
  const { action, options } = f.requests[0];
  assert.equal(validateAnswer(action, f.envelope), true);
  assert.deepEqual(action.payload, { selected: ['a'] });
  assert.deepEqual(action.context, { messageId: 'message-one', blockId: 'question' });
  assert.deepEqual(options, { retry: false });
  assert.equal(f.nodes().some(node => /stop/i.test(node.dataset.action || '')), false);
});

test('multiple choice honors saved selection bounds before invoking the API', async () => {
  const f = fixture({ data: { selection: 'multiple', minSelect: 2, maxSelect: 2 } });
  const inputs = f.nodes().filter(node => node.tagName === 'INPUT');
  inputs[0].checked = true; inputs[0].dispatch('change'); f.button('answer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 0); assert.match(f.root.textContent, /invalidAnswer/);
  inputs[1].checked = true; inputs[1].dispatch('change'); f.button('answer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].action.payload.selected, ['a', 'b']);
});

for (const status of ['answered', 'stopped', 'superseded', 'unknown']) test(`${status} question restores status without any answer actions`, () => {
  const f = fixture({ status });
  assert.match(f.root.textContent, new RegExp('chat.question.' + (status === 'unknown' ? 'unavailable' : status)));
  assert.equal(f.nodes().some(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)), false);
});

for (const reason of ['readonly', 'unregistered', 'wrong-c4', 'wrong-message', 'wrong-interrupt', 'wrong-summary']) test(`${reason} cannot submit a historical question`, () => {
  const f = fixture({ canWrite: reason !== 'readonly', missing: reason === 'unregistered', mutateQuestion(q) {
    if (reason === 'wrong-c4') q.c4_id = 99;
    if (reason === 'wrong-message') q.message_id = 'different-message';
    if (reason === 'wrong-interrupt') q.interrupt_id = 'different-question';
    if (reason === 'wrong-summary') q.question_summary = 'Different summary';
  } });
  assert.equal(f.nodes().some(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)), false);
  assert.equal(f.requests.length, 0);
});

test('confirmation cancel remains an answer and never calls a lifecycle control', async () => {
  const f = fixture({ type: 'confirmation', data: { cancelLabel: '<img src=x>' } });
  assert.match(f.root.textContent, /<img src=x/); assert.equal(f.nodes().some(node => node.tagName === 'IMG'), false);
  f.button('cancelAnswer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].action.payload, { outcome: 'cancel' });
  assert.equal(f.requests[0].action.type, 'confirmation.respond');
  assert.equal(f.question.status, 'paused');
});

test('forms retain valid typed values after failure and redraw', async () => {
  const f = fixture({ type: 'form_intent', submit: async () => { throw new Error('network'); } });
  const input = f.nodes().find(node => node.tagName === 'INPUT'); change(input, 'Howard');
  f.button('answer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].action.payload, { values: { name: 'Howard' } });
  assert.equal(validateAnswer(f.requests[0].action, f.envelope), true);
  const redrawn = f.render(); assert.equal(allNodes(redrawn).find(node => node.tagName === 'INPUT').value, 'Howard');
  assert.match(redrawn.textContent, /submitFailed/);
  allNodes(redrawn).find(node => node.dataset.action === 'answer').dispatch('click'); await tick();
  assert.equal(f.requests[0].action.id, f.requests[1].action.id);
});

test('form fields submit typed values for all supported scalar and select types', async () => {
  const fields = [
    { key: 'text', label: 'Text', type: 'text', defaultValue: 'default' },
    { key: 'lines', label: 'Lines', type: 'multiline_text' },
    { key: 'count', label: 'Count', type: 'integer', min: 1, max: 5 },
    { key: 'price', label: 'Price', type: 'number' },
    { key: 'day', label: 'Day', type: 'date' },
    { key: 'time', label: 'Time', type: 'datetime' },
    { key: 'agree', label: 'Agree', type: 'boolean' },
    { key: 'one', label: 'One', type: 'single_select', options: [{ id: 'a', label: 'A' }] },
    { key: 'many', label: 'Many', type: 'multi_select', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
  ];
  const f = fixture({ type: 'form_intent', data: { fields } });
  const field = label => f.nodes().find(node => node.attributes['aria-label'] === label);
  change(field('Lines'), 'two\nlines'); change(field('Count'), '2'); change(field('Price'), '1.5');
  change(field('Day'), '2026-11-07'); change(field('Time'), '2026-11-07T10:20');
  field('Agree').checked = true; field('Agree').dispatch('change'); change(field('One'), 'a');
  field('Many').selectedOptions = [{ value: 'a' }, { value: 'b' }]; field('Many').dispatch('change');
  f.button('answer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); const values = f.requests[0].action.payload.values;
  assert.equal(values.text, 'default'); assert.equal(values.lines, 'two\nlines'); assert.equal(values.count, 2);
  assert.equal(values.price, 1.5); assert.equal(values.day, '2026-11-07'); assert.match(values.time, /Z$/);
  assert.equal(values.agree, true); assert.equal(values.one, 'a'); assert.deepEqual(values.many, ['a', 'b']);
  assert.equal(validateAnswer(f.requests[0].action, f.envelope), true);
});

test('invalid form values stay visible and produce zero requests', async () => {
  const f = fixture({ type: 'form_intent', data: { fields: [{ key: 'count', label: 'Count', type: 'integer', min: 1, max: 5, required: true }] } });
  const input = f.nodes().find(node => node.tagName === 'INPUT'); change(input, '8');
  f.button('answer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 0); assert.match(f.root.textContent, /invalidAnswer/);
  assert.equal(allNodes(f.render()).find(node => node.tagName === 'INPUT').value, 8);
});

test('double click has one in-flight answer and explicit retry keeps the original action', async () => {
  const pending = deferred();
  const f = fixture({ type: 'confirmation', submit: () => pending.promise });
  const confirm = f.button('confirmAnswer'); confirm.dispatch('click'); confirm.dispatch('click');
  assert.equal(f.requests.length, 1); assert.equal(confirm.disabled, true);
  f.formState.receipt = { stored: false, retryAllowed: true, deliveryState: 'not_stored' }; f.formState.locked = true;
  f.question.status = 'answered'; f.question.answer_id = f.formState.action.id;
  pending.resolve(); await tick();
  const redrawn = f.render(); const retry = allNodes(redrawn).find(node => node.dataset.action === 'retryAnswer');
  assert.ok(retry); assert.equal(allNodes(redrawn).some(node => node.dataset.action === 'cancelAnswer'), false);
  retry.dispatch('click'); await tick();
  assert.equal(f.requests.length, 2); assert.equal(f.requests[1].action, f.requests[0].action); assert.equal(f.requests[1].options.retry, true);
});

test('unknown delivery locks alternate input and cannot be retried without server permission', () => {
  const f = fixture({ formState: { locked: true, receipt: { stored: null, retryAllowed: false } } });
  assert.match(f.root.textContent, /pending_reconciliation/);
  assert.equal(f.nodes().some(node => ['BUTTON', 'INPUT', 'TEXTAREA'].includes(node.tagName)), false);
});

test('free-text answers use the same question and validation, never ordinary send', async () => {
  const f = fixture(); const input = f.nodes().find(node => node.tagName === 'TEXTAREA');
  change(input, '<script>read this literally</script>'); f.button('answerOther').dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].action.payload, { freeText: '<script>read this literally</script>' });
  assert.equal(validateAnswer(f.requests[0].action, f.envelope), true);
});

test('required unchecked boolean is a valid false answer without an extra toggle', async () => {
  const f = fixture({ type: 'form_intent', data: { fields: [{ key: 'enabled', label: 'Enabled', type: 'boolean', required: true }] } });
  f.button('answer').dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].action.payload, { values: { enabled: false } });
});

test('stopped or superseded questions cannot expose a stale retry receipt', () => {
  for (const status of ['stopped', 'superseded']) {
    const f = fixture({ status, formState: { action: { id: 'answer-retained' }, receipt: { stored: false, retryAllowed: true } } });
    assert.equal(f.nodes().some(node => node.tagName === 'BUTTON'), false);
  }
});

test('full mounted page posts an answer, then exposes an enabled explicit retry with the same action', async () => {
  const { mountChat } = await import('../public/js/wb/chat.js');
  const base = fixture({ type: 'confirmation' });
  const document = createDocument(), root = document.createElement('div'), calls = [];
  let q = { ...base.question };
  const receipt = { stored: false, deliveryState: 'not_stored', retryAllowed: true, needsReconciliation: false };
  const page = mountChat({ document, root, t, fetch: async (path, options = {}) => {
    calls.push({ path, options });
    let data;
    if (path.endsWith('/answers')) {
      const body = JSON.parse(options.body);
      q = { ...q, status: 'answered', answer_id: body.action.id, delivery: receipt };
      data = { answer: { answerId: body.action.id }, delivery: receipt };
    } else if (path.includes('/questions?')) data = { items: [q], nextCursor: null };
    else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active', displayName: 'Original group' }, stored: false };
    else data = { items: [{ id: 'g:AA', display_name: 'Original group' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  await page.open(); allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  const confirm = allNodes(root).find(node => node.dataset.action === 'confirmAnswer'); assert.ok(confirm);
  confirm.dispatch('click'); confirm.dispatch('click'); await tick(); await tick();
  const first = calls.filter(call => call.path.endsWith('/answers')); assert.equal(first.length, 1);
  const retry = allNodes(root).find(node => node.dataset.action === 'retryAnswer'); assert.ok(retry); assert.equal(retry.disabled, false);
  retry.dispatch('click'); await tick(); await tick();
  const posts = calls.filter(call => call.path.endsWith('/answers')); assert.equal(posts.length, 2);
  assert.equal(posts[1].path, '/api/chat/conversations/g%3AAA/answers');
  const original = JSON.parse(posts[0].options.body), retried = JSON.parse(posts[1].options.body);
  assert.deepEqual(Object.keys(original).sort(), ['action', 'interruptId']); assert.equal(retried.retry, true);
  assert.deepEqual(retried.action, original.action); assert.equal(original.interruptId, base.envelope.interruptId);
  page.destroy();
});

test('unknown answer can only retry the same action after manual refresh confirms the question remains paused', async () => {
  const { mountChat } = await import('../public/js/wb/chat.js');
  const base = fixture({ type: 'confirmation' });
  const document = createDocument(), root = document.createElement('div'), posts = [];
  let questionReads = 0;
  const page = mountChat({ document, root, t, fetch: async (path, options = {}) => {
    let data;
    if (path.endsWith('/answers')) {
      const body = JSON.parse(options.body); posts.push(body);
      if (posts.length === 1) throw new Error('response lost');
      data = { answer: { answerId: body.action.id }, delivery: { stored: true, deliveryState: 'pending', retryAllowed: false } };
    } else if (path.includes('/questions?')) { questionReads++; data = { items: [{ ...base.question, status: 'paused', answer_id: null }], nextCursor: null }; }
    else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active', displayName: 'Original group' }, stored: false };
    else data = { items: [{ id: 'g:AA', display_name: 'Original group' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  const find = key => allNodes(root).find(node => node.dataset.action === key);
  await page.open(); allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  find('confirmAnswer').dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 1); assert.equal(find('retryAnswer'), undefined); assert.equal(find('cancelAnswer'), undefined);
  const before = questionReads;
  find('refresh').dispatch('click'); await tick(); await tick();
  assert.ok(questionReads > before); assert.equal(posts.length, 1);
  const retry = find('retryAnswer'); assert.ok(retry); assert.equal(retry.disabled, false);
  assert.equal(find('confirmAnswer'), undefined); assert.equal(find('cancelAnswer'), undefined); assert.equal(find('answerOther'), undefined);
  const card = allNodes(root).find(node => node.className === 'chat-question');
  assert.equal(allNodes(card).some(node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)), false);
  retry.dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 2); assert.equal(posts[1].retry, true); assert.deepEqual(posts[1].action, posts[0].action);
  assert.equal(posts[1].interruptId, posts[0].interruptId);
  page.destroy();
});

test('accepted answer without a C4 row displays not-stored instead of an empty draft receipt', () => {
  const f = fixture({ status: 'answered', formState: { receipt: {
    accepted: true, stored: false, retryAllowed: true, deliveryState: null,
  } } });
  assert.match(f.root.textContent, /chat.state.not_stored/);
  assert.equal(f.root.textContent.includes('chat.state.null'), false);
});

test('valid saved accepted action exposes an exact explicit retry', async () => {
  const base = fixture({ type: 'confirmation' });
  const action = { id: 'answer-saved-one', protocolVersion: '0.1', type: 'confirmation.respond', target: 'answer.confirm',
    context: { messageId: base.envelope.messageId, blockId: 'question' }, payload: { outcome: 'cancel' } };
  const f = fixture({ type: 'confirmation', status: 'answered', formState: { action, locked: true }, mutateQuestion(q) {
    q.answer_id = action.id; q.action = action; q.delivery = { stored: false, retryAllowed: true };
  } });
  const retry = f.button('retryAnswer'); assert.ok(retry); retry.dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0], { action, options: { retry: true } });
  assert.equal(f.button('confirmAnswer'), undefined); assert.equal(f.button('cancelAnswer'), undefined);
});

for (const problem of ['actionError', 'malformed', 'different-id']) test(`saved action ${problem} is readable but cannot expose retry`, () => {
  const action = { id: 'answer-saved-one', protocolVersion: '0.1', type: 'confirmation.respond', target: 'answer.confirm',
    context: { messageId: 'message-one', blockId: 'question' }, payload: { outcome: 'confirm' } };
  if (problem === 'malformed') action.context.blockId = 'wrong';
  const f = fixture({ type: 'confirmation', status: 'answered', formState: { action, locked: true }, mutateQuestion(q) {
    q.answer_id = problem === 'different-id' ? 'answer-different' : action.id;
    q.action = action; q.delivery = { stored: false, retryAllowed: true };
    if (problem === 'actionError') q.actionError = 'chat_answer_action_invalid';
  } });
  assert.match(f.root.textContent, /chat.question.actionUnavailable/);
  assert.equal(f.nodes().some(node => node.tagName === 'BUTTON'), false); assert.equal(f.requests.length, 0);
});

test('opening an answered question hydrates its stored action and retries exactly after reload', async () => {
  const { mountChat } = await import('../public/js/wb/chat.js');
  const base = fixture({ type: 'confirmation' });
  const action = { id: 'answer-persisted', protocolVersion: '0.1', type: 'confirmation.respond', target: 'answer.confirm',
    context: { messageId: base.envelope.messageId, blockId: 'question' }, payload: { outcome: 'cancel' }, clientTs: '2026-11-07T01:02:03Z' };
  const document = createDocument(), root = document.createElement('div'), posts = [];
  const page = mountChat({ document, root, t, fetch: async (path, options = {}) => {
    let data;
    if (path.endsWith('/answers')) {
      const body = JSON.parse(options.body); posts.push(body);
      data = { answer: { answerId: action.id }, delivery: { stored: true, deliveryState: 'pending', retryAllowed: false } };
    } else if (path.includes('/questions?')) data = { items: [{ ...base.question, status: 'answered', answer_id: action.id, action,
      delivery: { accepted: true, stored: false, deliveryState: null, retryAllowed: true } }], nextCursor: null };
    else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active', displayName: 'Original group' }, stored: false };
    else data = { items: [{ id: 'g:AA', display_name: 'Original group' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  await page.open(); allNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 0);
  const retry = allNodes(root).find(node => node.dataset.action === 'retryAnswer'); assert.ok(retry); assert.equal(retry.disabled, false);
  assert.equal(allNodes(root).some(node => ['confirmAnswer', 'cancelAnswer', 'answerOther'].includes(node.dataset.action)), false);
  retry.dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 1); assert.deepEqual(posts[0], { interruptId: base.envelope.interruptId, action, retry: true });
  page.destroy();
});
