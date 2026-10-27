import crypto from 'node:crypto';

const DEFAULT_MAX_VIEWERS = 4;
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_IDLE_GRACE_MS = 5_000;
const DEFAULT_REVALIDATE_MS = 10_000;
const DEFAULT_TICKET_TTL_MS = 30_000;
// Renewal mints a ticket every few seconds; only the newest few stay usable.
const MAX_TICKETS_PER_LEASE = 3;

export class ObserverManagerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ObserverManagerError';
    this.code = code;
  }
}

function samePrincipal(left, right) {
  return left?.kind === right?.kind && left?.principalId === right?.principalId &&
    left?.scope === 'admin' && right?.scope === 'admin';
}

export class ObserverManager {
  constructor({
    coordinator,
    containment,
    authGate,
    runtime,
    resolveOrigin,
    target = 'local',
    maxViewers = DEFAULT_MAX_VIEWERS,
    leaseTtlMs = DEFAULT_LEASE_TTL_MS,
    idleGraceMs = DEFAULT_IDLE_GRACE_MS,
    revalidateMs = DEFAULT_REVALIDATE_MS,
    ticketTtlMs = DEFAULT_TICKET_TTL_MS,
    now = () => Date.now(),
  }) {
    this.coordinator = coordinator;
    this.containment = containment;
    this.authGate = authGate;
    this.runtime = runtime;
    this.resolveOrigin = resolveOrigin;
    this.target = target;
    this.maxViewers = maxViewers;
    this.leaseTtlMs = leaseTtlMs;
    this.idleGraceMs = idleGraceMs;
    this.revalidateMs = revalidateMs;
    this.ticketTtlMs = ticketTtlMs;
    this.now = now;
    this.leases = new Map();
    // One-time WebSocket handshake tickets, keyed by 256-bit random value.
    this.tickets = new Map();
    this.generation = null;
    this._starting = null;
    this._pendingLeases = 0;
    this._epoch = 0;
    this._idleTimer = null;
    this._idleStopping = null;
    this._revalidationTimer = null;
    this._runtimeError = null;
    this._retiring = null;
    this._shuttingDown = false;
    this._lifecycleTransitions = 0;
  }

  _requireAdmin(context) {
    if (!context || context.scope !== 'admin' || !['cookie', 'api'].includes(context.kind)) {
      throw new ObserverManagerError('admin_required', 'Observer requires a live administrator principal');
    }
  }

  async _ensureGeneration(context) {
    if (this._retiring) await this._retiring;
    if (this._idleStopping) await this._idleStopping;
    if (this._shuttingDown || this._lifecycleTransitions > 0) {
      throw new ObserverManagerError('operation_obsolete', 'Observer lifecycle is changing');
    }
    context = this.authGate.revalidateAuthContext(context);
    if (!context) throw new ObserverManagerError('auth_required', 'Observer authentication expired');
    if (this._runtimeError) throw new ObserverManagerError('teardown_failed', 'Observer cleanup requires administrator recovery');
    if (this.containment.active && this.generation !== null) return this.containment.active;
    if (this._starting) return this._starting;
    this._starting = this.coordinator.firstLease(context).catch((error) => {
      if (error.cleanupError) this._runtimeError = error.cleanupError;
      throw error;
    }).then((active) => {
      this.generation = active.generation;
      this._startRevalidation();
      return active;
    }).finally(() => { this._starting = null; });
    return this._starting;
  }

  _startRevalidation() {
    if (this._revalidationTimer) return;
    this._revalidationTimer = setInterval(() => {
      this.revalidate().catch(() => {});
    }, this.revalidateMs);
    this._revalidationTimer.unref?.();
  }

  _stopRevalidation() {
    if (this._revalidationTimer) clearInterval(this._revalidationTimer);
    this._revalidationTimer = null;
  }

  _clearIdleTimer() {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleTimer = null;
  }

  _scheduleIdleStop() {
    if (this.leases.size > 0 || this._pendingLeases > 0 || this._starting || this._shuttingDown ||
        this._lifecycleTransitions > 0 || this._retiring || this._runtimeError ||
        this._idleTimer || !this.containment.active) return;
    const expectedGeneration = this.generation;
    this._idleTimer = setTimeout(() => {
      this._idleTimer = null;
      if (this.leases.size > 0 || this._pendingLeases > 0 || this._starting || this._shuttingDown ||
          this._lifecycleTransitions > 0 || this._retiring || this._runtimeError ||
          this.generation !== expectedGeneration) return;
      this._idleStopping = this.containment.stopGeneration({ reason: 'last_lease' }).then(() => {
        if (this.generation === expectedGeneration) this.generation = null;
        this._stopRevalidation();
      }).catch((error) => { this._runtimeError = error; }).finally(() => { this._idleStopping = null; });
    }, this.idleGraceMs);
    this._idleTimer.unref?.();
  }

