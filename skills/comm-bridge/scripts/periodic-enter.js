// This timer is driven only by the dispatcher's awaited loop, never setInterval.
export class PeriodicEnter {
  constructor({ enabled = false, intervalMs = 60000, maxAttempts = 3, now = () => performance.now(), emit = () => {} } = {}) {
    Object.assign(this, { enabled, intervalMs, maxAttempts, now, emit });
    this.reset();
  }

  reset(reason = 'reset') {
    if (this.pending) this.emit('periodic_disarmed', { reason });
    this.pending = null;
  }

  arm(identity, itemId) {
    if (!this.enabled || !identity) return this.reset('identity_unavailable');
    this.pending = { identity, itemId, attempts: 0, lastAt: this.now() };
    this.emit('periodic_armed', { itemId });
  }

  entered() {
    if (this.pending) this.pending.lastAt = this.now();
  }

  async tick({ identity, eligible, send }) {
    const pending = this.pending;
    if (!pending) return;
    if (!identity || identity !== pending.identity) return this.reset('target_changed_or_unavailable');
    if (!eligible || pending.attempts >= this.maxAttempts || this.now() - pending.lastAt < this.intervalMs) return;
    pending.attempts++;
    pending.lastAt = this.now();
    const metadata = { itemId: pending.itemId, attempt: pending.attempts, maxAttempts: this.maxAttempts };
    this.emit('periodic_attempt', metadata);
    try {
      await send();
      pending.lastAt = this.now();
      this.emit('periodic_sent', metadata);
    } catch {
      // Failed sends consume the same bounded budget; never serialize tmux stderr.
      this.emit('periodic_failed', metadata);
    }
    if (pending.attempts >= this.maxAttempts) this.emit('periodic_exhausted', metadata);
  }
}
