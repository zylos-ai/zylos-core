import fs from 'node:fs';
import path from 'node:path';
import { loadCoreModule } from './core-modules.js';
import { parseStateHeader } from '../../zylos-memory/scripts/state-format.js';
const { EventLogReader } = await loadCoreModule('event-log.js');
const { supervisorDiagnosticPath, groupMemoryDir, zylosRoot } = await loadCoreModule('session-group-paths.js');

// Recover from the existing rotated diagnostic log; retain only the evidence
// required by each alert, rather than conversation bodies or an unbounded log.
export class SyncObserver {
  constructor({ env = process.env, now = Date.now, warn = () => {} } = {}) {
    this.env = env; this.now = now;
    this.reader = new EventLogReader(supervisorDiagnosticPath(env), { warn });
    this.started = false; this.groups = new Map(); this.originTriggers = [];
    this.originResults = []; this.controls = new Map(); this.resolved = [];
  }
  close() { this.reader.close(); }
  consume(row) {
    if (row.event === 'sync_triggered') {
      if (row.kind === 'origin') {
        this.originTriggers.push(row.ts);
        this.originTriggers = this.originTriggers.filter(ts => ts >= this.now() - 3600000).slice(-5);
      } else {
        const key = JSON.stringify([row.kind, row.scope]);
        const old = this.groups.get(key);
        this.groups.set(key, { ...row, attempts: old?.checkpointId === row.checkpointId ? Math.min(3, old.attempts + 1) : 1 });
      }
      if (Number.isSafeInteger(row.controlId)) this.controls.set(row.controlId, row);
    }
    if (row.event === 'sync_result' && row.kind === 'origin' && row.action === 'round_complete') {
      this.originResults.push(row); this.originResults = this.originResults.slice(-10);
    }
  }
  read(db) {
    if (!this.started) {
      this.started = true;
      // Only the last three triggers per scope and last ten Origin results
      // matter; reverse recovery keeps memory bounded per scope.
      const triggers = new Map(), results = [], timeouts = new Map(), pending = new Map();
      try { this.reader.recoverTail(row => {
        if (row.event === 'sync_triggered') {
          const key = JSON.stringify([row.kind, row.scope]);
          if (Number.isSafeInteger(row.controlId)) {
            const control = db.getControlById(row.controlId);
            if (control?.status === 'timeout') timeouts.set(row.controlId, row);
            if (control && !['done', 'timeout', 'failed', 'cancelled', 'superseded'].includes(control.status)) pending.set(row.controlId, row);
          }
          const rows = triggers.get(key) ?? [];
          const limit = row.kind === 'origin' ? 5 : 3;
          if (rows.length < limit) { rows.push(row); triggers.set(key, rows); }
        }
        if (row.event === 'sync_result' && row.kind === 'origin' && row.action === 'round_complete' && results.length < 10) results.push(row);
        return {};
      }); } catch (error) {
        this.reader.close(); this.started = false; throw error;
      }
      for (const row of [...triggers.values()].flat().concat(results).sort((a, b) => a.ts - b.ts)) this.consume(row);
      // Timeout evidence is independent of the last-three trigger window.
      this.controls = pending;
      for (const row of timeouts.values()) this.controls.set(row.controlId, row);
    } else for (const row of this.reader.read()) this.consume(row);
  }
  acknowledged(alert) { if (alert.type === 'control_timeout') this.controls.delete(alert.controlId); }
  async inspect(db, { mode, syncMaxIntervalSeconds = 21600, activeScopes = [], episodes = [], syncBatchLimit = 200 }, markerHeld = async () => false) {
    this.read(db);
    const alerts = [], now = this.now();
    this.resolved = [];
    // A durable open episode survives loss of its trigger log. Only a newer
    // checkpoint resolves it, including after supervisor/log rotation restarts.
    for (const episode of episodes.filter(row => row.type === 'no_checkpoint')) {
      const checkpoint = await db.getLatestContentCheckpoint(episode.scope);
      if (checkpoint && checkpoint.id > (episode.checkpointId ?? 0)) this.resolved.push(episode);
    }
    for (const [key, row] of this.groups) {
      const checkpoint = await db.getLatestContentCheckpoint(row.scope);
      if (checkpoint && checkpoint.id > (row.checkpointId ?? 0)) { this.groups.delete(key); this.resolved.push({ type: 'no_checkpoint', kind: row.kind, scope: row.scope }); continue; }
      if (row.attempts >= 3) alerts.push({ type: 'no_checkpoint', kind: row.kind, scope: row.scope, attempts: row.attempts, checkpointId: row.checkpointId });
    }
    this.originTriggers = this.originTriggers.filter(ts => ts >= now - 3600000);
    if (this.originTriggers.length > 4) alerts.push({ type: 'origin_frequency', kind: 'origin', scope: 'origin', count: this.originTriggers.length });
    else this.resolved.push({ type: 'origin_frequency', kind: 'origin', scope: 'origin' });
    if (this.originResults.length === 10 && this.originResults.filter(row => row.processedCount === 0 && row.advancedGroups === 0).length > 5) {
      alerts.push({ type: 'origin_idle', kind: 'origin', scope: 'origin', empty: this.originResults.filter(row => row.processedCount === 0 && row.advancedGroups === 0).length, rounds: 10 });
    }
    else if (this.originResults.length === 10) this.resolved.push({ type: 'origin_idle', kind: 'origin', scope: 'origin' });
    for (const [id, row] of this.controls) {
      const control = await db.getControlById(id);
      if (control?.status === 'timeout') alerts.push({ type: 'control_timeout', kind: row.kind, scope: row.scope, controlId: id });
      if (!control || ['done', 'failed', 'cancelled', 'superseded'].includes(control.status)) this.controls.delete(id);
    }
    const scopes = mode === 'single' ? ['*'] : (await db.listGroupHeads()).map(row => row.sessionGroup);
    for (const scope of scopes) {
      const kind = scope === '*' ? 'global' : 'group';
      const range = scope === '*' ? await db.getGlobalUnsummarizedRange() : await db.getUnsummarizedRange(scope);
      const first = range.firstAt == null ? null : typeof range.firstAt === 'number' ? range.firstAt : Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(range.firstAt) ? range.firstAt : range.firstAt.replace(' ', 'T') + 'Z');
      if (!activeScopes.includes(scope) && range.count > 0 && first !== null && now - first > syncMaxIntervalSeconds * 1000) {
        alerts.push({ type: 'backlog', kind, scope, backlog: range.count, lag: Math.floor((now - first) / 1000) });
      }
      const resolvedLag = activeScopes.includes(scope) ? 2 * syncMaxIntervalSeconds : syncMaxIntervalSeconds;
      if (range.count === 0 || (range.count <= 4 * syncBatchLimit && first !== null && now - first <= resolvedLag * 1000)) {
        this.resolved.push({ type: 'backlog', kind, scope });
      }
      const checkpoint = await db.getLatestContentCheckpoint(scope);
      if (!checkpoint) continue;
      const state = scope === '*' ? path.join(zylosRoot(this.env), 'memory', 'state.md') : path.join(groupMemoryDir(scope, this.env), 'state.md');
      let text;
      try { text = fs.readFileSync(state, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; text = ''; }
      const header = parseStateHeader(text, { scope });
      if (header.valid && (header.coverage ?? 0) >= checkpoint.end_conversation_id) {
        this.resolved.push({ type: 'state_uncommitted', kind, scope });
      } else if (!await markerHeld(scope, kind)) {
        alerts.push({ type: 'state_uncommitted', kind, scope, checkpointId: checkpoint.id, coverage: header.coverage, checkpointEnd: checkpoint.end_conversation_id });
      }
    }
    return alerts;
  }
}
