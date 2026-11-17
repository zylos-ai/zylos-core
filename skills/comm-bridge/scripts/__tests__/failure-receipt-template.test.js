import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTestEnvironment } from '../../../../scripts/test-environment.js';

const environment = createTestEnvironment();
const { messageForFailureReceipt } = await import('../failure-receipt-template.js');
const { CONFIG_FILE } = await import('../local-config.js');
after(() => environment.cleanup());

const record = { id: 51, session_group: 'chat:target', reason: 'launch_failed', channel: 'internal' };

test('internal failure receipt uses configured status notice brand with the same safe default', () => {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ statusNotices: { brand: 'Factory' } }));
  assert.match(messageForFailureReceipt(record), /^\[Factory\]/);
  for (const brand of ['', 'unsafe\nbrand', 'unsafe\tbrand', 'x'.repeat(81), 42]) {
    assert.match(messageForFailureReceipt(record, { brand }), /^\[Zylos\]/);
  }
  assert.match(messageForFailureReceipt(record, { brand: '  Factory  ' }), /^\[Factory\]/);
});

test('internal receipt explicitly says no reply is needed without quoting original content', () => {
  const message = messageForFailureReceipt({ ...record, content: 'PRIVATE ORIGINAL' }, {});
  assert.match(message, /系统回执，无需回复/);
  assert.match(message, /System receipt; no reply is needed/);
  assert.equal(message.includes('PRIVATE ORIGINAL'), false);
});

test('internal exhausted delivery verification describes uncertainty rather than confirmed non-delivery', () => {
  const message = messageForFailureReceipt({ ...record, reason: 'delivery_unverified' }, {});
  assert.match(message, /消息 #51 未能确认送达会话组「chat:target」/);
  assert.match(message, /could not be confirmed delivered/);
  assert.equal(message.includes('没有送达'), false);
  assert.equal(message.includes('was not delivered'), false);
  assert.match(messageForFailureReceipt(record, {}), /没有送达/);
});
