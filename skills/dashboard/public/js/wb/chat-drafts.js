const PREFIX = 'zylos-dashboard-form-draft:';
export const MAX_DRAFTS = 64;
export const MAX_DRAFT_BYTES = 16 * 1024;
const PARTS = ['authRoot', 'instance', 'conversationId', 'messageId', 'blockId', 'schemaVersion'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

function scopeParts(scope) {
  if (!scope || PARTS.some(key => !own(scope, key) || !['string', 'number'].includes(typeof scope[key]) || String(scope[key]).length === 0)) return null;
  return PARTS.map(key => String(scope[key]));
}
function recordKey(scope) {
  const parts = scopeParts(scope);
  return parts ? PREFIX + JSON.stringify(parts) : null;
}
function keyScope(key) {
  try {
    const parts = JSON.parse(key.slice(PREFIX.length));
    if (!Array.isArray(parts) || parts.length !== PARTS.length || parts.some(part => typeof part !== 'string' || !part)) return null;
    return Object.fromEntries(PARTS.map((name, i) => [name, parts[i]]));
  } catch { return null; }
}
function readRecord(storage, key) {
  if (!key?.startsWith(PREFIX)) return null;
  try {
    const record = JSON.parse(storage.getItem(key));
    if (!record || recordKey(record.scope) !== key || !Number.isFinite(record.editedAt) ||
        !record.values || typeof record.values !== 'object' || Array.isArray(record.values)) return null;
    return record;
  } catch { return null; }
}

/** Editable values only; stored data never supplies question/action authority. */
export function createDraftStore({ storage = () => globalThis.sessionStorage, now = Date.now } = {}) {
  const getStorage = () => typeof storage === 'function' ? storage() : storage;
  const keys = target => {
    const result = [];
    for (let i = 0; i < target.length; i += 1) {
      const key = target.key(i);
      if (key?.startsWith(PREFIX)) result.push(key);
    }
    return result;
  };
  function removeMatching(match) {
    try {
      const target = getStorage();
      for (const key of keys(target)) {
        const scope = keyScope(key);
        if (scope && match(scope)) target.removeItem(key);
      }
      return true;
    } catch { return false; }
  }
  function loadEditable(scope) {
    try {
      const key = recordKey(scope);
      if (!key) return null;
      const target = getStorage(), raw = target.getItem(key);
      if (raw === null || new TextEncoder().encode(raw).byteLength > MAX_DRAFT_BYTES) return null;
      const record = readRecord(target, key);
      return record ? { values: record.values, freeText: typeof record.freeText === 'string' ? record.freeText : '' } : null;
    } catch { return null; }
  }
  return {
    loadEditable,
    load(scope) {
      return loadEditable(scope)?.values ?? null;
    },
    save(scope, values, { freeText } = {}) {
      const key = recordKey(scope);
      if (!key || !values || typeof values !== 'object' || Array.isArray(values) || freeText !== undefined && typeof freeText !== 'string') return { saved: false, reason: 'invalid' };
      let serialized;
      const record = { scope, editedAt: now(), values, ...(freeText === undefined ? {} : { freeText }) };
      try { serialized = JSON.stringify(record); }
      catch { return { saved: false, reason: 'invalid' }; }
      if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_BYTES) return { saved: false, reason: 'oversize' };
      try {
        const target = getStorage();
        const previous = keys(target).map(entryKey => readRecord(target, entryKey)).filter(Boolean);
        record.editedAt = previous.reduce((latest, entry) => Math.max(latest, entry.editedAt + 1), record.editedAt);
        serialized = JSON.stringify(record);
        if (new TextEncoder().encode(serialized).byteLength > MAX_DRAFT_BYTES) return { saved: false, reason: 'oversize' };
        // Write first: a quota/write failure must not evict another editable draft.
        target.setItem(key, serialized);
        const records = keys(target).map(entryKey => ({ key: entryKey, record: readRecord(target, entryKey) }));
        for (const entry of records.filter(entry => !entry.record)) target.removeItem(entry.key);
        const valid = records.filter(entry => entry.record).sort((a, b) => a.record.editedAt - b.record.editedAt || a.key.localeCompare(b.key));
        for (let i = 0; i < valid.length - MAX_DRAFTS; i += 1) target.removeItem(valid[i].key);
        return { saved: true };
      } catch { return { saved: false, reason: 'storage' }; }
    },
    remove(scope) {
      try { const key = recordKey(scope); if (key) getStorage().removeItem(key); return true; }
      catch { return false; }
    },
    clearInstance: ({ authRoot, instance }) => removeMatching(scope => scope.authRoot === authRoot && scope.instance === instance),
    clearAuthRoot: authRoot => removeMatching(scope => scope.authRoot === authRoot),
  };
}

