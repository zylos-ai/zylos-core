import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes, tick } from './helpers/conversation-dom.js';
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { renderQuestion } = await import('../public/js/wb/chat-questions.js');
const envelope = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url))).formQuestion;
function fixture(values = {}, onDraftChange = null) {
  const block = envelope.blocks[0], document = createDocument(), requests = [], formState = { values };
  const question = { c4Id: '12', messageId: envelope.messageId, interruptId: envelope.interruptId, questionSummary: envelope.questionSummary, status: 'paused' };
  const root = renderQuestion({ document, envelope, block, question, row: { id: 12, direction: 'out' }, canWrite: true,
    formState, onDraftChange, onSubmit: async action => { requests.push(action); } });
  const label = key => allNodes(root).find(node => node.dataset.fieldKey === key);
  const input = key => allNodes(label(key)).find(node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName));
  return { root, document, requests, formState, label, input,
    change(key, value) { const control = input(key); control.value = value; control.dispatch('change'); },
    submit() { allNodes(root).find(node => node.dataset.action === 'answer').dispatch('click'); } };
}
test('conditional fields retain node, focus and hidden values but submit only active keys', async () => {
  const f = fixture({ customer_type: 'company', company_name: 'Acme', employee_count: 3 });
  const name = f.input('company_name'); name.focus(); name.selectionStart = 2;
  f.change('customer_type', 'person');
  assert.equal(f.label('company_name').hidden, true);
  assert.equal(f.formState.values.company_name, 'Acme');
  f.change('customer_type', 'company');
  assert.equal(f.label('company_name').hidden, false);
  assert.equal(f.input('company_name'), name); assert.equal(f.document.activeElement, name); assert.equal(name.selectionStart, 2);
  f.change('customer_type', 'partner'); f.submit(); await tick();
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].payload.values, { customer_type: 'partner' });
});
test('shared field diagnostics prevent submission and clear when edited', async () => {
  const f = fixture({ customer_type: 'company', employee_count: 0 });
  f.submit(); await tick(); assert.equal(f.requests.length, 0);
  assert.deepEqual(f.formState.fieldErrors, [{ key: 'company_name', reason: 'required' }, { key: 'employee_count', reason: 'range' }]);
  assert.equal(f.input('employee_count').getAttribute('aria-invalid'), 'true');
  f.change('employee_count', '2'); f.change('company_name', '');
  f.submit(); await tick(); assert.equal(f.requests.length, 1); // Shared contract permits required empty text.
});
test('retained forms update server diagnostics and draft hint without replacing controls and clear hidden memory', () => {
  const f = fixture({ customer_type: 'person', company_name: 'private' }, () => 'unsaved');
  const control = f.input('customer_type'); f.change('customer_type', 'company');
  assert.equal(f.formState.draftStatus, 'unsaved'); assert.match(f.root.textContent, /draft.unsaved/);
  f.formState.fieldErrors = [{ key: 'company_name', reason: 'range' }]; f.formState.error = 'invalid_chat_answer';
  f.root.updateFormState(); assert.equal(f.input('customer_type'), control);
  assert.match(f.root.textContent, /field.range/); assert.match(f.root.textContent, /submitFailed/);
  f.root.clearEditableValues(); assert.deepEqual(f.formState.values, {}); assert.equal(f.input('company_name').value, '');
});
test('malformed stored field types remain available to shared validation without crashing controls', async () => {
  const invalid = { customer_type: 'company', company_name: { stale: true }, employee_count: 'invalid', tags: 3 };
  const f = fixture(invalid);
  assert.equal(f.input('company_name').value, ''); assert.equal(f.input('employee_count').value, '');
  assert.deepEqual(f.formState.values, invalid);
  f.submit(); await tick(); assert.equal(f.requests.length, 0);
  assert.ok(f.formState.fieldErrors.some(item => item.key === 'tags' && item.reason === 'type'));
});
