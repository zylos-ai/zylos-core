import { withRequestTimeout, waitUntilDeadline } from './request-timeout.js?v=2';
import { initWbPack } from './wb/i18n-wb.js?v=86';
const SUPPORTED = ['en', 'zh'];
const STORAGE_KEY = 'zylos-dashboard-locale';
const PACK_CACHE_PREFIX = 'zylos-dashboard-i18n-';
// A key every locale pack contains; rejects proxy/captive-portal JSON that
// would otherwise silently replace the pack and render raw keys (#208).
const SENTINEL_KEY = 'btn.actions';
const FETCH_ATTEMPTS = 3;
const RETRY_BASE_MS = 400;
const REQUEST_TIMEOUT_MS = 30000;
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
  let stored; try { stored = localStorage.getItem(STORAGE_KEY); } catch {}
  if (SUPPORTED.includes(stored)) return stored;
  return navigator.language?.startsWith('zh') ? 'zh' : 'en';
}

export function isValidPack(pack) {
  return Boolean(pack) && typeof pack === 'object' && !Array.isArray(pack) &&
    typeof pack[SENTINEL_KEY] === 'string';
}

async function fetchPack(locale) {
  return withRequestTimeout(async signal => {
    const resp = await fetch(`${assetRoot}/i18n/${locale}.json`, { cache: 'no-store', signal });
    if (!resp.ok) throw new Error(`i18n fetch ${resp.status}`);
    const pack = await resp.json();
    if (!isValidPack(pack)) throw new Error('i18n pack invalid');
    return pack;
  }, REQUEST_TIMEOUT_MS);
}

async function fetchPackWithRetry(locale, seq) {
  let lastErr;
  for (let i = 0; i < FETCH_ATTEMPTS; i++) {
    try {
      return await fetchPack(locale);
    } catch (err) {
      lastErr = err;
      if (seq !== requestSeq) throw err;
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
function scheduleHeal(locale, seq, applyPrimary, refreshWb) {
  let attempts = 0;
  const tick = async () => {
    if (seq !== requestSeq) return;
    attempts++;
    try {
      const pack = await fetchPack(locale);
      if (seq !== requestSeq) return;
      applyPrimary(pack);
      await refreshWb();
    } catch {
      if (seq === requestSeq && attempts < HEAL_MAX_ATTEMPTS) healTimer = setTimeout(tick, HEAL_INTERVAL_MS);
    }
  };
  healTimer = setTimeout(tick, HEAL_INTERVAL_MS);
}

export async function initI18n(locale, { deadline = Infinity } = {}) {
  const targetLocale = resolveLocale(locale);
  const seq = ++requestSeq;
  currentLocale = targetLocale;
  try { localStorage.setItem(STORAGE_KEY, targetLocale); } catch {}
  document.documentElement.lang = targetLocale;
  clearTimeout(healTimer);
  initWbPack.cancel();
  // Keep the rendered object stable while either pack can still arrive late.
  let primaryPack = readCachedPack(targetLocale) || {}, wbPack = {};
  const targetTranslations = translations = {};
  const projectPacks = () => {
    for (const key of Object.keys(targetTranslations)) delete targetTranslations[key];
    Object.assign(targetTranslations, wbPack, primaryPack);
  };
  projectPacks();
  const applyPrimary = pack => {
    if (seq !== requestSeq) return;
    primaryPack = pack;
    projectPacks();
    writeCachedPack(targetLocale, pack);
    renderI18n();
  };
  const loadWb = (waitDeadline = Infinity) => initWbPack(targetLocale, {
    assetRoot, translations: targetTranslations, deadline: waitDeadline,
    onMerge: pack => {
      if (seq !== requestSeq) return;
      wbPack = pack;
      projectPacks();
      renderI18n();
    }
  });
  const mainWork = (async () => {
    try {
      const pack = await fetchPackWithRetry(targetLocale, seq);
      applyPrimary(pack);
    } catch {
      // Actual request failures retain the existing cache and healing policy.
      if (seq === requestSeq) scheduleHeal(targetLocale, seq, applyPrimary, loadWb);
    }
  })();
  const wbWork = loadWb(deadline);
  await Promise.all([waitUntilDeadline(mainWork, deadline), wbWork]);
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
  document.dispatchEvent?.(new Event('dashboard-locale-change'));
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
}
