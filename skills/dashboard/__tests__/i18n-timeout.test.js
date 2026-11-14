import test from 'node:test';
import assert from 'node:assert/strict';
import { createWbPackLoader } from '../public/js/wb/i18n-wb.js';
import { withRequestTimeout, waitUntilDeadline } from '../public/js/request-timeout.js';
import { storage, deferred } from './fixtures/workbench-dom.js';

const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
const advance = async (context, ms) => { context.mock.timers.tick(ms); await flush(); };
const response = pack => ({ ok: true, json: async () => pack });
const hung = () => new Promise(() => {});
const wbPack = value => ({ 'wb.nav.overview': value, 'wb.shared': value });

for (const cached of [false, true]) {
  for (const body of [false, true]) {
    test(`workbench ${body ? 'body' : 'fetch'} continues beyond UI deadline ${cached ? 'with cache' : 'without cache'}`, { timeout: 5000 }, async context => {
      context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
      const saved = storage(cached ? { 'zylos-dashboard-i18n-wb-zh': JSON.stringify(wbPack('缓存')) } : {});
      const network = deferred(), translations = {}; let signal, calls = 0, merges = 0;
      const load = createWbPackLoader({ storage: saved, fetch: (url, options) => {
        assert.equal(options.cache, 'no-store'); signal = options.signal; calls++;
        return body ? Promise.resolve({ ok: true, json: () => network.promise }) : network.promise;
      } });
      const pending = load('zh', { translations, deadline: Date.now() + 6000, onMerge: () => merges++ });
      await advance(context, 6000); await pending;
      assert.equal(signal.aborted, false); assert.equal(calls, 1);
      assert.equal(translations['wb.nav.overview'], cached ? '缓存' : undefined);
      network.resolve(body ? wbPack('恢复') : response(wbPack('恢复')));
      await flush();
      assert.equal(translations['wb.nav.overview'], '恢复');
      assert.equal(merges, cached ? 2 : 1);
      assert.equal(JSON.parse(saved.getItem('zylos-dashboard-i18n-wb-zh'))['wb.nav.overview'], '恢复');
      await advance(context, 30000); assert.equal(signal.aborted, false);
    });
  }
}

for (const cached of [false, true]) {
  test(`workbench permanent hangs retry at thirty seconds ${cached ? 'with cache' : 'without cache'}`, { timeout: 5000 }, async context => {
    context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
    const saved = storage(cached ? { 'zylos-dashboard-i18n-wb-zh': JSON.stringify(wbPack('缓存')) } : {});
    const signals = [], translations = {}; let done = false, warnings = 0;
    const load = createWbPackLoader({ storage: saved, warn: () => warnings++, fetch: (url, options) => { signals.push(options.signal); return hung(); } });
    const pending = load('zh', { translations }).then(() => { done = true; });
    for (const ms of [30000, 400, 30000, 800, 29999]) await advance(context, ms);
    assert.equal(done, false); assert.equal(signals.length, 3);
    await advance(context, 1); await pending;
    assert.ok(signals.every(signal => signal.aborted));
    assert.equal(translations['wb.nav.overview'], cached ? '缓存' : undefined);
    assert.equal(warnings, cached ? 0 : 1);
  });
}

