import { withRequestTimeout, waitUntilDeadline } from '../request-timeout.js?v=2';
const REQUEST_TIMEOUT_MS = 30000;
export const WB_SENTINEL = 'wb.nav.overview';
export const validWbPack = pack => pack !== null && typeof pack === 'object' &&
  [Object.prototype, null].includes(Object.getPrototypeOf(pack)) && typeof pack[WB_SENTINEL] === 'string';
export function createWbPackLoader({ fetch = globalThis.fetch, storage = globalThis.localStorage,
  warn = console.warn, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let seq = 0;
  const primaryKeys = new WeakMap();
  const load = async function initWbPack(locale, { assetRoot = '', translations = {}, deadline = Infinity, onMerge = () => {} } = {}) {
    const current = ++seq, cacheKey = 'zylos-dashboard-i18n-wb-' + locale;
    if (!primaryKeys.has(translations)) primaryKeys.set(translations, new Set(Object.keys(translations)));
    const primary = primaryKeys.get(translations);
    const merge = pack => {
      for (const [key, value] of Object.entries(pack)) if (!primary.has(key)) translations[key] = value;
      onMerge(pack);
    };
    let cached;
    try { cached = JSON.parse(storage.getItem(cacheKey)); } catch {}
    const hasCache = validWbPack(cached);
    if (hasCache) merge(cached);
    const work = (async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const pack = await withRequestTimeout(async signal => {
            const response = await fetch(`${assetRoot}/i18n/wb.${locale}.json`, { cache: 'no-store', signal });
            if (!response.ok) throw Error('pack');
            const pack = await response.json();
            if (!validWbPack(pack)) throw Error('pack');
            return pack;
          }, REQUEST_TIMEOUT_MS);
          if (current !== seq) return;
          merge(pack);
          try { storage.setItem(cacheKey, JSON.stringify(pack)); } catch {}
          return;
        } catch {
          if (current !== seq) return;
          if (attempt < 2) await sleep(400 * (attempt + 1));
        }
      }
      if (!hasCache) warn('Workbench translations unavailable');
    })();
    await waitUntilDeadline(work, deadline);
  };
  load.cancel = () => { seq++; };
  return load;
}
export const initWbPack = createWbPackLoader();
