import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
import { CONTENT_PREFIX, makeQuestionSummary, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';

// Resolve the browser alias to the same shared source; never evaluate source text.
const browserSchema = new URL('../public/chat-schema.js?v=91', import.meta.url).href;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).href === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { renderChatContent } = await import('../public/js/wb/chat-blocks.js');
const t = key => key;
const action = type => ({ type, target: 'test.answer' });
function block(type, data, extra = {}) { return { id: 'block-one', type, schemaVersion: 1, fallbackText: 'Readable fallback', data, ...extra }; }
function envelope(blocks, question = false) {
  const value = { version: 1, kind: 'message', messageId: 'message-one', fallbackText: 'Envelope fallback', blocks };
  if (question) {
    value.interruptId = 'interrupt-one'; value.interrupt = { blockId: blocks[0].id, reason: blocks[0].type === 'confirmation' ? 'confirmation' : 'input_required' };
    value.questionSummary = makeQuestionSummary(value);
  }
  return value;
}
function render(value, options = {}) {
  const document = options.document ?? createDocument();
  return renderChatContent({ document, row: { id: 42, content: typeof value === 'string' ? value : CONTENT_PREFIX + JSON.stringify(value) }, t, ...options });
}
const choices = selection => block('choice', { prompt: 'Choose a plan', selection, options: [{ id: 'a', label: 'Plan A', description: 'Fast' }, { id: 'b', label: 'Plan B' }], action: action('choice.select') });
const confirmation = () => block('confirmation', { title: 'Confirm change', body: 'Check these facts', severity: 'normal', details: [{ label: 'Count', value: 3 }], action: action('confirmation.respond') });
const form = () => block('form_intent', { title: 'Profile', purpose: 'Tell us more', fields: [{ key: 'name', type: 'text', label: 'Name', help: 'Public name' }, { key: 'category', type: 'single_select', label: 'Category', options: [{ id: 'a', label: 'First' }] }], action: action('form.submit') });

test('immutable resolved interactive blocks display their saved answer without controls', () => {
  for (const [item, saved, expected] of [
    [choices('single'), { selected: ['b'] }, 'Plan B'],
    [confirmation(), { outcome: 'cancel' }, 'chat.question.cancel'],
    [form(), { values: { name: '<script>literal</script>', category: 'a' } }, '<script>literal</script>'],
  ]) {
    item.data.state = { status: 'resolved', ...saved, resolvedAt: '2026-11-07T00:00:00Z' };
    const source = envelope([item]);
    assert.equal(parseC4Content(CONTENT_PREFIX + JSON.stringify(source)).kind, 'envelope');
    const root = render(source);
    assert.match(root.textContent, /chat.block.state.resolved/);
    assert.ok(root.textContent.includes(expected));
    assert.equal(allNodes(root).some(node => ['BUTTON', 'INPUT', 'SCRIPT'].includes(node.tagName)), false);
  }
});

test('ordinary text and JSON remain literal text without actions or HTML', () => {
  for (const content of ['<script>alert(1)</script><img src=x onerror=evil()>', '{"kind":"message","blocks":[]}']) {
    let calls = 0;
    const root = render(content, { renderQuestion() { calls++; } });
    assert.equal(root.textContent, content);
    assert.equal(allNodes(root).filter(node => ['SCRIPT', 'IMG', 'BUTTON', 'INPUT'].includes(node.tagName)).length, 0);
    assert.equal(calls, 0);
  }
});

test('text block renders literal markdown and HTML rather than evaluating markup', () => {
  const root = render(envelope([block('markdown', { text: '**Hello** <svg onload=evil()> [link](javascript:evil())' })]));
  assert.match(root.textContent, /\*\*Hello\*\* <svg onload=evil\(\)>/);
  assert.equal(allNodes(root).some(node => ['A', 'SVG', 'SCRIPT'].includes(node.tagName)), false);
});

