import assert from 'node:assert/strict';
import { test } from 'node:test';

test('periodic defaults on; capture and bracketed paste default off with explicit opt-in', async t => {
  const keys = ['C4_PERIODIC_ENTER_ENABLED', 'C4_ENTER_CAPTURE_ENABLED', 'C4_BRACKETED_PASTE_ENABLED'];
  const previous = keys.map(key => process.env[key]);
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key];
    else process.env[key] = previous[i];
  }));
  for (const [index, value] of [undefined, '1', '0', '', 'false', 'invalid'].entries()) {
    for (const key of keys) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    const config = await import(new URL(`../c4-config.js?default=${index}-${Date.now()}`, import.meta.url));
    assert.equal(config.PERIODIC_ENTER_ENABLED, value === undefined || value === '1');
    assert.equal(config.ENTER_CAPTURE_ENABLED, value === '1');
    assert.equal(config.BRACKETED_PASTE_ENABLED, value === '1');
    assert.equal(config.PERIODIC_ENTER_INTERVAL_MS, 60000);
    assert.equal(config.PERIODIC_ENTER_MAX_ATTEMPTS, 3);
  }
});
