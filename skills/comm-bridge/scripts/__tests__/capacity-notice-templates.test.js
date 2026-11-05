import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageForStatus } from '../status-notice-templates.js';

const expected = {
  "memory_low": [
    "这台机器内存快用完了，运行可能变慢或不稳定；如果经常出现，请考虑给这台机器增加内存。",
    "This machine is almost out of memory, so things may slow down or become unstable. If this happens often, consider adding memory to this machine."
  ]
};
const render = (noticeCode, config = {}, fields = {}) =>
  messageForStatus({ context: 'capacity', noticeCode, ...fields }, config);
const prefixed = (lines, brand = 'Zylos') => lines.map(line => `[${brand}] ${line}`).join('\n');

for (const [id, lines] of Object.entries(expected)) {
  test(`capacity ${id} has the exact bilingual default without diagnostic text`, () => {
    const text = render(id, {}, {
      reason: 'PRIVATE_ERROR', sessionGroup: 'PRIVATE_GROUP', usedBytes: 12345,
    });
    assert.equal(text, prefixed(lines));
    assert.equal(text.split('\n').length, 2);
    assert.doesNotMatch(text, /cgroup|OOM|oom|tmux|\bK\b|PRIVATE_ERROR|PRIVATE_GROUP|12345/);
    assert.doesNotMatch(text, /not added to the processing queue|could not be completed/);
  });
}

test('capacity overrides select one ID and locale and share the configured brand', () => {
  const config = { brand: 'Acme', templates: {
    capacity: { memory_low: { zh: '自定义内存通知。' } },
    failure: { memory_low: { en: 'Wrong context.' } },
  } };
  assert.equal(render('memory_low', config), prefixed(['自定义内存通知。', expected.memory_low[1]], 'Acme'));
});

test('capacity overrides retain localized length and control-character validation', () => {
  for (const invalid of ['', '   ', 'x'.repeat(2001), 'bad\0text', 'bad\x7ftext']) {
    const config = { templates: { capacity: { memory_low: { zh: invalid, en: invalid } } } };
    assert.equal(render('memory_low', config), prefixed(expected.memory_low));
  }
  const accepted = 'x'.repeat(2000);
  const config = { brand: 'bad\nbrand', templates: { capacity: { memory_low: { en: accepted } } } };
  assert.equal(render('memory_low', config), prefixed([expected.memory_low[0], accepted]));
});

test('capacity overrides cannot borrow quota reset variables', () => {
  const config = { templates: { capacity: { memory_low: {
    zh: '错误变量 {resetAt}', en: 'Wrong variable {resetAt}',
  } } } };
  assert.equal(render('memory_low', config, { resetAt: Date.now() + 3600000 }), prefixed(expected.memory_low));
});

test('capacity IDs do not replace inbound or failure classification', () => {
  for (const context of ['inbound', 'failure']) {
    const text = messageForStatus({ context, noticeCode: 'memory_low', health: 'unavailable' }, {});
    assert.equal(text, messageForStatus({ context, health: 'unavailable' }, {}));
  }
});
