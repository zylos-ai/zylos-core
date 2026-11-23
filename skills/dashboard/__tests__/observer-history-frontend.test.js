import test from 'node:test';
import assert from 'node:assert/strict';
import '../public/js/markdown-it.min.js';
import { createHistoryMarkdown, escapeHistory } from '../public/js/observer-history.js';

test('history Markdown escapes HTML and permits only http(s) links, without remote images', () => {
  const render = createHistoryMarkdown(globalThis.markdownit);
  const result = render('<script>alert(1)</script> [bad](javascript:alert(1)) [file](file:///etc/passwd) [mail](mailto:x@y.com) [good](https://example.com) ![tracker](https://example.com/pixel)');
  assert.doesNotMatch(result, /<script|<img|href="(?:javascript|file|mailto):/);
  assert.match(result, /href="https:\/\/example.com"[^>]*rel="noopener noreferrer"/);
  assert.match(result, /&lt;script&gt;/);
  assert.equal(escapeHistory('"<>&\''), '&quot;&lt;&gt;&amp;&#39;');
});
