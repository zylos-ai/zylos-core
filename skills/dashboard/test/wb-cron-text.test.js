import test from 'node:test';
import assert from 'node:assert/strict';
import { cronText } from '../public/js/wb/cron-text.js';

test('cron rules in common shapes read as plain language', () => {
  assert.equal(cronText('0 8 * * *'), '每天 08:00');
  assert.equal(cronText('0 9 * * 1,3,5'), '每周一、三、五 09:00');
  assert.equal(cronText('30 7 * * 0,6'), '每周六、日 07:30');
  assert.equal(cronText('30 7 * * 7'), '每周日 07:30');
  assert.equal(cronText('0 9 * * 1-5'), '工作日 09:00');
  assert.equal(cronText('0 10 4 * *'), '每月 4 日 10:00');
  assert.equal(cronText('0 10 4 1,4,7,10 *'), '每季度首月 4 日 10:00');
  assert.equal(cronText('*/15 * * * *'), '每 15 分钟');
  assert.equal(cronText('0 */2 * * *'), '每 2 小时');
  assert.equal(cronText('0 8 * * *', 'en'), 'Every day at 08:00');
  assert.equal(cronText('0 9 * * 1,3,5', 'en'), 'Every Mon, Wed, Fri at 09:00');
  // Several hours in one rule read as several times.
  assert.equal(cronText('0 0,12 * * *'), '每天 00:00、12:00');
  assert.equal(cronText('30 18,9 * * 1-5'), '工作日 09:30、18:30');
  assert.equal(cronText('0 0,12 * * *', 'en'), 'Every day at 00:00, 12:00');
});

test('other cron rules are shown unchanged instead of guessed', () => {
  for (const expr of ['7 3 */2 * *', '0 9 * * 1-3', '0 25 * * *', '0 8 * 2 *', '0 8 1 * 1', '@daily', '0 8 * *', '*/0 * * * *', '0 1,2,3,4,5,6,7 * * *', '0 8,x * * *']) {
    assert.equal(cronText(expr), expr);
  }
});
