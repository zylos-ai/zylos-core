const SCHEMA_V2_SESSIONS = `
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0
);
`;

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime_events (
  id TEXT PRIMARY KEY,
  ingest_id TEXT NOT NULL UNIQUE,
  event_seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  event_type TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT,
  duration_ms INTEGER,
  metadata TEXT,
  source TEXT NOT NULL DEFAULT 'hook',
  confidence TEXT NOT NULL DEFAULT 'actual'
);
CREATE INDEX IF NOT EXISTS idx_events_seq ON runtime_events(event_seq);
CREATE INDEX IF NOT EXISTS idx_events_type ON runtime_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_timestamp ON runtime_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_events_session ON runtime_events(session_id);

CREATE TABLE IF NOT EXISTS metric_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  dimensions TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'actual'
);
CREATE INDEX IF NOT EXISTS idx_metrics_name_ts ON metric_points(metric_name, timestamp);

CREATE TABLE IF NOT EXISTS activity_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  project TEXT,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_facts_type_ts ON activity_facts(fact_type, timestamp);

CREATE TABLE IF NOT EXISTS source_health (
  name TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  extra TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, signal_type)
);

CREATE TABLE IF NOT EXISTS state_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runtime TEXT NOT NULL,
  session_id TEXT,
  running_tool TEXT,
  open_turn TEXT,
  pending_permission TEXT,
  possibly_stuck_since TEXT,
  last_progress_cursor INTEGER NOT NULL,
  last_message TEXT,
  snapshot_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_snapshots_latest ON state_snapshots(runtime, session_id, snapshot_at DESC);
