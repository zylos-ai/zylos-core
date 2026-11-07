import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { registerHooks } from 'node:module';
import { createDocument, allNodes } from './fixtures/workbench-dom.js';
import { CONTENT_PREFIX, parseC4Content } from '../../comm-bridge/scripts/c4-content-schema.js';
const shared = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(shared, context);
  return next(specifier, context);
} });
const { renderConversationContent } = await import('../public/js/wb/conversation-content.js');
const { renderChatContent } = await import('../public/js/wb/chat-blocks.js');
const fixture = JSON.parse(fs.readFileSync(new URL('../../../test/fixtures/view-and-form.json', import.meta.url), 'utf8'));

test('new page keeps known content on both sides of an unsupported conditional form', () => {
  const envelope = structuredClone(fixture.formQuestion);
  envelope.blocks.unshift({ id: 'intro', type: 'markdown', schemaVersion: 1, fallbackText: 'intro fallback', data: { text: 'Known introduction' } });
  envelope.blocks.push({ id: 'outro', type: 'markdown', schemaVersion: 1, fallbackText: 'outro fallback', data: { text: 'Known conclusion' } });
  const content = CONTENT_PREFIX + JSON.stringify(envelope);
  assert.equal(parseC4Content(content).kind, 'envelope');
  let controls = 0;
  const root = renderConversationContent({ document: createDocument(), row: { id: 42, direction: 'out', content }, t: key => key, renderQuestion() { controls++; } });
  const shown = root.textContent;
  assert.ok(shown.includes('Known introduction'));
  assert.ok(shown.includes(envelope.blocks[1].fallbackText));
  assert.ok(shown.includes('Known conclusion'));
  assert.ok(shown.indexOf('Known introduction') < shown.indexOf(envelope.blocks[1].fallbackText));
  assert.ok(shown.indexOf(envelope.blocks[1].fallbackText) < shown.indexOf('Known conclusion'));
  assert.equal(controls, 0);
  assert.equal(allNodes(root).some(node => ['INPUT', 'BUTTON', 'SELECT', 'TEXTAREA'].includes(node.tagName)), false);
});

test('host capability fallback does not change the default existing content renderer', () => {
  const source = { version: 1, kind: 'message', messageId: 'capability-message', fallbackText: 'message fallback', blocks: [
    { id: 'first', type: 'markdown', schemaVersion: 1, fallbackText: 'block fallback', data: { text: 'Full existing content' } },
  ] };
  const row = { id: 1, content: CONTENT_PREFIX + JSON.stringify(source) };
  const normal = renderChatContent({ document: createDocument(), row, t: key => key });
  const unsupported = renderChatContent({ document: createDocument(), row, t: key => key, supportsBlock: () => false });
  assert.ok(normal.textContent.includes('Full existing content'));
  assert.ok(unsupported.textContent.includes('block fallback'));
  assert.equal(unsupported.textContent.includes('Full existing content'), false);
});
