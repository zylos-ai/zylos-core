import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import fs from 'node:fs';
import { evaluateBeforeSend } from '../scripts/send-hook.js';
import { runComponents } from '../scripts/components.js';
import { registerQuestion } from '../src/lib/chat/questions.js';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
import { applyChatView } from '../public/js/wb/chat-view.js';
import { dashboardSource } from '../../comm-bridge/scripts/dashboard-source.js';
import { chatAttachmentPreview, conversationPreview, quotePreview } from '../src/lib/chat/history.js';
const shared = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(shared, context);
  return next(specifier, context);
} });
const { renderChatContent } = await import('../public/js/wb/chat-blocks.js');
const { readableText, previewLine } = await import('../public/js/wb/chat-compose-text.js');
const encode = envelope => CONTENT_PREFIX + JSON.stringify(envelope);
const block = (id, type, data, fallbackText = `${id} fallback`) => ({ id, type, schemaVersion: 1, data, fallbackText });
const future = () => ({ ...block('future', 'future_widget', {
  attachmentId: 'HIDDEN_ATTACHMENT', nameSnapshot: 'HIDDEN_FILE.png', action: { target: 'HIDDEN_ACTION' }, title: 'HIDDEN_TITLE'
}, '**literal** <img onerror=evil()> [link](javascript:evil())\nFuture fallback'),
  metadata: { citations: [{ label: 'HIDDEN_CITATION', url: 'https://example.test/private' }] } });
const message = blocks => ({ version: 1, kind: 'message', messageId: 'mixed-message', fallbackText: 'Whole-message words\nSecond line', blocks });
const row = source => ({ id: 42, direction: 'out', channel: 'dashboard', content: encode(source) });
const render = (source, extra = {}) => renderChatContent({ document: createDocument(), row: row(source), t: key => key, ...extra });
const chart = () => block('chart', 'category_series', { title: 'Known chart', points: [{ key: 'a', label: 'Alpha', value: 7 }] });

// Real browser modules and an injected in-memory DOM. Run for unknown-block
// renderer/parser changes; skip unrelated transport work. No runtime or storage.
test('unknown blocks render only their literal fallback while known siblings retain order and chart rendering', () => {
  const unknown = future();
  const source = message([block('before', 'markdown', { text: 'Known before' }), unknown, chart(), block('after', 'markdown', { text: 'Known after' })]);
  assert.equal(parseC4Content(encode(source)).kind, 'envelope');
  let charts = 0;
  const root = render(source, {
    supportsBlock(item) { assert.notEqual(item.id, 'future'); return true; },
    renderChart({ block: item, fallback }) { charts++; assert.equal(item.id, 'chart'); return fallback; },
    renderAttachment() { assert.fail('unknown data cannot become an attachment'); },
    renderQuestion() { assert.fail('ordinary unknown data cannot delegate a question'); }
  });
  assert.equal(charts, 1);
  const part = allNodes(root).find(node => node.dataset.blockId === 'future');
  assert.ok(part); assert.equal(part.textContent, unknown.fallbackText);
  assert.equal(allNodes(part).some(node => ['IMG', 'A', 'SCRIPT', 'BUTTON', 'INPUT', 'CANVAS', 'TABLE'].includes(node.tagName)), false);
  assert.equal(allNodes(part).some(node => node.listeners.size > 0), false);
  assert.deepEqual(root.children.map(node => node.dataset.blockId), ['before', 'future', 'chart', 'after']);
  assert.equal(allNodes(root).filter(node => node.tagName === 'TABLE').length, 1);
  assert.ok(root.textContent.includes('Known chartAlpha7'));
  assert.doesNotMatch(root.textContent, /HIDDEN_|partialContent|invalidContent|block.pending/);
});

test('pending and error unknown blocks never render reason citations or pending status', () => {
  for (const status of ['pending', 'error']) {
    const unknown = { ...future(), status }; delete unknown.data;
    if (status === 'error') unknown.reason = 'HIDDEN_REASON';
    const root = render(message([unknown]), {
      supportsBlock() { assert.fail('unknown blocks cannot invoke host capability callbacks'); },
      renderChart() { assert.fail('unknown blocks cannot invoke charts'); },
      renderAttachment() { assert.fail('unknown blocks cannot invoke attachments'); }
    });
    assert.equal(root.textContent, unknown.fallbackText);
    assert.equal(allNodes(root).some(node => ['A', 'BUTTON', 'IMG', 'INPUT'].includes(node.tagName)), false);
  }
});