for (const selection of ['single', 'multiple']) test(`${selection} choice presents saved options and delegates only the referenced question`, () => {
  let calls = 0;
  const root = render(envelope([choices(selection)], true), { renderQuestion({ envelope: source, block: sourceBlock, row }) {
    calls++; assert.equal(source.interruptId, 'interrupt-one'); assert.equal(sourceBlock.data.selection, selection); assert.equal(row.id, 42);
    return createDocument().createElement('fieldset');
  } });
  assert.match(root.textContent, /Choose a planPlan AFastPlan B/);
  assert.equal(calls, 1);
  assert.equal(allNodes(root).filter(node => node.tagName === 'FIELDSET').length, 1);
  assert.equal(allNodes(root).filter(node => node.tagName === 'INPUT' || node.tagName === 'BUTTON').length, 0);
});

test('confirmation and form descriptions preserve source titles facts and labels without controls', () => {
  const confirmRoot = render(envelope([confirmation()], true));
  assert.match(confirmRoot.textContent, /Confirm changeCheck these factsCount3/);
  const formRoot = render(envelope([form()], true));
  assert.match(formRoot.textContent, /ProfileTell us moreNamePublic nameCategoryFirst/);
  for (const root of [confirmRoot, formRoot]) assert.equal(allNodes(root).some(node => ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT'].includes(node.tagName)), false);
});

test('time series displays multiple labelled series null gaps units and bounded graphical values', () => {
  const root = render(envelope([block('time_series', { title: 'Traffic', xType: 'date', xLabel: 'Day', yLabel: 'Requests', yUnit: 'req', summary: 'Upward trend', series: [
    { key: 'web', label: 'Web', points: [{ x: '2026-01-01', y: 10 }, { x: '2026-01-02', y: null }] },
    { key: 'api', label: 'API', unit: 'calls', points: [{ x: '2026-01-01', y: 20 }] },
  ] })]));
  assert.match(root.textContent, /TrafficDay · RequestsWeb2026-01-0110 req2026-01-02chat.block.noValueAPI2026-01-0120 callsUpward trend/);
  assert.equal(allNodes(root).filter(node => node.className === 'chat-chart-series').length, 2);
  assert.equal(allNodes(root).filter(node => node.className === 'chat-chart-bar').length, 2);
});

test('breakdown and category charts retain values baseline and assessment descriptions', () => {
  const root = render(envelope([
    block('breakdown', { title: 'Budget', unit: 'USD', parts: [{ key: 'a', label: 'Product', value: 30 }, { key: 'b', label: 'Operations', value: 70 }], asOf: '2026-01-01' }),
    block('category_series', { title: 'Change', points: [{ key: 'a', label: 'A', value: -5, assessment: { status: 'warning', label: 'Review', detail: 'Below target' } }, { key: 'b', label: 'B', value: 0 }], reference: { label: 'Target', value: 1 } }, { id: 'block-two' }),
  ]));
  assert.match(root.textContent, /BudgetProduct30 USDOperations70 USD2026-01-01ChangeA-5Review · Below targetB0Target: 1/);
  assert.equal(allNodes(root).filter(node => node.className.includes('chat-chart-bar negative')).length, 1);
  for (const bar of allNodes(root).filter(node => node.className.includes('chat-chart-bar'))) {
    const width = Number.parseFloat(bar.style.width); assert.ok(width >= 0 && width <= 100);
  }
});

test('all-zero charts retain zero values without invalid widths', () => {
  const root = render(envelope([block('breakdown', { parts: [{ key: 'a', label: 'A', value: 0 }, { key: 'b', label: 'B', value: 0 }] })]));
  const bars = allNodes(root).filter(node => node.className === 'chat-chart-bar');
  assert.equal(bars.length, 2); assert.ok(bars.every(bar => bar.style.width === '0%'));
});

test('pending and failed blocks show fallback without delegating actions', () => {
  for (const status of ['pending', 'error']) {
    const root = render(envelope([{ id: 'block-one', type: 'choice', schemaVersion: 1, status, fallbackText: 'Waiting for content' }]));
    assert.match(root.textContent, /Waiting for content/);
    assert.equal(allNodes(root).some(node => ['BUTTON', 'INPUT'].includes(node.tagName)), false);
    assert.ok(root.textContent.includes(status === 'error' ? 'chat.block.reference 42' : 'chat.block.pending'));
    assert.equal(root.textContent.includes('chat.invalidContent'), false);
  }
});

test('valid error blocks display their supplied reason as inert text with the original reference', () => {
  const root = render(envelope([{ id: 'block-one', type: 'choice', schemaVersion: 1, status: 'error', fallbackText: 'Could not build choices', reason: '<img onerror=bad()> Source unavailable' }]));
  assert.equal(root.textContent, 'Could not build choices<img onerror=bad()> Source unavailablechat.block.reference 42');
  assert.equal(allNodes(root).some(node => ['IMG', 'SCRIPT', 'BUTTON', 'INPUT'].includes(node.tagName)), false);
  const empty = render(envelope([{ id: 'block-one', type: 'choice', schemaVersion: 1, status: 'error', fallbackText: '' }]));
  assert.equal(empty.textContent, 'chat.block.failedchat.block.reference 42');
});

test('interactive choice controls replace static options while read-only cards retain them', () => {
  const makeControls = active => () => {
    const document = createDocument(), root = document.createElement('div');
    if (active) {
      root.dataset.choiceControls = 'true';
      for (const label of ['Plan A', 'Plan B']) { const item = document.createElement('label'); item.textContent = label; root.append(item); }
    }
    return root;
  };
  const active = render(envelope([choices('single')], true), { renderQuestion: makeControls(true) });
  assert.equal(active.textContent.match(/Plan A/g)?.length, 1);
  assert.equal(allNodes(active).some(node => node.className === 'chat-choice-options'), false);
  assert.match(active.textContent, /Choose a plan/);
  const readonly = render(envelope([choices('single')], true), { renderQuestion: makeControls(false) });
  assert.equal(readonly.textContent.match(/Plan A/g)?.length, 1);
  assert.equal(allNodes(readonly).filter(node => node.className === 'chat-choice-options').length, 1);
});

for (const [name, invalid] of [
  ['broken JSON', CONTENT_PREFIX + '{broken'],
  ['unsupported block', CONTENT_PREFIX + JSON.stringify(envelope([block('future_block', { title: 'Unknown' })]))],
  ['invalid chart data', CONTENT_PREFIX + JSON.stringify(envelope([block('time_series', { xType: 'number', series: [{ key: 'bad', label: 'Bad', points: [{ x: 1, y: 'execute me' }] }] })]))],
  ['missing interrupt reference', CONTENT_PREFIX + JSON.stringify({ ...envelope([choices('single')], true), interrupt: { blockId: 'missing-block', reason: 'input_required' } })],
]) test(`${name} remains visible as a referenced read-only error`, () => {
  let calls = 0;
  const root = render(invalid, { renderQuestion() { calls++; } });
  assert.equal(root.textContent, 'chat.invalidContentchat.block.reference 42');
  assert.equal(calls, 0);
  assert.equal(allNodes(root).some(node => ['BUTTON', 'INPUT', 'A', 'SCRIPT'].includes(node.tagName)), false);
});

test('citations remain plain references even for executable URI schemes and HTML labels', () => {
  const root = render(envelope([block('markdown', { text: 'Body' }, { metadata: { citations: [{ label: '<img onerror=evil()>', url: 'javascript:evil()', ref: '<script>secret</script>' }] } })]));
  assert.match(root.textContent, /<img onerror=evil\(\)> · <script>secret<\/script> · javascript:evil\(\)/);
  assert.equal(allNodes(root).some(node => ['A', 'IMG', 'SCRIPT'].includes(node.tagName)), false);
});

test('renderer failure replaces the failed block with a referenced error and no partial actions', () => {
  const root = render(envelope([choices('single')], true), { renderQuestion() { throw new Error('unsafe private failure'); } });
  assert.equal(root.textContent, 'chat.invalidContentchat.block.reference 42');
  assert.equal(root.textContent.includes('unsafe private failure'), false);
});

test('answers controls and empty message envelopes display their validated fallback only', () => {
  const empty = render(envelope([])); assert.equal(empty.textContent, 'Envelope fallback');
  const emptyText = render(envelope([block('markdown', { text: '' })])); assert.equal(emptyText.textContent, 'Readable fallback');
  const control = render({ version: 1, kind: 'control', messageId: 'control-message', interruptId: 'interrupt-one', fallbackText: 'Question stopped', control: { operation: 'stop', messageId: 'message-one' } });
  assert.equal(control.textContent, 'Question stopped');
  assert.equal(allNodes(control).some(node => node.tagName === 'BUTTON'), false);
});
