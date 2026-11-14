import test from 'node:test';
import assert from 'node:assert/strict';
import { createWbPackLoader } from '../public/js/wb/i18n-wb.js';
import { withRequestTimeout } from '../public/js/request-timeout.js';
import { storage } from './fixtures/workbench-dom.js';

const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const advance = async (context, ms) => { context.mock.timers.tick(ms); await flush(); };
const response = pack => ({ ok: true, json: async () => pack });
const hung = () => new Promise(() => {});

for (const cached of [false, true]) {
  for (const body of [false, true]) {
    test(`workbench ${body ? 'body' : 'fetch'} timeout retries and falls back ${cached ? 'to cache' : 'without cache'}`, async context => {
      context.mock.timers.enable({ apis: ['setTimeout'] });
      const saved = storage(cached ? { 'zylos-dashboard-i18n-wb-zh': JSON.stringify({ 'wb.nav.overview': '缓存' }) } : {});
      const signals = [], translations = {}; let warnings = 0, settled = false;
      const load = createWbPackLoader({ storage: saved, warn: () => warnings++, fetch: (url, options) => {
        assert.equal(options.cache, 'no-store'); signals.push(options.signal);
        return body ? Promise.resolve({ ok: true, json: hung }) : hung();
      } });
      const pending = load('zh', { translations }).then(() => { settled = true; });
      const timeout = cached ? 300 : 600;
      for (const gap of [timeout, 400, timeout, 800, timeout - 1]) await advance(context, gap);
      assert.equal(settled, false);
      await advance(context, 1); await pending;
      assert.equal(signals.length, 3); assert.ok(signals.every(signal => signal.aborted));
      assert.equal(translations['wb.nav.overview'], cached ? '缓存' : undefined);
      assert.equal(warnings, cached ? 0 : 1);
    });
  }
}

test('workbench merges cache immediately when shared startup budget is exhausted', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const translations = {};
  const load = createWbPackLoader({
    storage: storage({ 'zylos-dashboard-i18n-wb-zh': JSON.stringify({ 'wb.nav.overview': '缓存' }) }),
    fetch: () => assert.fail('expired startup issued a request'),
    sleep: () => assert.fail('expired startup added a retry delay'),
    warn: () => assert.fail('valid cache should not warn')
  });
  await load('zh', { translations, deadline: Date.now() });
  assert.equal(translations['wb.nav.overview'], '缓存');
  assert.equal(Date.now(), 1000);
});

test('main language timeouts retain cache or raw keys, heal, and share startup budget', async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const saved = storage(); let handler;
  context.mock.method(globalThis, 'fetch', (...args) => handler(...args));
  for (const [key, value] of Object.entries({ localStorage: saved,
    document: { documentElement: {}, querySelectorAll: () => [], dispatchEvent() {} } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    context.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const main = await import('../public/js/i18n.js?timeout-tests');
  main.setAssetRoot('/fixture');
  for (const cached of [false, true]) {
    for (const body of [false, true]) {
      const key = 'zylos-dashboard-i18n-zh';
      if (cached) saved.setItem(key, JSON.stringify({ 'btn.actions': '缓存' }));
      else saved.values.delete(key);
      const signals = []; let healthy = false, settled = false;
      handler = (url, options) => {
        if (url.includes('/i18n/wb.')) return Promise.resolve(response({ 'wb.nav.overview': '概览' }));
        signals.push(options.signal);
        return healthy ? Promise.resolve(response({ 'btn.actions': '恢复' }))
          : body ? Promise.resolve({ ok: true, json: hung }) : hung();
      };
      const pending = main.initI18n('zh').then(() => { settled = true; });
      const timeout = cached ? 300 : 600;
      for (const gap of [timeout, 400, timeout, 800, timeout - 1]) await advance(context, gap);
      assert.equal(settled, false);
      await advance(context, 1); await pending;
      assert.equal(signals.length, 3); assert.ok(signals.every(signal => signal.aborted));
      assert.equal(main.t('btn.actions'), cached ? '缓存' : 'btn.actions');
      healthy = true;
      await advance(context, 5000);
      assert.equal(main.t('btn.actions'), '恢复');
      assert.equal(main.t('wb.nav.overview'), '概览');
      assert.equal(JSON.parse(saved.getItem(key))['btn.actions'], '恢复');
    }
  }
  for (const budget of [1000, 4500]) {
    saved.values.delete('zylos-dashboard-i18n-zh');
    saved.values.delete('zylos-dashboard-i18n-wb-zh');
    let mainCalls = 0, wbCalls = 0, settled = false;
    handler = url => { if (url.includes('/wb.')) wbCalls++; else mainCalls++; return hung(); };
    const started = Date.now(), deadline = started + budget;
    const pending = main.initI18n('zh', { deadline }).then(() => { settled = true; });
    const gaps = budget === 1000 ? [600, 399] : [600, 400, 600, 800, 600, 600, 400, 499];
    for (const gap of gaps) await advance(context, gap);
    assert.equal(settled, false);
    await advance(context, 1); await pending;
    assert.equal(Date.now() - started, budget);
    assert.equal(mainCalls, budget === 1000 ? 1 : 3);
    assert.equal(wbCalls, budget === 1000 ? 0 : 2);
    assert.equal(main.t('btn.actions'), 'btn.actions');
    let observerCalled = false;
    await assert.rejects(withRequestTimeout(() => { observerCalled = true; return hung(); }, 1000, undefined, deadline),
      { name: 'TimeoutError' });
    assert.equal(observerCalled, false);
    assert.equal(Date.now() - started, budget);
  }
});

test('request deadline preserves upstream cancellation and clears completed timers', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const upstream = new AbortController(); let signal;
  const pending = withRequestTimeout(value => { signal = value; return hung(); }, 1000, upstream.signal);
  const reason = new Error('navigation changed');
  const rejected = assert.rejects(pending, error => error === reason);
  upstream.abort(reason); await rejected;
  assert.equal(signal.reason, reason);
  const completedSignal = await withRequestTimeout(async value => value, 1000);
  await advance(context, 1000);
  assert.equal(completedSignal.aborted, false);
  await assert.rejects(withRequestTimeout(() => assert.fail('pre-aborted request started'), 1000, upstream.signal), error => error === reason);
});
