import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, visibleNodes, visibleText, tick, deferred } from './helpers/conversation-dom.js';
import { CONTENT_PREFIX } from '../../comm-bridge/scripts/c4-content-schema.js';
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(sourceSchema, context);
  return next(specifier, context);
} });
// Boundary: real controller/page/renderer with injected fetch and storage only; no HTTP, DB, PM2 or tmux.
// Run for draft authority, field-error and retained-control changes. Official runner owns isolated paths.
// Every mounted page/controller is destroyed by t.after, including assertion failures.
const { mountConversationPage } = await import('../public/js/wb/conversation-page.js');
const { createConversationState } = await import('../public/js/wb/conversation-state.js');
const envelope = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url))).formQuestion;
const block = envelope.blocks[0], scope = { authRoot: 'fixture', instance: 'A' };
const fullScope = { ...scope, conversationId: 'g:AA', messageId: envelope.messageId, blockId: block.id, schemaVersion: 2 };
const question = () => ({ c4Id: '12', messageId: envelope.messageId, interruptId: envelope.interruptId, questionSummary: envelope.questionSummary, status: 'paused', constraints: { block, interrupt: envelope.interrupt } });
const values = () => ({ customer_type: 'company', company_name: 'Private', employee_count: 2 });
const action = () => ({ id: 'answer-test', protocolVersion: '0.1', type: block.data.action.type, target: block.data.action.target, context: { messageId: envelope.messageId, blockId: block.id }, payload: { values: { customer_type: 'person' } } });
function store() {
  let saved = values(), freeText = ''; const loads = [], removes = [];
  return { loads, removes, load(key) { loads.push(key); return saved && { ...saved }; }, loadEditable(key) { const v = this.load(key); return v ? { values: v, freeText } : null; }, save(key, v, options = {}) { saved = { ...v }; freeText = options.freeText ?? ''; return { saved: true }; }, remove(key) { removes.push(key); saved = null; freeText = ''; } };
}
async function controller(t, { result, failure, answerStatus } = {}) {
  const drafts = store(); let row = question();
  const state = createConversationState({ draftStore: drafts, draftScope: () => scope, setTimeout: () => 1, clearTimeout() {},
    request: async (p, options) => {
      if (p.endsWith('/answers')) { if (answerStatus) row = { ...row, status: answerStatus }; if (failure) throw failure; return result; }
      if (p.includes('/questions?')) return { items: [row], nextCursor: null };
      if (p.includes('/messages?')) return { items: [], nextCursor: null };
      if (p.includes('/status?')) return { items: [] };
      if (p === '/api/session-mode') return { data: { sessionMode: 'multi' } };
      if (p.endsWith('/g%3AAA')) return { conversation: { id: 'g:AA', state: 'active' } };
      return { items: [{ id: 'g:AA' }], nextCursor: null };
    } });
  t.after(() => state.destroy()); await state.open(); await state.select('g:AA');
  const form = { values: values(), freeText: 'Other pending answer', draftScope: fullScope }; state.snapshot().questionForms.set(`12:${envelope.interruptId}`, form);
  return { state, drafts, form, terminal() { row = { ...row, status: 'stopped' }; } };
}
for (const stored of [false, null, true]) test(`accepted form clears editable drafts with delivery stored=${stored}`, async t => {
  const f = await controller(t, { result: { answer: { answerId: action().id }, delivery: { stored } } });
  await f.state.answer(envelope.interruptId, action());
  assert.deepEqual(f.form.values, {}); assert.equal(f.form.draftCleared, true);
  assert.equal(f.drafts.removes.length, 1); assert.deepEqual(f.drafts.removes[0], fullScope);
  assert.equal(f.form.freeText, '');
  assert.equal(f.form.action.id, action().id); assert.equal(f.state.snapshot().questions[0].status, 'answered');
});
test('authoritative terminal question clears persistence and retains visible inputs without a rendered message', async t => {
  const f = await controller(t); f.terminal(); await f.state.refreshQuestions();
  assert.deepEqual(f.form.values, values()); assert.equal(f.drafts.removes.length, 1);
  assert.equal(f.form.freeText, 'Other pending answer');
});
test('terminal authority removes inactive values while retaining visible fields and other-answer input', async t => {
  const f = await controller(t);
  f.form.values.customer_type = 'person';
  f.terminal(); await f.state.refreshQuestions();
  assert.deepEqual(f.form.values, { customer_type: 'person' });
  assert.equal(f.form.freeText, 'Other pending answer');
  assert.equal(f.drafts.removes.length, 1);
});
for (const [code, status] of [['chat_question_not_paused', 'stopped'], ['chat_answer_conflict', 'answered']]) {
  test(`${code} keeps visible form input locked and deletes hidden values and persistence`, async t => {
    const f = await controller(t, { failure: { status: 409, code }, answerStatus: status });
    f.form.values.customer_type = 'person';
    await f.state.answer(envelope.interruptId, action());
    assert.deepEqual(f.form.values, { customer_type: 'person' });
    assert.equal(f.form.freeText, 'Other pending answer');
    assert.equal(f.form.locked, true); assert.equal(f.form.error, code);
    assert.equal(f.drafts.removes.length, 1);
  });
}
test('definite failure retains values and accepts only bounded originating submitted field errors', async t => {
  const failure = { status: 400, code: 'invalid_chat_answer', payload: { fields: [
    { key: 'company_name', reason: 'required' }, { key: 'other', reason: 'range' },
    { key: 'customer_type', reason: 'type', extra: 'discard' }, { key: 'customer_type', reason: 'invented' }
  ] } };
  const f = await controller(t, { failure }); await f.state.answer(envelope.interruptId, action());
  assert.deepEqual(f.form.values, values()); assert.equal(f.drafts.removes.length, 0);
  assert.deepEqual(f.form.fieldErrors, [{ key: 'customer_type', reason: 'type' }]); assert.equal(f.form.locked, false);
});
async function mounted(t, { terminal = false, gate = null, answerFailure = null, sharedDrafts = null } = {}) {
  const drafts = sharedDrafts || store(), document = createDocument(), root = document.createElement('div'); let ended = terminal;
  const page = mountConversationPage({ root, document, draftStore: drafts, draftScope: () => scope, fetch: async p => {
    let data;
    if (p.endsWith('/answers') && answerFailure) return { ok: false, status: 400, json: async () => answerFailure };
    if (p.includes('/questions?')) { if (gate) await gate.promise; data = { items: [{ ...question(), status: ended ? 'stopped' : 'paused' }], nextCursor: null }; }
    else if (p.includes('/messages?')) data = { items: [{ id: 12, direction: 'out', status: 'delivered', content: CONTENT_PREFIX + JSON.stringify(envelope) }], nextCursor: null };
    else if (p.includes('/status?')) data = { items: [] };
    else if (p.includes('/api/session-mode')) data = { data: { sessionMode: 'multi' } };
    else if (p.endsWith('/g%3AAA')) data = { conversation: { id: 'g:AA', state: 'active' } };
    else data = { items: [{ id: 'g:AA' }], nextCursor: null };
    return { ok: true, status: 200, json: async () => data };
  } });
  t.after(() => page.destroy()); await page.open();
  visibleNodes(root).find(n => n.dataset.conversationId === 'g:AA').dispatch('click');
  const opening = tick();
  await tick();
  return { root, document, page, drafts, opening, end() { ended = true; }, input(key) { return root.querySelector(`[data-field-key="${key}"]`)?.querySelector('input,select,textarea'); } };
}
test('mounted reload waits for authority before hydrating and terminal state defeats persisted values', async t => {
  const gate = deferred(), f = await mounted(t, { gate });
  assert.equal(f.drafts.loads.length, 0); gate.resolve(); await f.opening; await tick(); await tick();
  assert.ok(f.drafts.loads.length > 0); assert.equal(f.input('company_name')?.value, 'Private');
  const control = f.input('company_name'); control.focus(); control.selectionStart = 3;
  visibleNodes(f.root).find(n => n.dataset.action === 'refreshStatus').dispatch('click'); await tick(); await tick();
  assert.equal(f.input('company_name'), control); assert.equal(f.document.activeElement, control); assert.equal(control.selectionStart, 3);
  f.end(); visibleNodes(f.root).find(n => n.dataset.action === 'refreshStatus').dispatch('click'); await tick(); await tick();
  assert.equal(control.value, 'Private'); assert.equal(control.disabled, true); assert.ok(f.drafts.removes.length > 0);
});
test('mounted terminal authority clears retained hidden controls and keeps visible input locked', async t => {
  const f = await mounted(t); await f.opening; await tick(); await tick();
  const company = f.input('company_name'), count = f.input('employee_count'), selector = f.input('customer_type');
  selector.value = 'person'; selector.dispatch('change');
  const other = f.root.querySelector('.chat-question-other textarea');
  other.value = 'Visible alternative'; other.dispatch('input');
  assert.equal(company.closest('label').hidden, true); assert.equal(company.value, 'Private');
  f.end(); visibleNodes(f.root).find(n => n.dataset.action === 'refreshStatus').dispatch('click'); await tick(); await tick();
  assert.equal(company.value, ''); assert.equal(count.value, '');
  assert.equal(selector.value, 'person'); assert.equal(selector.disabled, true);
  assert.equal(other.value, 'Visible alternative'); assert.equal(other.disabled, true);
  assert.ok(f.drafts.removes.length > 0);
});
test('missing active fields can receive authoritative required diagnostics', async t => {
  const f = await controller(t, { failure: { status: 400, code: 'invalid_chat_answer', payload: { fields: [{ key: 'employee_count', reason: 'required' }] } } });
  const submitted = action(); submitted.payload.values = { customer_type: 'company', company_name: 'Acme' };
  await f.state.answer(envelope.interruptId, submitted);
  assert.deepEqual(f.form.fieldErrors, [{ key: 'employee_count', reason: 'required' }]);
});

