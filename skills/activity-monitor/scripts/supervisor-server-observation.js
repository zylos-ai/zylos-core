import { loadCoreModule } from './core-modules.js';
const { openTmuxConnection, serverGeneration } = await loadCoreModule('runtime/tmux-connection.js');

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
  constructor(scenes, { guard, socketKey = 'default', open = openTmuxConnection,
    readGeneration = serverGeneration } = {}) {
    Object.assign(this, { scenes, guard, socketKey, open, readGeneration });
    this.cached = null;
    this.exits = new Map();
    this.reported = new Set();
    // Preserve the scene provider interface and property injection without copying
    // methods that rely on the provider's own identity or private state.
    return new Proxy(this, {
      get: (target, key) => {
        const owner = key in target ? target : scenes;
        const value = owner[key];
        return typeof value === 'function' ? value.bind(owner) : value;
      },
      set: (target, key, value) => {
        (key in target ? target : scenes)[key] = value;
        return true;
      },
    });
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
      connection = await this.open(this.scenes.connectionOptions);
      const result = await this.guard.observeSuccess({ socketKey: this.socketKey,
        readGeneration: () => this.readGeneration(connection) });
      if (scenes.some(scene => scene.ready && scene.tmuxTarget?.serverGeneration !== result.generation)) {
        throw Object.assign(new Error('tmux changed during observation'), { code: 'TMUX_UNAVAILABLE', cause: 'error' });
      }
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
      await this.success(Array.isArray(result) ? result : result ? [result] : [], method === 'listRuns');
      return result;
    } catch (error) { await this.failure(error); throw error; }
  }
  observeGroup(...args) { return this.strict('observeGroup', args); }
  readRun(...args) { return this.strict('readRun', args); }
  listRuns(...args) { return this.strict('listRuns', args); }
  async advance() {
    const result = await this.guard.advance({ socketKey: this.socketKey });
    this.recordExit(result);
    return result;
  }
}
