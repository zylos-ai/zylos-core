import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionHotTtl } from '../session-hot-ttl.js';

test('hot TTL preserves positive integer environment and config precedence', () => {
  assert.equal(resolveSessionHotTtl({}, {}).seconds, 3300);
  assert.equal(resolveSessionHotTtl({ session_hot_ttl_seconds: ' 61 ' }, {}).minutes, 61 / 60);
  for (const value of ['0', '-1', '1.5', '', '12x', '1e3', '0x10', '9007199254740992']) {
    const resolved = resolveSessionHotTtl({ session_mode: 'multi', session_hot_ttl_seconds: '90' },
      { ZYLOS_SESSION_HOT_TTL_SECONDS: value });
    assert.equal(resolved.seconds, 90);
    assert.equal(resolved.source, 'config');
    assert.equal(resolved.environment_set, true);
    assert.equal(resolved.environment_valid, false);
    assert.equal(resolved.read_only, true);
    assert.equal(resolveSessionHotTtl({ session_hot_ttl_seconds: value }, {}).seconds, 3300);
  }
  const environment = resolveSessionHotTtl({ session_mode: 'multi', session_hot_ttl_seconds: 300 },
    { ZYLOS_SESSION_HOT_TTL_SECONDS: ' 121 ' });
  assert.equal(environment.seconds, 121);
  assert.equal(environment.minutes, 121 / 60);
  assert.equal(environment.source, 'environment');
  assert.equal(environment.environment_valid, true);
  assert.equal(environment.read_only, true);
  assert.equal(resolveSessionHotTtl({ session_hot_ttl_seconds: 86401 }, {}).seconds, 86401,
    'existing effective values are not clamped to the new-write limits');
});
