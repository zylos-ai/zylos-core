import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatState } from '../public/js/wb/chat-state.js';

// Pure state/API-boundary tests: requests are injected promises, never HTTP,
// SQLite, runtime processes or the live instance. The normal runner isolates HOME.
const pending = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const question = (overrides = {}) => ({ c4_id: 11, message_id: 'question-message',
  interrupt_id: 'question-one', question_summary: 'Choose a route', status: 'paused', ...overrides });
const action = (overrides = {}) => ({ id: 'answer-intent-1', protocolVersion: '0.1',
  type: 'choice.select', target: 'route.choose', context: { messageId: 'question-message', blockId: 'choice' },
  payload: { selected: ['first'] }, ...overrides });
const answerResult = (intent, delivery = {}) => ({ answer: { answerId: intent.id },
  delivery: { stored: true, accepted: true, deliveryState: 'pending', retryAllowed: false, ...delivery } });
const posts = calls => calls.filter(call => call.options?.method === 'POST');
function fixture({ handle = () => undefined, mode = 'multi', identity } = {}) {
  const calls = [];
  const state = createChatState({ identity, request: async (path, options) => {
    calls.push({ path, options });
    const handled = handle(path, options);
    if (handled !== undefined) return handled;
    if (path === '/api/session-mode') return { data: { sessionMode: mode } };
    if (path.includes('/messages?')) return { items: [{ id: 11, direction: 'out', content: 'Question' }], afterCursor: 'after', nextCursor: null };
    if (path.includes('/questions?')) return { items: [question()], nextCursor: null };
    if (path.endsWith('/answers')) return answerResult(options.body.action);
    if (path.includes('/status?')) return { items: [] };
    if (path.includes('?')) return { items: [{ id: 'g:A' }, { id: 'g:B' }], nextCursor: null };
    const id = decodeURIComponent(path.split('/').at(-1));
    return { conversation: { id, state: 'active' }, conversationId: id, stored: false };
  } });
  const form = (row = state.snapshot().questions[0], values = {}) => {
    const forms = state.snapshot().questionForms, key = `${row.c4_id}:${row.interrupt_id}`;
    if (!forms.has(key)) forms.set(key, { values: { note: 'keep this input' }, action: null,
      sending: false, locked: false, receipt: null, error: null, ...values });
    return forms.get(key);
  };
  const open = async () => { await state.open(); await state.select('g:A'); };
  return { state, calls, form, open };
}

test('question pages use bounded cursors and manual refresh replaces the page', async () => {
  let round = 0;
  const f = fixture({ handle: path => {
    if (!path.includes('/questions?')) return undefined;
    const url = new URL(path, 'http://fixture.invalid');
    assert.equal(url.searchParams.get('limit'), '50');
    if (url.searchParams.has('cursor')) {
      assert.equal(url.searchParams.get('cursor'), 'next question');
      return { items: [question({ status: 'answered', answer_id: 'accepted-one' }),
        question({ c4_id: 12, interrupt_id: 'question-two' })], nextCursor: null };
    }
    return ++round === 1 ? { items: [question()], nextCursor: 'next question' }
      : { items: [question({ c4_id: 13, interrupt_id: 'replacement' })], nextCursor: null };
  } });
  await f.open();
  assert.equal(f.state.snapshot().questionsReady, true);
  assert.equal(f.state.snapshot().questions.length, 1);
  await f.state.loadMoreQuestions();
  assert.equal(f.state.snapshot().questions.length, 2);
  assert.equal(f.state.snapshot().questions[0].status, 'answered');
  const count = f.calls.length;
  await f.state.loadMoreQuestions();
  assert.equal(f.calls.length, count);
  await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().questions.length, 1);
  assert.equal(f.state.snapshot().questions[0].interrupt_id, 'replacement');
  assert.equal(f.calls.at(-1).path.includes('cursor='), false);
  assert.equal(posts(f.calls).length, 0);
  f.state.destroy();
});

test('a delayed question page from another conversation cannot replace the selected questions', async () => {
  const wait = pending();
  const f = fixture({ handle: path => path.includes('g%3AA/questions?') ? wait.promise
    : path.includes('g%3AB/questions?') ? { items: [question({ c4_id: 22, interrupt_id: 'question-B' })], nextCursor: null } : undefined });
  await f.state.open();
  const first = f.state.select('g:A');
  await f.state.select('g:B');
  wait.resolve({ items: [question()], nextCursor: null });
  await first;
  assert.equal(f.state.snapshot().selectedId, 'g:B');
  assert.equal(f.state.snapshot().questions.length, 1);
  assert.equal(f.state.snapshot().questions[0].interrupt_id, 'question-B');
  assert.equal(f.state.snapshot().error, null);
  f.state.destroy();
});

