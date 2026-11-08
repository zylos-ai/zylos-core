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

  // A new paste gets a fresh attempt budget, but an earlier item that is still
  // pending keeps its deadline: text pasted on top of an unsubmitted message
  // must not push that message's recovery back (#795).
  arm(itemId, itemType) {
    if (!this.enabled) return this.reset('disabled');
    const previous = this.pending;
    const carried = previous && previous.attempts < this.maxAttempts;
    this.pending = { itemId, itemType, attempts: 0, lastAt: carried ? previous.lastAt : this.now() };
    this.emit('periodic_armed', carried
      ? { itemId, itemType, carriedFrom: previous.itemId }
      : { itemId, itemType });
  }

  async tick({ eligible, send }) {
    const pending = this.pending;
    if (!pending) return;
    if (!eligible || pending.attempts >= this.maxAttempts || this.now() - pending.lastAt < this.intervalMs) return;
    pending.attempts++;
    pending.lastAt = this.now();
    const metadata = { itemId: pending.itemId, itemType: pending.itemType, attempt: pending.attempts, maxAttempts: this.maxAttempts };
    this.emit('periodic_attempt', metadata);
    try {
      await send();
      pending.lastAt = this.now();
      this.emit('periodic_sent', metadata);
    } catch {
      // Failed sends consume the bounded budget without leaking tmux stderr.
      this.emit('periodic_failed', metadata);
    }
    if (pending.attempts >= this.maxAttempts) this.emit('periodic_exhausted', metadata);
  }
}
