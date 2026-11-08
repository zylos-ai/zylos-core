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
test('retained forms update diagnostics and clear removed values without erasing visible inputs', () => {
  const f = fixture({ customer_type: 'person', company_name: 'private' }, () => 'unsaved');
  const control = f.input('customer_type'); f.change('customer_type', 'company');
  assert.equal(f.formState.draftStatus, 'unsaved'); assert.match(f.root.textContent, /draft.unsaved/);
  f.formState.fieldErrors = [{ key: 'company_name', reason: 'range' }]; f.formState.error = 'invalid_chat_answer';
  f.root.updateFormState(); assert.equal(f.input('customer_type'), control);
  assert.match(f.root.textContent, /field.range/); assert.match(f.root.textContent, /submitFailed/);
  f.change('customer_type', 'person');
  const other = f.root.querySelector('.chat-question-other textarea');
  other.value = 'Visible free text'; other.dispatch('input');
  f.formState.values = { customer_type: 'person' };
  f.root.clearRemovedValues();
  assert.equal(f.input('customer_type'), control); assert.equal(control.value, 'person');
  assert.equal(f.label('company_name').hidden, true); assert.equal(f.input('company_name').value, '');
  assert.equal(other.value, 'Visible free text');
  assert.deepEqual(f.formState.values, { customer_type: 'person' });
  assert.equal(f.formState.freeText, 'Visible free text');
  Object.assign(f.formState, { values: {}, freeText: '', fieldErrors: [], formError: null, draftStatus: null });
  f.root.clearRemovedValues();
  assert.deepEqual(f.formState.values, {}); assert.equal(control.value, '');
  assert.equal(f.input('company_name').value, ''); assert.equal(other.value, '');
  assert.equal(f.root.querySelector('.chat-form-draft-status').hidden, true);
});
test('malformed stored field types remain available to shared validation without crashing controls', async () => {
  const invalid = { customer_type: 'company', company_name: { stale: true }, employee_count: 'invalid', tags: 3 };
  const f = fixture(invalid);
  assert.equal(f.input('company_name').value, ''); assert.equal(f.input('employee_count').value, '');
  assert.deepEqual(f.formState.values, invalid);
  f.submit(); await tick(); assert.equal(f.requests.length, 0);
  assert.ok(f.formState.fieldErrors.some(item => item.key === 'tags' && item.reason === 'type'));
});
test('multiline fields render with browser readonly textarea type and submit typed text', async () => {
  const document = createDocument(), original = document.createElement;
  document.createElement = tag => {
    const node = original(tag);
    if (tag === 'textarea') Object.defineProperty(node, 'type', { get: () => 'textarea' });
    return node;
  };
  const message = structuredClone(envelope), block = message.blocks[0];
  block.data.fields.push({ key: 'notes', type: 'multiline_text', label: 'Notes', required: true, maxLength: 100 });
  const formState = { values: { customer_type: 'person' } }, requests = [];
  const root = renderQuestion({ document, envelope: message, block, row: { id: 12, direction: 'out' }, canWrite: true, formState,
    question: { c4Id: '12', messageId: message.messageId, interruptId: message.interruptId, questionSummary: message.questionSummary, status: 'paused' },
    onSubmit: async action => { requests.push(action); } });
  const textarea = root.querySelector('[data-field-key="notes"] textarea');
  assert.equal(textarea.type, 'textarea'); textarea.value = 'line one\nline two'; textarea.dispatch('input');
  allNodes(root).find(node => node.dataset.action === 'answer').dispatch('click'); await tick();
  assert.equal(requests.length, 1); assert.equal(requests[0].payload.values.notes, 'line one\nline two');
});
test('shared local field validation blocks requests and preserves actionable form-level correction message', async () => {
  const f = fixture({ customer_type: 'company', employee_count: 0 });
  f.submit(); await tick();
  assert.equal(f.requests.length, 0);
  assert.deepEqual(f.formState.fieldErrors, [{ key: 'company_name', reason: 'required' }, { key: 'employee_count', reason: 'range' }]);
  assert.equal(f.root.querySelector('.chat-form-error').textContent, 'chat.question.correctFields');
  const error = f.label('employee_count').querySelector('.chat-field-error');
  assert.equal(error.hidden, false); assert.equal(error.textContent, 'chat.question.field.range');
});
test('bounded required single-select uses segment buttons and preserves existing conditional filtering', async () => {
  const f = fixture({ customer_type: 'person', company_name: 'retained', employee_count: 2 });
  const group = f.label('customer_type').querySelector('.chat-form-segments');
  assert.equal(group.children.length, 3); assert.equal(f.input('customer_type').hidden, true);
  const company = group.children.find(node => node.value === 'company'); company.dispatch('click');
  assert.equal(company.getAttribute('aria-pressed'), 'true'); assert.equal(f.label('company_name').hidden, false);
  group.children.find(node => node.value === 'person').dispatch('click');
  assert.equal(company.getAttribute('aria-pressed'), 'false'); assert.equal(f.label('company_name').hidden, true);
  f.submit(); await tick(); assert.deepEqual(f.requests[0].payload.values, { customer_type: 'person' });
});
test('single-select uses segments only for required fields with two through four options', async t => {
  for (const required of [false, true]) {
    for (const count of [1, 2, 3, 4, 5]) {
      await t.test(`${required ? 'required' : 'optional'} field with ${count} options`, async () => {
        const message = structuredClone(envelope), block = message.blocks[0];
        const options = Array.from({ length: count }, (_, index) => ({ id: `option_${index}`, label: `Option ${index}` }));
        block.data.fields = [{ key: 'selection', label: 'Selection', type: 'single_select', required, options }];
        const document = createDocument(), formState = { values: { selection: options[0].id } }, requests = [];
        const root = renderQuestion({ document, envelope: message, block, row: { id: 12, direction: 'out' }, canWrite: true, formState,
          question: { c4Id: '12', messageId: message.messageId, interruptId: message.interruptId, questionSummary: message.questionSummary, status: 'paused' },
          onSubmit: async action => { requests.push(action); } });
        const field = root.querySelector('[data-field-key="selection"]');
        assert.ok(field, 'the shared schema accepts the field and renders its controls');
        const select = field.querySelector('select'), segments = field.querySelector('.chat-form-segments');
        const segmented = required && count >= 2 && count <= 4;
        assert.equal(Boolean(segments), segmented);
        assert.equal(Boolean(select.hidden), segmented);
        assert.equal(select.value, options[0].id);
        if (segmented) {
          assert.equal(segments.children.length, count);
          segments.children.at(-1).dispatch('click');
          assert.equal(formState.values.selection, options.at(-1).id);
          assert.equal(segments.children.at(-1).getAttribute('aria-pressed'), 'true');
          allNodes(root).find(node => node.dataset.action === 'answer').dispatch('click'); await tick();
          assert.equal(requests.length, 1); assert.equal(requests[0].payload.values.selection, options.at(-1).id);
        } else {
          assert.equal(select.children[0].value, '', 'native selects retain the empty choice');
          select.value = ''; select.dispatch('change');
          assert.equal(Object.hasOwn(formState.values, 'selection'), false);
          allNodes(root).find(node => node.dataset.action === 'answer').dispatch('click'); await tick();
          assert.equal(requests.length, required ? 0 : 1);
          if (required) assert.deepEqual(formState.fieldErrors, [{ key: 'selection', reason: 'required' }]);
          else assert.deepEqual(requests[0].payload.values, {});
        }
      });
    }
  }
});
