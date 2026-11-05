import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageForStatus } from '../status-notice-templates.js';

const expected = {
  "memory_low": [
    "这台机器内存快用完了，运行可能变慢或不稳定；如果经常出现，请考虑给这台机器增加内存。",
    "This machine is almost out of memory, so things may slow down or become unstable. If this happens often, consider adding memory to this machine."
  ],
  "inputs_unreadable": [
    "系统出现异常，暂时无法确认这台机器的内存是否够用。为了稳定运行，现在只能同时运行一个对话，其他对话会排队等候，回复可能变慢。恢复后会自动回到正常状态，不需要你操作；如果长时间没有恢复，请联系技术支持。",
    "Something is wrong with the system: it cannot confirm whether this machine has enough memory right now. To stay stable, only one conversation can run at a time and others wait in line, so replies may be slower. Things return to normal by themselves once this clears, with nothing for you to do. If it lasts a long time, please contact technical support."
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
  for (const id of ['inputs_unreadable']) {
    assert.equal(render(id, config), prefixed(expected[id], 'Acme'));
  }
});

test('capacity overrides retain localized length and control-character validation', () => {
  for (const invalid of ['', '   ', 'x'.repeat(2001), 'bad\0text', 'bad\x7ftext']) {
    const config = { templates: { capacity: { inputs_unreadable: { zh: invalid, en: invalid } } } };
    assert.equal(render('inputs_unreadable', config), prefixed(expected.inputs_unreadable));
  }
  const accepted = 'x'.repeat(2000);
  const config = { brand: 'bad\nbrand', templates: { capacity: { inputs_unreadable: { en: accepted } } } };
  assert.equal(render('inputs_unreadable', config), prefixed([expected.inputs_unreadable[0], accepted]));
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
