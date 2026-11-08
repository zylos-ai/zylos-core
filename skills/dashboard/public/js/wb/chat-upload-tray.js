const SEND_WINDOW_MS = 25 * 60 * 1000;
const CONFIG_REQUEST_TIMEOUT_MS = 120000;
const scopeKey = scope => scope && typeof scope.instance === 'string' && scope.instance
  && ['string', 'number'].includes(typeof scope.conversationId) && String(scope.conversationId)
  ? JSON.stringify([scope.instance, String(scope.conversationId)]) : null;

/** Pending uploads belong to an instance and local conversation, never browser storage. */
export function createUploadTray({ fetch: read = globalThis.fetch,
  createXHR = () => new globalThis.XMLHttpRequest(), createFormData = () => new globalThis.FormData(),
  url = globalThis.URL, now = Date.now, onChange = () => {}, onUnauthorized = () => {},
  setTimeout: later = globalThis.setTimeout, clearTimeout: cancel = globalThis.clearTimeout } = {}) {
  const trays = new Map();
  let current = null, sequence = 0, expiryTimer = null, destroyed = false;
  const notify = () => { if (!destroyed) onChange(snapshot()); };
  const active = () => trays.get(current);
  function live(tray) { return !destroyed && trays.get(tray.key) === tray; }
  function expire() {
    let changed = false;
    for (const tray of trays.values()) for (const item of tray.items) {
      if (item.status === 'ready' && item.expiresAt <= now()) {
        item.status = 'expired'; item.error = 'chat_attachment_expired'; changed = true;
      }
    }
    scheduleExpiry();
    return changed;
  }
  function scheduleExpiry() {
    if (expiryTimer !== null) cancel(expiryTimer);
    expiryTimer = null;
    if (destroyed) return;
    let next = Infinity;
    for (const tray of trays.values()) for (const item of tray.items) {
      if (item.status === 'ready') next = Math.min(next, item.expiresAt);
    }
    if (Number.isFinite(next)) {
      expiryTimer = later(() => { expiryTimer = null; if (expire()) notify(); }, Math.max(1, Math.min(2147483647, next - now())));
      expiryTimer?.unref?.();
    }
  }
  function snapshot() {
    expire();
    const tray = active();
    return { scope: tray ? { ...tray.scope } : null, items: (tray?.items || []).map(item => ({
      localId: item.localId, id: item.id, name: item.name, size: item.size, mime: item.mime, kind: item.kind,
      status: item.status, progress: item.progress, error: item.error, previewUrl: item.previewUrl,
      expiresAt: item.expiresAt, revision: item.revision
    })), config: tray?.config ? { ...tray.config } : null, configStatus: tray?.configStatus || 'idle', error: tray?.error || null };
  }
  function release(item) {
    const stop = item.stop; item.stop = null; stop?.();
    if (item.previewUrl) { url.revokeObjectURL(item.previewUrl); item.previewUrl = null; }
    item.file = null;
  }
  function clear(match = null, { silent = false } = {}) {
    let changed = false;
    for (const [key, tray] of trays) {
      if (match && (match.instance !== undefined && match.instance !== tray.scope.instance
        || match.conversationId !== undefined && String(match.conversationId) !== tray.scope.conversationId)) continue;
      trays.delete(key); changed = true;
      if (tray.configTimer !== null && tray.configTimer !== undefined) cancel(tray.configTimer);
      tray.configTimer = null; tray.configAbort?.abort();
      for (const item of tray.items) release(item);
      tray.items = [];
    }
    if (current !== null && !trays.has(current)) { current = null; changed = true; }
    if (changed) { scheduleExpiry(); if (!silent) notify(); }
    return changed;
  }
  function clearForAuthentication(match = null) {
    const selected = active();
    const failed = selected && (!match || (match.instance === undefined || match.instance === selected.scope.instance)
      && (match.conversationId === undefined || String(match.conversationId) === selected.scope.conversationId)) ? selected : null;
    const changed = clear(match, { silent: true });
    if (failed) {
      // Keep an empty failed configuration so an authentication redraw cannot replay a denied read.
      trays.set(failed.key, { key: failed.key, scope: { ...failed.scope }, uploadsUrl: failed.uploadsUrl,
        items: [], configStatus: 'failed', error: failed.uploadAttempted ? 'chat_upload_config_failed' : null,
        uploadAttempted: !!failed.uploadAttempted });
      current = failed.key;
    }
    if (changed) notify();
  }
  function unauthorized(tray) {
    clearForAuthentication({ instance: tray.scope.instance });
    onUnauthorized({ ...tray.scope });
  }
  function ensureConfig(tray) {
    if (tray.config) return Promise.resolve(tray.config);
    if (tray.loading) return tray.loading;
    const version = tray.configVersion = (tray.configVersion || 0) + 1;
    const configLive = () => live(tray) && tray.configVersion === version;
    const controller = new AbortController(); tray.configAbort = controller;
    const timeout = later(() => controller.abort(), CONFIG_REQUEST_TIMEOUT_MS); timeout?.unref?.(); tray.configTimer = timeout;
    tray.configStatus = 'loading'; tray.error = null;
    tray.loading = (async () => {
      try {
        const response = await read(tray.uploadsUrl + '/config', { cache: 'no-store', signal: controller.signal });
        if (!configLive()) return null;
        if (response.status === 401) { unauthorized(tray); return null; }
        if (!response.ok) throw Error('chat_upload_config_failed');
        const config = await response.json();
        if (!configLive()) return null;
        if (!Number.isSafeInteger(config.maxUploadBytes) || config.maxUploadBytes <= 0
          || !Number.isSafeInteger(config.maxAttachments) || config.maxAttachments <= 0) throw Error('chat_upload_config_failed');
        tray.config = { maxUploadBytes: config.maxUploadBytes, maxAttachments: Math.min(20, config.maxAttachments) };
        tray.configStatus = 'ready'; return tray.config;
      } catch {
        if (configLive()) { tray.configStatus = 'failed'; tray.error = tray.uploadAttempted ? 'chat_upload_config_failed' : null; }
        return null;
      } finally {
        cancel(timeout);
        if (configLive()) { tray.configTimer = null; tray.configAbort = null; tray.loading = null; notify(); }
      }
    })();
    notify(); return tray.loading;
  }
  function setScope(scope) {
    if (destroyed) return Promise.resolve(null);
    const key = scopeKey(scope);
    if (!key || typeof scope.uploadsUrl !== 'string' || !scope.uploadsUrl) {
      if (current !== null) { current = null; notify(); }
      return Promise.resolve(null);
    }
    let tray = trays.get(key);
    if (current === key && tray) return tray.configStatus === 'idle' ? ensureConfig(tray) : tray.loading || Promise.resolve(tray.config || null);
    current = key;
    if (!tray) {
      tray = { key, scope: { instance: scope.instance, conversationId: String(scope.conversationId) },
        uploadsUrl: scope.uploadsUrl.replace(/\/+$/, ''), items: [], configStatus: 'idle', error: null };
      trays.set(key, tray);
    }
    notify(); return ensureConfig(tray);
  }
  function moveScope(from, to) {
    const oldKey = scopeKey(from), newKey = scopeKey(to), tray = trays.get(oldKey);
    if (!tray || !newKey || from.instance !== to.instance || typeof to.uploadsUrl !== 'string' || !to.uploadsUrl
      || tray.items.some(item => item.status === 'uploading') || trays.get(newKey)?.items.length) return false;
    if (oldKey === newKey) return true;
    const target = trays.get(newKey);
    if (target) {
      trays.delete(newKey);
      if (target.configTimer !== null && target.configTimer !== undefined) cancel(target.configTimer);
      target.configTimer = null; target.configAbort?.abort();
    }
    if (tray.configTimer !== null && tray.configTimer !== undefined) cancel(tray.configTimer);
    tray.configTimer = null; tray.configAbort?.abort(); tray.configVersion = (tray.configVersion || 0) + 1;
    tray.configAbort = null; tray.loading = null; tray.configStatus = tray.config ? 'ready' : 'idle';
    trays.delete(oldKey); tray.key = newKey;
    tray.scope = { instance: to.instance, conversationId: String(to.conversationId) };
    tray.uploadsUrl = to.uploadsUrl.replace(/\/+$/, ''); trays.set(newKey, tray);
    if (current === oldKey) current = newKey;
    notify(); return true;
  }
  function upload(tray, item) {
    item.revision += 1; const revision = item.revision, startedAt = now();
    item.status = 'uploading'; item.progress = 0; item.error = null; item.id = null; item.expiresAt = null;
    let xhr;
    const listeners = [];
    const listen = (target, type, fn) => { target.addEventListener(type, fn); listeners.push([target, type, fn]); };
    const cleanup = () => { for (const [target, type, fn] of listeners) target.removeEventListener(type, fn); listeners.length = 0; item.stop = null; };
    const exists = () => live(tray) && tray.items.includes(item) && item.revision === revision;
    const fail = error => { cleanup(); if (exists()) { item.status = 'failed'; item.error = error; notify(); } };
    try {
      xhr = createXHR(); xhr.open('POST', tray.uploadsUrl);
      listen(xhr.upload, 'progress', event => {
        if (exists() && event.lengthComputable && event.total > 0) {
          item.progress = Math.max(0, Math.min(100, Math.round(event.loaded / event.total * 100))); notify();
        }
      });
      listen(xhr, 'load', () => {
        cleanup(); if (!exists()) return;
        if (xhr.status === 401) { unauthorized(tray); return; }
        let result;
        try { result = JSON.parse(xhr.responseText); } catch { /* A lost or invalid response does not identify a ready upload. */ }
        if (xhr.status < 200 || xhr.status >= 300 || !result || typeof result.id !== 'string' || !result.id
          || typeof result.name !== 'string' || !Number.isSafeInteger(result.size) || result.size < 0
          || !['image', 'file'].includes(result.kind)) {
          item.status = 'failed'; item.error = typeof result?.error === 'string' ? result.error : 'chat_upload_failed'; notify(); return;
        }
        Object.assign(item, { id: result.id, name: result.name, size: result.size, mime: typeof result.mime === 'string' ? result.mime : '',
          kind: result.kind, progress: 100,
          // The HTTP API may omit expiresAt. Counting from upload start is conservative about time in transit.
          expiresAt: Number.isFinite(result.expiresAt) ? result.expiresAt : startedAt + SEND_WINDOW_MS,
          status: 'ready', error: null });
        expire(); notify();
      });
      listen(xhr, 'error', () => fail('chat_upload_unknown'));
      listen(xhr, 'timeout', () => fail('chat_upload_unknown'));
      listen(xhr, 'abort', () => fail('chat_upload_interrupted'));
      item.stop = () => { cleanup(); xhr.abort(); };
      const body = createFormData(); body.append('file', item.file, item.name);
      xhr.send(body);
    } catch { cleanup(); xhr?.abort(); fail('chat_upload_failed'); }
    notify();
  }
  async function acceptFiles(files) {
    const tray = active();
    if (!tray || destroyed) return { accepted: [], rejected: [], error: 'chat_upload_unavailable' };
    tray.uploadAttempted = true;
    const config = await ensureConfig(tray);
    if (!config || !live(tray)) return { accepted: [], rejected: [], error: 'chat_upload_config_failed' };
    const accepted = [], rejected = [];
    for (const file of files || []) {
      // Bound feedback for a potentially large selection, including rejected oversized files.
      if (accepted.length + rejected.length >= 21) break;
      if (tray.items.length >= config.maxAttachments) { rejected.push({ error: 'chat_attachment_too_many' }); break; }
      if (!(file instanceof Blob) || !Number.isSafeInteger(file.size)) { rejected.push({ error: 'chat_upload_invalid_file' }); break; }
      if (file.size > config.maxUploadBytes) { rejected.push({ name: file.name || 'attachment', error: 'chat_attachment_too_large' }); continue; }
      const item = { localId: 'upload-' + ++sequence, file, name: file.name || 'attachment', size: file.size,
        mime: file.type || '', kind: file.type?.startsWith('image/') ? 'image' : 'file', revision: 0, previewUrl: null };
      if (item.kind === 'image') { try { item.previewUrl = url.createObjectURL(file); } catch { /* Filename remains available when a local preview cannot be allocated. */ } }
      tray.items.push(item); accepted.push(item.localId); upload(tray, item);
    }
    tray.error = rejected[0]?.error || null; notify(); return { accepted, rejected };
  }
  function remove(localId) {
    const tray = active(), item = tray?.items.find(entry => entry.localId === localId);
    if (!item) return false;
    tray.items = tray.items.filter(entry => entry !== item); release(item); tray.error = null;
    scheduleExpiry(); notify(); return true;
  }
  function retry(localId) {
    const tray = active(), item = tray?.items.find(entry => entry.localId === localId);
    if (!item || !['failed', 'expired'].includes(item.status) || !item.file || destroyed) return false;
    upload(tray, item); return true;
  }
  function capture() {
    expire(); const tray = active();
    const items = (tray?.items || []).filter(item => item.status === 'ready').map(({ localId, id, revision }) => ({ localId, id, revision }));
    return { scope: tray ? { ...tray.scope } : null, items, ids: items.map(item => item.id) };
  }
  function completeStored(captured) {
    const tray = trays.get(scopeKey(captured?.scope)); if (!tray) return;
    for (const capturedItem of captured.items || []) {
      const item = tray.items.find(entry => entry.localId === capturedItem.localId && entry.id === capturedItem.id && entry.revision === capturedItem.revision);
      if (!item) continue;
      tray.items = tray.items.filter(entry => entry !== item); release(item);
    }
    scheduleExpiry(); notify();
  }
  return { setScope, moveScope, snapshot, acceptFiles, remove, retry, capture, completeStored, clear, clearForAuthentication,
    readyIDs: () => capture().ids,
    isSendable(text = '') { expire(); const items = active()?.items || []; return !destroyed && !!active()
      && !items.some(item => item.status === 'uploading') && (!!String(text).trim() || items.some(item => item.status === 'ready')); },
    destroy() { destroyed = true; clear(); if (expiryTimer !== null) cancel(expiryTimer); expiryTimer = null; }
  };
}
