import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadCoreModule } from './core-modules.js';
const { zylosRoot, supervisorDiagnosticPath } = await loadCoreModule('session-group-paths.js');
const { appendEvent } = await loadCoreModule('event-log.js');

const fields = ['scope', 'kind', 'type', 'controlId', 'checkpointId', 'checkpointEnd', 'reason', 'repairAttempt'];
const validCursors = cursors => Array.isArray(cursors) && cursors.every(row =>
  row && !Array.isArray(row) && typeof row.scope === 'string' && row.scope.length > 0 &&
  Number.isSafeInteger(row.syncedId) && row.syncedId >= 0 &&
  Number.isSafeInteger(row.checkpointId) && row.checkpointId >= 0);
const identity = alert => alert && typeof alert === 'object' && !Array.isArray(alert) && typeof alert.scope === 'string' && alert.scope.length > 0 &&
  ['group', 'origin', 'global'].includes(alert.kind) && typeof alert.type === 'string' && alert.type.length > 0 &&
  (alert.type !== 'control_timeout' || Number.isSafeInteger(alert.controlId)) &&
  (alert.cursors === undefined || validCursors(alert.cursors));
export function syncAlertEpisodeKey(alert) {
  if (!identity(alert)) throw new TypeError('Invalid Sync alert episode');
  return JSON.stringify([alert.scope, alert.kind, alert.type, ...(alert.type === 'control_timeout' ? [alert.controlId] : [])]);
}
const evidence = alert => ({
  ...Object.fromEntries(fields.filter(key => alert[key] !== undefined).map(key => [key, alert[key]])),
  ...(alert.cursors === undefined ? {} : { cursors: alert.cursors.map(({ scope, syncedId, checkpointId }) => ({ scope, syncedId, checkpointId })) }),
});

// One supervisor owns this file. Notification claims are durable before enqueue,
// so an interrupted send cannot replay an already claimed episode after restart.
export class SyncAlertEpisodes {
  constructor({ env = process.env, now = Date.now, diagnostic, file } = {}) {
    this.file = file ?? path.join(zylosRoot(env), 'activity-monitor', 'sync-alert-episodes.json');
    this.now = now; this.available = true; this.episodes = new Map();
    this.diagnostic = diagnostic ?? (row => appendEvent(supervisorDiagnosticPath(env), row));
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.version !== 1 || !Array.isArray(stored.episodes)) throw new Error('Invalid episode state');
      for (const item of stored.episodes) {
        if (!identity(item.alert) || typeof item.sent !== 'boolean') throw new Error('Invalid episode entry');
        const key = syncAlertEpisodeKey(item.alert);
        if (this.episodes.has(key)) throw new Error('Duplicate episode entry');
        this.episodes.set(key, { alert: evidence(item.alert), sent: item.sent });
      }
    } catch (error) { if (error.code !== 'ENOENT') this.unavailable(error); }
  }
  unavailable(error) {
    if (!this.available) return;
    this.available = false;
    try { this.diagnostic({ v: 1, ts: this.now(), event: 'sync_alert_state_unavailable', code: error.code || 'INVALID_STATE' }); } catch { /* Remain closed if diagnostics also fail. */ }
  }
  publish(next) {
    if (!this.available) return false;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    let descriptor;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      descriptor = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 1, episodes: [...next.values()] }) + '\n');
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      fs.renameSync(temporary, this.file);
      descriptor = fs.openSync(path.dirname(this.file), 'r');
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); descriptor = undefined;
      this.episodes = next;
      return true;
    } catch (error) {
      if (descriptor !== undefined) try { fs.closeSync(descriptor); } catch { /* Preserve the failure. */ }
      try { fs.unlinkSync(temporary); } catch { /* A failed rename may leave no temporary file. */ }
      this.unavailable(error);
      return false;
    }
  }
  entries() { return [...this.episodes.values()].map(item => ({ ...item.alert, sent: item.sent })); }
  reconcile({ active = [], resolved = [] } = {}) {
    if (!this.available) return [];
    const next = new Map(this.episodes);
    for (const alert of resolved) {
      // A timeout is one permanent episode per control, with no retention cutoff.
      if (alert.type !== 'control_timeout') next.delete(syncAlertEpisodeKey(alert));
    }
    for (const alert of active) {
      const key = syncAlertEpisodeKey(alert), previous = next.get(key);
      next.set(key, { alert: evidence(alert), sent: previous?.sent ?? false });
    }
    if (JSON.stringify([...next]) !== JSON.stringify([...this.episodes]) && !this.publish(next)) return [];
    return active.filter(alert => !this.episodes.get(syncAlertEpisodeKey(alert))?.sent);
  }
  claim(alert) {
    if (!this.available) return false;
    const key = syncAlertEpisodeKey(alert), previous = this.episodes.get(key);
    if (previous?.sent) return false;
    const next = new Map(this.episodes);
    next.set(key, { alert: evidence(alert), sent: true });
    return this.publish(next);
  }
  // Call only when enqueue is known not to have happened. An unknown send outcome
  // keeps its durable claim to favor one notification over duplicate delivery.
  retry(alert) {
    if (!this.available) return false;
    const key = syncAlertEpisodeKey(alert), previous = this.episodes.get(key);
    if (!previous) return true;
    const next = new Map(this.episodes);
    next.set(key, { ...previous, sent: false });
    return this.publish(next);
  }
}
