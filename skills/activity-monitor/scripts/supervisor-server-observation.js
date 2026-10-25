export function parseServerAlertTarget(value) {
  if (typeof value !== 'string') return null;
  const colon = value.indexOf(':');
  if (colon <= 0 || colon === value.length - 1 || /[\0\r\n]/.test(value)) return null;
  const channel = value.slice(0, colon).trim(), endpoint = value.slice(colon + 1).trim();
  return channel && endpoint ? { channel, endpoint } : null;
}

/** Observe-only decorator. Cached occupancy is never a current identity or an
 * authorization to reclaim, deliver, publish status, or release capacity.
 */
export class SupervisorServerObservation {
  constructor(scenes, { guard, socketKey = 'default' } = {}) {
    Object.assign(this, { scenes, guard, socketKey });
    this.cached = null;
  }
  failure(error) {
    if (error?.code === 'TMUX_UNAVAILABLE') this.guard.observeFailure({ socketKey: this.socketKey, error });
    if (error?.code === 'TMUX_NO_SERVER') {
      this.cached = [];
      this.guard.observeSuccess({ socketKey: this.socketKey });
    }
  }
  success(scenes, replace, cacheOccupancy = true) {
    this.guard.observeSuccess({ socketKey: this.socketKey });
    if (!cacheOccupancy) return;
    const occupancy = scenes.map(scene => ({ sessionGroup: scene.sessionGroup, present: scene.present,
      tmuxName: scene.tmuxName, runDir: scene.runDir, createdAt: scene.createdAt, currentSessionTs: scene.currentSessionTs }));
    if (replace) this.cached = occupancy;
    else if (occupancy.length) {
      const groups = new Set(occupancy.map(scene => scene.sessionGroup));
      this.cached = [...(this.cached ?? []).filter(scene => !groups.has(scene.sessionGroup)), ...occupancy];
    }
  }
  async observe(context) {
    try {
      const scenes = await this.scenes.observe(context);
      const unavailable = scenes.find(scene => scene.observationError?.code === 'TMUX_UNAVAILABLE');
      if (unavailable) this.failure(unavailable.observationError);
      else this.success(scenes, true);
      return scenes;
    } catch (error) {
      this.failure(error);
      if (error?.code !== 'TMUX_UNAVAILABLE' || !this.cached?.length) throw error;
      return this.cached.map(scene => ({
        sessionGroup: scene.sessionGroup, present: scene.present, tmuxName: scene.tmuxName,
        runDir: scene.runDir, createdAt: scene.createdAt, currentSessionTs: scene.currentSessionTs,
        ready: false, processRunning: undefined,
        runId: null, sessionId: null, runtime: 'unknown', tmuxTarget: null,
        state: 'unknown', idleSince: null, usagePercent: null, observationError: error }));
    }
  }
  async strict(method, args) {
    try {
      const result = await this.scenes[method](...args);
      const scenes = Array.isArray(result) ? result : result ? [result] : [];
      const unavailable = scenes.find(scene => scene.observationError?.code === 'TMUX_UNAVAILABLE');
      if (unavailable) throw unavailable.observationError;
      // Identity checks do not replace the full occupancy snapshot with a partial scene.
      this.success(scenes, method === 'listRuns', method !== 'readIdentity');
      return result;
    } catch (error) { this.failure(error); throw error; }
  }
  observeGroup(...args) { return this.strict('observeGroup', args); }
  readRun(...args) { return this.strict('readRun', args); }
  listRuns(...args) { return this.strict('listRuns', args); }
  readIdentity(...args) { return this.strict('readIdentity', args); }
  async forward(method, args) {
    try { return await this.scenes[method](...args); }
    catch (error) { this.failure(error); throw error; }
  }
  bindTarget(...args) { return this.forward('bindTarget', args); }
  readScreen(...args) { return this.forward('readScreen', args); }
  stop(...args) { return this.forward('stop', args); }
  advance() { return this.guard.advance({ socketKey: this.socketKey }); }
}
