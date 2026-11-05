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
    this.startupAlerted = false;
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
      if (!this.startupAlerted) {
        this.startupAlerted = true;
        try {
          await this.deps.startupAlert?.({
            event: 'startup_configuration_unreadable',
            session_group: '*',
            reason: error.code ?? error.message,
          });
        } catch (alertError) {
          await this.deps.reportError(alertError, { phase: 'startup-alert' });
        }
      }
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
    d.beginRound?.();
    const authority = async read => {
      try { return await read(); }
      catch (error) {
        if (this.configuration?.mode === 'multi') await d.reconciliationReadFailed?.(error);
        throw error;
      }
    };
    // Transition owns its own serialization and must precede this round's work.
    const transition = await authority(() => d.getModeTransition());
    if (transition) {
      try { await d.advanceTransition(transition); }
      catch (error) { await d.reportError(error, { phase: 'transition' }); }
    }
    let context;
    await d.lifecycleSerial(async () => {
      // Sample all round authorities and scenes while socket admission is excluded.
      this.configuration = await d.readConfiguration(transition);
      context = { configuration: this.configuration, transition,
        fences: await authority(() => d.listDrainFences()), restartRequests: [] };
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
        context.transition = await authority(() => d.getModeTransition());
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
    try { await d.lifecycleSerial(() => d.reconcileRunEndings?.(context)); }
    catch (error) { await d.reportError(error, { phase: 'run-ending-reconciliation' }); }
    await this.each(context.scenes, scene => d.probeAndPublish(scene, context), 'observe');
    try { await d.updateCapacity?.(context); }
    catch (error) { await d.reportError(error, { phase: 'capacity' }); }
    await d.lifecycleSerial(async () => {
      // Automatic legacy migration can open a transition after the initial read.
      const transitionOpen = Boolean(transition || context.transition);
      await this.each(context.fences, fence => d.advanceReclaim(fence, context), 'reclaim');
      if (transitionOpen) return;
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