test('terminal authority on reload removes saved input without hydrating editable fields', async t => {
  const f = await mounted(t, { terminal: true }); await f.opening; await tick(); await tick();
  assert.equal(f.drafts.loads.length, 0); assert.ok(f.drafts.removes.length > 0);
  assert.equal(f.input('company_name'), undefined);
});
test('mounted authoritative field errors update the retained focused form and preserve inputs', async t => {
  const f = await mounted(t, { answerFailure: { error: 'invalid_chat_answer', fields: [{ key: 'employee_count', reason: 'range' }] } });
  await f.opening; await tick(); await tick();
  const control = f.input('employee_count'); control.focus(); control.selectionStart = 1;
  visibleNodes(f.root).find(n => n.dataset.action === 'answer').dispatch('click'); await tick(); await tick();
  assert.equal(f.input('employee_count'), control); assert.equal(f.document.activeElement, control);
  assert.equal(control.getAttribute('aria-invalid'), 'true'); assert.equal(f.input('company_name').value, 'Private');
  assert.equal(f.drafts.removes.length, 0);
});
test('authentication cleanup erases retained hidden controls and prevents draft restoration', async t => {
  const f = await mounted(t); await f.opening; await tick(); await tick();
  const secret = f.input('company_name'), selector = f.input('customer_type');
  selector.value = 'person'; selector.dispatch('change'); assert.equal(secret.closest('label').hidden, true);
  f.page.clearDrafts(scope);
  assert.equal(secret.value, ''); assert.equal(secret.disabled, true);
  assert.equal(f.drafts.loads.length, 1); assert.ok(f.drafts.removes.length > 0);
});
test('authentication cleanup remains authoritative after pending invalid answer and paused reconciliation', async t => {
  const pending = deferred(), f = await controller(t, { result: pending.promise });
  const answering = f.state.answer(envelope.interruptId, action());
  f.state.clearDrafts(scope);
  pending.reject({ status: 400, code: 'invalid_chat_answer', payload: { fields: [{ key: 'customer_type', reason: 'type' }] } });
  await answering;
  assert.equal(f.form.locked, true); assert.equal(f.form.authCleared, true); assert.deepEqual(f.form.values, {});
  f.form.receipt = { needsReconciliation: true };
  await f.state.refreshQuestions();
  assert.equal(f.form.locked, true); assert.deepEqual(f.form.values, {}); assert.deepEqual(f.form.fieldErrors, []);
  const priorAction = f.form.action;
  await f.state.answer(envelope.interruptId, { ...action(), id: 'new-answer' });
  assert.equal(f.form.action, priorAction);
});
test('login restore gate retries cleanup when storage becomes available later in the page', async () => {
  const { createDraftStore, createDraftRestoreStore, consumeDraftReset, draftResetCookieName } = await import('../public/js/wb/chat-drafts.js');
  const entries = new Map(), storage = { get length() { return entries.size; }, key(i) { return [...entries.keys()][i]; },
    getItem(key) { return entries.get(key) ?? null; }, setItem(key, value) { entries.set(key, value); }, removeItem(key) { entries.delete(key); } };
  let available = true;
  const drafts = createDraftStore({ storage: () => { if (!available) throw Error('temporarily unavailable'); return storage; } });
  const ownScope = { ...fullScope, authRoot: 'https://fixture.test/dash', instance: 'https://fixture.test/dash' };
  drafts.save(ownScope, values()); available = false;
  const name = draftResetCookieName('/dash'); let cookie = name + '=1';
  const document = { get cookie() { return cookie; }, set cookie(value) { if (value.startsWith(name + '=;')) cookie = ''; } };
  const options = { document, location: { origin: 'https://fixture.test' }, base: '/dash', store: drafts };
  consumeDraftReset(options); assert.equal(cookie, name + '=1');
  const gated = createDraftRestoreStore(options);
  assert.equal(gated.load(ownScope), null); assert.equal(gated.loadEditable(ownScope), null); assert.equal(entries.size, 1);
  available = true;
  assert.equal(gated.loadEditable(ownScope), null); assert.equal(entries.size, 0); assert.equal(cookie, '');
  gated.save(ownScope, { customer_type: 'person' });
  assert.deepEqual(gated.load(ownScope), { customer_type: 'person' });
});
test('remote agent named local has a distinct draft identity from the local dashboard', async () => {
  const { draftInstance, createDraftAuth } = await import('../public/js/wb/chat-drafts.js');
  const root = 'https://fixture.test/dash';
  assert.equal(draftInstance(root, null), root); assert.equal(draftInstance(root, ''), root);
  assert.equal(draftInstance(root, 'local'), root + '/fleet/local');
  const cleared = [];
  const auth = createDraftAuth({ authRoot: root, store: { clearInstance(scope) { cleared.push(scope); } }, fetch: async () => ({ status: 401 }) });
  await auth.fetch(root + '/fleet/local/api/chat/conversations');
  assert.deepEqual(cleared, [{ authRoot: root, instance: root + '/fleet/local' }]);
});

