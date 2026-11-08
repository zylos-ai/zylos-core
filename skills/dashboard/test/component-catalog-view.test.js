import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes } from './helpers/conversation-dom.js';
import { CONTENT_PREFIX, COMPONENT_DEFINITIONS, REGISTERED_COMPONENT_KEYS, makeQuestionSummary,
  parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

const browserSchema = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { renderChatContent } = await import('../public/js/wb/chat-blocks.js');
const { renderQuestion } = await import('../public/js/wb/chat-questions.js');

// Actual DOM renderer boundary, in-memory document only. Run when catalog
// implementation claims or renderer registration changes, skip unrelated IO.
test('every advertised component has a shipped renderer beyond fallback text', () => {
  const advertised = COMPONENT_DEFINITIONS.filter(item => REGISTERED_COMPONENT_KEYS.includes(item.key));
  assert.deepEqual(advertised.map(item => item.key), REGISTERED_COMPONENT_KEYS);
  for (const item of advertised) {
    const envelope = structuredClone(item.example);
    const block = envelope.blocks.find(block => block.type === item.type);
    assert.ok(block, item.key);
    block.fallbackText = 'catalog-render-fallback-sentinel';
    delete block.status;
    if (envelope.interrupt) envelope.questionSummary = makeQuestionSummary(envelope);
    assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(envelope)).kind, 'envelope', item.key);
    const document = createDocument();
    const root = renderChatContent({ document, row: { id: 1, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope) } });
    assert.equal(root.textContent.includes('catalog-render-fallback-sentinel'), false, item.key);
    assert.equal(allNodes(root).some(node => node.className?.includes('chat-block-error')), false, item.key);
    const expectedTag = ['time_series', 'breakdown', 'category_series'].includes(item.type) ? 'TABLE'
      : item.type === 'choice' ? 'UL' : item.type === 'form_intent' ? 'DL' : 'P';
    assert.ok(allNodes(root).some(node => node.tagName === expectedTag), item.key);
  }
});


test('advertised conditional form example has live active-field controls in the shipped renderer', () => {
  assert.ok(REGISTERED_COMPONENT_KEYS.includes('form_intent@2'));
  const item = COMPONENT_DEFINITIONS.find(item => item.key === 'form_intent@2');
  const envelope = structuredClone(item.example), document = createDocument();
  const question = { c4Id: 1, messageId: envelope.messageId, interruptId: envelope.interruptId,
    questionSummary: envelope.questionSummary, status: 'paused' };
  const formState = { values: { customer_type: 'person', company_name: 'Retained company' } };
  const root = renderChatContent({ document, row: { id: 1, direction: 'out', content: CONTENT_PREFIX + JSON.stringify(envelope) },
    renderQuestion: args => renderQuestion({ ...args, document, question, formState, canWrite: true, onSubmit: async () => {} }) });
  const company = root.querySelector('[data-field-key="company_name"]');
  assert.ok(company); assert.equal(company.hidden, true);
  const customer = root.querySelector('[data-field-key="customer_type"] select');
  customer.value = 'company'; customer.dispatch('change');
  assert.equal(company.hidden, false); assert.equal(company.querySelector('input').value, 'Retained company');
  assert.equal(root.querySelectorAll('[data-field-key="company_name"]').length, 1);
  assert.equal(root.querySelectorAll('.chat-form-fields').length, 0);
});
