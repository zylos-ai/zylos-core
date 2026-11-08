// Driven only by the dispatcher's awaited loop, never setInterval.
export class PeriodicEnter {
  constructor({ enabled = false, intervalMs = 60000, maxAttempts = 3, now = () => performance.now(), emit = () => {} } = {}) {
    Object.assign(this, { enabled, intervalMs, maxAttempts, now, emit });
    this.reset();
  }

  reset(reason = 'reset') {
    if (this.pending) this.emit('periodic_disarmed', { itemId: this.pending.itemId, itemType: this.pending.itemType, reason });
    this.pending = null;
  }

  // Arming on top of an existing budget (#795): the earlier paste may still be
  // sitting unsubmitted in the input box, so the new paste must not push its
  // recovery back. `since` keeps the oldest unrecovered paste time; the new item
  // still gets a fresh attempt budget.
  arm(itemId, itemType) {
    if (!this.enabled) return this.reset('disabled');
    const t = this.now();
    const prev = this.pending;
    const since = prev ? prev.since : t;
    this.pending = { itemId, itemType, attempts: 0, lastAt: t, since, carried: Boolean(prev) };
    this.emit('periodic_armed', { itemId, itemType, carried: Boolean(prev) });
  }

  entered() {
    if (this.pending) this.pending.lastAt = this.now();
  }

  due(pending, t) {
    if (t - pending.lastAt >= this.intervalMs) return true;
    return pending.carried && t - pending.since >= this.intervalMs;
  }

  async tick({ eligible, send }) {
    const pending = this.pending;
    if (!pending) return;
    if (!eligible || pending.attempts >= this.maxAttempts || !this.due(pending, this.now())) return;
    pending.attempts++;
    pending.lastAt = pending.since = this.now();
    const metadata = { itemId: pending.itemId, itemType: pending.itemType, attempt: pending.attempts, maxAttempts: this.maxAttempts };
    this.emit('periodic_attempt', metadata);
    try {
      await send();
      pending.lastAt = pending.since = this.now();
      this.emit('periodic_sent', metadata);
    } catch {
      // Failed sends consume the bounded budget without leaking tmux stderr.
      this.emit('periodic_failed', metadata);
    }
    if (pending.attempts >= this.maxAttempts) this.emit('periodic_exhausted', metadata);
  }
}
