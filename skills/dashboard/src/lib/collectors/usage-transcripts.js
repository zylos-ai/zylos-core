import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectSlug } from '../claude-project-path.js';

const DAY = 86400000;

export class UsageTranscripts {
  constructor(store, config, { getSnapshot, now = Date.now } = {}) {
    this.store = store;
    this.config = config;
    this.getSnapshot = getSnapshot;
    this.now = now;
    this._lastDiscovery = null;
    this._round = null;
    this._pending = new Map();
    this.snapshot = null;
    this._snapshotAt = null;
    this._legacySessionId = null;
  }

  discover(at = this.now()) {
    const stamp = new Date(at).toISOString();
    const cutoff = new Date(at - 8 * DAY).toISOString();
    let offsets = {};
    try {
      const row = this.store.db.prepare("SELECT extra FROM source_health WHERE name = 'conversation_reader' AND signal_type = 'byte_offset'").get();
      const old = JSON.parse(row?.extra ?? '{}');
      offsets = { ...(old.files ?? {}) };
      if (old.file && Number.isSafeInteger(old.offset)) offsets[old.file] ??= old.offset;
    } catch { /* No previous collector cursor. */ }
    const insert = row => this.store.insertUsageTranscript({ ...row,
      byte_offset: Number.isSafeInteger(offsets[row.transcript_path]) && offsets[row.transcript_path] >= 0
        ? offsets[row.transcript_path] : 0 }, stamp);
    for (const row of this.store.transcriptStartsSince(cutoff)) {
      if (!['claude', 'codex'].includes(row.runtime) || !row.session_id ||
          typeof row.transcript_path !== 'string' || !path.isAbsolute(row.transcript_path) ||
          !row.transcript_path.endsWith('.jsonl')) continue;
      const inserted = insert(row);
      if (row.runtime === 'codex' && inserted.changes === 1) {
        const first = this.store.getUsageTranscript(row.transcript_path);
        this.store.upsertCodexRolloutPath({ sessionId: first.session_id,
          transcriptPath: first.transcript_path, lastEventAt: row.timestamp });
      }
    }
    let mains = this.store.claudeMainTranscripts();
    this._legacySessionId = null;
    try {
      const zylosDir = this.config.zylosDir || path.join(process.env.HOME, 'zylos');
      const status = JSON.parse(fs.readFileSync(path.join(zylosDir, 'activity-monitor', 'statusline.json'), 'utf8'));
      if (status.session_id && !mains.some(main => main.run_id != null || main.session_group != null)) {
        this._legacySessionId = status.session_id;
        if (!mains.some(main => main.session_id === status.session_id)) {
          const file = path.join(this.config.homeDir || process.env.HOME, '.claude', 'projects',
            claudeProjectSlug(zylosDir), `${status.session_id}.jsonl`);
          if (fs.existsSync(file)) insert({ transcript_path: file, runtime: 'claude', session_id: status.session_id });
        }
      }
    } catch { /* Legacy sessions may have no statusline. */ }
    mains = this.store.claudeMainTranscripts();
    for (const main of mains) {
      const dir = path.join(path.dirname(main.transcript_path), main.session_id, 'subagents');
      let names;
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (name.endsWith('.jsonl')) insert({ ...main, transcript_path: path.join(dir, name), parent_path: main.transcript_path });
      }
    }
    for (const row of this.store.missingUsageTranscripts()) {
      try {
        fs.statSync(row.transcript_path);
        this.store.restoreUsageTranscript(row.transcript_path);
      } catch { /* A missing file keeps its original retention deadline. */ }
    }
    this.store.pruneUsageTranscripts(cutoff);
    this._lastDiscovery = at;
  }

  isOriginCurrent(row, snapshot) {
    if (!snapshot || snapshot.listKnown !== true || !['origin', null].includes(row.session_group)) return false;
    const current = this._currentRun(row, snapshot);
    if (row.runtime === 'codex' && row.run_id != null && row.run_id === current) {
      return this.store.currentOriginTranscript('codex', current)?.transcript_path === row.transcript_path;
    }
    return (row.run_id != null && row.run_id === current) ||
      (row.run_id == null && row.session_group == null && row.session_id === this._legacySessionId);
  }

  _currentRun(row, snapshot) {
    const group = row.session_group ?? 'origin';
    return snapshot.rows?.find(item => (item.sessionGroup ?? 'origin') === group)?.live?.runId ?? null;
  }

  currentOriginMapping(runtime) {
    if (!this.snapshot) return null;
    const runId = this._currentRun({ session_group: 'origin' }, this.snapshot);
    return runId == null ? null : this.store.currentOriginTranscript(runtime, runId);
  }

  async _newRound(at) {
    if (this._lastDiscovery == null || at - this._lastDiscovery >= 60000 || at < this._lastDiscovery) this.discover(at);
    let snapshot = this.snapshot;
    if (this._snapshotAt == null || at < this._snapshotAt || at - this._snapshotAt >= 60000) {
      snapshot = null;
      try {
        const candidate = await this.getSnapshot?.(at) ?? null;
        if (candidate?.listKnown === true && candidate.sources?.status?.ok !== false) snapshot = candidate;
      } catch { /* Failed snapshots cannot authorize current-session events or finishing. */ }
      this.snapshot = snapshot;
      this._snapshotAt = snapshot ? at : null;
    }
    return { at, snapshot, rows: this.store.activeUsageTranscripts(50) };
  }

  collect(runtime, callback, at = this.now()) {
    if (this._pending.has(runtime)) return this._pending.get(runtime);
    const pending = this._collect(runtime, callback, at).finally(() => this._pending.delete(runtime));
    this._pending.set(runtime, pending);
    return pending;
  }

  async _collect(runtime, callback, at) {
    // Both runtime pollers consume one shared oldest-file selection.
    if (!this._round || this._round.runtimes.has(runtime) || at < this._round.at) {
      this._round = { at, runtimes: new Set(), data: this._newRound(at) };
    }
    this._round.runtimes.add(runtime);
    const { rows, snapshot } = await this._round.data;
    let written = 0;
    for (const row of rows) {
      if (row.runtime !== runtime) continue;
      const stamp = new Date(at).toISOString();
      let status = 'active', offset = row.byte_offset;
      try {
        fs.statSync(row.transcript_path);
        const result = await callback(row, this.isOriginCurrent(row, snapshot));
        if (typeof result === 'number') offset = result;
        else {
          offset = result?.byteOffset ?? offset;
          written += result?.written ?? 0;
        }
        const stat = fs.statSync(row.transcript_path);
        if (snapshot?.listKnown === true && stat.size === offset && stat.mtimeMs < at - 30 * 60000 &&
            row.run_id !== this._currentRun(row, snapshot)) status = 'finished';
      } catch (error) {
        if (error.code === 'ENOENT') status = 'missing';
        else {
          this.store.updateUsageTranscript(row.transcript_path, { now: stamp });
          throw error;
        }
      }
      this.store.updateUsageTranscript(row.transcript_path, { byte_offset: offset, status, now: stamp });
    }
    return written;
  }
}
