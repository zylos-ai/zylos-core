import assert from 'node:assert/strict';
import test from 'node:test';
import '../public/js/markdown-it.min.js';
import { createMarkdownRenderer } from '../public/js/markdown-config.js';

// Native import follows the browser bundle's global export, without reevaluating source.
const buildRenderer = () => createMarkdownRenderer(globalThis.markdownit);

test('raw HTML in memory content stays escaped, never executed', () => {
  const md = buildRenderer();
  const html = md.render('<img src=x onerror=alert(1)>\n\n<script>alert(2)</script>');
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /<script/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;script&gt;/);
});

test('javascript: link destinations are not rendered as links', () => {
  const md = buildRenderer();
  const html = md.render('[x](javascript:alert(1))');
  assert.doesNotMatch(html, /href="javascript:/);
});