export const browserDraftStore = createDraftStore();
const normalizeBase = base => String(base || '').replace(/\/+$/, '');
export function draftAuthRoot(location, base = '') {
  const parent = normalizeBase(base).replace(/\/fleet\/[^/]+$/, '');
  return new URL(parent || '/', location.origin).href.replace(/\/$/, '');
}
export function draftInstance(authRoot, target) {
  return !target ? authRoot : `${authRoot}/fleet/${encodeURIComponent(target)}`;
}
export function draftResetCookieName(base = '') {
  return `zylos_dashboard_draft_reset_${encodeURIComponent(normalizeBase(base))}`;
}

/** A success-only, noncredential marker also covers native login form navigation. */
export function consumeDraftReset({ document, location, base = '', store = browserDraftStore }) {
  const authRoot = draftAuthRoot(location, base), rootBase = new URL(authRoot).pathname.replace(/\/$/, '');
  const name = draftResetCookieName(rootBase);
  const pending = document.cookie.split(';').some(item => item.trim() === `${name}=1`);
  if (!pending) return false;
  const cleared = store.clearAuthRoot(authRoot);
  // Retain the marker if storage is unavailable so a later restore still clears.
  if (cleared) document.cookie = `${name}=; SameSite=Strict; Path=${rootBase || '/'}; Max-Age=0`;
  return true;
}

/** Retry the login cleanup immediately before every restore, including delayed storage access. */
export function createDraftRestoreStore({ document, location, base = '', store = browserDraftStore }) {
  const authRoot = draftAuthRoot(location, base), rootBase = new URL(authRoot).pathname.replace(/\/$/, '');
  const name = draftResetCookieName(rootBase);
  const ready = () => {
    consumeDraftReset({ document, location, base, store });
    return !document.cookie.split(';').some(item => item.trim() === `${name}=1`);
  };
  return { ...store,
    load: scope => ready() ? store.load(scope) : null,
    loadEditable: scope => ready() ? (store.loadEditable ? store.loadEditable(scope) : (() => { const values = store.load(scope); return values ? { values, freeText: '' } : null; })()) : null,
  };
}

export function createDraftAuth({ authRoot, store = browserDraftStore, fetch: fetcher = globalThis.fetch, onClear = () => {} }) {
  function clear(instance) {
    if (instance === undefined) store.clearAuthRoot(authRoot);
    else store.clearInstance({ authRoot, instance });
    onClear({ authRoot, ...(instance === undefined ? {} : { instance }) });
  }
  const targetFor = input => {
    try {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, authRoot + '/');
      const root = new URL(authRoot);
      if (url.origin !== root.origin) return null;
      const base = root.pathname.replace(/\/$/, '');
      if (base && url.pathname !== base && !url.pathname.startsWith(base + '/')) return null;
      const suffix = url.pathname.slice(base.length);
      const fleet = suffix.match(/^\/fleet\/([^/]+)(?:\/|$)/);
      return fleet ? draftInstance(authRoot, decodeURIComponent(fleet[1])) : authRoot;
    } catch { return null; }
  };
  return {
    clear,
    async fetch(input, options) {
      const instance = targetFor(input);
      const response = await fetcher(input, options);
      if (response.status === 401 && instance !== null) clear(instance);
      return response;
    },
  };
}
