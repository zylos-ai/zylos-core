import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
const { assertSessionGroup, sessionGroupRunRoot } = await loadCoreModule('session-group-paths.js');

/** Persistent run identity authorizes reconciliation; cached observations never do. */
export class SupervisorRunEndings {
  constructor({ db, readIdentity, env, alert, diagnostic, reportError = () => {}, now = Date.now,
    stat = fs.stat, readFile = fs.readFile, readdir = fs.readdir, isObservable = () => true }) {
    Object.assign(this, { db, readIdentity, env, alert, diagnostic, reportError, now, stat, readFile, readdir, isObservable });
    this.files = new Map();
    this.failures = new Map();
    this.shortRuns = new Map();
    this.notices = new Map();
  }

  async currentSession(group) {
    try {
      const file = path.join(sessionGroupRunRoot(this.env), assertSessionGroup(group), 'current-session.json');
      const stat = await this.stat(file, { bigint: true });
      const signature = `${stat.ino}:${stat.size}:${stat.mtimeNs}`;
      const previous = this.files.get(group);
      if (previous?.signature === signature) return previous.value;
      let parsed;
      try { parsed = JSON.parse(await this.readFile(file, 'utf8')); }
      catch (cause) { if (!(cause instanceof SyntaxError)) throw cause; }
      const value = typeof parsed?.runId === 'string' && parsed.runId && Number.isFinite(parsed.ts) ? parsed : null;
      this.files.set(group, { signature, value });
      return value;
    } catch { this.files.delete(group); return null; }
  }

  notify(key, event) {
    const now = this.now();
    if (this.notices.has(key) && now - this.notices.get(key) < 1800000) return;
    this.notices.set(key, now);
    try { this.diagnostic?.(event); } catch (error) { this.reportError(error, { phase: 'run-ending-diagnostic' }); }
    if (this.alert) Promise.resolve().then(() => this.alert(event)).catch(error => {
      this.notices.delete(key); this.reportError(error, { phase: 'run-ending-alert' });
    });
  }

  failure(key, cause, group = '*') {
    const since = this.failures.get(key) ?? this.now();
    this.failures.set(key, since);
    this.reportError(cause, { phase: 'run-ending-reconciliation', sessionGroup: group });
    if (this.now() - since >= 60000) this.notify(`failure:${key}`, {
      event: 'run_ending_reconciliation_failed', session_group: group, reason: cause.code ?? cause.message,
    });
  }

  reset(group) { this.shortRuns.delete(group); }

  async advance(context) {
    if (context.configuration.mode !== 'multi' || context.transition || context.fences.some(row => row.sessionGroup === '*')) return;
    let records, lastDone, entries, fences;
    try {
      if (await this.db.getModeTransition()) return;
      fences = await this.db.listDrainFences();
      if (fences.some(row => row.sessionGroup === '*')) return;
      records = new Map((await this.db.listRunEndings()).map(row => [row.sessionGroup, row]));
      lastDone = await this.db.getLastCompletedModeTransition();
      this.failures.delete('read');
    } catch (cause) {
      for (const key of this.failures.keys()) if (key.startsWith('write:')) this.failures.delete(key);
      this.failure('read', cause); return;
    }
    try { entries = await this.readdir(sessionGroupRunRoot(this.env), { withFileTypes: true }); }
    catch (cause) {
      if (cause.code !== 'ENOENT') this.failure('directories', cause);
      for (const key of this.failures.keys()) if (key.startsWith('write:')) this.failures.delete(key);
      return;
    }
    this.failures.delete('directories');
    const groups = new Set(entries.filter(entry => entry.isDirectory()).map(entry => entry.name));
    for (const key of this.failures.keys()) if (key.startsWith('write:') && !groups.has(key.slice(6))) this.failures.delete(key);
    const multiSince = lastDone?.target_mode === 'multi' ? lastDone.updated_at * 1000 : null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const group = entry.name;
      try { assertSessionGroup(group); } catch { continue; }
      if (records.get(group)?.reason !== 'unexpected') this.reset(group);
      const scene = context.scenes.find(row => row.sessionGroup === group);
      if (!this.isObservable(group) || scene?.observationError || (scene !== undefined && scene.present !== false) || fences.some(row => row.sessionGroup === group)) { this.failures.delete(`write:${group}`); continue; }
      const current = await this.currentSession(group);
      if (!current || multiSince !== null && current.ts < multiSince || records.get(group)?.runId === current.runId) { this.failures.delete(`write:${group}`); continue; }
      let fresh;
      try { fresh = await this.readIdentity(group); }
      catch { this.failures.delete(`write:${group}`); continue; }
      if (!fresh || fresh.observationError || fresh.present !== false) { this.failures.delete(`write:${group}`); continue; }
      try {
        const result = await this.db.recordRunEnd(group, { runId: current.runId, reason: 'unexpected' });
        this.failures.delete(`write:${group}`);
        if (!result.recorded) continue;
        const duration = Math.floor(this.now() / 1000) * 1000 - current.ts;
        if (duration >= 600000) this.reset(group);
        else {
          const count = (this.shortRuns.get(group) ?? 0) + 1;
          this.shortRuns.set(group, count);
          if (count >= 5) this.notify(`short:${group}`, { event: 'repeated_unexpected_run_end', session_group: group, reason: 'five_short_runs' });
        }
      } catch (cause) { this.failure(`write:${group}`, cause, group); }
    }
  }
}
