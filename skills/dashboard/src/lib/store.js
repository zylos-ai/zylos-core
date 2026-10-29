import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';

import { migrateDatabase } from './schema.js';

export class Store {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(dbPath);
    // Empty databases can enable pointer maps without rewriting existing data.
    if (this.db.pragma('page_count', { simple: true }) === 0) {
      this.db.pragma('auto_vacuum = INCREMENTAL');
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    try {
      this.migrate();
      this._prepareStatements();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  migrate() {
    migrateDatabase(this.db);
  }

  _prepareStatements() {
    this._insertEvent = this.db.prepare(`
      INSERT OR IGNORE INTO runtime_events
        (id, ingest_id, event_seq, timestamp, runtime, session_id, event_type, category, summary, duration_ms, metadata, source, confidence)
      VALUES
        (@id, @ingest_id, @event_seq, @timestamp, @runtime, @session_id, @event_type, @category, @summary, @duration_ms, @metadata, @source, @confidence)
    `);

    this._nextSeq = this.db.prepare('SELECT COALESCE(MAX(event_seq), 0) + 1 AS seq FROM runtime_events');

    this._queryEvents = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until
      ORDER BY event_seq ASC
      LIMIT @limit OFFSET @offset
    `);

    this._queryEventsDesc = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until
      ORDER BY event_seq DESC
      LIMIT @limit OFFSET @offset
    `);

    this._queryEventsByType = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until AND event_type = @event_type
      ORDER BY event_seq ASC
      LIMIT @limit OFFSET @offset
    `);

    this._queryEventsByTypeDesc = this.db.prepare(`
      SELECT * FROM runtime_events
      WHERE timestamp >= @since AND timestamp <= @until AND event_type = @event_type
      ORDER BY event_seq DESC
      LIMIT @limit OFFSET @offset
    `);

    this._latestEventByType = this.db.prepare(`
      SELECT * FROM runtime_events WHERE event_type = ? ORDER BY event_seq DESC LIMIT 1
    `);

    this._eventsSince = this.db.prepare(`
      SELECT * FROM runtime_events WHERE event_seq > ? ORDER BY event_seq ASC
    `);

    this._deleteOldEvents = this.db.prepare(`
      DELETE FROM runtime_events WHERE timestamp < datetime(@anchor, '-' || @days || ' days')
    `);

    this._insertMetric = this.db.prepare(`
      INSERT INTO metric_points (timestamp, runtime, session_id, metric_name, metric_value, dimensions, source, confidence)
      VALUES (@timestamp, @runtime, @session_id, @metric_name, @metric_value, @dimensions, @source, @confidence)
    `);

    this._insertMetricIgnore = this.db.prepare(`
      INSERT OR IGNORE INTO metric_points (timestamp, runtime, session_id, metric_name, metric_value, dimensions, source, confidence)
      VALUES (@timestamp, @runtime, @session_id, @metric_name, @metric_value, @dimensions, @source, @confidence)
    `);

    this._updateMetric = this.db.prepare(`
      UPDATE metric_points
         SET metric_value = COALESCE(@metric_value, metric_value),
             dimensions   = COALESCE(@dimensions, dimensions),
             timestamp    = COALESCE(@timestamp, timestamp),
             session_id   = CASE WHEN @timestamp IS NOT NULL THEN @session_id ELSE session_id END
       WHERE id = @id
    `);

    this._metricExistsByEventId = this.db.prepare(`
      SELECT 1 FROM metric_points
      WHERE metric_name = @metric_name
        AND COALESCE(session_id, '') = COALESCE(@session_id, '')
        AND source = @source
        AND json_extract(dimensions, '$.event_id') = @event_id
      LIMIT 1
    `);

    this._queryMetrics = this.db.prepare(`
      SELECT * FROM metric_points
      WHERE metric_name = @name AND timestamp >= @since AND timestamp <= @until
      ORDER BY timestamp ASC
    `);

    this._latestMetric = this.db.prepare(`
      SELECT * FROM metric_points
      WHERE metric_name = @name AND source = @source
        AND timestamp >= @since AND timestamp <= @until
        AND (@runtime IS NULL OR COALESCE(NULLIF(runtime, ''), 'claude') = @runtime)
      ORDER BY timestamp DESC, id DESC LIMIT 1
    `);

    this._deleteOldMetrics = this.db.prepare(`
      DELETE FROM metric_points WHERE timestamp < datetime('now', '-' || ? || ' days')
    `);

    this._deletePm2Metrics = this.db.prepare(`
      DELETE FROM metric_points WHERE metric_name LIKE 'pm2_%' AND timestamp < datetime('now', '-' || ? || ' days')
    `);

    this._deleteMetricsByNameAndSource = this.db.prepare(`
      DELETE FROM metric_points
      WHERE metric_name LIKE @metric_name_pattern
        AND source LIKE @source_pattern
        AND timestamp < datetime(@anchor, '-' || @days || ' days')
    `);

    this._deleteMetricsByName = this.db.prepare(`
      DELETE FROM metric_points
      WHERE metric_name LIKE @metric_name_pattern
        AND timestamp < datetime('now', '-' || @days || ' days')
    `);

    this._deleteMetricsExcludingPatterns = this.db.prepare(`
      DELETE FROM metric_points
      WHERE timestamp < datetime(@anchor, '-' || @days || ' days')
        AND metric_name NOT IN ('usage_event', 'statusline_summary', 'system_summary', 'pm2_summary', 'ttft', 'turn_duration')
        AND metric_name NOT LIKE 'pm2_%'
        AND source NOT LIKE 'otel%'
    `);

    this._upsertPm2State = this.db.prepare(`
      INSERT INTO pm2_latest_state
        (process_name, status, cpu, memory_bytes, restarts, uptime_ms, updated_at)
      VALUES
        (@process_name, @status, @cpu, @memory_bytes, @restarts, @uptime_ms, @updated_at)
      ON CONFLICT(process_name) DO UPDATE SET
        status = @status,
        cpu = @cpu,
        memory_bytes = @memory_bytes,
        restarts = @restarts,
        uptime_ms = @uptime_ms,
        updated_at = @updated_at
    `);

    this._getAllPm2State = this.db.prepare(`
      SELECT * FROM pm2_latest_state ORDER BY process_name ASC
    `);

    this._deleteOldSnapshots = this.db.prepare(`
      DELETE FROM state_snapshots WHERE snapshot_at < datetime(@anchor, '-' || @days || ' days')
    `);

    this._insertFact = this.db.prepare(`
      INSERT INTO activity_facts (timestamp, fact_type, runtime, session_id, project, data)
      VALUES (@timestamp, @fact_type, @runtime, @session_id, @project, @data)
    `);

    this._queryFacts = this.db.prepare(`
      SELECT * FROM activity_facts
      WHERE timestamp >= @since AND timestamp <= @until
      ORDER BY timestamp DESC
      LIMIT @limit
    `);

    this._deleteOldFacts = this.db.prepare(`
      DELETE FROM activity_facts WHERE timestamp < datetime(@anchor, '-' || @days || ' days')
    `);

    this._upsertSourceHealth = this.db.prepare(`
      INSERT INTO source_health (name, signal_type, status, extra, updated_at)
      VALUES (@name, @signal_type, @status, @extra, datetime('now'))
      ON CONFLICT(name, signal_type) DO UPDATE SET
        status = @status, extra = @extra, updated_at = datetime('now')
    `);

    this._getSourceHealth = this.db.prepare('SELECT * FROM source_health');

    this._getCollectorLiveness = this.db.prepare(
      "SELECT * FROM source_health WHERE signal_type = 'collector_liveness'"
    );

    this._saveSnapshot = this.db.prepare(`
      INSERT INTO state_snapshots
        (runtime, session_id, running_tool, open_turn, pending_permission, possibly_stuck_since, last_progress_cursor, last_message, last_prompt, last_progress_at)
      VALUES
        (@runtime, @session_id, @running_tool, @open_turn, @pending_permission, @possibly_stuck_since, @last_progress_cursor, @last_message, @last_prompt, @last_progress_at)
    `);

    this._latestSnapshot = this.db.prepare(`
      SELECT * FROM state_snapshots
      WHERE runtime = @runtime AND (session_id = @session_id OR (@session_id IS NULL AND session_id IS NULL))
      ORDER BY snapshot_at DESC LIMIT 1
    `);

    this._insertSession = this.db.prepare(
      'INSERT OR REPLACE INTO auth_sessions (token_hash, created_at, last_activity_at, remember) VALUES (?, ?, ?, ?)'
    );
    this._getSession = this.db.prepare(
      'SELECT * FROM auth_sessions WHERE token_hash = ?'
    );
    this._touchSession = this.db.prepare(
      'UPDATE auth_sessions SET last_activity_at = ? WHERE token_hash = ?'
    );
    this._deleteSession = this.db.prepare(
      'DELETE FROM auth_sessions WHERE token_hash = ?'
    );
    this._cleanupSessions = this.db.prepare(
      'DELETE FROM auth_sessions WHERE created_at < ? OR last_activity_at < ?'
    );

    this._upsertCodexRolloutPath = this.db.prepare(`
      INSERT INTO codex_rollout_paths (runtime, session_id, transcript_path, last_event_at, updated_at)
      VALUES (@runtime, @session_id, @transcript_path, @last_event_at, datetime('now'))
      ON CONFLICT(runtime, session_id) DO UPDATE SET
        transcript_path = @transcript_path,
        last_event_at = @last_event_at,
        updated_at = datetime('now')
    `);

    this._latestCodexRolloutPath = this.db.prepare(`
      SELECT * FROM codex_rollout_paths
      WHERE runtime = @runtime
      ORDER BY updated_at DESC
      LIMIT 1
    `);

    this._getCodexRolloutCursor = this.db.prepare(`
      SELECT * FROM codex_rollout_cursors WHERE transcript_path = ?
    `);

    this._upsertCodexRolloutCursor = this.db.prepare(`
      INSERT INTO codex_rollout_cursors (transcript_path, byte_offset, session_id, updated_at)
      VALUES (@transcript_path, @byte_offset, @session_id, datetime('now'))
      ON CONFLICT(transcript_path) DO UPDATE SET
        byte_offset = @byte_offset,
        session_id = @session_id,
        updated_at = datetime('now')
    `);

    this._insertApiKey = this.db.prepare(`
      INSERT INTO api_keys (name, key_hash, scope)
      VALUES (@name, @key_hash, @scope)
    `);

    this._getApiKeyByHash = this.db.prepare(`
      SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL
    `);

    this._listActiveApiKeys = this.db.prepare(`
      SELECT * FROM api_keys WHERE revoked_at IS NULL
    `);

    this._getApiKeyByName = this.db.prepare(`
      SELECT * FROM api_keys WHERE name = ? AND revoked_at IS NULL
    `);

    this._countRevokedApiKeysByName = this.db.prepare(`
      SELECT COUNT(*) AS count FROM api_keys WHERE name = ? AND revoked_at IS NOT NULL
    `);

    this._listApiKeys = this.db.prepare(`
      SELECT id, name, scope, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at DESC
    `);

    this._revokeApiKey = this.db.prepare(`
      UPDATE api_keys SET revoked_at = datetime('now') WHERE name = ? AND revoked_at IS NULL
    `);

    this._updateApiKeyHash = this.db.prepare(`
      UPDATE api_keys SET key_hash = ? WHERE id = ? AND revoked_at IS NULL
    `);

    this._touchApiKey = this.db.prepare(`
      UPDATE api_keys SET last_used_at = datetime('now') WHERE id = ?
    `);

    this._insertApiSession = this.db.prepare(`
      INSERT INTO api_sessions (token_hash, api_key_id, scope, created_at, expires_at)
      VALUES (@token_hash, @api_key_id, @scope, @created_at, @expires_at)
    `);

    this._getApiSession = this.db.prepare(`
      SELECT s.*, k.revoked_at AS key_revoked_at FROM api_sessions s
      JOIN api_keys k ON s.api_key_id = k.id
      WHERE s.token_hash = ?
    `);

    this._deleteExpiredApiSessions = this.db.prepare(`
      DELETE FROM api_sessions WHERE expires_at < ?
    `);

    this._deleteApiSessionsForKey = this.db.prepare(`
      DELETE FROM api_sessions WHERE api_key_id = ?
    `);

    this._deleteApiSessionsForRevokedName = this.db.prepare(`
      DELETE FROM api_sessions
      WHERE api_key_id IN (
        SELECT id FROM api_keys WHERE name = ? AND revoked_at IS NOT NULL
      )
    `);

    this._deleteRevokedApiKeysByName = this.db.prepare(`
      DELETE FROM api_keys WHERE name = ? AND revoked_at IS NOT NULL
    `);

    this._deleteApiSessionsForRevokedKeys = this.db.prepare(`
      DELETE FROM api_sessions
      WHERE api_key_id IN (
        SELECT id FROM api_keys WHERE revoked_at IS NOT NULL
      )
    `);

    this._deleteRevokedApiKeys = this.db.prepare(`
      DELETE FROM api_keys WHERE revoked_at IS NOT NULL
    `);

    this._rotateApiKeyTx = this.db.transaction((name, keyHash) => {
      const key = this._getApiKeyByName.get(name);
      if (!key) return null;
      this._updateApiKeyHash.run(keyHash, key.id);
      this._deleteApiSessionsForKey.run(key.id);
      return this._getApiKeyByName.get(name) || null;
    });

    this._hardDeleteApiKeyTx = this.db.transaction((name) => {
      const active = this._getApiKeyByName.get(name);
      const revokedCount = this._countRevokedApiKeysByName.get(name)?.count || 0;
      if (!revokedCount) return { active: !!active, deleted: 0 };
      this._deleteApiSessionsForRevokedName.run(name);
      const result = this._deleteRevokedApiKeysByName.run(name);
      return { active: !!active, deleted: result.changes };
    });

    this._purgeRevokedApiKeysTx = this.db.transaction(() => {
      this._deleteApiSessionsForRevokedKeys.run();
      const result = this._deleteRevokedApiKeys.run();
      return result.changes;
    });
  }

  insertEvent(event) {
    const seq = this._nextSeq.get().seq;
    const info = this._insertEvent.run({
      id: event.id,
      ingest_id: event.ingest_id,
      event_seq: seq,
      timestamp: event.timestamp,
      runtime: event.runtime || 'claude',
      session_id: event.session_id || null,
      event_type: event.event_type,
      category: event.category,
      summary: event.summary || null,
      duration_ms: event.duration_ms || null,
      metadata: event.metadata ? JSON.stringify(event.metadata) : null,
      source: event.source || 'hook',
      confidence: event.confidence || 'actual'
    });
    return { inserted: info.changes > 0, event_seq: seq };
  }

  queryEvents({ since, until, types, sessionId, limit = 100, offset = 0, order = 'asc' }) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';
    const desc = order === 'desc';

    if (types && types.length === 1) {
      const stmt = desc ? this._queryEventsByTypeDesc : this._queryEventsByType;
      return stmt.all({ since: s, until: u, event_type: types[0], limit, offset })
        .map(this._parseEventRow);
    }

    let rows = (desc ? this._queryEventsDesc : this._queryEvents).all({ since: s, until: u, limit, offset });
    if (types && types.length > 0) {
      const typeSet = new Set(types);
      rows = rows.filter(r => typeSet.has(r.event_type));
    }
    if (sessionId) {
      rows = rows.filter(r => r.session_id === sessionId);
    }
    return rows.map(this._parseEventRow);
  }

  latestEventByType(eventType) {
    const row = this._latestEventByType.get(eventType);
    return row ? this._parseEventRow(row) : null;
  }

  eventsSince(eventSeq) {
    return this._eventsSince.all(eventSeq).map(this._parseEventRow);
  }

  deleteEventsOlderThan(days, anchor = 'now') {
    return this._deleteOldEvents.run({ days, anchor });
  }

  insertMetric(point) {
    return this._runMetricInsert(this._insertMetric, point);
  }

  insertMetricOnce(point) {
    return this._runMetricInsert(this._insertMetricIgnore, point);
  }

  // Correct a metric row in place. Used when a single logical event is observed
  // more than once and the later observation is the more complete one.
  // An optional timestamp/session_id pair replaces attribution atomically;
  // omitting timestamp preserves both, including for existing partial updates.
  updateMetric(id, { metric_value, dimensions, timestamp, session_id } = {}) {
    if (!id) return { updated: false };
    const info = this._updateMetric.run({
      id,
      metric_value: metric_value ?? null,
      dimensions: dimensions ? JSON.stringify(dimensions) : null,
      timestamp: timestamp ?? null,
      session_id: session_id || null
    });
    return { updated: info.changes > 0, changes: info.changes };
  }

  _runMetricInsert(stmt, point) {
    const info = stmt.run({
      timestamp: point.timestamp,
      runtime: point.runtime || 'claude',
      session_id: point.session_id || null,
      metric_name: point.metric_name,
      metric_value: point.metric_value,
      dimensions: point.dimensions ? JSON.stringify(point.dimensions) : null,
      source: point.source,
      confidence: point.confidence || 'actual'
    });
    return { inserted: info.changes > 0, changes: info.changes };
  }

  hasMetricEventId({ metricName, sessionId, source, eventId }) {
    if (!metricName || !source || !eventId) return false;
    return !!this._metricExistsByEventId.get({
      metric_name: metricName,
      session_id: sessionId || null,
      source,
      event_id: eventId
    });
  }

  queryMetrics({ name, since, until }) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';
    return this._queryMetrics.all({ name, since: s, until: u }).map(row => ({
      ...row,
      dimensions: row.dimensions ? JSON.parse(row.dimensions) : null
    }));
  }

  latestMetric({ name, source, since, until, runtime = null }) {
    const row = this._latestMetric.get({ name, source, runtime,
      since: since || '1970-01-01T00:00:00Z', until: until || '2099-12-31T23:59:59Z' });
    return row ? { ...row, dimensions: row.dimensions ? JSON.parse(row.dimensions) : null } : null;
  }

  deleteMetricsOlderThan(days) {
    return this._deleteOldMetrics.run(days);
  }

  deletePm2MetricsOlderThan(days) {
    return this._deletePm2Metrics.run(days);
  }

  deleteMetricsByNameAndSource(metricNamePattern, sourcePattern, days, anchor = 'now') {
    return this._deleteMetricsByNameAndSource.run({
      metric_name_pattern: metricNamePattern,
      source_pattern: sourcePattern,
      days,
      anchor
    });
  }

  deleteMetricsByName(metricNamePattern, days) {
    return this._deleteMetricsByName.run({
      metric_name_pattern: metricNamePattern,
      days
    });
  }

  deleteOtherLegacyMetricsOlderThan(days, anchor = 'now') {
    return this._deleteMetricsExcludingPatterns.run({ days, anchor });
  }

  upsertPm2State(processName, state = {}) {
    if (!processName) return { changes: 0 };
    const info = this._upsertPm2State.run({
      process_name: processName,
      status: state.status || 'unknown',
      cpu: Number(state.cpu) || 0,
      memory_bytes: Math.max(0, Math.floor(Number(state.memory_bytes ?? state.memory) || 0)),
      restarts: Math.max(0, Math.floor(Number(state.restarts) || 0)),
      uptime_ms: Math.max(0, Math.floor(Number(state.uptime_ms ?? state.uptime) || 0)),
      updated_at: state.updated_at || new Date().toISOString()
    });
    return { changes: info.changes };
  }

  getAllPm2State() {
    return this._getAllPm2State.all().map(row => ({
      process_name: row.process_name,
      name: row.process_name,
      status: row.status,
      cpu: row.cpu,
      memory_bytes: row.memory_bytes,
      memory: row.memory_bytes,
      restarts: row.restarts,
      uptime_ms: row.uptime_ms,
      uptime: row.uptime_ms,
      updated_at: row.updated_at
    }));
  }

  deleteSnapshotsOlderThan(days, anchor = 'now') {
    return this._deleteOldSnapshots.run({ days, anchor });
  }

  walCheckpoint() {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  dbSizeBytes() {
    try {
      const row = this.db.prepare('PRAGMA database_list').all().find(r => r.name === 'main');
      if (!row?.file) return 0;
      return fs.statSync(row.file).size;
    } catch {
      return 0;
    }
  }

  vacuum() {
    this.db.exec('VACUUM');
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.pragma('optimize');
    return { vacuumed: true };
  }

  autoVacuumMode() {
    return this.db.pragma('auto_vacuum', { simple: true });
  }

  spaceUsage() {
    const pageCount = this.db.pragma('page_count', { simple: true });
    const freePages = this.db.pragma('freelist_count', { simple: true });
    const pageSize = this.db.pragma('page_size', { simple: true });
    return { pageCount, freePages, pageSize, effectiveBytes: (pageCount - freePages) * pageSize };
  }

  diskFreeBytes() {
    const file = this.db.prepare('PRAGMA database_list').all().find(row => row.name === 'main')?.file;
    if (!file) return null;
    const stats = fs.statfsSync(path.dirname(file));
    return stats.bavail * stats.bsize;
  }

  enableIncrementalVacuum(maxEffectiveBytes = 2 * 1024 * 1024 * 1024) {
    const mode = this.autoVacuumMode();
    if (mode === 2) return { converted: false, alreadyEnabled: true };
    const { effectiveBytes } = this.spaceUsage();
    let freeBytes = null;
    try { freeBytes = this.diskFreeBytes(); } catch { /* Skip when free space cannot be verified. */ }
    const reason = effectiveBytes > maxEffectiveBytes ? 'effective_data_too_large'
      : !Number.isFinite(freeBytes) ? 'disk_space_unknown'
        : freeBytes < effectiveBytes * 2 ? 'insufficient_disk_space' : null;
    if (reason) return { converted: false, skipped: true, reason, effectiveBytes, freeBytes };
    this.db.pragma('auto_vacuum = INCREMENTAL');
    // FULL already has pointer maps. NONE needs a single rewrite to create them.
    if (mode === 0) this.vacuum();
    return { converted: true, effectiveBytes, freeBytes };
  }

  incrementalVacuum(pages = 1000) {
    if (!Number.isSafeInteger(pages) || pages < 1) throw new RangeError('Invalid vacuum page limit');
    const before = this.spaceUsage().freePages;
    this.db.pragma(`incremental_vacuum(${pages})`);
    return Math.max(0, before - this.spaceUsage().freePages);
  }

  insertFact(fact) {
    this._insertFact.run({
      timestamp: fact.timestamp,
      fact_type: fact.fact_type,
      runtime: fact.runtime || 'claude',
      session_id: fact.session_id || null,
      project: fact.project || null,
      data: fact.data ? JSON.stringify(fact.data) : null
    });
  }

  queryFacts({ since, until, types, project, limit = 100 }) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';
    let rows = this._queryFacts.all({ since: s, until: u, limit });
    if (types && types.length > 0) {
      const typeSet = new Set(types);
      rows = rows.filter(r => typeSet.has(r.fact_type));
    }
    if (project) {
      rows = rows.filter(r => r.project === project);
    }
    return rows.map(row => ({
      ...row,
      data: row.data ? JSON.parse(row.data) : null
    }));
  }

  deleteFactsOlderThan(days, anchor = 'now') {
    return this._deleteOldFacts.run({ days, anchor });
  }

  upsertSourceHealth(name, signalType, status, extra) {
    this._upsertSourceHealth.run({
      name,
      signal_type: signalType,
      status,
      extra: extra ? JSON.stringify(extra) : null
    });
  }

  getSourceHealth() {
    return this._getSourceHealth.all().map(row => ({
      ...row,
      extra: row.extra ? JSON.parse(row.extra) : null
    }));
  }

  getCollectorLiveness() {
    return this._getCollectorLiveness.all().map(row => ({
      ...row,
      extra: row.extra ? JSON.parse(row.extra) : null
    }));
  }

  saveSnapshot(snapshot) {
    this._saveSnapshot.run({
      runtime: snapshot.runtime,
      session_id: snapshot.session_id || null,
      running_tool: snapshot.running_tool ? JSON.stringify(snapshot.running_tool) : null,
      open_turn: snapshot.open_turn ? JSON.stringify(snapshot.open_turn) : null,
      pending_permission: snapshot.pending_permission ? JSON.stringify(snapshot.pending_permission) : null,
      possibly_stuck_since: snapshot.possibly_stuck_since || null,
      last_progress_cursor: snapshot.last_progress_cursor,
      last_message: snapshot.last_message || null,
      last_prompt: snapshot.last_prompt || null,
      last_progress_at: snapshot.last_progress_at || null
    });
  }

  latestSnapshot(runtime, sessionId) {
    const row = this._latestSnapshot.get({ runtime, session_id: sessionId || null });
    if (!row) return null;
    return {
      ...row,
      running_tool: row.running_tool ? JSON.parse(row.running_tool) : null,
      open_turn: row.open_turn ? JSON.parse(row.open_turn) : null,
      pending_permission: row.pending_permission ? JSON.parse(row.pending_permission) : null
    };
  }

  insertSession(tokenHash, now, remember = false) {
    this._insertSession.run(tokenHash, now, now, remember ? 1 : 0);
  }

  getSession(tokenHash) {
    return this._getSession.get(tokenHash) || null;
  }

  touchSession(tokenHash, now) {
    this._touchSession.run(now, tokenHash);
  }

  deleteSession(tokenHash) {
    this._deleteSession.run(tokenHash);
  }

  cleanupSessions(absoluteCutoff, idleCutoff) {
    return this._cleanupSessions.run(absoluteCutoff, idleCutoff);
  }

  upsertCodexRolloutPath({ runtime = 'codex', sessionId, transcriptPath, lastEventAt }) {
    if (!sessionId || !transcriptPath || typeof transcriptPath !== 'string') return { changes: 0 };
    if (!transcriptPath.endsWith('.jsonl')) return { changes: 0 };
    const info = this._upsertCodexRolloutPath.run({
      runtime,
      session_id: sessionId,
      transcript_path: transcriptPath,
      last_event_at: lastEventAt || null
    });
    return { changes: info.changes };
  }

  latestCodexRolloutPath(runtime = 'codex') {
    const row = this._latestCodexRolloutPath.get({ runtime });
    return row ? {
      runtime: row.runtime,
      session_id: row.session_id,
      transcript_path: row.transcript_path,
      last_event_at: row.last_event_at,
      updated_at: row.updated_at
    } : null;
  }

  getCodexRolloutCursor(transcriptPath) {
    if (!transcriptPath) return null;
    const row = this._getCodexRolloutCursor.get(transcriptPath);
    return row ? {
      transcript_path: row.transcript_path,
      byte_offset: row.byte_offset,
      session_id: row.session_id,
      updated_at: row.updated_at
    } : null;
  }

  upsertCodexRolloutCursor({ transcriptPath, byteOffset, sessionId }) {
    if (!transcriptPath || !Number.isFinite(byteOffset) || byteOffset < 0) return { changes: 0 };
    const info = this._upsertCodexRolloutCursor.run({
      transcript_path: transcriptPath,
      byte_offset: Math.floor(byteOffset),
      session_id: sessionId || null
    });
    return { changes: info.changes };
  }

  aggregateCost({ since, until, sessionId } = {}) {
    const { clause, params } = this._metricBoundsWhere({ since, until, sessionId });
    const sql = `
      SELECT SUM(cost) AS total, COUNT(cost) AS cnt FROM (
        SELECT metric_value AS cost FROM metric_points
        WHERE metric_name = 'api_request_cost'${clause}
        UNION ALL
        SELECT json_extract(dimensions, '$.cost') AS cost FROM metric_points
        WHERE metric_name = 'usage_event'
          AND json_extract(dimensions, '$.cost') IS NOT NULL${clause}
      )`;
    const row = this.db.prepare(sql).get(params);
    if (!row || row.cnt === 0) return null;
    return row.total;
  }

  aggregateCacheRate({ since, until, sessionId } = {}) {
    const { clause, params } = this._metricBoundsWhere({ since, until, sessionId });
    const sql = `
      SELECT COALESCE(SUM(cache_read), 0) AS cache_read,
             COALESCE(SUM(total_input), 0) AS total_input
      FROM (
        SELECT json_extract(dimensions, '$.cache_read') AS cache_read,
               metric_value AS total_input
        FROM metric_points WHERE metric_name = 'api_request_tokens'${clause}
        UNION ALL
        SELECT json_extract(dimensions, '$.cache_read') AS cache_read,
               metric_value AS total_input
        FROM metric_points WHERE metric_name = 'usage_event'${clause}
      )`;
    const row = this.db.prepare(sql).get(params);
    if (!row || row.total_input === 0) return null;
    return row.cache_read / row.total_input;
  }

  aggregateTokens({ since, until, sessionId } = {}) {
    const { clause, params } = this._metricBoundsWhere({ since, until, sessionId });
    const sql = `
      SELECT COALESCE(SUM(input), 0) AS input,
             COALESCE(SUM(cache_read), 0) AS cache_read,
             COALESCE(SUM(cache_creation), 0) AS cache_creation,
             COALESCE(SUM(output), 0) AS output,
             COALESCE(SUM(total_input), 0) AS total_input,
             COUNT(*) AS cnt
      FROM (
        SELECT json_extract(dimensions, '$.input') AS input,
               json_extract(dimensions, '$.cache_read') AS cache_read,
               json_extract(dimensions, '$.cache_creation') AS cache_creation,
               json_extract(dimensions, '$.output') AS output,
               metric_value AS total_input
        FROM metric_points WHERE metric_name = 'api_request_tokens'${clause}
        UNION ALL
        SELECT json_extract(dimensions, '$.input') AS input,
               json_extract(dimensions, '$.cache_read') AS cache_read,
               json_extract(dimensions, '$.cache_creation') AS cache_creation,
               json_extract(dimensions, '$.output') AS output,
               metric_value AS total_input
        FROM metric_points WHERE metric_name = 'usage_event'${clause}
      )`;
    const row = this.db.prepare(sql).get(params);
    if (!row || row.cnt === 0) return null;
    return {
      input: row.total_input,
      output: row.output,
      cache_read: row.cache_read,
      cache_rate: row.total_input > 0 ? row.cache_read / row.total_input : 0
    };
  }

  aggregateTokenSeries({ since, until, bucketSeconds = 3600 } = {}) {
    const sql = `
      SELECT (CAST(CAST(strftime('%s', timestamp) AS INTEGER) / @bucket AS INTEGER) * @bucket) AS bucket_start,
             COALESCE(SUM(total_input), 0) AS input_sum,
             COALESCE(SUM(output), 0) AS output_sum,
             COALESCE(SUM(cache_read), 0) AS cache_read_sum,
             COALESCE(SUM(total_input), 0) AS total_input_sum
      FROM (
        SELECT timestamp,
               metric_value AS total_input,
               json_extract(dimensions, '$.output') AS output,
               json_extract(dimensions, '$.cache_read') AS cache_read
        FROM metric_points
        WHERE metric_name = 'api_request_tokens'
          AND timestamp >= @since AND timestamp <= @until
        UNION ALL
        SELECT timestamp,
               metric_value AS total_input,
               json_extract(dimensions, '$.output') AS output,
               json_extract(dimensions, '$.cache_read') AS cache_read
        FROM metric_points
        WHERE metric_name = 'usage_event'
          AND timestamp >= @since AND timestamp <= @until
      )
      GROUP BY bucket_start ORDER BY bucket_start`;
    const rows = this.db.prepare(sql).all({ since, until, bucket: bucketSeconds });
    return rows.map(r => ({
      ...r,
      cache_rate: r.total_input_sum > 0 ? r.cache_read_sum / r.total_input_sum : null
    }));
  }

  aggregateCostSeries({ since, until, bucketSeconds = 3600 } = {}) {
    const sql = `
      SELECT (CAST(CAST(strftime('%s', timestamp) AS INTEGER) / @bucket AS INTEGER) * @bucket) AS bucket_start,
             SUM(cost) AS cost_sum,
             COUNT(*) AS request_count
      FROM (
        SELECT timestamp, metric_value AS cost
        FROM metric_points
        WHERE metric_name = 'api_request_cost'
          AND timestamp >= @since AND timestamp <= @until
        UNION ALL
        SELECT timestamp, json_extract(dimensions, '$.cost') AS cost
        FROM metric_points
        WHERE metric_name = 'usage_event'
          AND json_extract(dimensions, '$.cost') IS NOT NULL
          AND timestamp >= @since AND timestamp <= @until
      )
      GROUP BY bucket_start ORDER BY bucket_start`;
    return this.db.prepare(sql).all({ since, until, bucket: bucketSeconds });
  }

  aggregateCacheRateSeries({ since, until, bucketSeconds = 3600 } = {}) {
    const sql = `
      SELECT (CAST(CAST(strftime('%s', timestamp) AS INTEGER) / @bucket AS INTEGER) * @bucket) AS bucket_start,
             COALESCE(SUM(cache_read), 0) AS cache_read_sum,
             COALESCE(SUM(total_input), 0) AS total_input_sum
      FROM (
        SELECT timestamp,
               json_extract(dimensions, '$.cache_read') AS cache_read,
               metric_value AS total_input
        FROM metric_points
        WHERE metric_name = 'api_request_tokens'
          AND timestamp >= @since AND timestamp <= @until
        UNION ALL
        SELECT timestamp,
               json_extract(dimensions, '$.cache_read') AS cache_read,
               metric_value AS total_input
        FROM metric_points
        WHERE metric_name = 'usage_event'
          AND timestamp >= @since AND timestamp <= @until
      )
      GROUP BY bucket_start ORDER BY bucket_start`;
    const rows = this.db.prepare(sql).all({ since, until, bucket: bucketSeconds });
    return rows.map(r => ({ ...r, rate: r.total_input_sum > 0 ? r.cache_read_sum / r.total_input_sum : null }));
  }

  getProjectDistribution({ since, until } = {}) {
    const s = since || '1970-01-01T00:00:00Z';
    const u = until || '2099-12-31T23:59:59Z';

    // Get rows with project attribution from JSONL-ingested metrics
    const rows = this.db.prepare(`
      SELECT metric_value, dimensions FROM metric_points
      WHERE metric_name IN ('api_request_tokens', 'usage_event')
        AND timestamp >= @since AND timestamp <= @until
    `).all({ since: s, until: u });

    let totalTokens = 0;
    let totalOutput = 0;
    const projectOutputTokens = {};

    for (const row of rows) {
      let dims;
      try { dims = JSON.parse(row.dimensions); } catch { continue; }
      const output = dims.output || 0;
      const totalInput = Number(row.metric_value) || dims.total_input || 0;
      totalTokens += totalInput + output;
      totalOutput += output;

      const projects = dims.projects;
      if (Array.isArray(projects) && projects.length > 0) {
        const share = output / projects.length;
        for (const p of projects) {
          projectOutputTokens[p] = (projectOutputTokens[p] || 0) + share;
        }
      } else {
        // Fall back to hook-based project extraction for older data without project attribution
        // (these records were ingested before the project extraction was added)
      }
    }

    // Distribute unattributed output tokens using hook tool call proportions
    const attributedOutput = Object.values(projectOutputTokens).reduce((a, b) => a + b, 0);
    const unattributedOutput = totalOutput - attributedOutput;

    if (unattributedOutput > 0) {
      const events = this.db.prepare(`
        SELECT summary FROM runtime_events
        WHERE event_type IN ('post_tool_use', 'tool_call', 'tool_result')
          AND timestamp >= @since AND timestamp <= @until
      `).all({ since: s, until: u });

      const hookCounts = {};
      for (const e of events) {
        for (const project of this._extractProjectsFromSummary(e.summary)) {
          hookCounts[project] = (hookCounts[project] || 0) + 1;
        }
      }
      for (const [project, count] of Object.entries(this._projectWeightsFromCodexRollouts({ since: s, until: u }))) {
        hookCounts[project] = (hookCounts[project] || 0) + count;
      }
      const totalHookCalls = Object.values(hookCounts).reduce((a, b) => a + b, 0) || 1;
      for (const [p, count] of Object.entries(hookCounts)) {
        projectOutputTokens[p] = (projectOutputTokens[p] || 0) + unattributedOutput * (count / totalHookCalls);
      }
    }

    const totalCost = this.aggregateCost({ since: s, until: u }) || 0;

    const items = Object.entries(projectOutputTokens)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([name, outputTok]) => {
        const pct = totalOutput > 0 ? outputTok / totalOutput : 0;
        return {
          name,
          outputTokens: Math.round(outputTok),
          cost: +(totalCost * pct).toFixed(4),
          percentage: +(pct * 100).toFixed(1)
        };
      });

    return { items, totalTokens, totalOutput, totalCost };
  }

  _extractProjectsFromSummary(summary) {
    const projects = new Set();
    for (const filePath of this._extractFilePaths(summary)) {
      const project = this._extractProject(filePath);
      if (project) projects.add(project);
    }
    return [...projects];
  }

  _extractFilePaths(summary) {
    if (!summary) return [];
    const paths = new Set();
    const pathPattern = /(?:~\/|\/)?(?:Users\/[^/\s]+\/zylos\/|zylos\/)?(?:workspace|\.claude\/skills|skills)\/[^\s,'")]+/g;
    for (const match of summary.matchAll(pathPattern)) {
      paths.add(match[0]);
    }
    return [...paths];
  }

  _projectWeightsFromCodexRollouts({ since, until } = {}) {
    const rows = this.db.prepare(`
      SELECT transcript_path FROM codex_rollout_paths
      WHERE runtime = 'codex'
        AND last_event_at >= @since AND last_event_at <= @until
    `).all({ since, until });

    const weights = {};
    for (const row of rows) {
      const transcriptPath = row.transcript_path;
      if (!transcriptPath || !fs.existsSync(transcriptPath)) continue;
      let content;
      try {
        content = fs.readFileSync(transcriptPath, 'utf8');
      } catch {
        continue;
      }
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        const payload = event.type === 'session_meta'
          ? { ...(event.payload || {}), type: 'session_meta' }
          : event.payload || {};
        for (const project of this._extractProjectsFromRolloutPayload(payload)) {
          weights[project] = (weights[project] || 0) + 1;
        }
      }
    }
    return weights;
  }

  _extractProjectsFromRolloutPayload(payload) {
    const projects = new Set();
    const addFromValue = (value) => {
      if (!value) return;
      if (typeof value === 'string') {
        for (const filePath of this._extractFilePaths(value)) {
          const project = this._extractProject(filePath);
          if (project) projects.add(project);
        }
        const directProject = this._extractProject(value);
        if (directProject) projects.add(directProject);
      } else if (Array.isArray(value)) {
        for (const item of value) addFromValue(item);
      } else if (typeof value === 'object') {
        for (const item of Object.values(value)) addFromValue(item);
      }
    };

    if (payload.type === 'session_meta') addFromValue(payload.cwd);
    if (payload.type !== 'function_call' && payload.type !== 'custom_tool_call') return [...projects];

    addFromValue(payload.name);
    addFromValue(payload.input);
    if (payload.arguments) {
      try {
        addFromValue(JSON.parse(payload.arguments));
      } catch {
        addFromValue(payload.arguments);
      }
    }

    return [...projects];
  }

  _extractProject(filePath) {
    if (!filePath) return null;
    const parts = filePath.replace(/^\/+/, '').split('/');
    const wsIdx = parts.indexOf('workspace');
    if (wsIdx >= 0 && parts[wsIdx + 1]) return parts[wsIdx + 1];
    const skillsIdx = parts.indexOf('skills');
    if (skillsIdx >= 0 && parts[skillsIdx + 1]) return parts[skillsIdx + 1];
    return null;
  }

  _metricBoundsWhere({ since, until, sessionId } = {}) {
    let clause = '';
    const params = {};
    if (since) { clause += ' AND timestamp >= @since'; params.since = since; }
    if (until) { clause += ' AND timestamp <= @until'; params.until = until; }
    if (sessionId) { clause += ' AND session_id = @sessionId'; params.sessionId = sessionId; }
    return { clause, params };
  }

  insertApiKey({ name, keyHash, scope }) {
    return this._insertApiKey.run({ name, key_hash: keyHash, scope });
  }

  getApiKeyByHash(hash) {
    return this._getApiKeyByHash.get(hash) || null;
  }

  listActiveApiKeys() {
    return this._listActiveApiKeys.all();
  }

  getApiKeyByName(name) {
    return this._getApiKeyByName.get(name) || null;
  }

  listApiKeys() {
    return this._listApiKeys.all();
  }

  revokeApiKey(name) {
    return this._revokeApiKey.run(name);
  }

  rotateApiKey(name, keyHash) {
    return this._rotateApiKeyTx(name, keyHash);
  }

  hardDeleteApiKey(name) {
    return this._hardDeleteApiKeyTx(name);
  }

  purgeRevokedApiKeys() {
    return this._purgeRevokedApiKeysTx();
  }

  touchApiKey(id) {
    this._touchApiKey.run(id);
  }

  insertApiSession({ tokenHash, apiKeyId, scope, createdAt, expiresAt }) {
    this._insertApiSession.run({
      token_hash: tokenHash,
      api_key_id: apiKeyId,
      scope,
      created_at: createdAt,
      expires_at: expiresAt,
    });
  }

  getApiSession(tokenHash) {
    return this._getApiSession.get(tokenHash) || null;
  }

  cleanupExpiredApiSessions() {
    this._deleteExpiredApiSessions.run(Date.now());
  }

  close() {
    this.db.close();
  }

  _parseEventRow(row) {
    return {
      ...row,
      metadata: row.metadata ? JSON.parse(row.metadata) : null
    };
  }
}
