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
    // Mode cutover does not restart this owner. Read current strict F1 before actions.
    this.configuration = await d.readConfiguration();
    // Reads must succeed before using an empty/absent fact to authorize actions.
    const transition = await d.getModeTransition();
    const fences = await d.listDrainFences();
    const context = { configuration: this.configuration, transition, fences };
    if (d.checkManualFences) {
      try { await d.lifecycleSerial(() => d.checkManualFences(context)); }
      catch (error) { await d.reportError(error, { phase: 'manual-fences' }); }
    }
    if (transition) {
      await d.advanceTransition(transition);
    } else {
      await d.lifecycleSerial(async () => {
        // A socket request may have accepted a transition since the first read.
        if (await d.getModeTransition()) return;
        if (this.configuration.legacy) {
          try { await d.advanceAutomaticMigration?.(context); }
          catch (error) { await d.reportError(error, { phase: 'automatic-migration' }); }
          // An available migration owner may have accepted a transition.
          if (await d.getModeTransition()) return;
        }
        for (const phase of ['advanceManual', 'advanceRestarts', 'reconcileConfiguration']) {
          try { await d[phase](context); }
          catch (error) { await d.reportError(error, { phase }); }
        }
      });
    }
    const scenes = await d.observe(context);
    await d.observeExits?.(scenes);
    await this.each(scenes, scene => d.probeAndPublish(scene, context), 'observe');
    // Re-read both authorities inside the same queue used by socket admission.
    await d.lifecycleSerial(async () => {
      const current = { ...context, transition: await d.getModeTransition(), fences: await d.listDrainFences() };
      await this.each(current.fences, fence => d.advanceReclaim(fence, current), 'reclaim');
      if (current.transition) return;
      await this.each(scenes, scene => d.checkRotation(scene, current), 'rotation');
      if (this.configuration.mode === 'multi') {
        await this.each(scenes, scene => d.checkTtl(scene, current), 'ttl');
        // Reclaim may have changed capacity; never re-use the earlier scene list.
        try { await d.checkEviction(await d.observe(current), current); }
        catch (error) { await d.reportError(error, { phase: 'eviction' }); }
      }
      try { await d.checkSync(scenes, current); }
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
