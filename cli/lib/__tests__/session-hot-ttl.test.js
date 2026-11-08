import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSessionHotTtl } from '../session-hot-ttl.js';

test('hot TTL preserves positive integer environment and config precedence', () => {
  assert.equal(resolveSessionHotTtl({}, {}).seconds, 1800);
  assert.equal(resolveSessionHotTtl({ session_hot_ttl_seconds: ' 61 ' }, {}).minutes, 61 / 60);
  for (const value of ['0', '-1', '1.5', '', '12x', '9007199254740992']) {
    const resolved = resolveSessionHotTtl({ session_mode: 'multi', session_hot_ttl_seconds: '90' },
      { ZYLOS_SESSION_HOT_TTL_SECONDS: value });
    assert.equal(resolved.seconds, 90);
    assert.equal(resolved.source, 'config');
    assert.equal(resolved.environment_set, true);
    assert.equal(resolved.environment_valid, false);
    assert.equal(resolved.read_only, true);
    assert.equal(resolveSessionHotTtl({ session_hot_ttl_seconds: value }, {}).seconds, 1800);
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

test('hot TTL metadata permits editing only in multi mode without an environment setting', () => {
  const configured = { session_hot_ttl_seconds: 2400 };
  for (const mode of [undefined, 'single', 'invalid']) {
    const resolved = resolveSessionHotTtl({ ...configured, session_mode: mode }, {});
    assert.equal(resolved.read_only, true);
    assert.equal(resolved.mode, mode === undefined ? 'single' : mode === 'invalid' ? null : mode);
  }
  const resolved = resolveSessionHotTtl({ ...configured, session_mode: 'multi' }, {});
  assert.equal(resolved.read_only, false);
  assert.equal(resolved.source, 'config');
  assert.equal(resolved.min_minutes, 5);
  assert.equal(resolved.max_minutes, 1440);
});
