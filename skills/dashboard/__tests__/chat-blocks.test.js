import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
import { CONTENT_PREFIX, makeQuestionSummary } from '../../comm-bridge/scripts/c4-content-schema.js';

// Resolve the browser alias to the same shared source; never evaluate source text.
const browserSchema = new URL('../public/chat-schema.js', import.meta.url).pathname;
const sourceSchema = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
const legacySchema = new URL('../../../test/fixtures/c4-content-schema-legacy.js', import.meta.url).href;
const legacyRenderer = new URL('./fixtures/chat-blocks-legacy.js', import.meta.url).href;
const legacyPlainText = new URL('./fixtures/plain-text-legacy.js', import.meta.url).href;
const browserDescriptors = new URL('../public/runtime-descriptors.js', import.meta.url).pathname;
const sourceDescriptors = new URL('../../../cli/lib/runtime/descriptors.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserDescriptors) return next(sourceDescriptors, context);
  if (context.parentURL && new URL(context.parentURL).pathname === new URL(legacyRenderer).pathname) {
    const resolved = new URL(specifier, context.parentURL).pathname;
    if (resolved === new URL('../../chat-schema.js', legacyRenderer).pathname) return next(legacySchema, context);
    if (resolved === new URL('./plain-text.js', legacyRenderer).pathname) return next(legacyPlainText, context);
  }
  if (context.parentURL && new URL(specifier, context.parentURL).pathname === browserSchema) return next(sourceSchema, context);
  return next(specifier, context);
} });
const { renderChatContent } = await import('../public/js/wb/chat-blocks.js');

const t = key => key;

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

// Browser renderer and injected DOM only; no network, database or runtime.

test('text block renders literal markdown and HTML rather than evaluating markup', () => {
  const root = render(envelope([block('markdown', { text: '**Hello** <svg onload=evil()> [link](javascript:evil())' })]));
  assert.match(root.textContent, /\*\*Hello\*\* <svg onload=evil\(\)>/);
  assert.equal(allNodes(root).some(node => ['A', 'SVG', 'SCRIPT'].includes(node.tagName)), false);
});

test('citations remain plain references even for executable URI schemes and HTML labels', () => {
  const root = render(envelope([block('markdown', { text: 'Body' }, { metadata: { citations: [{ label: '<img onerror=evil()>', url: 'javascript:evil()', ref: '<script>secret</script>' }] } })]));
  assert.match(root.textContent, /<img onerror=evil\(\)> · <script>secret<\/script> · javascript:evil\(\)/);
  assert.equal(allNodes(root).some(node => ['A', 'IMG', 'SCRIPT'].includes(node.tagName)), false);
});

// Hosts can deliberately retain static fallback for an unavailable renderer.

// Actual browser module, resolver alias and DOM fallback. Run for attachment
// schema/registration changes; in-memory DOM only, no HTTP or runtime resources.