test('main and workbench accept slow and late packs, reject stale locales, and heal actual failures', { timeout: 5000 }, async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 100000 });
  const saved = storage(); let handler, renders = 0;
  context.mock.method(globalThis, 'fetch', (...args) => handler(...args));
  for (const [key, value] of Object.entries({ localStorage: saved,
    document: { documentElement: {}, querySelectorAll: () => [], dispatchEvent() { renders++; } } })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    context.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const main = await import('../public/js/i18n.js?late-packs');
  main.setAssetRoot('/fixture');
  const mainKey = 'zylos-dashboard-i18n-zh', wbKey = 'zylos-dashboard-i18n-wb-zh';

  // Healthy 1.5-second responses use the first attempt, including body decoding.
  saved.values.clear(); let slowCalls = 0;
  handler = url => { slowCalls++; return Promise.resolve({ ok: true, json: () => new Promise(resolve => setTimeout(() =>
    resolve(url.includes('/wb.') ? wbPack('慢速概览') : { 'btn.actions': '慢速操作' }), 1500)) }); };
  const slow = main.initI18n('zh', { deadline: Date.now() + 6000 });
  await advance(context, 0); await advance(context, 1500); await advance(context, 1500); await slow;
  assert.equal(slowCalls, 2); assert.equal(main.t('btn.actions'), '慢速操作');
  assert.equal(main.t('wb.nav.overview'), '慢速概览');

  // Both completion orders preserve primary precedence on the same live object.
  for (const cached of [false, true]) {
    for (const wbFirst of [false, true]) {
      saved.values.clear();
      if (cached) {
        saved.setItem(mainKey, JSON.stringify({ 'btn.actions': '缓存', 'wb.shared': '主缓存' }));
        saved.setItem(wbKey, JSON.stringify(wbPack('WB缓存')));
      }
      const primary = deferred(), secondary = deferred(), signals = []; let calls = 0;
      handler = (url, options) => { calls++; signals.push(options.signal); return url.includes('/wb.') ? secondary.promise : primary.promise; };
      const started = Date.now();
      const pending = main.initI18n('zh', { deadline: started + 6000 });
      await advance(context, 6000); await pending;
      assert.equal(Date.now() - started, 6000); assert.equal(calls, 2);
      assert.ok(signals.every(signal => !signal.aborted));
      assert.equal(main.t('btn.actions'), cached ? '缓存' : 'btn.actions');
      const before = renders;
      if (wbFirst) { secondary.resolve(response(wbPack('恢复概览'))); await flush(); }
      primary.resolve(response({ 'btn.actions': '恢复操作', 'wb.shared': '主包优先' })); await flush();
      if (!wbFirst) { secondary.resolve(response(wbPack('恢复概览'))); await flush(); }
      assert.equal(main.t('btn.actions'), '恢复操作'); assert.equal(main.t('wb.nav.overview'), '恢复概览');
      assert.equal(main.t('wb.shared'), '主包优先'); assert.ok(renders >= before + 2);
      const cachedPrimary = JSON.parse(saved.getItem(mainKey));
      assert.equal(cachedPrimary['btn.actions'], '恢复操作'); assert.equal('wb.nav.overview' in cachedPrimary, false);
    }
  }

  // A removed cached primary key reveals the latest already-loaded WB value.
  saved.values.clear();
  saved.setItem(mainKey, JSON.stringify({ 'btn.actions': '缓存', 'wb.shared': '旧主包' }));
  const replacedPrimary = deferred(), earlierWb = deferred();
  handler = url => url.includes('/wb.') ? earlierWb.promise : replacedPrimary.promise;
  const replaced = main.initI18n('zh', { deadline: Date.now() + 6000 });
  await advance(context, 6000); await replaced;
  earlierWb.resolve(response(wbPack('新版WB'))); await flush();
  assert.equal(main.t('wb.shared'), '旧主包');
  replacedPrimary.resolve(response({ 'btn.actions': '新版主包' })); await flush();
  assert.equal(main.t('wb.shared'), '新版WB');
  assert.equal('wb.shared' in JSON.parse(saved.getItem(mainKey)), false);

  // A late WB pack recovers even when the main pack never failed.
  saved.values.clear(); const lateWb = deferred(); let mainCalls = 0;
  handler = url => {
    if (url.includes('/wb.')) return lateWb.promise;
    mainCalls++; return Promise.resolve(response({ 'btn.actions': '操作' }));
  };
  const wbOnly = main.initI18n('zh', { deadline: Date.now() + 6000 });
  await advance(context, 0); await advance(context, 6000); await wbOnly;
  assert.equal(main.t('wb.nav.overview'), 'wb.nav.overview');
  lateWb.resolve(response(wbPack('迟到概览'))); await flush();
  assert.equal(main.t('wb.nav.overview'), '迟到概览'); assert.equal(mainCalls, 1);

  // Locale replacement invalidates both late packets before merge or cache write.
  saved.values.clear(); const oldMain = deferred(), oldWb = deferred();
  handler = url => url.endsWith('/zh.json') ? oldMain.promise : url.endsWith('/wb.zh.json') ? oldWb.promise
    : Promise.resolve(response(url.includes('/wb.') ? wbPack('English') : { 'btn.actions': 'Actions' }));
  const old = main.initI18n('zh', { deadline: Date.now() + 6000 });
  await advance(context, 6000); await old;
  await main.initI18n('en'); const beforeOld = renders;
  oldWb.resolve(response(wbPack('过期'))); oldMain.resolve(response({ 'btn.actions': '过期' })); await flush();
  assert.equal(main.t('btn.actions'), 'Actions'); assert.equal(main.t('wb.nav.overview'), 'English');
  assert.equal(saved.getItem(mainKey), null); assert.equal(saved.getItem(wbKey), null); assert.equal(renders, beforeOld);

  // Only actual thirty-second failures enter retries and the existing heal loop.
  saved.values.clear(); const failedSignals = []; let healthy = false;
  handler = (url, options) => {
    if (url.includes('/wb.')) return Promise.resolve(response(wbPack('概览')));
    if (healthy) return Promise.resolve(response({ 'btn.actions': '自愈' }));
    failedSignals.push(options.signal); return hung();
  };
  const failing = main.initI18n('zh', { deadline: Date.now() + 6000 });
  await advance(context, 6000); await failing;
  assert.equal(main.t('btn.actions'), 'btn.actions'); assert.equal(failedSignals[0].aborted, false);
  for (const ms of [24000, 400, 30000, 800, 30000]) await advance(context, ms);
  assert.equal(failedSignals.length, 3); assert.ok(failedSignals.every(signal => signal.aborted));
  healthy = true; await advance(context, 5000);
  assert.equal(main.t('btn.actions'), '自愈'); assert.equal(main.t('wb.nav.overview'), '概览');
});

test('UI deadline leaves work running and completed requests clear their timers', { timeout: 5000 }, async context => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const network = deferred(); let updated = false;
  const work = network.promise.then(() => { updated = true; });
  const waiting = waitUntilDeadline(work, Date.now() + 6000);
  await advance(context, 6000); await waiting; assert.equal(updated, false);
  network.resolve(); await flush(); assert.equal(updated, true);
  const completedSignal = await withRequestTimeout(async value => value, 30000);
  await advance(context, 30000); assert.equal(completedSignal.aborted, false);
});