test('remote-disabled question reads clear the entire page and invalidate older data', async () => {
  const wait = pending();
  const f = fixture({ handle: path => path.includes('g%3AA/messages?') ? wait.promise
    : path.includes('g%3AB/questions?') ? Promise.reject({ code: 'remote_chat_disabled', status: 403 }) : undefined });
  await f.state.open();
  const first = f.state.select('g:A');
  await f.state.select('g:B');
  assert.equal(f.state.snapshot().blocked, true);
  assert.equal(f.state.snapshot().selectedId, null);
  assert.equal(f.state.snapshot().items.length, 0);
  assert.equal(f.state.snapshot().questions.length, 0);
  assert.equal(f.state.snapshot().questionForms.size, 0);
  wait.resolve({ items: [{ id: 99, content: 'private stale message' }] });
  await first;
  assert.equal(f.state.snapshot().messages.length, 0);
  assert.equal(f.state.snapshot().questions.length, 0);
  assert.equal(posts(f.calls).length, 0);
  f.state.destroy();
});

for (const readonly of ['single', 'external']) test(`${readonly} history cannot submit question answers`, async () => {
  const f = fixture({ mode: readonly === 'single' ? 'single' : 'multi' });
  await f.state.open();
  if (readonly === 'external') await f.state.setTab('external');
  await f.state.select('g:A');
  if (readonly === 'single') f.form();
  await f.state.answer('question-one', action());
  assert.equal(f.state.snapshot().canWrite, false);
  assert.equal(posts(f.calls).length, 0);
  if (readonly === 'external') assert.equal(f.calls.filter(call => call.path.includes('/questions?')).length, 0);
  f.state.destroy();
});

test('drafts and unregistered questions never gain answer authority', async () => {
  const f = fixture({ handle: path => path.includes('/questions?') ? { items: [], nextCursor: null } : undefined });
  await f.state.open(); await f.state.select('d:new');
  assert.equal(f.calls.filter(call => call.path.includes('/questions?')).length, 0);
  await f.state.answer('question-one', action());
  await f.state.select('g:A');
  await f.state.answer('question-one', action());
  assert.equal(posts(f.calls).length, 0);
  assert.equal(f.state.snapshot().questions.length, 0);
  f.state.destroy();
});

test('manual refresh overlays lifecycle and delivery without resending or modifying source messages', async () => {
  let refreshed = false;
  const f = fixture({ handle: path => path.includes('/questions?') ? { items: [question(refreshed
    ? { status: 'answered', answer_id: 'saved-answer', delivery: { stored: true, deliveryState: 'failed', retryAllowed: false } }
    : {})], nextCursor: null } : undefined });
  await f.open();
  const original = f.state.snapshot().messages[0];
  const form = f.form(); form.action = action();
  refreshed = true;
  await f.state.refreshQuestions();
  const row = f.state.snapshot().questions[0];
  assert.equal(row.status, 'answered');
  assert.equal(row.delivery.deliveryState, 'failed');
  assert.equal(form.action, null);
  assert.equal(form.receipt.stored, true);
  assert.equal(f.state.snapshot().messages[0], original);
  assert.equal(original.content, 'Question');
  assert.equal(posts(f.calls).length, 0);
  f.state.destroy();
});

test('ordinary message updates leave a paused question pending', async () => {
  let newer = false;
  const f = fixture({ handle: path => path.includes('/messages?') ? { items: newer
    ? [{ id: 12, direction: 'out', content: 'Additional explanation' }]
    : [{ id: 11, direction: 'out', content: 'Question' }], afterCursor: 'after', nextCursor: null } : undefined });
  await f.open(); newer = true;
  await f.state.refreshMessages();
  assert.equal(f.state.snapshot().messages.length, 2);
  assert.equal(f.state.snapshot().questions[0].status, 'paused');
  assert.equal(posts(f.calls).length, 0);
  f.state.destroy();
});

