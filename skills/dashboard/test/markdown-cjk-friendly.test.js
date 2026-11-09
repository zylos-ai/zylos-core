import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import '../public/js/markdown-it.min.js';
import { createMarkdownRenderer } from '../public/js/markdown-config.js';
import { markdownPreview } from '../src/lib/chat/markdown-preview.js';
import { createDocument } from './helpers/conversation-dom.js';

// Resolve the shared schema at the same URL served by the Dashboard; import
// the real conversation renderer without starting the HTTP service.
const shared = new URL('../../comm-bridge/scripts/c4-content-schema.js', import.meta.url).href;
const schemaResolution = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL && new URL(specifier, context.parentURL).pathname.endsWith('/public/chat-schema.js')) return next(shared, context);
  return next(specifier, context);
} });
const { renderConversationContent } = await import('../public/js/wb/conversation-content.js');
schemaResolution.deregister();

// Wiring only: exercise product renderers without opening services or databases.
test('Memory Markdown uses CJK-friendly emphasis while preserving code and English', () => {
  const md = createMarkdownRenderer(globalThis.markdownit);
  assert.equal(md.render('**（粗体）**后文 `**（代码）**后文` **Bold** and *italic*'),
    '<p><strong>（粗体）</strong>后文 <code>**（代码）**后文</code> <strong>Bold</strong> and <em>italic</em></p>\n');
  // The upstream library deliberately keeps CommonMark underscore boundaries.
  assert.equal(md.render('前文__【粗体】__后文'), '<p>前文__【粗体】__后文</p>\n');
});

test('conversation bodies use CJK-friendly emphasis while preserving code and English', t => {
  function renderedHtml(content) {
    const document = createDocument();
    document.defaultView = { markdownit: globalThis.markdownit };
    const root = renderConversationContent({ document, row: { id: 1, direction: 'out', content }, t: key => key });
    t.after(() => root.destroy());
    const formatted = root.querySelectorAll('.chat-message-text.conversation-markdown');
    assert.equal(formatted.length, 1, 'the real Markdown branch replaces the original text node');
    // The fake DOM retains innerHTML verbatim. Assert the actual HTML produced
    // by the product parser; browser cases cover HTML parsing and layout.
    return formatted[0].innerHTML;
  }
  assert.equal(renderedHtml('**（粗体）**后文 `**（代码）**后文` **Bold** and *italic*'),
    '<p><strong>（粗体）</strong>后文 <code>**（代码）**后文</code> <strong>Bold</strong> and <em>italic</em></p>\n');
  const english = '**Bold** and *italic* with `**literal**`.';
  assert.equal(renderedHtml(english), globalThis.markdownit({ html: false, linkify: true, breaks: true }).render(english));
});

test('server Markdown previews use CJK-friendly emphasis while preserving code and English', () => {
  assert.equal(markdownPreview('**（粗体）**后文 `**（代码）**后文` **Bold** and *italic*'),
    '（粗体）后文 **（代码）**后文 Bold and italic');
  assert.equal(markdownPreview('前文__【粗体】__后文'), '前文__【粗体】__后文');
});

test('malformed emphasis follows the mature parser without custom recovery', () => {
  const source = '**已跑完；**证据未核**，核后报。**';
  assert.equal(createMarkdownRenderer(globalThis.markdownit).render(source),
    '<p><strong>已跑完；</strong>证据未核<strong>，核后报。</strong></p>\n');
  assert.equal(markdownPreview(source), '已跑完；证据未核，核后报。');
});