`;

// Shared by the service and the side-effect-free schema owner.
export const TARGET_SCHEMA_VERSION = 20;

export function inspectDatabase(db) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
  const currentVersion = hasTable ? (db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get()?.v ?? 0) : 0;
  if (!Number.isInteger(currentVersion) || currentVersion < 0) throw new Error('Unsupported Dashboard schema version');
  if (!hasTable && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get()) {
    throw new Error('Unsupported Dashboard layout: missing schema_migrations');
  }
  if (currentVersion > 0 && currentVersion <= TARGET_SCHEMA_VERSION) {
    if (currentVersion > 13 && currentVersion < 20) throw new Error('Unsupported Dashboard migration source');
    for (const table of ['runtime_events', 'metric_points', 'activity_facts', 'source_health', 'state_snapshots']) {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error(`Unsupported Dashboard layout: missing ${table}`);
    }
    const required = {
      runtime_events: 'id ingest_id event_seq timestamp runtime session_id event_type category summary duration_ms metadata source confidence',
      metric_points: 'id timestamp runtime session_id metric_name metric_value dimensions source confidence',
      activity_facts: 'id timestamp fact_type runtime session_id project data',
      source_health: 'name signal_type status extra updated_at',
      state_snapshots: 'id runtime session_id running_tool open_turn pending_permission possibly_stuck_since last_progress_cursor snapshot_at',
    };
    if (currentVersion >= 2) required.auth_sessions = 'token_hash created_at last_activity_at';
    if (currentVersion >= 3) required.state_snapshots += ' last_message';
    if (currentVersion >= 4) required.state_snapshots += ' last_prompt';
    if (currentVersion >= 6) required.state_snapshots += ' last_progress_at';
    if (currentVersion >= 7) required.auth_sessions += ' remember';
    if (currentVersion >= 8) {
      required.codex_rollout_paths = 'runtime session_id transcript_path last_event_at updated_at';
      required.codex_rollout_cursors = 'transcript_path byte_offset session_id updated_at';
    }
    if (currentVersion >= 9) {
      required.api_keys = 'id name key_hash scope created_at last_used_at revoked_at';
      required.api_sessions = 'token_hash api_key_id scope created_at expires_at';
    }
    if (currentVersion >= 10) required.pm2_latest_state = 'process_name status cpu memory_bytes restarts uptime_ms updated_at';
    if (currentVersion >= 20) {
      required.runtime_events += ' session_group run_id';
      required.core_log_cursors = 'stream file_dev file_ino generation anchor_len anchor_sha256 file_name byte_offset status updated_at';
    }
    for (const [table, columns] of Object.entries(required)) {
      db.prepare(`SELECT ${columns.split(' ').join(', ')} FROM ${table} LIMIT 0`).all();
    }
    if (currentVersion >= 20) {
      const indexes = db.pragma('index_list(core_log_cursors)');
      const active = indexes.find(index => index.name === 'idx_core_log_cursors_active');
      const activeColumns = db.pragma('index_info(idx_core_log_cursors_active)').map(column => column.name);
      const activeSql = db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_core_log_cursors_active'").get()?.sql || '';
      if (!active?.unique || !active.partial || activeColumns.join(',') !== 'stream,file_dev,file_ino'
          || !/WHERE\s+status\s*=\s*'active'\s*;?$/i.test(activeSql)) throw new Error('Unsupported Dashboard active cursor index');
      const groupColumns = db.pragma('index_info(idx_events_group_seq)').map(column => column.name);
      const group = db.pragma('index_list(runtime_events)').find(index => index.name === 'idx_events_group_seq');
      if (!group || group.unique || group.partial || groupColumns.join(',') !== 'session_group,event_seq') throw new Error('Unsupported Dashboard event group index');
      const cursorColumns = db.pragma('table_info(core_log_cursors)');
      const primary = cursorColumns.filter(column => column.pk).sort((a,b) => a.pk-b.pk).map(column => column.name);
      if (primary.join(',') !== 'stream,file_dev,file_ino,generation') throw new Error('Unsupported Dashboard cursor primary key');
      const identity = db.pragma('table_info(runtime_events)').filter(column => ['session_group','run_id'].includes(column.name));
      if (identity.some(column => column.notnull || column.dflt_value !== null || column.type.toUpperCase() !== 'TEXT')) throw new Error('Unsupported Dashboard nullable event identity');
    }
  }
  return { currentVersion, targetVersion: TARGET_SCHEMA_VERSION, needsMigration: currentVersion < TARGET_SCHEMA_VERSION };
}

export function migrateDatabase(db) {
  const { currentVersion } = inspectDatabase(db);
  if (currentVersion > TARGET_SCHEMA_VERSION) {
    const error = new Error(`Dashboard schema ${currentVersion} is newer than supported ${TARGET_SCHEMA_VERSION}`);
    error.code = 'SCHEMA_TOO_NEW';
    throw error;
  }
    if (currentVersion < 1) {
      db.exec(SCHEMA_V1);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(1);
    }
    if (currentVersion < 2) {
      db.exec(SCHEMA_V2_SESSIONS);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(2);
    }
    if (currentVersion < 3) {
      const cols = db.pragma('table_info(state_snapshots)').map(c => c.name);
      if (!cols.includes('last_message')) {
        db.exec('ALTER TABLE state_snapshots ADD COLUMN last_message TEXT');
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(3);
    }
    if (currentVersion < 4) {
      const cols = db.pragma('table_info(state_snapshots)').map(c => c.name);
      if (!cols.includes('last_prompt')) {
        db.exec('ALTER TABLE state_snapshots ADD COLUMN last_prompt TEXT');
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(4);
    }
    if (currentVersion < 5) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_metric_points_name_session_ts
        ON metric_points (metric_name, session_id, timestamp)
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(5);
    }
    if (currentVersion < 6) {
      const cols = db.pragma('table_info(state_snapshots)').map(c => c.name);
      if (!cols.includes('last_progress_at')) {
        db.exec('ALTER TABLE state_snapshots ADD COLUMN last_progress_at TEXT');
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(6);
    }
    if (currentVersion < 7) {
      const cols = db.pragma('table_info(auth_sessions)').map(c => c.name);
      if (!cols.includes('remember')) {
        db.exec('ALTER TABLE auth_sessions ADD COLUMN remember INTEGER NOT NULL DEFAULT 0');
      }
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(7);
    }
    if (currentVersion < 8) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS codex_rollout_paths (
          runtime TEXT NOT NULL,
          session_id TEXT NOT NULL,
          transcript_path TEXT NOT NULL,
          last_event_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (runtime, session_id)
        );
        CREATE INDEX IF NOT EXISTS idx_codex_rollout_paths_updated
        ON codex_rollout_paths (runtime, updated_at DESC);

        CREATE TABLE IF NOT EXISTS codex_rollout_cursors (
          transcript_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          session_id TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(8);
    }
    if (currentVersion < 9) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS api_keys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          key_hash TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'read',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          last_used_at TEXT,
          revoked_at TEXT
        );

        CREATE TABLE IF NOT EXISTS api_sessions (
          token_hash TEXT PRIMARY KEY,
          api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
          scope TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_api_sessions_expires ON api_sessions(expires_at);
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(9);
    }
    if (currentVersion < 10) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS pm2_latest_state (
          process_name TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          cpu REAL NOT NULL DEFAULT 0,
          memory_bytes INTEGER NOT NULL DEFAULT 0,
          restarts INTEGER NOT NULL DEFAULT 0,
          uptime_ms INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_event_dedup
        ON metric_points (
          COALESCE(session_id, ''),
          source,
          metric_name,
          json_extract(dimensions, '$.event_id')
        )
        WHERE metric_name = 'usage_event'
          AND json_extract(dimensions, '$.event_id') IS NOT NULL;
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(10);
    }
    if (currentVersion < 11) {
      const foreignKeys = db.pragma('foreign_keys', { simple: true });
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(`
            DROP TABLE IF EXISTS api_keys_new;
            CREATE TABLE api_keys_new (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              key_hash TEXT NOT NULL,
              scope TEXT NOT NULL DEFAULT 'read',
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              last_used_at TEXT,
              revoked_at TEXT
            );
            INSERT INTO api_keys_new (id, name, key_hash, scope, created_at, last_used_at, revoked_at)
            SELECT id, name, key_hash, scope, created_at, last_used_at, revoked_at FROM api_keys;
            DROP TABLE api_keys;
            ALTER TABLE api_keys_new RENAME TO api_keys;
            CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_active_name
              ON api_keys(name)
              WHERE revoked_at IS NULL;
            UPDATE sqlite_sequence
              SET seq = (SELECT COALESCE(MAX(id), 0) FROM api_keys)
              WHERE name = 'api_keys';
          `);
          db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(11);
        })();
      } finally {
        db.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
      }
    }
    if (currentVersion < 12) {
      // One Claude API response becomes several transcript lines, so usage must
      // be unique per request, not per line. Belt-and-braces behind the
      // collector's own request-level dedup. Partial index: pre-fix rows carry
      // no request_id dimension, so they are excluded and this cannot fail on
      // existing data.
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_event_request_dedup
        ON metric_points (
          source,
          metric_name,
          json_extract(dimensions, '$.request_id')
        )
        WHERE metric_name = 'usage_event'
          AND json_extract(dimensions, '$.request_id') IS NOT NULL;
      `);
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(12);
    }
    if (currentVersion < 13) {
      process.stderr.write('[store] Building metric lookup and cost indexes (migration 13)\n');
      db.transaction(() => {
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_metric_latest
            ON metric_points(metric_name, source, timestamp);
          CREATE INDEX IF NOT EXISTS idx_metric_cost_time
            ON metric_points(metric_name, timestamp, json_extract(dimensions, '$.cost'));
          CREATE INDEX IF NOT EXISTS idx_metric_cost_session
            ON metric_points(metric_name, session_id, timestamp, json_extract(dimensions, '$.cost'));
        `);
        db.prepare('INSERT OR IGNORE INTO schema_migrations (version) VALUES (?)').run(13);
      })();
    }
    if (currentVersion < 20) {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS core_log_cursors (
            stream TEXT NOT NULL,
            file_dev INTEGER NOT NULL,
            file_ino INTEGER NOT NULL,
            generation INTEGER NOT NULL CHECK (generation >= 1),
            anchor_len INTEGER NOT NULL DEFAULT 0 CHECK (anchor_len BETWEEN 0 AND 4096),
            anchor_sha256 TEXT,
            file_name TEXT NOT NULL,
            byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','done','gap','source_missing')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (stream, file_dev, file_ino, generation),
            CHECK ((anchor_len = 0) = (anchor_sha256 IS NULL)),
            CHECK (anchor_len > 0 OR byte_offset = 0)
          );
          CREATE UNIQUE INDEX IF NOT EXISTS idx_core_log_cursors_active
            ON core_log_cursors(stream, file_dev, file_ino) WHERE status = 'active';
          ALTER TABLE runtime_events ADD COLUMN session_group TEXT;
          ALTER TABLE runtime_events ADD COLUMN run_id TEXT;
          CREATE INDEX IF NOT EXISTS idx_events_group_seq ON runtime_events(session_group, event_seq);
          INSERT OR IGNORE INTO schema_migrations (version) VALUES (20);
        `);
      })();
    }
}