test('optional other-answer text persists with fields through failed submission and page reload, then auth clears both', async t => {
  const sharedDrafts = store();
  const f = await mounted(t, { sharedDrafts, answerFailure: { error: 'invalid_chat_answer' } });
  await f.opening; await tick(); await tick();
  const other = f.root.querySelector('.chat-question-other textarea');
  other.value = 'Alternative request'; other.dispatch('input');
  assert.equal(sharedDrafts.loadEditable(fullScope).freeText, 'Alternative request');
  visibleNodes(f.root).find(n => n.dataset.action === 'answerOther').dispatch('click'); await tick(); await tick();
  assert.equal(other.value, 'Alternative request'); assert.equal(f.input('company_name').value, 'Private');
  f.page.destroy();
  const reloaded = await mounted(t, { sharedDrafts }); await reloaded.opening; await tick(); await tick();
  const restored = reloaded.root.querySelector('.chat-question-other textarea');
  assert.equal(restored.value, 'Alternative request'); assert.equal(reloaded.input('company_name').value, 'Private');
  reloaded.page.clearDrafts(scope); assert.equal(restored.value, ''); assert.equal(reloaded.input('company_name').value, '');
});
test('draft record includes optional other-answer text in byte limit and same-clock edits preserve strict eviction order', async () => {
  const { createDraftStore, MAX_DRAFT_BYTES } = await import('../public/js/wb/chat-drafts.js');
  const entries = new Map(), storage = { get length() { return entries.size; }, key(i) { return [...entries.keys()][i]; }, getItem(key) { return entries.get(key) ?? null; }, setItem(key, v) { entries.set(key, v); }, removeItem(key) { entries.delete(key); } };
  const drafts = createDraftStore({ storage, now: () => 100 });
  const own = i => ({ ...fullScope, messageId: String(i) });
  for (let i = 0; i < 64; i++) assert.equal(drafts.save(own(i), { name: i }, { freeText: 'other-' + i }).saved, true);
  drafts.save(own(0), { name: 'newest' }, { freeText: 'keep' });
  drafts.save(own(64), {}, { freeText: 'new' });
  assert.equal(drafts.load(own(1)), null); assert.deepEqual(drafts.loadEditable(own(0)), { values: { name: 'newest' }, freeText: 'keep' });
  assert.equal(drafts.save(own(0), {}, { freeText: '字'.repeat(MAX_DRAFT_BYTES) }).reason, 'oversize');
  assert.equal(drafts.loadEditable(own(0)).freeText, 'keep');
  assert.equal(drafts.save(own(0), {}, { freeText: {} }).reason, 'invalid');
});

test('asynchronous form authority hides static fields and failed submit announces generic error once', async t => {
  const gate = deferred(), f = await mounted(t, { gate, answerFailure: { error: 'invalid_chat_answer' } });
  const staticFields = f.root.querySelector('.chat-question-description>.chat-form-fields');
  assert.ok(staticFields); assert.equal(!!staticFields.hidden, false);
  gate.resolve(); await f.opening; await tick(); await tick();
  assert.equal(staticFields.hidden, true);
  visibleNodes(f.root).find(n => n.dataset.action === 'answer').dispatch('click'); await tick(); await tick();
  assert.equal((visibleText(f.root).match(/chat.question.submitFailed/g) || []).length, 1);
  assert.equal(f.input('company_name').value, 'Private');
});
