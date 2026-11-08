import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, visibleNodes, visibleText, tick, deferred } from './helpers/conversation-dom.js';
import { CONTENT_PREFIX, parseC4Content, makeQuestionSummary, validateAnswer } from '../../comm-bridge/scripts/c4-content-schema.js';
const browserSchema = new URL('../public/chat-schema.js?v=92', import.meta.url).href;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === new URL(browserSchema).pathname) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { renderQuestion } = await import('../public/js/wb/chat-questions.js');
const t = key => key;
function fixture({ type = 'choice', data = {}, status = 'paused', canWrite = true, missing = false, stateAvailable = true, statePendingPage = false, readOnlyExternal = false,
  mutateQuestion, formState = {}, submit = async () => {}, otherAnswerDisclosure = false, timeZone = null } = {}) {
  const defaults = type === 'choice' ? { prompt: 'Pick one', options: [{ id: 'a', label: 'First' }, { id: 'b', label: 'Second' }], action: { type: 'choice.select', target: 'answer.choice' } }
    : type === 'confirmation' ? { title: 'Proceed?', severity: 'normal', action: { type: 'confirmation.respond', target: 'answer.confirm' } }
      : { title: 'Your details', fields: [{ key: 'name', label: 'Name', type: 'text', required: true, maxLength: 10 }], action: { type: 'form.submit', target: 'answer.form' } };
  const block = { id: 'question', type, schemaVersion: 1, fallbackText: 'Question fallback', data: { ...defaults, ...data } };
  const envelope = { version: 1, kind: 'message', messageId: 'message-one', fallbackText: 'Question fallback; waiting',
    blocks: [block], interruptId: 'question-one', interrupt: { blockId: block.id, reason: type === 'confirmation' ? 'confirmation' : 'input_required' } };
  envelope.questionSummary = makeQuestionSummary(envelope);
  assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(envelope)).kind, 'envelope');
  const row = { id: 12, direction: 'out' };
  const question = missing ? null : { c4Id: '12', messageId: envelope.messageId, interruptId: envelope.interruptId,
    questionSummary: envelope.questionSummary, constraints: { block, interrupt: envelope.interrupt },
    status, answerId: null, action: null, actionError: null, delivery: null };
  mutateQuestion?.(question);
  const document = createDocument(), requests = [];
  const render = () => renderQuestion({ document, row, envelope, block, question, canWrite, stateAvailable, statePendingPage, readOnlyExternal, otherAnswerDisclosure, t, formState, timeZone,
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
    if (reason === 'wrong-c4') q.c4Id = '99';
    if (reason === 'wrong-message') q.messageId = 'different-message';
    if (reason === 'wrong-interrupt') q.interruptId = 'different-question';
    if (reason === 'wrong-summary') q.questionSummary = 'Different summary';
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

test('date-time fields show and read wall time in the instance time zone, not the browser zone', async t => {
  const saved = process.env.TZ;
  t.after(() => { if (saved === undefined) delete process.env.TZ; else process.env.TZ = saved; });
  process.env.TZ = 'America/Los_Angeles';
  const fields = [{ key: 'time', label: 'Time', type: 'datetime', defaultValue: '2026-11-07T17:30:00Z' }];
  for (const [timeZone, shown, typed, sent] of [
    ['Asia/Shanghai', '2026-11-08T01:30', '2026-11-08T09:00', '2026-11-08T01:00:00.000Z'],
    [null, '2026-11-07T17:30', '2026-11-08T09:00', '2026-11-08T09:00:00.000Z'],
  ]) {
    const f = fixture({ type: 'form_intent', data: { fields }, timeZone });
    const input = f.nodes().find(node => node.attributes['aria-label'] === 'Time');
    assert.equal(input.value, shown, `the saved instant is shown in ${timeZone ?? 'UTC'}`);
    change(input, typed);
    f.button('answer').dispatch('click'); await tick();
    assert.equal(f.requests[0].action.payload.values.time, sent);
  }
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
  f.question.status = 'answered'; f.question.answerId = f.formState.action.id;
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

test('full mounted page posts an answer, then exposes an enabled explicit retry with the same action', async testContext => {
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const base = fixture({ type: 'confirmation' });
  const document = createDocument(), root = document.createElement('div'), calls = [];
  let q = { ...base.question };
  const receipt = { stored: false, deliveryState: 'not_stored', retryAllowed: true, needsReconciliation: false };
  const page = mountConversationPage({ document, root, t, fetch: async (path, options = {}) => {
    calls.push({ path, options });
    let data;
    if (path.endsWith('/answers')) {
      const body = JSON.parse(options.body);
      q = { ...q, status: 'answered', answerId: body.action.id, delivery: receipt };
      data = { answer: { answerId: body.action.id }, delivery: receipt };
    } else if (path.includes('/questions?')) data = { items: [q], nextCursor: null };
    else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active', displayName: 'Original group' }, stored: false };
    else data = { items: [{ id: 'g:AA', display_name: 'Original group' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  testContext.after(() => page.destroy());
  await page.open(); visibleNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  const confirm = visibleNodes(root).find(node => node.dataset.action === 'confirmAnswer'); assert.ok(confirm);
  confirm.dispatch('click'); confirm.dispatch('click'); await tick(); await tick();
  const first = calls.filter(call => call.path.endsWith('/answers')); assert.equal(first.length, 1);
  const retry = visibleNodes(root).find(node => node.dataset.action === 'retryAnswer'); assert.ok(retry); assert.equal(retry.disabled, false);
  retry.dispatch('click'); await tick(); await tick();
  const posts = calls.filter(call => call.path.endsWith('/answers')); assert.equal(posts.length, 2);
  assert.equal(posts[1].path, '/api/chat/conversations/g%3AAA/answers');
  const original = JSON.parse(posts[0].options.body), retried = JSON.parse(posts[1].options.body);
  assert.deepEqual(Object.keys(original).sort(), ['action', 'interruptId']); assert.equal(retried.retry, true);
  assert.deepEqual(retried.action, original.action); assert.equal(original.interruptId, base.envelope.interruptId);
  page.destroy();
});

test('unknown answer restores normal same-action submission after manual refresh confirms paused without an answer', async testContext => {
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const base = fixture({ type: 'confirmation' });
  const document = createDocument(), root = document.createElement('div'), posts = [];
  let questionReads = 0;
  const page = mountConversationPage({ document, root, t, fetch: async (path, options = {}) => {
    let data;
    if (path.endsWith('/answers')) {
      const body = JSON.parse(options.body); posts.push(body);
      if (posts.length === 1) throw new Error('response lost');
      data = { answer: { answerId: body.action.id }, delivery: { stored: true, deliveryState: 'pending', retryAllowed: false } };
    } else if (path.includes('/questions?')) { questionReads++; data = { items: [{ ...base.question, status: 'paused', answerId: null }], nextCursor: null }; }
    else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active', displayName: 'Original group' }, stored: false };
    else data = { items: [{ id: 'g:AA', display_name: 'Original group' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  const find = key => visibleNodes(root).find(node => node.dataset.action === key);
  testContext.after(() => page.destroy());
  await page.open(); visibleNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  find('confirmAnswer').dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 1); assert.equal(!!find('retryAnswer'), false); assert.equal(find('cancelAnswer').disabled, true);
  const before = questionReads;
  find('refresh').dispatch('click'); await tick(); await tick();
  assert.ok(questionReads > before); assert.equal(posts.length, 1);
  assert.equal(!!find('retryAnswer'), false);
  assert.ok(find('confirmAnswer')); assert.ok(find('cancelAnswer')); assert.ok(find('answerOther'));
  assert.equal(find('confirmAnswer').disabled, false);
  find('confirmAnswer').dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 2); assert.equal(Object.hasOwn(posts[1], 'retry'), false);
  assert.deepEqual(posts[1].action, posts[0].action);
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
    q.answerId = action.id; q.action = action; q.delivery = { stored: false, retryAllowed: true };
  } });
  const retry = f.button('retryAnswer'); assert.ok(retry); retry.dispatch('click'); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0], { action, options: { retry: true } });
  assert.equal(!!f.button('confirmAnswer'), false); assert.equal(!!f.button('cancelAnswer'), false);
});

for (const problem of ['actionError', 'malformed', 'different-id']) test(`saved action ${problem} is readable but cannot expose retry`, () => {
  const action = { id: 'answer-saved-one', protocolVersion: '0.1', type: 'confirmation.respond', target: 'answer.confirm',
    context: { messageId: 'message-one', blockId: 'question' }, payload: { outcome: 'confirm' } };
  if (problem === 'malformed') action.context.blockId = 'wrong';
  const f = fixture({ type: 'confirmation', status: 'answered', formState: { action, locked: true }, mutateQuestion(q) {
    q.answerId = problem === 'different-id' ? 'answer-different' : action.id;
    q.action = action; q.delivery = { stored: false, retryAllowed: true };
    if (problem === 'actionError') q.actionError = 'chat_answer_action_invalid';
  } });
  assert.match(f.root.textContent, /chat.question.actionUnavailable/);
  assert.equal(f.nodes().some(node => node.tagName === 'BUTTON'), false); assert.equal(f.requests.length, 0);
});

test('opening an answered question hydrates its stored action and retries exactly after reload', async testContext => {
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const base = fixture({ type: 'confirmation' });
  const action = { id: 'answer-persisted', protocolVersion: '0.1', type: 'confirmation.respond', target: 'answer.confirm',
    context: { messageId: base.envelope.messageId, blockId: 'question' }, payload: { outcome: 'cancel' }, clientTs: '2026-11-07T01:02:03Z' };
  const document = createDocument(), root = document.createElement('div'), posts = [];
  const page = mountConversationPage({ document, root, t, fetch: async (path, options = {}) => {
    let data;
    if (path.endsWith('/answers')) {
      const body = JSON.parse(options.body); posts.push(body);
      data = { answer: { answerId: action.id }, delivery: { stored: true, deliveryState: 'pending', retryAllowed: false } };
    } else if (path.includes('/questions?')) data = { items: [{ ...base.question, status: 'answered', answerId: action.id, action,
      delivery: { accepted: true, stored: false, deliveryState: null, retryAllowed: true } }], nextCursor: null };
    else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active', displayName: 'Original group' }, stored: false };
    else data = { items: [{ id: 'g:AA', display_name: 'Original group' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  testContext.after(() => page.destroy());
  await page.open(); visibleNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 0);
  const retry = visibleNodes(root).find(node => node.dataset.action === 'retryAnswer'); assert.ok(retry); assert.equal(retry.disabled, false);
  assert.equal(visibleNodes(root).some(node => ['confirmAnswer', 'cancelAnswer', 'answerOther'].includes(node.dataset.action)), false);
  retry.dispatch('click'); await tick(); await tick();
  assert.equal(posts.length, 1); assert.deepEqual(posts[0], { interruptId: base.envelope.interruptId, action, retry: true });
  page.destroy();
});

test('a failed state query preserves the last known lifecycle and explains the missing update separately', () => {
  const f = fixture({ status: 'paused', stateAvailable: false });
  assert.match(f.root.textContent, /chat.question.paused/); assert.match(f.root.textContent, /chat.question.stateUnavailable/);
  assert.equal(f.root.textContent.includes('chat.question.unavailable'), false);
  assert.ok(f.button('answer'));
  const initial = fixture({ missing: true, canWrite: false, stateAvailable: false });
  assert.match(initial.root.textContent, /chat.questions.unavailable/);
  assert.equal(initial.root.textContent.includes('chat.question.stateUnavailable'), false);
  assert.equal(initial.root.textContent.includes('chat.question.unavailable'), false);
  assert.equal(initial.nodes().some(node => node.tagName === 'BUTTON'), false);
});

test('external history explains read-only questions without claiming they are unregistered', () => {
  const f = fixture({ missing: true, canWrite: false, readOnlyExternal: true, stateAvailable: false });
  assert.match(f.root.textContent, /chat.question.externalReadOnly/);
  assert.equal(f.root.textContent.includes('chat.question.unavailable'), false);
  assert.equal(f.nodes().some(node => ['BUTTON', 'INPUT', 'TEXTAREA'].includes(node.tagName)), false);
});

test('a question whose state page is not loaded does not claim missing registration', () => {
  const f = fixture({ missing: true, canWrite: false, statePendingPage: true });
  assert.match(f.root.textContent, /chat.question.stateNotLoaded/);
  assert.equal(f.root.textContent.includes('chat.question.unavailable'), false);
  assert.equal(f.nodes().some(node => node.tagName === 'BUTTON'), false);
});

test('mounted later-page question stays read-only until its authority page is loaded', async testContext => {
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const base = fixture({ type: 'confirmation' });
  const document = createDocument(), root = document.createElement('div'), calls = [];
  const page = mountConversationPage({ document, root, t, fetch: async (path, options = {}) => {
    calls.push({ path, method: options.method || 'GET' });
    let data;
    if (path.includes('/questions?')) {
      const url = new URL(path, 'http://fixture.invalid');
      assert.equal(url.searchParams.get('limit'), '50');
      data = url.searchParams.get('cursor') === 'later-question-page'
        ? { items: [base.question], nextCursor: null }
        : { items: [], nextCursor: 'later-question-page' };
    } else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered',
      content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active' }, stored: false };
    else data = { items: [{ id: 'g:AA' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  testContext.after(() => page.destroy());
  try {
    await page.open();
    visibleNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click');
    await tick(); await tick();
    const find = key => visibleNodes(root).find(node => node.dataset.action === key);
    assert.match(visibleText(root), /chat.question.stateNotLoaded/);
    assert.equal(visibleText(root).includes('chat.question.unavailable'), false);
    assert.equal(!!find('confirmAnswer'), false);
    assert.equal(!!find('cancelAnswer'), false);
    assert.ok(find('loadMoreQuestions'));
    find('loadMoreQuestions').dispatch('click'); await tick(); await tick();
    assert.ok(calls.some(call => call.path.includes('cursor=later-question-page')));
    assert.equal(visibleText(root).includes('chat.question.stateNotLoaded'), false);
    assert.match(visibleText(root), /chat.question.paused/);
    assert.ok(find('confirmAnswer')); assert.ok(find('cancelAnswer'));
    assert.equal(!!find('loadMoreQuestions'), false);
    assert.equal(calls.filter(call => call.method !== 'GET').length, 0);
  } finally { page.destroy(); }
});

test('a mounted paused question preserves a definite invalid-data rejection after refresh', async testContext => {
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const base = fixture({ type: 'confirmation' });
  const document = createDocument(), root = document.createElement('div');
  let posts = 0, reads = 0;
  const page = mountConversationPage({ document, root, t, fetch: async (path, options = {}) => {
    if (path.endsWith('/answers')) { posts++; return { ok: false, status: 409, json: async () => ({ error: 'chat_question_unavailable' }) }; }
    const data = path.includes('/questions?') ? (reads++, { items: [base.question], nextCursor: null })
      : path.includes('/messages?') ? { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }], nextCursor: null, afterCursor: 'after' }
        : path.includes('session-mode') ? { data: { sessionMode: 'multi' } }
          : /conversations\/g%3AAA$/.test(path) ? { conversation: { id: 'g:AA', state: 'active' }, stored: false }
            : { items: [{ id: 'g:AA' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  const find = key => visibleNodes(root).find(node => node.dataset.action === key);
  testContext.after(() => page.destroy());
  await page.open(); visibleNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  find('confirmAnswer').dispatch('click'); await tick(); await tick();
  assert.equal(posts, 1); assert.equal(reads, 2);
  assert.match(visibleText(root), /chat.question.invalidData/);
  assert.equal(visibleText(root).includes('chat.state.pending_reconciliation'), false);
  assert.equal(find('confirmAnswer').disabled, true);
  find('refresh').dispatch('click'); await tick(); await tick();
  assert.match(visibleText(root), /chat.question.invalidData/);
  assert.equal(find('confirmAnswer').disabled, true); assert.equal(posts, 1);
  page.destroy();
});

for (const error of ['chat_question_not_paused', 'chat_answer_conflict']) test(`${error} uses the server-ended explanation without inventing delivery uncertainty`, () => {
  const f = fixture({ status: 'answered', formState: { error, locked: true }, mutateQuestion(q) { q.delivery = { stored: true, deliveryState: 'pending', retryAllowed: false }; } });
  assert.match(f.root.textContent, /chat.question.ended/);
  assert.equal(f.root.textContent.includes('pending_reconciliation'), false);
  assert.equal(f.root.textContent.includes('chat.question.submitFailed'), false);
});

async function mountedQuestions(testContext, { mode = 'multi', saved = false, retryAllowed, failQuestionQuery = false } = {}) {
  const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
  const base = fixture({ type: 'confirmation' });
  const action = { id: 'answer-saved-mount', protocolVersion: '0.1', type: 'confirmation.respond', target: 'answer.confirm',
    context: { messageId: base.envelope.messageId, blockId: 'question' }, payload: { outcome: 'confirm' } };
  const document = createDocument(), root = document.createElement('div'), posts = [];
  let queryFailed = failQuestionQuery, questionReads = 0;
  const page = mountConversationPage({ document, root, t, fetch: async (path, options = {}) => {
    let data;
    if (path.endsWith('/answers')) { posts.push(JSON.parse(options.body)); throw new Error('response lost'); }
    if (path.includes('/questions?')) {
      questionReads++;
      if (queryFailed) return { ok: false, status: 502, json: async () => ({ error: 'chat_question_unavailable' }) };
      data = { items: [{ ...base.question, ...(saved ? { status: 'answered', answerId: action.id, action,
        delivery: { stored: false, retryAllowed } } : {}) }], nextCursor: null };
    } else if (path.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(base.envelope) }, ...(queryFailed ? [{ id: 13, direction: 'out', status: 'delivered', content: 'A newly read message' }] : [])], nextCursor: null, afterCursor: 'after' };
    else if (path.includes('/status?')) data = { items: [] };
    else if (path.includes('/api/session-mode')) data = { data: { sessionMode: mode } };
    else if (/conversations\/g%3AAA$/.test(path)) data = { conversation: { id: 'g:AA', state: 'active', displayName: 'Original group' }, stored: false };
    else data = { items: [{ id: 'g:AA', display_name: 'Original group' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  testContext.after(() => page.destroy());
  await page.open(); visibleNodes(root).find(node => node.dataset.conversationId === 'g:AA').dispatch('click'); await tick(); await tick();
  return { root, posts, page, questionReads: () => questionReads, failQueries() { queryFailed = true; } };
}

test('mounted single-mode page displays the question but has no answer or retry controls', async testContext => {
  const f = await mountedQuestions(testContext, { mode: 'single' });
  assert.match(visibleText(f.root), /Proceed\?/);
  assert.equal(allNodes(f.root).some(node => ['confirmAnswer', 'cancelAnswer', 'answerOther', 'retryAnswer'].includes(node.dataset.action)), false);
  assert.equal(allNodes(f.root).filter(node => ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName) && !node.closest('.conversation-create-form')).every(node => node.disabled), true);
  assert.equal(f.posts.length, 0); f.page.destroy();
});

for (const retryAllowed of [false, null, undefined]) test(`mounted saved answer retryAllowed ${retryAllowed} cannot expose retry`, async testContext => {
  const f = await mountedQuestions(testContext, { saved: true, retryAllowed });
  assert.match(visibleText(f.root), /chat.question.answered/);
  assert.equal(allNodes(f.root).some(node => node.dataset.action === 'retryAnswer'), false);
  assert.equal(f.posts.length, 0); f.page.destroy();
});

test('mounted quiet question refresh failure retains known controls and reports an independent update warning', async testContext => {
  const f = await mountedQuestions(testContext);
  const beforeReads = f.questionReads();
  f.failQueries(); visibleNodes(f.root).find(node => node.dataset.action === 'refreshMessages').dispatch('click'); await tick(); await tick();
  assert.ok(f.questionReads() > beforeReads, 'new history triggers a real quiet question read');
  const card = f.root.querySelector('.chat-question');
  assert.match(visibleText(card), /chat.question.paused/);
  assert.equal(visibleText(card).includes('chat.question.stateUnavailable'), false);
  const confirm = visibleNodes(card).find(node => node.dataset.action === 'confirmAnswer');
  assert.ok(confirm); assert.equal(confirm.disabled, false);
  const warning = f.root.querySelector('.conversation-update-error');
  assert.equal(warning.hidden, false); assert.equal(visibleText(warning), 'chat.page.updateRetry');
  assert.equal(allNodes(card).includes(warning), false);
  assert.equal(f.posts.length, 0);
});

test('mounted failed question query retains paused status and disables retained controls until authority returns', async testContext => {
  const f = await mountedQuestions(testContext);
  assert.equal(visibleText(f.root).includes('chat.questions.unavailable'), false);
  f.failQueries(); visibleNodes(f.root).find(node => node.dataset.action === 'refreshStatus').dispatch('click'); await tick(); await tick();
  const card = f.root.querySelector('.chat-question');
  assert.match(visibleText(card), /chat.question.paused/); assert.match(visibleText(card), /chat.question.stateUnavailable/);
  assert.equal(visibleText(card).includes('chat.question.unavailable'), false);
  const confirm = visibleNodes(card).find(node => node.dataset.action === 'confirmAnswer');
  assert.ok(confirm); assert.equal(confirm.disabled, true);
  const separate = visibleNodes(f.root).find(node => node.classList.contains('chat-notice') && visibleText(node) === 'chat.questions.unavailable');
  assert.ok(separate); assert.equal(allNodes(card).includes(separate), false);
  assert.equal(f.posts.length, 0);
});

test('a saved question with invalid constraints displays unavailable without answer controls', () => {
  const f = fixture({ mutateQuestion(q) {
    q.constraints = null; q.questionError = 'chat_question_unavailable';
  } });
  assert.match(f.root.textContent, /chat.question.unavailable/);
  assert.equal(f.nodes().some(node => ['BUTTON', 'INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName)), false);
  assert.equal(f.requests.length, 0);
});


test('other-answer disclosure is created by the question renderer and keeps the answer action', async () => {
  const f = fixture({ otherAnswerDisclosure: true });
  const details = f.nodes().find(node => node.tagName === 'DETAILS');
  assert.ok(details);
  assert.equal(details.children[0].tagName, 'SUMMARY');
  assert.equal(details.children[0].textContent, 'chat.question.otherAnswer');
  const input = f.nodes().find(node => node.tagName === 'TEXTAREA');
  assert.ok(input);
  assert.equal(details.children[1].children[0], input);
  assert.equal(details.children[2], f.button('answerOther'));
  change(input, 'My own answer');
  f.button('answerOther').dispatch('click');
  await tick();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].action.payload.freeText, 'My own answer');
  const normal = fixture();
  assert.equal(normal.nodes().some(node => node.tagName === 'DETAILS'), false);
});