test('concurrent submits issue one request and keep the original conversation route', async () => {
  const wait = pending();
  const f = fixture({ handle: (path, options) => path.endsWith('/answers') ? wait.promise : undefined });
  await f.open(); const form = f.form(), intent = action();
  const first = f.state.answer('question-one', intent);
  const second = f.state.answer('question-one', intent);
  assert.equal(form.sending, true);
  assert.equal(posts(f.calls).length, 1);
  await f.state.select('g:B');
  wait.resolve(answerResult(intent)); await Promise.all([first, second]);
  const request = posts(f.calls)[0];
  assert.match(request.path, /g%3AA\/answers$/);
  assert.deepEqual(Object.keys(request.options.body).sort(), ['action', 'interruptId']);
  assert.equal(request.options.body.interruptId, 'question-one');
  assert.equal(f.state.snapshot().selectedId, 'g:B');
  assert.equal(f.state.snapshot().questions[0].status, 'paused');
  assert.equal(form.sending, false);
  f.state.destroy();
});

test('an accepted answer prevents a second answer even when ordinary sending remains allowed', async () => {
  const f = fixture(); await f.open(); const form = f.form();
  await f.state.answer('question-one', action());
  assert.equal(f.state.snapshot().questions[0].status, 'answered');
  assert.equal(form.locked, true);
  await f.state.answer('question-one', action({ id: 'different-answer', payload: { selected: ['second'] } }));
  await f.state.answer('question-one', action());
  assert.equal(posts(f.calls).length, 1);
  assert.equal(f.state.snapshot().canWrite, true);
  f.state.destroy();
});

test('explicit retry uses the original action only after authority permits it', async () => {
  let permit = true;
  const f = fixture({ handle: (path, options) => path.endsWith('/answers')
    ? answerResult(options.body.action, { stored: false, deliveryState: null, retryAllowed: permit }) : undefined });
  await f.open(); const form = f.form(), intent = action();
  await f.state.answer('question-one', intent);
  await f.state.answer('question-one', intent);
  await f.state.answer('question-one', action({ payload: { selected: ['second'] } }), { retry: true });
  await f.state.answer('question-one', action({ id: 'different-answer' }), { retry: true });
  assert.equal(posts(f.calls).length, 1);
  await f.state.answer('question-one', intent, { retry: true });
  assert.equal(posts(f.calls).length, 2);
  assert.equal(posts(f.calls)[1].options.body.retry, true);
  assert.deepEqual(posts(f.calls)[1].options.body.action, posts(f.calls)[0].options.body.action);
  permit = false; form.receipt.retryAllowed = false;
  await f.state.answer('question-one', intent, { retry: true });
  assert.equal(posts(f.calls).length, 2);
  f.state.destroy();
});

for (const lifecycle of ['stopped', 'superseded']) test(`${lifecycle} questions cannot submit or retry`, async () => {
  const f = fixture({ handle: path => path.includes('/questions?') ? { items: [question({ status: lifecycle,
    answer_id: 'answer-intent-1', delivery: { stored: false, retryAllowed: true } })], nextCursor: null } : undefined });
  await f.open(); f.form(undefined, { action: action(), receipt: { stored: false, retryAllowed: true } });
  await f.state.answer('question-one', action());
  await f.state.answer('question-one', action(), { retry: true });
  assert.equal(posts(f.calls).length, 0);
  f.state.destroy();
});

test('definite validation failure keeps valid inputs and permits editing without claiming acceptance', async () => {
  let reject = true;
  const f = fixture({ handle: (path, options) => path.endsWith('/answers')
    ? reject ? Promise.reject({ status: 400, code: 'invalid_chat_answer' }) : answerResult(options.body.action) : undefined });
  await f.open(); const form = f.form();
  await f.state.answer('question-one', action());
  assert.equal(form.values.note, 'keep this input');
  assert.equal(form.error, 'invalid_chat_answer');
  assert.equal(form.locked, false);
  assert.equal(form.action, null);
  assert.equal(f.state.snapshot().questions[0].status, 'paused');
  assert.equal(f.state.snapshot().questionsReady, true);
  reject = false;
  await f.state.answer('question-one', action({ id: 'corrected-answer' }));
  assert.equal(posts(f.calls).length, 2);
  assert.equal(f.state.snapshot().questions[0].status, 'answered');
  f.state.destroy();
});

test('unknown answer outcome requires manual reconciliation and never automatically retries', async () => {
  let reconciled = false;
  const f = fixture({ handle: (path, options) => path.endsWith('/answers')
    ? Promise.reject(new Error('network lost'))
    : path.includes('/questions?') ? { items: [question(reconciled ? { status: 'answered', answer_id: 'answer-intent-1',
      delivery: { stored: null, needsReconciliation: true, retryAllowed: false } } : {})], nextCursor: null } : undefined });
  await f.open(); const form = f.form(), intent = action();
  await f.state.answer('question-one', intent);
  assert.equal(form.values.note, 'keep this input');
  assert.equal(form.receipt.stored, null);
  assert.equal(form.receipt.retryAllowed, false);
  assert.equal(form.locked, true);
  assert.equal(f.state.snapshot().questionsReady, false);
  await f.state.answer('question-one', intent);
  await f.state.answer('question-one', intent, { retry: true });
  assert.equal(posts(f.calls).length, 1);
  reconciled = true; await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().questionsReady, true);
  assert.equal(f.state.snapshot().questions[0].status, 'answered');
  assert.equal(form.action.id, intent.id);
  assert.equal(posts(f.calls).length, 1);
  f.state.destroy();
});

