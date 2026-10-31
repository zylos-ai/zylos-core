const SUPPORTED = ['en', 'zh'];
const STORAGE_KEY = 'zylos-dashboard-locale';
const PACK_CACHE_PREFIX = 'zylos-dashboard-i18n-';
// A key every locale pack contains; rejects proxy/captive-portal JSON that
// would otherwise silently replace the pack and render raw keys (#208).
const SENTINEL_KEY = 'btn.actions';
const FETCH_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const HEAL_INTERVAL_MS = 5000;
const HEAL_MAX_ATTEMPTS = 6;

let currentLocale = 'en';
let translations = {};
let assetRoot = '';
let healTimer = null;
// Bumped by every initI18n call; async continuations compare against it so a
// slow stale request can never overwrite a newer locale's pack or cache.
let requestSeq = 0;

export function setAssetRoot(root) { assetRoot = root; }
export function getLocale() { return currentLocale; }

export function resolveLocale(explicit) {
  if (SUPPORTED.includes(explicit)) return explicit;
  const stored = localStorage.getItem(STORAGE_KEY);
  if (SUPPORTED.includes(stored)) return stored;
  return navigator.language?.startsWith('zh') ? 'zh' : 'en';
}

export function isValidPack(pack) {
  return Boolean(pack) && typeof pack === 'object' && !Array.isArray(pack) &&
    typeof pack[SENTINEL_KEY] === 'string';
}

async function fetchPack(locale) {
  const resp = await fetch(`${assetRoot}/i18n/${locale}.json`, { cache: 'no-store' });
  if (!resp.ok) throw new Error(`i18n fetch ${resp.status}`);
  const pack = await resp.json();
  if (!isValidPack(pack)) throw new Error('i18n pack invalid');
  return pack;
}

async function fetchPackWithRetry(locale) {
  let lastErr;
  for (let i = 0; i < FETCH_ATTEMPTS; i++) {
    try {
      return await fetchPack(locale);
    } catch (err) {
      lastErr = err;
      if (i < FETCH_ATTEMPTS - 1) await new Promise(r => setTimeout(r, RETRY_BASE_MS * (i + 1)));
    }
  }
  throw lastErr;
}

function readCachedPack(locale) {
  try {
    const pack = JSON.parse(localStorage.getItem(PACK_CACHE_PREFIX + locale));
    return isValidPack(pack) ? pack : null;
  } catch {
    return null;
  }
}

function writeCachedPack(locale, pack) {
  try {
    localStorage.setItem(PACK_CACHE_PREFIX + locale, JSON.stringify(pack));
  } catch {
    // Storage unavailable (private mode / quota) — the cache is best-effort.
  }
}

// Late recovery: keep retrying in the background and re-render static labels
// once a fresh pack lands, so a transient failure heals without a manual
// refresh. Dynamic regions already re-render on their own timers.
function scheduleHeal(locale, seq) {
  let attempts = 0;
  const tick = async () => {
    if (seq !== requestSeq) return;
    attempts++;
    try {
      const pack = await fetchPack(locale);
      if (seq !== requestSeq) return;
      translations = pack;
      writeCachedPack(locale, pack);
      renderI18n();
    } catch {
      if (attempts < HEAL_MAX_ATTEMPTS) healTimer = setTimeout(tick, HEAL_INTERVAL_MS);
    }
  };
  healTimer = setTimeout(tick, HEAL_INTERVAL_MS);
}

export async function initI18n(locale) {
  const targetLocale = resolveLocale(locale);
  const seq = ++requestSeq;
  currentLocale = targetLocale;
  localStorage.setItem(STORAGE_KEY, targetLocale);
  document.documentElement.lang = targetLocale;
  clearTimeout(healTimer);
  try {
    const pack = await fetchPackWithRetry(targetLocale);
    if (seq !== requestSeq) return; // superseded by a newer call while fetching
    translations = pack;
    writeCachedPack(targetLocale, pack);
  } catch {
    // Never throw: a failed pack fetch must not kill app startup (top-level
    // await). Fall back to the last good pack — stale text beats raw keys.
    if (seq !== requestSeq) return;
    translations = readCachedPack(targetLocale) || {};
    scheduleHeal(targetLocale, seq);
  }
}

export function t(key, params = {}) {
  let text = translations[key] || key;
  for (const [k, v] of Object.entries(params)) {
    text = text.replaceAll(`{${k}}`, v ?? '');
  }
  return text;
}

export function renderI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}
