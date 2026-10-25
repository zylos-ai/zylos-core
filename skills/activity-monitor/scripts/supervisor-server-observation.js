import { loadCoreModule } from './core-modules.js';
const { openTmuxConnection } = await loadCoreModule('runtime/tmux-connection.js');

export function parseServerAlertTarget(value) {
  if (typeof value !== 'string') return null;
  const colon = value.indexOf(':');
  if (colon <= 0 || colon === value.length - 1 || /[\0\r\n]/.test(value)) return null;
  const channel = value.slice(0, colon).trim(), endpoint = value.slice(colon + 1).trim();
  return channel && endpoint ? { channel, endpoint } : null;
}

/** Observe-only decorator. Cached occupancy is never a current identity or an
 * authorization to reclaim, deliver, publish status, or release capacity.
 * advance() MUST be invoked outside the lifecycle queue.
 */
export class SupervisorServerObservation {
  constructor(scenes, { guard, socketKey = 'default', open = openTmuxConnection } = {}) {
    Object.assign(this, { scenes, guard, socketKey, open });
    this.cached = null;
    this.exits = new Map();
    this.reported = new Set();
  }
  recordExit(result) {
    if (result?.status !== 'old_server_gone' || this.reported.has(result.generation)) return;
    this.reported.add(result.generation);
    const scenes = (this.cached ?? []).filter(scene => scene.tmuxTarget?.serverGeneration === result.generation);
    if (scenes.length) this.exits.set(result.generation, scenes);
  }
  takeServerExits() {
    const exits = [...this.exits].map(([generation, scenes]) => ({ generation, scenes }));
    this.exits.clear();
    return exits;
  }
  async failure(error) {
    if (error?.code === 'TMUX_UNAVAILABLE') {
      this.recordExit(await this.guard.observeFailure({ socketKey: this.socketKey, error, deferTermination: true }));
    }
  }
  async success(scenes, replace) {
    let connection;
    try {
      const generations = new Set(scenes.filter(scene => scene.present).map(scene => scene.tmuxTarget?.serverGeneration));
      if (generations.size > 1 || generations.has(undefined)) {
        throw Object.assign(new Error('tmux changed during observation'), { code: 'TMUX_UNAVAILABLE', cause: 'error' });
      }
      let generation = generations.values().next().value;
      if (!generation) {
        connection = await this.open(this.scenes.connectionOptions);
        generation = connection.serverGeneration;
      }
      // Each scene was already revalidated on its bound connection. Reuse that
      // generation instead of opening another executor and querying tmux twice.
      const result = await this.guard.observeSuccess({ socketKey: this.socketKey,
        readGeneration: () => generation });
      if (!result.cached) return;
      const matching = scenes.filter(scene => scene.tmuxTarget?.serverGeneration === result.generation);
      if (replace) this.cached = matching;
      else if (matching.length) {
        const groups = new Set(matching.map(scene => scene.sessionGroup));
        this.cached = [...(this.cached ?? []).filter(scene => scene.tmuxTarget?.serverGeneration === result.generation && !groups.has(scene.sessionGroup)), ...matching];
      }
    } catch (error) {
      if (error?.code === 'TMUX_NO_SERVER' && !scenes.some(scene => scene.present)) {
        await this.guard.observeNoServer({ socketKey: this.socketKey });
        if (replace) this.cached = [];
        return;
      }
      if (error?.code === 'TMUX_NO_SERVER') throw Object.assign(new Error('tmux changed during observation'), { code: 'TMUX_UNAVAILABLE', cause: 'error' });
      throw error;
    } finally { connection?.close(); }
  }
  async observe(context) {
    try {
      const scenes = await this.scenes.observe(context);
      const unavailable = scenes.find(scene => scene.observationError?.code === 'TMUX_UNAVAILABLE');
      if (unavailable) await this.failure(unavailable.observationError);
      else await this.success(scenes, true);
      return scenes;
    } catch (error) {
      await this.failure(error);
      if (error?.code !== 'TMUX_UNAVAILABLE' || !this.cached?.length) throw error;
      return this.cached.map(scene => ({ ...scene, ready: false, processRunning: undefined,
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
      await this.success(scenes, method === 'listRuns');
      return result;
    } catch (error) { await this.failure(error); throw error; }
  }
  observeGroup(...args) { return this.strict('observeGroup', args); }
  readRun(...args) { return this.strict('readRun', args); }
  listRuns(...args) { return this.strict('listRuns', args); }
  readIdentity(...args) { return this.strict('readIdentity', args); }
  async forward(method, args) {
    try { return await this.scenes[method](...args); }
    catch (error) { await this.failure(error); throw error; }
  }
  bindTarget(...args) { return this.forward('bindTarget', args); }
  readScreen(...args) { return this.forward('readScreen', args); }
  stop(...args) { return this.forward('stop', args); }
  observeFixedTarget(...args) { return this.forward('observeFixedTarget', args); }
  stopFixedTarget(...args) { return this.forward('stopFixedTarget', args); }
  async advance() {
    const result = await this.guard.advance({ socketKey: this.socketKey });
    this.recordExit(result);
    return result;
  }
}
