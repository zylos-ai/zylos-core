import fs from 'node:fs';
import path from 'node:path';
import { claudeProjectSlug } from '../claude-project-path.js';
import { sameSourceFile } from '../source-file-identity.js';
import { loadCoreModule } from '../core-modules.js';

const { runtimesWith } = await loadCoreModule('runtime/descriptors.js');

const DAY = 86400000;
const INACTIVE_MS = 30 * 60000;
// Healthy snapshots reuse existing identity/lifecycle signals between refreshes.
const SNAPSHOT_FALLBACK_MS = 10 * 60000;
// Persisted lifecycle signals still work when Origin is asleep and costKey is
// unavailable. Turn stops and tool events do not change a session's identity.
const SESSION_LIFECYCLE_EVENTS = ['session_start', 'activate_new', 'start_always',
  'activate_continuation', 'adopt_ready', 'activate_failed', 'activate_timeout',
  'reclaim_done', 'rotate_done', 'crash_detected', 'manual_restart_done', 'unowned_start_stopped'];

/** A non-origin group's own main transcript (not a subagent file): its assistant words belong to that group. */
export function groupMainTranscript(mapping) {
  return !mapping?.parent_path && mapping?.kind !== 'child' &&
    typeof mapping?.session_group === 'string' && mapping.session_group !== 'origin';
}

/** A child runtime's transcript (and its subagents): counted for cost only. */
export const childTranscript = mapping => mapping?.kind === 'child';