  async createLease(context, { target = this.target, runId } = {}) {
    this._requireAdmin(context);
    const origin = this.resolveOrigin ? await this.resolveOrigin() : null;
    if (origin && (!runId || origin.runId !== runId)) throw new ObserverManagerError('target_mismatch', 'Refresh and confirm the current Origin run');
    if (target !== this.target) throw new ObserverManagerError('target_mismatch', 'Observer target is not this producer');
    if (this._shuttingDown || this._lifecycleTransitions > 0) {
      throw new ObserverManagerError('operation_obsolete', 'Observer lifecycle is changing');
    }
    this._clearIdleTimer();
    const epoch = this._epoch;
    this._pendingLeases += 1;
    try {
      await this.revalidate();
      if (epoch !== this._epoch || this._shuttingDown || this._lifecycleTransitions > 0) {
        throw new ObserverManagerError('operation_obsolete', 'Observer lease start was superseded');
      }
      if (this.leases.size + this._pendingLeases > this.maxViewers) {
        throw new ObserverManagerError('capacity_exceeded', 'Observer viewer capacity reached');
      }
      context = this.authGate.revalidateAuthContext(context);
      if (!context) throw new ObserverManagerError('auth_required', 'Observer authentication expired');
      const active = await this._ensureGeneration(context);
      context = this.authGate.revalidateAuthContext(context);
      if (!context) throw new ObserverManagerError('auth_required', 'Observer authentication expired');
      if (epoch !== this._epoch || active !== this.containment.active || active.generation !== this.generation) {
        throw new ObserverManagerError('operation_obsolete', 'Observer lease start was superseded');
      }
      if (origin && active.originRunId !== origin.runId) throw new ObserverManagerError('target_mismatch', 'Origin changed during Observer attachment');
      const id = crypto.randomBytes(24).toString('base64url');
      const createdAt = this.now();
      const lease = {
        id,
        principal: context,
        runId: origin?.runId ?? null,
        target,
        generation: active.generation,
        createdAt,
        expiresAt: createdAt + this.leaseTtlMs,
      };
      this.leases.set(id, lease);
      return { ...this.publicLease(lease), ticket: this._mintTicket(lease) };
    } finally {
      this._pendingLeases -= 1;
      this._scheduleIdleStop();
    }
  }

  publicLease(lease) {
    return {
      id: lease.id,
      expiresAt: lease.expiresAt,
      generation: lease.generation,
      resource: 'frame',
      ...(lease.runId ? { runId: lease.runId } : {}),
    };
  }

  // Tickets let a cookie WebSocket handshake prove it read the response of the
  // origin-checked lease request when the browser omits Fetch Metadata and a
  // proxy rewrites Host. They are bound to the lease and principal, short-lived
  // and single-use.
  _mintTicket(lease) {
    const now = this.now();
    const owned = [];
    for (const [value, ticket] of this.tickets) {
      if (ticket.expiresAt <= now) this.tickets.delete(value);
      else if (ticket.leaseId === lease.id) owned.push(value);
    }
    // Map order is mint order, so the oldest tickets are dropped first.
    while (owned.length >= MAX_TICKETS_PER_LEASE) this.tickets.delete(owned.shift());
    const value = crypto.randomBytes(32).toString('base64url');
    this.tickets.set(value, { leaseId: lease.id, principal: lease.principal, expiresAt: now + this.ticketTtlMs });
    return value;
  }

  _dropTickets(leaseId) {
    for (const [value, ticket] of this.tickets) if (ticket.leaseId === leaseId) this.tickets.delete(value);
  }

  consumeTicket(value, leaseId, context) {
    const ticket = typeof value === 'string' ? this.tickets.get(value) : undefined;
    if (!ticket) return false;
    // Any presentation spends the ticket, including a mismatched one.
    this.tickets.delete(value);
    const lease = this.leases.get(leaseId);
    return ticket.expiresAt > this.now() && ticket.leaseId === leaseId && Boolean(lease) &&
      samePrincipal(ticket.principal, context) && samePrincipal(lease.principal, context);
  }

  validateLease(id, context, { target = this.target, renew = false } = {}) {
    this._requireAdmin(context);
    const lease = this.leases.get(id);
    if (!lease) throw new ObserverManagerError('lease_not_found', 'Observer lease was not found');
    if (lease.expiresAt <= this.now()) {
      this.leases.delete(id);
      this._dropTickets(id);
      this._scheduleIdleStop();
      throw new ObserverManagerError('lease_expired', 'Observer lease expired');
    }
    if (!samePrincipal(lease.principal, context) || lease.target !== target ||
        lease.generation !== this.generation || lease.generation !== this.containment.active?.generation) {
      throw new ObserverManagerError('lease_mismatch', 'Observer lease binding did not match');
    }
    lease.principal = context;
    if (renew) lease.expiresAt = this.now() + this.leaseTtlMs;
    return lease;
  }

  renewLease(id, context, options) {
    const lease = this.validateLease(id, context, { ...options, renew: true });
    return { ...this.publicLease(lease), ticket: this._mintTicket(lease) };
  }