test('question errors stay with their conversation and preserve its form', async () => {
  let fail = false;
  const f = fixture({ handle: path => path.includes('g%3AA/questions?') && fail
    ? Promise.reject({ code: 'chat_core_unavailable', status: 502 }) : undefined });
  await f.open(); const form = f.form();
  fail = true; await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().error, 'chat_core_unavailable');
  assert.equal(form.values.note, 'keep this input');
  await f.state.select('g:B');
  assert.equal(f.state.snapshot().error, null);
  assert.equal(f.state.snapshot().questionForms.size, 0);
  assert.equal(f.state.snapshot().questionsReady, true);
  f.state.destroy();
});

test('closing and reopening never posts an answer or stops a paused question', async () => {
  const f = fixture(); await f.open(); f.form();
  f.state.close(); await f.state.open();
  assert.equal(f.state.snapshot().questions[0].status, 'paused');
  assert.equal(posts(f.calls).length, 0);
  assert.equal(f.calls.some(call => /controls|stop/.test(call.path)), false);
  f.state.destroy();
});

test('a question refresh during submission cannot hide the accepted answer response', async () => {
  const wait = pending(), intent = action();
  const f = fixture({ handle: path => path.endsWith('/answers') ? wait.promise : undefined });
  await f.open(); const form = f.form();
  const sending = f.state.answer('question-one', intent);
  await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().questions[0].status, 'paused');
  wait.resolve(answerResult(intent)); await sending;
  assert.equal(form.receipt.stored, true);
  assert.equal(f.state.snapshot().questions[0].status, 'answered');
  assert.equal(f.state.snapshot().questions[0].answer_id, intent.id);
  await f.state.answer('question-one', intent);
  assert.equal(posts(f.calls).length, 1);
  f.state.destroy();
});

test('a stale failed question refresh cannot overwrite a newer successful refresh', async () => {
  let held = false;
  const wait = pending();
  const f = fixture({ handle: path => {
    if (!path.includes('/questions?') || !held) return undefined;
    held = false;
    return wait.promise;
  } });
  await f.open(); held = true;
  const oldRefresh = f.state.refreshQuestions();
  await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().questionsReady, true);
  wait.reject({ code: 'chat_core_unavailable', status: 502 });
  await oldRefresh;
  assert.equal(f.state.snapshot().questionsReady, true);
  assert.equal(f.state.snapshot().error, null);
  assert.equal(f.state.snapshot().questionsLoading, false);
  f.state.destroy();
});

test('a successful question retry clears only the question query error', async () => {
  let failQuestions = false;
  const f = fixture({ handle: path => path.includes('/questions?') && failQuestions
    ? Promise.reject({ code: 'chat_core_unavailable', status: 502 }) : undefined });
  await f.open(); failQuestions = true; await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().error, 'chat_core_unavailable');
  failQuestions = false; await f.state.refreshQuestions();
  assert.equal(f.state.snapshot().error, null);
  assert.equal(f.state.snapshot().questionsReady, true);
  f.state.destroy();
});

test('a pending question read cannot restore paused after the answer was accepted', async () => {
  const answerWait = pending(), questionWait = pending(), intent = action();
  let delayQuestions = false;
  const f = fixture({ handle: path => path.endsWith('/answers') ? answerWait.promise
    : path.includes('/questions?') && delayQuestions ? questionWait.promise : undefined });
  await f.open(); const form = f.form();
  const sending = f.state.answer('question-one', intent);
  delayQuestions = true;
  const refreshing = f.state.refreshQuestions();
  answerWait.resolve(answerResult(intent)); await sending;
  questionWait.resolve({ items: [question()], nextCursor: null }); await refreshing;
  assert.equal(form.receipt.stored, true);
  assert.equal(f.state.snapshot().questions[0].status, 'answered');
  assert.equal(f.state.snapshot().questions[0].answer_id, intent.id);
  assert.equal(f.state.snapshot().questionsLoading, false);
  assert.equal(posts(f.calls).length, 1);
  f.state.destroy();
});
