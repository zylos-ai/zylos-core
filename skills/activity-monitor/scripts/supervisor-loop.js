/** One non-overlapping observation/reconciliation loop. Socket I/O is independent. */
export class SupervisorLoop {
  constructor(deps, { intervalMs = 1000, schedule = setTimeout, cancel = clearTimeout } = {}) {
    this.deps = deps;
    this.intervalMs = intervalMs;
    this.schedule = schedule;
    this.cancel = cancel;
    this.running = false;
    this.inflight = null;
    this.timer = null;
    this.configuration = null;
    this.configurationError = null;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    try {
      this.configuration = await this.deps.readConfiguration();
    } catch (error) {
      this.configurationError = error;
      // Bad startup configuration is terminal for this process's scheduling.
      // Keep the daemon observable; recovery requires a deliberate restart.
      await this.deps.reportError(error, { phase: 'configuration' });
      return;
    }
    try {
      await this.deps.restore();
      await this.deps.openAdmission();
    } catch (error) {
      await this.deps.reportError(error, { phase: 'restore' });
      this.running = false;
      throw error;
    }
    return this.tick();
  }

  async each(items, action, phase) {
    for (const item of items) {
      try { await action(item); }
      catch (error) { await this.deps.reportError(error, { phase, sessionGroup: item.sessionGroup }); }
    }
  }

  tick() {
    if (!this.running || this.configurationError) return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
    this.inflight = this.runRound().catch(error => this.deps.reportError(error, { phase: 'round' }))
      .finally(async () => {
        try { await this.deps.afterRound?.(); }
        catch (error) { await this.deps.reportError(error, { phase: 'after-round' }); }
        this.inflight = null;
        if (this.running) this.timer = this.schedule(() => { this.timer = null; void this.tick(); }, this.intervalMs);
      });
    return this.inflight;
  }

  async runRound() {
    const d = this.deps;
    // Transition owns its own serialization and must precede this round's work.
    const transition = await d.getModeTransition();
    if (transition) await d.advanceTransition(transition);
    let context;
    await d.lifecycleSerial(async () => {
      // Sample all round authorities and scenes while socket admission is excluded.
      this.configuration = await d.readConfiguration();
      context = { configuration: this.configuration, transition,
        fences: await d.listDrainFences(), restartRequests: [] };
      try { context.restartRequests = await d.readRestartRequests(); }
      catch (error) {
        // Unreadable intent blocks new work, but cannot strand existing D8 reclaim.
        context.restartRequestsError = error;
        await d.reportError(error, { phase: 'restart-requests' });
      }
      context.scenes = await d.observe(context);
      context.manualRequests = [];
      if (d.checkManualFences) {
        try { context.manualRequests = await d.checkManualFences(context); }
        catch (error) { await d.reportError(error, { phase: 'manual-fences' }); }
      }
      if (!context.transition && context.configuration.legacy) {
        try { await d.advanceAutomaticMigration?.(context); }
        catch (error) { await d.reportError(error, { phase: 'automatic-migration' }); }
        // Migration may have accepted a transition while holding this queue.
        context.transition = await d.getModeTransition();
      }
      if (!context.transition) {
        for (const phase of ['advanceManual', 'advanceRestarts', 'reconcileConfiguration']) {
          try { await d[phase](context); }
          catch (error) { await d.reportError(error, { phase }); }
        }
      }
    });
    // These workers may acquire lifecycle serialization for their own mutations.
    await d.observeExits?.(context.scenes);
    await this.each(context.scenes, scene => d.probeAndPublish(scene, context), 'observe');
    await d.lifecycleSerial(async () => {
      await this.each(context.fences, fence => d.advanceReclaim(fence, context), 'reclaim');
      if (context.transition) return;
      await this.each(context.scenes, scene => d.checkRotation(scene, context), 'rotation');
      if (context.configuration.mode === 'multi') {
        await this.each(context.scenes, scene => d.checkTtl(scene, context), 'ttl');
        try { await d.checkEviction(context.scenes, context); }
        catch (error) { await d.reportError(error, { phase: 'eviction' }); }
      }
      try { await d.checkSync(context.scenes, context); }
      catch (error) { await d.reportError(error, { phase: 'sync' }); }
    });
    await d.writeMetricsAndMaintain(context);
  }

  async stop() {
    this.running = false;
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
    await this.inflight;
  }
}
