import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionPoolBaseline } from '../../../../cli/lib/session-pool-config.js';

test('pool baseline uses environment then file then memory, minimum one', () => {
  const hardware = { platform: 'darwin', totalMemoryBytes: 8 * 1024 ** 3 };
  assert.deepEqual(resolveSessionPoolBaseline({ ...hardware, env: {}, config: {} }), { k: 6, fixed: false });
  assert.equal(resolveSessionPoolBaseline({ ...hardware, env: { ZYLOS_SESSION_POOL_SIZE: '25' }, config: { session_pool_size: 3 } }).k, 25);
  for (const value of ['0', '-1', '1.5', 'bogus', true, null]) {
    assert.equal(resolveSessionPoolBaseline({ ...hardware, env: { ZYLOS_SESSION_POOL_SIZE: value }, config: { session_pool_size: 3 } }).k, 3);
    assert.equal(resolveSessionPoolBaseline({ ...hardware, env: {}, config: { session_pool_size: value } }).k, 6);
  }
  assert.equal(resolveSessionPoolBaseline({ platform: 'darwin', totalMemoryBytes: 1024 ** 3, env: {}, config: {} }).k, 1);
});
