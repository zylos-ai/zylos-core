import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readDeliveryIdentity } from '../runtime-delivery.js';

const foreground = { session_id: 'managed-session', claude_pid: 103, process_start: 'boot:456' };
function fixture({ record = foreground, pane = 101, start = 'boot:456', parents = { 103: 102, 102: 101 } } = {}) {
  return {
    zylosDir: '/isolated', session: 'managed',
    processStart: () => start,
    run: (_bin, args) => { assert.ok(args.includes('managed')); return String(pane); },
    read: file => {
      if (file.endsWith('foreground-session.json')) return JSON.stringify(record);
      const pid = Number(file.match(/\/proc\/(\d+)\/stat/)[1]);
      return `${pid} (process with spaces) S ${parents[pid] || 1} 0`;
    },
  };
}

test('managed pane ancestry and current process start prove foreground identity without generation', () => {
  assert.deepEqual(readDeliveryIdentity(fixture()), { runtime: 'claude', ...foreground });
  assert.deepEqual(readDeliveryIdentity(fixture({ pane: 103 })), { runtime: 'claude', ...foreground });
});

test('foreign manual process, recycled pid and missing session cannot establish identity', () => {
  assert.equal(readDeliveryIdentity(fixture({ pane: 999 })), null);
  assert.equal(readDeliveryIdentity(fixture({ start: 'boot:789' })), null);
  assert.equal(readDeliveryIdentity(fixture({ start: null })), null);
  assert.equal(readDeliveryIdentity(fixture({ record: { ...foreground, session_id: '' } })), null);
  assert.equal(readDeliveryIdentity(fixture({ record: { ...foreground, claude_pid: '103' } })), null);
});
