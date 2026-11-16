import test from 'node:test';
import assert from 'node:assert/strict';
import { storage, deferred } from './fixtures/workbench-dom.js';

test('default workbench loader reads current storage and fetch on every call', { timeout: 5000 }, async context => {
  const cacheKey = 'zylos-dashboard-i18n-wb-en';
  const pack = value => ({ 'wb.nav.overview': value });
  const originalStorage = storage({ [cacheKey]: JSON.stringify(pack('original')) });
  const originalRead = context.mock.method(originalStorage, 'getItem');
  const originalWrite = context.mock.method(originalStorage, 'setItem');
  const originalFetch = context.mock.fn(async () => ({ ok: true, json: async () => pack('original') }));

  for (const [key, value] of Object.entries({ localStorage: originalStorage, fetch: originalFetch })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    context.after(() => {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    });
  }
  const { initWbPack } = await import('../public/js/wb/i18n-wb.js');

  for (const value of ['first', 'second']) {
    const currentStorage = storage({ [cacheKey]: JSON.stringify(pack(`${value}-cached`)) });
    const read = context.mock.method(currentStorage, 'getItem');
    const write = context.mock.method(currentStorage, 'setItem');
    const network = deferred();
    const currentFetch = context.mock.fn(() => network.promise);
    globalThis.localStorage = currentStorage;
    globalThis.fetch = currentFetch;

    const translations = {};
    const pending = initWbPack('en', { assetRoot: '/fixture', translations });
    // Settle the request even if a cache assertion fails, so no timeout survives teardown.
    network.resolve({ ok: true, json: async () => pack(`${value}-fresh`) });
    try {
      assert.equal(translations['wb.nav.overview'], `${value}-cached`);
      assert.equal(read.mock.callCount(), 1);
      assert.deepEqual(read.mock.calls[0].arguments, [cacheKey]);
    } finally {
      await pending;
    }

    assert.equal(currentFetch.mock.callCount(), 1);
    const [url, options] = currentFetch.mock.calls[0].arguments;
    assert.equal(url, '/fixture/i18n/wb.en.json');
    assert.equal(options.cache, 'no-store');
    assert.equal(translations['wb.nav.overview'], `${value}-fresh`);
    assert.equal(write.mock.callCount(), 1);
    assert.deepEqual(write.mock.calls[0].arguments, [cacheKey, JSON.stringify(pack(`${value}-fresh`))]);
  }

  assert.equal(originalRead.mock.callCount(), 0);
  assert.equal(originalWrite.mock.callCount(), 0);
  assert.equal(originalFetch.mock.callCount(), 0);
});
