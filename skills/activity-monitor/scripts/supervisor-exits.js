import fs from 'node:fs/promises';
import { loadCoreModule } from './core-modules.js';
const { handoffPath } = await loadCoreModule('session-group-paths.js');

/** Volatile observations only. Diagnostic history never authorizes a stop. */
export class SupervisorExits {
  constructor({ scenes, db, serialize, readMode, diagnostic, env, reportError = () => {}, stat = fs.stat }) {
    Object.assign(this, { scenes, db, serialize, readMode, diagnostic, env, reportError, stat });
    this.previous = new Map();
  }
  async report(scene) {
    const mode = (await this.readMode()).mode;
    let rotated = false;
    if (scene.runtime === 'codex' && Number.isFinite(scene.currentSessionTs)) {
      try { rotated = (await this.stat(handoffPath(mode === 'single' ? null : scene.sessionGroup, this.env))).mtimeMs > scene.currentSessionTs; }
      catch { /* Handoff is diagnostic evidence only. */ }
    }
    this.diagnostic({ event: rotated ? 'rotate_done' : 'crash_detected', sessionGroup: scene.sessionGroup,
      runId: scene.runId, sessionId: scene.sessionId, runtime: scene.runtime });
  }
  async gated(scene) {
    return await this.db.getModeTransition() || await this.db.getDrainFence('*') || await this.db.getDrainFence(scene.sessionGroup);
  }
  async advance(current) {
    const candidates = new Map();
    const observed = new Map(current.map(scene => [scene.sessionGroup, scene]));
    for (const [group, old] of this.previous) {
      const next = observed.get(group);
      if (!next || next.present === false || (next.runId && next.runId !== old.runId)) candidates.set(group, old);
      else if (next.ready && next.runId === old.runId && next.sessionId !== old.sessionId) {
        this.diagnostic({event:'rotate_done',sessionGroup:group,runId:old.runId,oldSessionId:old.sessionId,sessionId:next.sessionId,runtime:next.runtime});
      }
    }
    for (const scene of current) if (scene.ready && scene.processRunning === false) candidates.set(scene.sessionGroup, scene);
    for (const [group, scene] of candidates) {
      try { await this.serialize(async () => {
        if (await this.gated(scene)) { this.previous.delete(group); return; }
        const fresh = await this.scenes.observeGroup(group);
        if (fresh.present && fresh.runId === scene.runId) {
          if (!fresh.ready || fresh.processRunning !== false) return;
          // adapter.stop resolves only after confirming the requested run is gone.
          await this.scenes.stop(fresh);
        } else if (fresh.present !== false && !fresh.runId) return;
        await this.report(scene);
        if (this.previous.get(group)?.runId === scene.runId) this.previous.delete(group);
      }); } catch(error) { this.reportError(error,{phase:"runtime-exit",sessionGroup:group}); }
    }
    for (const scene of current) if (scene.ready && scene.processRunning !== false) this.previous.set(scene.sessionGroup, scene);
  }
}
