import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/js/markdown-it.min.js';
import { createMarkdownRenderer } from '../public/js/markdown-config.js';
import { markdownPreview } from '../src/lib/chat/markdown-preview.js';

// Wiring only: exercise product renderers without opening services or databases.
test('Memory Markdown uses CJK-friendly emphasis while preserving code and English', () => {
  const md = createMarkdownRenderer(globalThis.markdownit);
  assert.equal(md.render('**（粗体）**后文 `**（代码）**后文` **Bold** and *italic*'),
    '<p><strong>（粗体）</strong>后文 <code>**（代码）**后文</code> <strong>Bold</strong> and <em>italic</em></p>\n');
  // The upstream library deliberately keeps CommonMark underscore boundaries.
  assert.equal(md.render('前文__【粗体】__后文'), '<p>前文__【粗体】__后文</p>\n');
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