test('View references keep the unknown placeholder and preserve unreferenced known siblings', () => {
  const source = message([block('before', 'markdown', { text: 'Known before' }), future(), chart()]);
  source.metadata = { view: { schemaVersion: 1, root: 'layout', nodes: [
    { id: 'layout', type: 'stack', children: ['future-slot', 'before-slot'] },
    { id: 'future-slot', type: 'block', blockId: 'future' },
    { id: 'before-slot', type: 'block', blockId: 'before' }
  ] } };
  let layouts = 0;
  const root = render(source, { layout(root, view, nodes) {
    layouts++; assert.deepEqual([...nodes.keys()], ['before', 'future', 'chart']);
    assert.equal(nodes.get('future').textContent, source.blocks[1].fallbackText);
    applyChatView(root.ownerDocument, root, view, nodes);
  } });
  assert.equal(layouts, 1);
  assert.deepEqual(allNodes(root).filter(node => node.dataset.blockId).map(node => node.dataset.blockId), ['future', 'before', 'chart']);
  assert.equal(root.children.at(-1).dataset.blockId, 'chart');
  assert.doesNotMatch(root.textContent, /HIDDEN_|invalidContent/);
});

// Pure reader functions only: no ChatHistory construction, database connection,
// file reads or external sends. Run for unknown parsing or text output changes.
test('copy quote and preview text equal known messages with the same envelope fallback', () => {
  const unknown = message([future()]);
  const known = message([block('future', 'markdown', { text: 'Different known body' })]);
  assert.equal(readableText(row(unknown)), readableText(row(known)));
  assert.equal(readableText(row(unknown)), unknown.fallbackText);
  assert.equal(previewLine(readableText(row(unknown))), previewLine(readableText(row(known))));
  const quote = source => dashboardSource('[quote c4_id=42]\nMy reply', 'Owner', {
    row: { id: 43 }, lookupQuote: () => row(source)
  });
  assert.equal(quote(unknown), quote(known));
  assert.ok(quote(unknown).includes('Whole-message words\nSecond line'));
  assert.doesNotMatch(quote(unknown), /HIDDEN_|Future fallback|content invalid/);
});

test('server history summaries keep the existing static-component labels for unknown blocks', () => {
  const unknown = message([future()]);
  // History intentionally maps non-Markdown content to component labels rather
  // than the envelope fallback; compare with the equivalent known static block.
  const known = message([block('future', 'choice', { prompt: 'Known prompt', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], action: { type: 'choice.select', target: 'answer' } })]);
  assert.equal(parseC4Content(encode(known)).kind, 'envelope');
  for (const locale of ['en', 'zh']) {
    const options = { locale };
    assert.equal(chatAttachmentPreview(encode(unknown), options), chatAttachmentPreview(encode(known), options));
    assert.equal(conversationPreview(encode(unknown), options), conversationPreview(encode(known), options));
    assert.equal(quotePreview(row(unknown), options), quotePreview(row(known), options));
    assert.equal(quotePreview(row(unknown), { ...options, singleLine: true }), quotePreview(row(known), { ...options, singleLine: true }));
    assert.doesNotMatch(chatAttachmentPreview(encode(unknown), options), /HIDDEN_|\.png|Chart|图表|Image|图片/);
  }
});

// Direct acceptance functions only: valid non-attachment messages never open
// storage, and unknown content is rejected before attachment resolution.
test('BeforeSend and the component CLI keep the same unknown content unsendable', () => {
  const fixtures = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/c4-content-protocol.json', import.meta.url), 'utf8'));
  const source = message([future()]);
  const known = message([block('future', 'markdown', { text: 'Known text' })]);
  for (const [envelope, accepted] of [[source, false], [known, true]]) {
    const content = encode(envelope);
    assert.equal(parseC4Content(content).kind, 'envelope');
    const input = structuredClone(fixtures.hookInputs.find(row => row.name === 'valid_input').value);
    input.request.content = content;
    const result = evaluateBeforeSend(input);
    assert.equal(result.decision, accepted ? 'continue' : 'abort');
    let output = '';
    const exit = runComponents(['validate', '-', '--json'], {
      readInput: () => content, stdout: { write(value) { output += value; } },
      stderr: { write() { assert.fail('JSON validation emits its result to stdout'); } }
    });
    assert.equal(exit, accepted ? 0 : 1);
    assert.equal(JSON.parse(output).ok, accepted);
    if (!accepted) assert.equal(JSON.parse(output).error.code, 'enum');
  }
});

test('historical unknown siblings cannot register a question or reach question storage', () => {
  const source = message([future()]);
  assert.equal(registerQuestion(row(source)), null);
  for (const key of ['interruptId', 'questionSummary', 'interrupt']) {
    const question = { ...source, [key]: key === 'interrupt' ? {} : 'question' };
    assert.throws(() => registerQuestion(row(question)), error => error.code === 'INVALID_CONTENT');
  }
});