  releaseLease(id, context, options) {
    const lease = this.validateLease(id, context, options);
    this.leases.delete(id);
    this._dropTickets(id);
    this._scheduleIdleStop();
    return { released: true, id: lease.id };
  }

  async revalidate() {
    if (this.resolveOrigin && this.containment.active) {
      let origin;
      try { origin = await this.resolveOrigin(); } catch {}
      if (!origin || origin.runId !== this.containment.active.originRunId) {
        await this.handleContainmentFailure(new ObserverManagerError('target_mismatch', 'Origin identity changed'));
        return 0;
      }
    }
    const now = this.now();
    for (const [id, lease] of this.leases) {
      const refreshed = this.authGate.revalidateAuthContext(lease.principal);
      if (lease.expiresAt <= now || !refreshed ||
          lease.generation !== this.generation || lease.generation !== this.containment.active?.generation) {
        this.leases.delete(id);
        this._dropTickets(id);
      } else {
        lease.principal = refreshed;
      }
    }
    for (const [value, ticket] of this.tickets) if (ticket.expiresAt <= now) this.tickets.delete(value);
    this._scheduleIdleStop();
    return this.leases.size;
  }

  async invalidateAndDisable(reason = 'disabled') {
    this._lifecycleTransitions += 1;
    this._epoch += 1;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    this.tickets.clear();
    this.generation = null;
    try {
      if (this._retiring) await this._retiring;
      if (this._idleStopping) await this._idleStopping;
      const starting = this._starting;
      if (starting) {
        try { await starting; } catch {}
      }
      this._stopRevalidation();
      try {
        const result = await this.coordinator.disable({ reason });
        this.generation = null;
        this._runtimeError = null;
        return result;
      } catch (error) {
        await this._cleanupAfterLifecycleFailure(error, `${reason}_failed`);
      }
    } finally {
      this._lifecycleTransitions -= 1;
    }
  }

  async invalidateAndUninstall() {
    this._lifecycleTransitions += 1;
    this._epoch += 1;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    this.tickets.clear();
    this.generation = null;
    try {
      if (this._retiring) await this._retiring;
      if (this._idleStopping) await this._idleStopping;
      const starting = this._starting;
      if (starting) {
        try { await starting; } catch {}
      }
      this._stopRevalidation();
      try {
        const result = await this.coordinator.uninstall();
        this.generation = null;
        this._runtimeError = null;
        return result;
      } catch (error) {
        await this._cleanupAfterLifecycleFailure(error, 'uninstall_failed');
      }
    } finally {
      this._lifecycleTransitions -= 1;
    }
  }

  async shutdown(reason = 'dashboard_shutdown') {
    this._shuttingDown = true;
    this._epoch += 1;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    this.tickets.clear();
    if (this._retiring) await this._retiring;
    if (this._idleStopping) await this._idleStopping;
    const starting = this._starting;
    if (starting) {
      try { await starting; } catch {}
    }
    this._stopRevalidation();
    const result = await this.containment.stopGeneration({ reason });
    this.generation = null;
    this._runtimeError = null;
    return result;
  }

  async _cleanupAfterLifecycleFailure(originalError, reason) {
    if (originalError?.cleanupAttempted === true) {
      this._runtimeError = originalError.cause || originalError;
      throw originalError;
    }
    try {
      await this.containment.stopGeneration({ reason });
      this.generation = null;
      this._runtimeError = null;
    } catch (cleanupError) {
      this._runtimeError = cleanupError;
      try {
        Object.defineProperty(originalError, 'cleanupError', {
          value: cleanupError,
          enumerable: false,
          configurable: true,
        });
      } catch {}
    }
    throw originalError;
  }

  // True while a generation is attaching; its worker aborts on Agent resizes.
  isStarting() {
    return this._starting !== null;
  }

  runtimeStatus() {
    return {
      state: this._retiring ? 'retiring' : this._runtimeError ? 'blocked' :
        this.containment.active && this.generation !== null ? 'live' : 'idle',
      error: this._runtimeError?.code || (this._runtimeError ? 'teardown_failed' : null),
    };
  }

  handleContainmentFailure(error, active = this.containment.active) {
    // Fence admission synchronously, before stream close can trigger new demand.
    if (!active || active !== this.containment.active) return Promise.resolve();
    if (this._retiring) return this._retiring;
    this._epoch += 1;
    const epoch = this._epoch;
    this._clearIdleTimer();
    this._stopRevalidation();
    this.leases.clear();
    this.tickets.clear();
    this.generation = null;
    const retirement = Promise.resolve().then(async () => {
      try {
        await this.containment.stopGeneration({ reason: 'child_failure' });
        if (this._epoch === epoch) this._runtimeError = null;
      } catch (cleanupError) {
        // Lifecycle operations wait for us before attempting their own cleanup.
        this._runtimeError = cleanupError;
      }
    }).finally(() => {
      if (this._retiring === retirement) this._retiring = null;
    });
    this._retiring = retirement;
    return retirement;
  }
}
