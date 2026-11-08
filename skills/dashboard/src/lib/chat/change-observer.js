const invalid = code => Object.assign(new Error(code), { code, statusCode: 400 });

export function normalizeChatSubscription({ tab = 'mine', conversationId = null, ids = [] } = {}) {
  if (!['mine', 'external'].includes(tab)) throw invalid('invalid_chat_tab');
  if (conversationId !== null && (typeof conversationId !== 'string' || conversationId.length > 2048
    || !/^(?:g:(?:[0-9A-F]{2})+|l:(?:[0-9A-F]{2})+:(?:[0-9A-F]{2})*)$/.test(conversationId))) throw invalid('invalid_chat_conversation');
  if (!Array.isArray(ids) || ids.length > 100 || ids.some(id => !/^[1-9][0-9]*$/.test(String(id)) || !Number.isSafeInteger(Number(id)))) throw invalid('invalid_chat_message_ids');
  const values = ids.map(Number);
  if (new Set(values).size !== values.length || !conversationId && values.length || tab === 'external' && values.length) throw invalid('invalid_chat_message_ids');
  return { tab, conversationId, ids: values.sort((a, b) => a - b) };
}

export function parseChatSubscription(parameters) {
  if (!parameters.has('chat')) return null;
  for (const name of ['chat', 'chat_tab', 'chat_conversation', 'chat_ids']) {
    if (parameters.getAll(name).length > 1) throw invalid('invalid_chat_subscription');
  }
  if (parameters.get('chat') !== '1') throw invalid('invalid_chat_subscription');
  const rawIds = parameters.get('chat_ids');
  return normalizeChatSubscription({ tab: parameters.get('chat_tab') ?? 'mine',
    conversationId: parameters.get('chat_conversation') || null, ids: rawIds ? rawIds.split(',') : [] });
}

/** One read-only sampler shared by all currently authorized chat streams. */
export class ChatChangeObserver {
  constructor({ c4Reader, history, intervalMs = 500, setTimeout: delay = globalThis.setTimeout,
    clearTimeout: cancel = globalThis.clearTimeout } = {}) {
    this.reader = c4Reader;
    this.history = history;
    this.intervalMs = intervalMs;
    this.delay = delay;
    this.cancel = cancel;
    this.subscriptions = new Set();
    this.timer = null;
    this.version = null;
    this.closed = false;
  }

  subscribe(subscription, { validate, send, onStop } = {}) {
    if (this.closed) return () => {};
    const options = normalizeChatSubscription(subscription);
    const record = { options, key: JSON.stringify(options), validate, send, onStop, snapshot: null };
    this.subscriptions.add(record);
    this._sample();
    this._schedule();
    return () => this._remove(record);
  }

  _authorized(record) {
    try { return typeof record.validate === 'function' && record.validate() === true; }
    catch { return false; }
  }

  _remove(record, reason) {
    if (!this.subscriptions.delete(record)) return;
    if (!this.subscriptions.size) {
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null;
      this.version = null;
    }
    if (reason) {
      try { record.onStop?.(reason); } catch { /* subscriber owns transport */ }
    }
  }

  _send(record, event) {
    if (this.closed || !this.subscriptions.has(record)) return false;
    if (!this._authorized(record)) { this._remove(record, 'chat_access_revoked'); return false; }
    try {
      if (record.send(event, { version: 1, ...record.options }) !== false) return true;
    } catch { /* closed or slow transport */ }
    this._remove(record, 'chat_unavailable');
    return false;
  }

  _sample() {
    if (this.closed || !this.subscriptions.size) return;
    for (const record of [...this.subscriptions]) {
      if (!this._authorized(record)) this._remove(record, 'chat_access_revoked');
    }
    if (!this.subscriptions.size) return;
    let version;
    try { version = this.reader.readVersion(); } catch { version = null; }
    if (!version || this.version && version.generation !== this.version.generation) {
      for (const record of [...this.subscriptions]) this._remove(record, 'chat_unavailable');
      return;
    }
    const changed = !this.version || this.version.version !== version.version;
    const snapshots = new Map();
    for (const record of [...this.subscriptions]) {
      if (this.closed || !this.subscriptions.has(record)) continue;
      if (!changed && record.snapshot) continue;
      try {
        const previous = record.snapshot;
        const key = JSON.stringify([record.key, previous?.highwater ?? null]);
        if (!snapshots.has(key)) snapshots.set(key, this.history.chatChangeSnapshot(record.options,
          { afterId: previous?.highwater ?? null }));
        const next = snapshots.get(key);
        record.snapshot = next;
        if (!previous) this._send(record, 'chat_ready');
        else {
          if (next.listChanged || previous.latestId !== next.latestId) this._send(record, 'chat_messages_changed');
          if (this.subscriptions.has(record) && JSON.stringify(previous.delivery) !== JSON.stringify(next.delivery)) this._send(record, 'chat_delivery_changed');
        }
      } catch {
        this._remove(record, 'chat_unavailable');
      }
    }
    if (this.subscriptions.size) this.version = version;
  }

  _schedule() {
    if (this.closed || this.timer !== null || !this.subscriptions.size) return;
    this.timer = this.delay(() => {
      this.timer = null;
      this._sample();
      this._schedule();
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  close() {
    this.closed = true;
    for (const record of [...this.subscriptions]) this._remove(record, 'chat_unavailable');
  }
}
