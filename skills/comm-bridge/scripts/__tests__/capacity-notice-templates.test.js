import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageForStatus } from '../status-notice-templates.js';

const expected = {
  memory_reclaim: [
    '这台机器内存快用完了，已自动关掉一个空闲了 5 分钟以上的对话；它下次收到消息会自动重新开始。',
    'This machine is almost out of memory, so one conversation that had been idle for more than 5 minutes was closed automatically. It will start again by itself when its next message arrives.',
  ],
  oom_kill: [
    '这台机器内存不够用，系统刚刚强制结束了一个程序。被打断的对话和服务会自动重新启动；如果经常出现，请考虑给这台机器增加内存。',
    'This machine ran out of memory, and the system just force-stopped a program. Interrupted conversations and services restart automatically. If this happens often, consider adding memory to this machine.',
  ],
  inputs_unreadable: [
    '暂时读不到这台机器的内存使用情况。为了安全，现在除系统助手外同时只运行一个对话，其他对话排队等候；恢复读取后会自动调整。',
    'Memory usage on this machine cannot be read right now. To stay safe, only one conversation runs at a time besides the system assistant, and others wait in line. This adjusts automatically once readings recover.',
  ],
  publish_failed: [
    '同时运行的对话数量暂时无法更新，系统会按更保守的数量继续运行。',
    'The number of conversations that can run at the same time cannot be updated right now. The system keeps running with a more cautious number.',
  ],
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
    capacity: { oom_kill: { zh: '自定义内存通知。' } },
    failure: { oom_kill: { en: 'Wrong context.' } },
  } };
  assert.equal(render('oom_kill', config), prefixed(['自定义内存通知。', expected.oom_kill[1]], 'Acme'));
  for (const id of ['memory_reclaim', 'inputs_unreadable', 'publish_failed']) {
    assert.equal(render(id, config), prefixed(expected[id], 'Acme'));
  }
});

test('capacity overrides retain localized length and control-character validation', () => {
  for (const invalid of ['', '   ', 'x'.repeat(2001), 'bad\0text', 'bad\x7ftext']) {
    const config = { templates: { capacity: { publish_failed: { zh: invalid, en: invalid } } } };
    assert.equal(render('publish_failed', config), prefixed(expected.publish_failed));
  }
  const accepted = 'x'.repeat(2000);
  const config = { brand: 'bad\nbrand', templates: { capacity: { publish_failed: { en: accepted } } } };
  assert.equal(render('publish_failed', config), prefixed([expected.publish_failed[0], accepted]));
});

test('only memory reclaim substitutes the supplied idle minutes', () => {
  assert.equal(render('memory_reclaim', {}, { idleMinutes: 10 }), prefixed(expected.memory_reclaim.map(line => line.replace('5', '10'))));
  const config = { templates: { capacity: {
    memory_reclaim: { zh: '空闲 {idleMinutes} 分钟。', en: 'Idle {idleMinutes} minutes.' },
  } } };
  assert.equal(render('memory_reclaim', config, { idleMinutes: 1 }), '[Zylos] 空闲 1 分钟。\n[Zylos] Idle 1 minutes.');
  for (const id of ['oom_kill', 'inputs_unreadable', 'publish_failed']) {
    assert.equal(render(id, { templates: { capacity: { [id]: {
      zh: '不可用的 {idleMinutes} 变量。', en: 'Invalid {idleMinutes} variable.',
    } } } }, { idleMinutes: 10 }), prefixed(expected[id]));
  }
});

test('capacity overrides cannot borrow quota reset variables', () => {
  const config = { templates: { capacity: { oom_kill: {
    zh: '错误变量 {resetAt}', en: 'Wrong variable {resetAt}',
  } } } };
  assert.equal(render('oom_kill', config, { resetAt: Date.now() + 3600000 }), prefixed(expected.oom_kill));
});

test('capacity IDs do not replace inbound or failure classification', () => {
  for (const context of ['inbound', 'failure']) {
    const text = messageForStatus({ context, noticeCode: 'oom_kill', health: 'unavailable' }, {});
    assert.equal(text, messageForStatus({ context, health: 'unavailable' }, {}));
  }
});