export class UsageTranscripts {
  constructor(store, config, { getSnapshot, getSnapshotKey, now = Date.now } = {}) {
    this.store = store;
    this.config = config;
    this.getSnapshot = getSnapshot;
    this.getSnapshotKey = getSnapshotKey;
    this._lifecycleSequence = null;
    this._lastLiveSnapshotKey = null;
    this.now = now;
    this._lastDiscovery = null;
    this._round = null;
    this._pending = new Map();
    this.snapshot = null;
    this._snapshotAt = null;
    this._snapshotKey = undefined;
    this._legacySessionId = null;
    this._legacyStatusStale = false;
    this._lastChecked = new Map();
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
      if (!runtimesWith('usage').includes(row.runtime) || !row.session_id ||
          typeof row.transcript_path !== 'string' || !path.isAbsolute(row.transcript_path) ||
          !row.transcript_path.endsWith('.jsonl')) continue;
      const inserted = insert(row);
      if (row.runtime === 'codex' && inserted.changes === 1 && ['origin', null].includes(row.session_group)) {
        const first = this.store.getUsageTranscript(row.transcript_path);
        this.store.upsertCodexRolloutPath({ sessionId: first.session_id,
          transcriptPath: first.transcript_path, lastEventAt: row.timestamp });
      }
    }
    let mains = this.store.claudeMainTranscripts();
    this._legacySessionId = null;
    this._legacyStatusStale = false;
    try {
      const zylosDir = this.config.zylosDir || path.join(process.env.HOME, 'zylos');
      const statusFile = path.join(zylosDir, 'activity-monitor', 'statusline.json');
      const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
      // A legacy statusline left behind by multi-session startup is not liveness.
      if (status.session_id) {
        this._legacySessionId = status.session_id;
        this._legacyStatusStale = fs.statSync(statusFile).mtimeMs < at - INACTIVE_MS;
        if (!this._legacyStatusStale && !mains.some(main => main.session_id === status.session_id)) {
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
    if (!snapshot || childTranscript(row) || !['origin', null].includes(row.session_group)) return false;
    const current = this._currentRun(row, snapshot);
    if (row.runtime === 'codex' && row.run_id != null && row.run_id === current) {
      return this.store.currentOriginTranscript('codex', current)?.transcript_path === row.transcript_path;
    }
    return (row.run_id != null && row.run_id === current) ||
      (row.run_id == null && row.session_group == null && !this._legacyStatusStale &&
        row.session_id === this._legacySessionId);
  }

  _currentRun(row, snapshot) {
    const group = row.session_group ?? 'origin';
    return snapshot.rows?.find(item => (item.sessionGroup ?? 'origin') === group)?.live?.runId ?? null;
  }

  async _newRound(at) {
    if (this._round && at < this._round.at) this._lastChecked.clear();
    const discoveryDue = this._lastDiscovery == null || at - this._lastDiscovery >= 60000 || at < this._lastDiscovery;
    if (discoveryDue) this.discover(at);
    const snapshotKey = this._readSnapshotKey();
    let snapshot = this.snapshot;
    // A known group list can still carry an unreadable Origin observation.
    // Retry those snapshots at the previous cadence so lost current summaries
    // are not extended by the healthy snapshot's ten-minute cache.
    const snapshotTtl = snapshot?.rows?.some(row => (row.sessionGroup ?? 'origin') === 'origin' &&
      (!row.live || row.live.error || row.presence === 'unknown')) ? 60000 : SNAPSHOT_FALLBACK_MS;
    if (this._snapshotAt == null || at < this._snapshotAt ||
        at - this._snapshotAt >= snapshotTtl || snapshotKey !== this._snapshotKey) {
      snapshot = null;
      let matchedKey;
      try {
        const candidate = await this.getSnapshot?.(at) ?? null;
        const latestKey = this._readSnapshotKey();
        if (candidate?.listKnown === true) {
          // A signal change does not invalidate a successful read. Suppressing
          // it would drop assistant events while their transcript cursor advances.
          snapshot = candidate;
          if (snapshotKey !== null && latestKey !== null && snapshotKey === latestKey) matchedKey = snapshotKey;
        }
      } catch { /* Failed snapshots cannot authorize current-session events or finishing. */ }
      this.snapshot = snapshot;
      this._snapshotAt = snapshot ? at : null;
      this._snapshotKey = matchedKey; // An unmatched key forces the next round to refresh.
    }
    const active = this.store.activeUsageTranscripts(-1);
    const paths = new Set(active.map(row => row.transcript_path));
    for (const file of this._lastChecked.keys()) {
      if (!paths.has(file)) this._lastChecked.delete(file);
    }
    active.sort((a, b) => (this._lastChecked.get(a.transcript_path) ?? -Infinity) -
      (this._lastChecked.get(b.transcript_path) ?? -Infinity) || a.transcript_path.localeCompare(b.transcript_path));
    const rows = active.slice(0, 50);
    for (const row of rows) this._lastChecked.set(row.transcript_path, at);
    return { at, snapshot, rows };
  }

  _readSnapshotKey() {
    try {
      const liveKey = this.getSnapshotKey?.();
      // An unavailable observation is not a new identity. Lifecycle events and
      // the fallback still detect changes while the live signal is absent.
      if (liveKey != null) this._lastLiveSnapshotKey = liveKey;
    }
    catch { /* The persisted lifecycle signal and fallback remain available. */ }
    try {
      this._lifecycleSequence ??= this.store.db.prepare(`SELECT event_seq,id FROM runtime_events
        WHERE source='core-log' AND event_type IN (${SESSION_LIFECYCLE_EVENTS.map(() => '?').join(',')})
        ORDER BY event_seq DESC LIMIT 1`);
      const event = this._lifecycleSequence.get(...SESSION_LIFECYCLE_EVENTS);
      // Deletion can reduce/reuse event_seq; the event ID also distinguishes a
      // newly imported lifecycle observation at a previously used sequence.
      return JSON.stringify([this._lastLiveSnapshotKey, event?.event_seq ?? null, event?.id ?? null]);
    }
    catch { return null; } // Unknown signals force another read; they do not veto valid Core facts.
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
      // A stopped runtime poller must not hold completed progress indefinitely.
      this._flushRound(this._round);
      this._round = { at, runtimes: new Set(), completed: new Set(), updates: [], data: this._newRound(at) };
    }
    const round = this._round;
    round.runtimes.add(runtime);
    const { rows, snapshot } = await round.data;
    let written = 0;
    let succeeded = false;
    try {
      for (const row of rows) {
        if (row.runtime !== runtime) continue;
        const stamp = new Date(at).toISOString();
        let status = 'active', offset = row.byte_offset, identity = null;
        try {
          identity = fs.statSync(row.transcript_path);
          const result = await callback(row, this.isOriginCurrent(row, snapshot));
          if (typeof result === 'number') offset = result;
          else {
            offset = result?.byteOffset ?? offset;
            written += result?.written ?? 0;
          }
          const stat = fs.statSync(row.transcript_path);
          const ended = snapshot && (row.runtime === 'claude' && row.run_id == null &&
            row.session_group == null && this._legacySessionId != null
            ? this._legacyStatusStale || row.session_id !== this._legacySessionId
            : row.run_id !== this._currentRun(row, snapshot));
          const ownershipKnown = !snapshot?.transcriptIdentityOnly || this._currentRun(row, snapshot) !== null;
          if (snapshot && ownershipKnown && stat.size === offset && stat.mtimeMs < at - INACTIVE_MS && ended) status = 'finished';
        } catch (error) {
          if (error.code === 'ENOENT') status = 'missing';
          else throw error;
        }
        if (offset !== row.byte_offset || status !== row.status) round.updates.push({ row, offset, status, identity, stamp });
      }
      succeeded = true;
    } finally {
      round.completed.add(runtime);
      if (!succeeded || rows.every(row => round.completed.has(row.runtime))) this._flushRound(round);
    }
    return written;
  }

  _flushRound(round) {
    if (!round?.updates.length) return;
    this.store.db.transaction(() => {
      for (const { row, offset, status, identity, stamp } of round.updates) {
        // Deletion may finalize a mapping while its callback awaits. Preserve
        // that EOF proof and never put an old cursor onto a replacement file.
        const current = this.store.getUsageTranscript(row.transcript_path);
        if (!current || current.status === 'finished' || current.byte_offset !== row.byte_offset) continue;
        if (identity && !sameSourceFile(row.transcript_path, identity)) continue;
        if (current.byte_offset === offset && current.status === status) continue;
        this.store.updateUsageTranscript(row.transcript_path, { byte_offset: offset, status, now: stamp });
      }
    }).immediate();
    round.updates.length = 0;
  }
}
