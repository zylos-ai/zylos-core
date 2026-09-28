// Driven only by the dispatcher's awaited loop, never setInterval.
export class PeriodicEnter {
  constructor({ enabled = false, intervalMs = 60000, maxAttempts = 3, now = () => performance.now(), emit = () => {} } = {}) {
    Object.assign(this, { enabled, intervalMs, maxAttempts, now, emit });
    this.reset();
  }

  reset(reason = 'reset') {
    if (this.pending) this.emit('periodic_disarmed', { itemId: this.pending.itemId, itemType: this.pending.itemType, pane: this.pending.pane, reason });
    this.pending = null;
  }

  arm(target, itemId, itemType) {
    if (!this.enabled) return this.reset('disabled');
    if (!target?.identity || !target.pane) {
      this.reset('identity_unavailable');
      this.emit('periodic_arm_skipped', { itemId, itemType, reason: 'identity_unavailable' });
      return;
    }
    this.pending = { ...target, itemId, itemType, attempts: 0, lastAt: this.now() };
    this.emit('periodic_armed', { itemId, itemType, pane: target.pane });
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
    const metadata = { itemId: pending.itemId, itemType: pending.itemType, pane: pending.pane, attempt: pending.attempts, maxAttempts: this.maxAttempts };
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
