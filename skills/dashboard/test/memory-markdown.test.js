import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createMarkdownRenderer, markdownHtml } from '../public/js/markdown-config.js';
const vendoredPath = new URL('../public/js/markdown-it.min.js', import.meta.url).pathname;

// The UMD bundle sits inside a "type":"module" package, so require() would
// misparse it; evaluate it the way a CJS host would.
function loadVendoredMarkdownIt() {
  const code = fs.readFileSync(vendoredPath, 'utf8');
  const mod = { exports: {} };
  new Function('module', 'exports', code)(mod, mod.exports);
  return mod.exports;
}

// The renderer the memory page uses, built on the vendored bundle.
const buildRenderer = () => createMarkdownRenderer(loadVendoredMarkdownIt());

test('vendored markdown-it bundle is committed and loadable', () => {
  const stat = fs.statSync(vendoredPath);
  assert.ok(stat.size > 50_000, 'expected the full minified bundle, not a stub');
  assert.equal(typeof loadVendoredMarkdownIt(), 'function');
});

test('inline formatting renders: bold, italic, code, strikethrough-free fallback', () => {
  const md = buildRenderer();
  const html = md.render('**bold** *italic* `code`');
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>italic<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test('links render with target=_blank and rel=noopener noreferrer', () => {
  const md = buildRenderer();
  const html = md.render('[docs](https://example.com/docs)');
  assert.match(html, /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer">docs<\/a>/);
  // linkify: bare URLs become links with the same hardening.
  const bare = md.render('see https://example.com');
  assert.match(bare, /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">/);
  // Memory file names are not domains: identity.md stays plain text, in headings too.
  assert.doesNotMatch(md.render('# identity.md\n\nsee state.md'), /<a /);
});

test('tables and blockquotes render', () => {
  const md = buildRenderer();
  const html = md.render('| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted');
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /<blockquote>/);
});

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

test('headings and fenced code blocks still render as before', () => {
  const md = buildRenderer();
  const html = md.render('# Title\n\n```\nconst a = 1;\n```');
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<pre><code>const a = 1;\n<\/code><\/pre>/);
});

test('the renderer keeps raw HTML escaped and falls back to the escaped raw view without the bundle', () => {
  const md = buildRenderer();
  assert.doesNotMatch(md.render('<script>alert(1)</script>'), /<script>/);
  assert.doesNotMatch(md.render('[x](javascript:alert(1))'), /href="javascript:/);
  // Without a scheme nothing becomes a link: file names and www. addresses stay text.
  assert.doesNotMatch(md.render('see www.example.com and notes.md'), /<a /);
  assert.equal(createMarkdownRenderer(undefined), null);
  const esc = text => text.replace(/</g, '&lt;');
  assert.equal(markdownHtml(null, '<b>raw</b>', esc), '<pre class="memory-raw"><code>&lt;b>raw&lt;/b></code></pre>');
  assert.match(markdownHtml(md, '**bold**', esc), /<strong>bold<\/strong>/);
});

test('index.html loads markdown-it before app.js and bumps cache versions', () => {
  const html = fs.readFileSync(new URL('../public/index.html', import.meta.url).pathname, 'utf8');
  const mdIdx = html.indexOf('js/markdown-it.min.js');
  const appIdx = html.indexOf('js/app.js?v=');
  assert.ok(mdIdx > -1, 'markdown-it script tag present');
  assert.ok(mdIdx < appIdx, 'markdown-it loads before app.js');
  assert.match(html, /app\.js\?v=100/);
  assert.match(html, /style\.css\?v=60/);
});

test('stylesheet covers the newly rendered elements', () => {
  const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url).pathname, 'utf8');
  assert.match(css, /\.memory-markdown table/);
  assert.match(css, /\.memory-markdown blockquote/);
  assert.match(css, /\.memory-markdown a /);
  assert.match(css, /\.memory-markdown code/);
});
