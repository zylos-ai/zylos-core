export class SseHub {
  constructor(keepaliveMs = 15_000, { maxChatClients = 100, maxChatClientsPerPrincipal = 20 } = {}) {
    this.keepaliveMs = keepaliveMs;
    this.clients = new Set();
    this.keepaliveTimer = null;
    this.sequence = 0;
    this.maxChatClients = maxChatClients;
    this.maxChatClientsPerPrincipal = maxChatClientsPerPrincipal;
    this.chatClients = new Map();
  }

  canAddChatClient(principal) {
    let total = 0;
    for (const count of this.chatClients.values()) total += count;
    return total < this.maxChatClients && (this.chatClients.get(principal) || 0) < this.maxChatClientsPerPrincipal;
  }

  addClient(res, validator, { onClose, chatPrincipal } = {}) {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no'
    });
    const client = { res, validator: validator || null, onClose, chatPrincipal };
    if (chatPrincipal !== undefined) this.chatClients.set(chatPrincipal, (this.chatClients.get(chatPrincipal) || 0) + 1);
    this.clients.add(client);
    res.on('close', () => this._remove(client));
    this._write(client, ': connected\n\n');
    if (this.clients.size) this._startKeepalive();
    return client;
  }

  detachChat(client) {
    if (client.chatPrincipal !== undefined) {
      const count = this.chatClients.get(client.chatPrincipal) - 1;
      if (count) this.chatClients.set(client.chatPrincipal, count);
      else this.chatClients.delete(client.chatPrincipal);
      client.chatPrincipal = undefined;
    }
  }

  _remove(client) {
    if (!this.clients.delete(client)) return;
    this.detachChat(client);
    try { client.onClose?.(); } catch { /* transport teardown must continue */ }
    if (this.clients.size === 0) this._stopKeepalive();
  }

  removeClient(res) {
    for (const client of this.clients) {
      if (client.res === res) { this._remove(client); break; }
    }
  }

  _write(client, payload) {
    if (!this.clients.has(client)) return false;
    try {
      // Disconnect a slow reader instead of retaining an unbounded event queue.
      if (client.res.writableLength > 64 * 1024 || client.res.write(payload) === false) {
        this._remove(client);
        if (client.res.destroy) client.res.destroy();
        else client.res.end();
        return false;
      }
      return true;
    } catch {
      this._remove(client);
      try { client.res.destroy?.(); } catch { /* already closed */ }
      return false;
    }
  }

  sendTo(client, eventType, data) {
    if (!this.clients.has(client) || this._evictIfInvalid(client)) return false;
    const payload = `id: ${++this.sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    return this._write(client, payload);
  }

  broadcast(eventType, data) {
    // Chat activity is opt-in and may only be sent to its authorized subscriber.
    if (eventType.startsWith('chat_')) return;
    const payload = `id: ${++this.sequence}\nevent: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of [...this.clients]) {
      if (!this._evictIfInvalid(client)) this._write(client, payload);
    }
  }

  closeAll() {
    for (const client of [...this.clients]) {
      this._remove(client);
      try { client.res.end(); } catch { /* already closed */ }
    }
    this._stopKeepalive();
  }

  _evictIfInvalid(client) {
    let valid = true;
    try { valid = !client.validator || client.validator(); } catch { valid = false; }
    if (valid) return false;
    this._write(client, 'event: auth_expired\ndata: {}\n\n');
    this._remove(client);
    try { client.res.end(); } catch { /* already closed */ }
    return true;
  }

  _startKeepalive() {
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      for (const client of [...this.clients]) {
        if (!this._evictIfInvalid(client)) this._write(client, ': keepalive\n\n');
      }
    }, this.keepaliveMs);
    this.keepaliveTimer.unref?.();
  }

  _stopKeepalive() {
    if (!this.keepaliveTimer) return;
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }
}
