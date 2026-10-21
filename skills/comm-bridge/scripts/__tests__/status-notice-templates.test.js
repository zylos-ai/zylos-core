import assert from 'node:assert/strict';
import { test } from 'node:test';
import { messageForStatus } from '../status-notice-templates.js';
import { messageForRoute } from '../../../activity-monitor/scripts/message-router.js';

test('AM and C4 fallback use the same bilingual Zylos defaults', () => {
  for (const health of ['rate_limited', 'auth_failed', 'unavailable']) {
    const input = { health, reason: 'PRIVATE_ERROR_TEXT' };
    assert.equal(messageForRoute(input), messageForStatus(input));
    assert.match(messageForStatus(input), /^\[Zylos\]/);
    assert.match(messageForStatus(input), /未进入处理队列/);
    assert.match(messageForStatus(input), /not added to the processing queue/);
    assert.doesNotMatch(messageForStatus(input), /PRIVATE_ERROR_TEXT|automatically/);
  }
});

test('first failure wording does not claim an already delivered request was never queued', () => {
  const message = messageForStatus({ health: 'rate_limited', context: 'failure' });
  assert.match(message, /本次请求未能完成/);
  assert.match(message, /could not be completed/);
  assert.doesNotMatch(message, /未进入处理队列|not added to the processing queue/);
});

test('operators can override language, brand and each failure context independently', () => {
  const config = { language: 'en', brand: 'Product', templates: {
    failure: { rate_limited: { en: 'Please retry this request later.' } },
  } };
  assert.equal(messageForStatus({ health: 'rate_limited', context: 'failure' }, config), '[Product] Please retry this request later.');
  assert.match(messageForStatus({ health: 'rate_limited' }, config), /not added to the processing queue/);
  assert.doesNotMatch(messageForStatus({ health: 'rate_limited' }, config), /当前/);
  assert.match(messageForStatus({ health: 'auth_failed' }, { language: 'zh' }), /当前认证不可用/);
});

test('invalid operator configuration falls back without exposing runtime text', () => {
  const input = { health: 'unknown', reason: 'PRIVATE', context: 'failure' };
  const config = { language: 'invalid', brand: 'bad\nbrand', templates: { failure: { unavailable: { zh: '\0', en: 'x'.repeat(2001) } } } };
  assert.equal(messageForStatus(input, config), messageForStatus(input, {}));
  assert.doesNotThrow(() => messageForStatus(input, null));
});
