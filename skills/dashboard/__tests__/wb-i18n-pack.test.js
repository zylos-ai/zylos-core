import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWbPackLoader, validWbPack, WB_SENTINEL } from '../public/js/wb/i18n-wb.js';
import { storage, deferred } from './fixtures/workbench-dom.js';
const pack = value => ({ [WB_SENTINEL]: value, 'wb.sample': value });
const response = value => ({ ok: true, json: async () => value });

test('translation packs contain the same keys and sentinel', () => {
  const en = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.en.json', import.meta.url), 'utf8'));
  const zh = JSON.parse(fs.readFileSync(new URL('../public/i18n/wb.zh.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort()); assert.equal(validWbPack(en), true); assert.equal(validWbPack(zh), true);
});
test('translation loader preserves primary keys and replaces cached workbench values with fresh pack', async () => {
  const saved = storage({ 'zylos-dashboard-i18n-wb-en': JSON.stringify(pack('cached')) });
  const network = deferred(), translations = { [WB_SENTINEL]: 'Primary' }, seen = [];
  const load = createWbPackLoader({ storage: saved, fetch: () => network.promise });
  const pending = load('en', { translations, onMerge: () => seen.push(translations['wb.sample']) });
  assert.equal(translations['wb.sample'], 'cached'); network.resolve(response(pack('fresh'))); await pending;
  assert.equal(translations[WB_SENTINEL], 'Primary'); assert.equal(translations['wb.sample'], 'fresh'); assert.equal(seen.length, 2);
});
test('translation failures retry three times with no-store and warn once without changing primary', async () => {
  let calls = 0, warnings = 0; const delays = [], translations = { 'btn.actions': 'Actions' };
  const load = createWbPackLoader({ storage: storage(), fetch: async (url, options) => {
    calls++; assert.equal(url, '/assets/i18n/wb.en.json'); assert.equal(options.cache, 'no-store'); return { ok: false };
  }, warn: () => warnings++, sleep: async delay => delays.push(delay) });
  await load('en', { assetRoot: '/assets', translations }); assert.equal(calls, 3); assert.equal(warnings, 1);
  assert.deepEqual(delays, [400, 800]); assert.equal(translations['btn.actions'], 'Actions'); assert.equal(translations[WB_SENTINEL] ?? WB_SENTINEL, WB_SENTINEL);
});
test('translation loader rejects proxy JSON without sentinel and never caches it', async () => {
  const saved = storage(); let warnings = 0;
  const load = createWbPackLoader({ storage: saved, fetch: async () => response({ html: 'login' }), sleep: async () => {}, warn: () => warnings++ });
  await load('en'); assert.equal(saved.getItem('zylos-dashboard-i18n-wb-en'), null); assert.equal(warnings, 1);
  assert.equal(validWbPack([]), false); assert.equal(validWbPack(null), false); assert.equal(validWbPack(new Date()), false);
});
test('translation loader retains valid cache through network failure without warning', async () => {
  const translations = {}, saved = storage({ 'zylos-dashboard-i18n-wb-zh': JSON.stringify(pack('缓存')) }); let warnings = 0;
  const load = createWbPackLoader({ storage: saved, fetch: async () => { throw Error('offline'); }, sleep: async () => {}, warn: () => warnings++ });
  await load('zh', { translations }); assert.equal(translations['wb.sample'], '缓存'); assert.equal(warnings, 0);
});
test('translation loader discards late responses from the previous locale', async () => {
  const zh = deferred(), en = deferred(), translations = {}, saved = storage();
  const load = createWbPackLoader({ storage: saved, fetch: url => url.includes('.zh.') ? zh.promise : en.promise });
  const old = load('zh', { translations }), current = load('en', { translations });
  en.resolve(response(pack('English'))); await current; zh.resolve(response(pack('中文'))); await old;
  assert.equal(translations['wb.sample'], 'English'); assert.equal(saved.getItem('zylos-dashboard-i18n-wb-zh'), null);
});
test('translation loader cancellation invalidates an in-flight response before main locale fetch completes', async () => {
  const pending = deferred(), translations = {}, saved = storage();
  const load = createWbPackLoader({ storage: saved, fetch: () => pending.promise });
  const work = load('zh', { translations }); load.cancel(); pending.resolve(response(pack('old'))); await work;
  assert.equal(translations['wb.sample'], undefined); assert.equal(saved.getItem('zylos-dashboard-i18n-wb-zh'), null);
});
test('translation loader tolerates storage writes failing after a fresh pack', async () => {
  const translations = {};
  const load = createWbPackLoader({ storage: { getItem() { throw Error('blocked'); }, setItem() { throw Error('blocked'); } }, fetch: async () => response(pack('ok')) });
  await load('en', { translations }); assert.equal(translations['wb.sample'], 'ok');
});

// Actual main+workbench pack integration with in-memory storage, fetch and timers.
// Run when either loader/merge/heal wiring changes; skip changes outside that boundary.
// No browser, server or process is started. The runner must isolate HOME, ZYLOS_DIR,
// PM2_HOME, short TMPDIR and a private tmux namespace, read back actual paths before
// running, then clean up isolated resources; teardown restores all mocked globals.
test('main translation healing keeps its cache primary-only and restores workbench labels', async context => {
  const saved = storage(); let mainCalls = 0, workbenchCalls = 0;
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const advance = async ms => {
    context.mock.timers.tick(ms);
    for (let i = 0; i < 30; i++) await Promise.resolve();
  };
  context.mock.method(globalThis, 'fetch', async url => {
    if (url.endsWith('/i18n/en.json')) {
      mainCalls++; return mainCalls <= 3 ? { ok: false, status: 404 } : response({ 'btn.actions': 'Actions' });
    }
    assert.equal(url, '/fixture/i18n/wb.en.json'); workbenchCalls++;
    return response(pack(workbenchCalls === 1 ? 'cached-era' : 'fresh'));
  });
  const globals = { localStorage: saved, document: { documentElement: {}, querySelectorAll: () => [], dispatchEvent() {} } };
  for (const [key, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    context.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else Reflect.deleteProperty(globalThis, key); });
  }
  const main = await import('../public/js/i18n.js?workbench-heal');
  main.setAssetRoot('/fixture'); const pending = main.initI18n('en');
  await advance(0); await advance(400); await advance(800); await pending;
  assert.equal(main.t('wb.sample'), 'cached-era');
  await advance(5000);
  assert.equal(main.t('btn.actions'), 'Actions'); assert.equal(main.t('wb.sample'), 'fresh');
  const cachedPrimary = JSON.parse(saved.getItem('zylos-dashboard-i18n-en'));
  assert.equal(cachedPrimary['btn.actions'], 'Actions'); assert.equal('wb.sample' in cachedPrimary, false);
});
