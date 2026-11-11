const invalid = code => Object.assign(new Error(code), { code, statusCode: 400 });

export function normalizeChatSubscription({ tab = 'mine', conversationId = null } = {}) {
  if (!['mine', 'external'].includes(tab)) throw invalid('invalid_chat_tab');
  if (conversationId !== null && (typeof conversationId !== 'string' || conversationId.length > 2048
    || !/^(?:g:(?:[0-9A-F]{2})+|l:(?:[0-9A-F]{2})+:(?:[0-9A-F]{2})*)$/.test(conversationId))) throw invalid('invalid_chat_conversation');
  return { tab, conversationId };
}

export function parseChatSubscription(parameters) {
  if (!parameters.has('chat')) return null;
  for (const name of ['chat', 'chat_tab', 'chat_conversation']) {
    if (parameters.getAll(name).length > 1) throw invalid('invalid_chat_subscription');
  }
  if (parameters.get('chat') !== '1' || parameters.has('chat_ids')) throw invalid('invalid_chat_subscription');
  return normalizeChatSubscription({ tab: parameters.get('chat_tab') ?? 'mine',
    conversationId: parameters.get('chat_conversation') || null });
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
    this.recoveries = new Set();
    this.timer = null;
    this.version = null;
    this.names = null;
    this.nameVersion = null;
    this.closed = false;
  }

  subscribe(subscription, { validate, send, onStop } = {}) {
    if (this.closed) return () => {};
    const options = normalizeChatSubscription(subscription);
    const record = { options, key: JSON.stringify(options), validate, send, onStop, snapshot: null, generation: null };
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
    const active = this.subscriptions.delete(record);
    const recovering = this.recoveries.delete(record);
    if (!active && !recovering) return;
    if (!this.subscriptions.size && !this.recoveries.size) {
      if (this.timer !== null) this.cancel(this.timer);
      this.timer = null;
      this.version = null;
    }
    if (reason) {
      try { record.onStop?.(reason); } catch { /* subscriber owns transport */ }
    }
  }

  _detach(record) {
    if (!this.subscriptions.delete(record)) return;
    // Keep only a generation watch: no chat snapshot or admission capacity.
    record.snapshot = null;
    this.recoveries.add(record);
    try { record.onStop?.('chat_unavailable'); } catch { /* subscriber owns transport */ }
  }

  _recover(version) {
    if (!version) return;
    for (const record of [...this.recoveries]) {
      if (record.generation !== version.generation) this._remove(record, 'chat_database_changed');
    }
  }

  _send(record, event) {
    if (this.closed || !this.subscriptions.has(record)) return false;
    try {
      if (record.send(event, { version: 1, ...record.options, ids: record.snapshot?.delivery.map(row => row.id) ?? [] }) !== false) return true;
    } catch { /* closed or slow transport */ }
    this._detach(record);
    return false;
  }

  _sample() {
    if (this.closed || !this.subscriptions.size && !this.recoveries.size) return;
    for (const record of [...this.subscriptions, ...this.recoveries]) {
      if (!this._authorized(record)) this._remove(record, 'chat_access_revoked');
    }
    if (!this.subscriptions.size && !this.recoveries.size) return;
    let version;
    try { version = this.reader.readVersion(); } catch { version = null; }
    if (!version || this.version && version.generation !== this.version.generation) {
      for (const record of [...this.subscriptions]) this._detach(record);
      this._recover(version);
      this.version = null;
      return;
    }
    this._recover(version);
    let namesChanged = false;
    const namesDb = this.history.conversations?.db;
    if (namesDb) {
      // data_version sees the CLI's connection; total_changes sees this service's
      // manual writes. Only a changed name projection emits a dirty hint.
      const nameVersion = `${namesDb.pragma('data_version', { simple: true })}:${namesDb.prepare('SELECT total_changes() AS n').get().n}`;
      if (nameVersion !== this.nameVersion) {
        const nextNames = JSON.stringify(namesDb.prepare(`SELECT session_group, display_name FROM group_display_names
          UNION ALL SELECT 'draft:' || local_id, display_name FROM chat_conversations WHERE state<>'active'
          ORDER BY 1`).all());
        namesChanged = this.names !== null && this.names !== nextNames;
        this.names = nextNames;
        this.nameVersion = nameVersion;
      }
    }
    const changed = !this.version || this.version.version !== version.version || namesChanged;
    const snapshots = new Map();
    for (const record of [...this.subscriptions]) {
      if (this.closed || !this.subscriptions.has(record)) continue;
      if (!changed && record.snapshot) continue;
      try {
        record.generation = version.generation;
        const previous = record.snapshot;
        const key = JSON.stringify([record.key, previous?.highwater ?? null]);
        if (!snapshots.has(key)) snapshots.set(key, this.history.chatChangeSnapshot(record.options,
          { afterId: previous?.highwater ?? null }));
        const next = snapshots.get(key);
        record.snapshot = next;
        if (!previous) this._send(record, 'chat_ready');
        else {
          if (namesChanged || next.listChanged || previous.latestId !== next.latestId) this._send(record, 'chat_messages_changed');
          if (this.subscriptions.has(record) && JSON.stringify(previous.delivery) !== JSON.stringify(next.delivery)) this._send(record, 'chat_delivery_changed');
        }
      } catch {
        this._detach(record);
      }
    }
    this.version = this.subscriptions.size ? version : null;
  }

  _schedule() {
    if (this.closed || this.timer !== null || !this.subscriptions.size && !this.recoveries.size) return;
    this.timer = this.delay(() => {
      this.timer = null;
      this._sample();
      this._schedule();
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  close() {
    this.closed = true;
    for (const record of [...this.subscriptions, ...this.recoveries]) this._remove(record, 'chat_unavailable');
  }
}
