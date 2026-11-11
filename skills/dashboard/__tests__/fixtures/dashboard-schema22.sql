-- Frozen Dashboard schema at Core 1d5faf8b (version 22), generated from its actual migration.
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE runtime_events (
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
, session_group TEXT, run_id TEXT);

CREATE INDEX idx_events_seq ON runtime_events(event_seq);

CREATE INDEX idx_events_type ON runtime_events(event_type);

CREATE INDEX idx_events_timestamp ON runtime_events(timestamp);

CREATE INDEX idx_events_session ON runtime_events(session_id);

CREATE TABLE metric_points (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  dimensions TEXT,
  source TEXT NOT NULL,
  confidence TEXT NOT NULL DEFAULT 'actual'
, session_group TEXT);

CREATE INDEX idx_metrics_name_ts ON metric_points(metric_name, timestamp);

CREATE TABLE activity_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  fact_type TEXT NOT NULL,
  runtime TEXT NOT NULL DEFAULT 'claude',
  session_id TEXT,
  project TEXT,
  data TEXT
);

CREATE INDEX idx_facts_type_ts ON activity_facts(fact_type, timestamp);

CREATE TABLE source_health (
  name TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  extra TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (name, signal_type)
);

CREATE TABLE state_snapshots (
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
, last_prompt TEXT, last_progress_at TEXT);

CREATE INDEX idx_snapshots_latest ON state_snapshots(runtime, session_id, snapshot_at DESC);

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  remember INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_metric_points_name_session_ts
        ON metric_points (metric_name, session_id, timestamp)
      ;

CREATE TABLE codex_rollout_paths (
          runtime TEXT NOT NULL,
          session_id TEXT NOT NULL,
          transcript_path TEXT NOT NULL,
          last_event_at TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (runtime, session_id)
        );

CREATE INDEX idx_codex_rollout_paths_updated
        ON codex_rollout_paths (runtime, updated_at DESC);

CREATE TABLE codex_rollout_cursors (
          transcript_path TEXT PRIMARY KEY,
          byte_offset INTEGER NOT NULL DEFAULT 0,
          session_id TEXT,
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

CREATE TABLE api_sessions (
          token_hash TEXT PRIMARY KEY,
          api_key_id INTEGER NOT NULL REFERENCES api_keys(id),
          scope TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );

CREATE INDEX idx_api_sessions_expires ON api_sessions(expires_at);

CREATE TABLE pm2_latest_state (
          process_name TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          cpu REAL NOT NULL DEFAULT 0,
          memory_bytes INTEGER NOT NULL DEFAULT 0,
          restarts INTEGER NOT NULL DEFAULT 0,
          uptime_ms INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

CREATE UNIQUE INDEX idx_usage_event_dedup
        ON metric_points (
          COALESCE(session_id, ''),
          source,
          metric_name,
          json_extract(dimensions, '$.event_id')
        )
        WHERE metric_name = 'usage_event'
          AND json_extract(dimensions, '$.event_id') IS NOT NULL;

CREATE TABLE "api_keys" (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              name TEXT NOT NULL,
              key_hash TEXT NOT NULL,
              scope TEXT NOT NULL DEFAULT 'read',
              created_at TEXT NOT NULL DEFAULT (datetime('now')),
              last_used_at TEXT,
              revoked_at TEXT
            );

CREATE UNIQUE INDEX idx_api_keys_active_name
              ON api_keys(name)
              WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX idx_usage_event_request_dedup
        ON metric_points (
          source,
          metric_name,
          json_extract(dimensions, '$.request_id')
        )
        WHERE metric_name = 'usage_event'
          AND json_extract(dimensions, '$.request_id') IS NOT NULL;

CREATE INDEX idx_metric_latest
            ON metric_points(metric_name, source, timestamp);

CREATE INDEX idx_metric_cost_time
            ON metric_points(metric_name, timestamp, json_extract(dimensions, '$.cost'));

CREATE INDEX idx_metric_cost_session
            ON metric_points(metric_name, session_id, timestamp, json_extract(dimensions, '$.cost'));

CREATE TABLE core_log_cursors (
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

CREATE UNIQUE INDEX idx_core_log_cursors_active
            ON core_log_cursors(stream, file_dev, file_ino) WHERE status = 'active';

CREATE INDEX idx_events_group_seq ON runtime_events(session_group, event_seq);

CREATE TABLE group_display_names (
            session_group TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            source TEXT NOT NULL CHECK (source IN ('human','agent')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

CREATE INDEX idx_metric_points_group_ts ON metric_points(metric_name, session_group, timestamp);

CREATE TABLE usage_transcripts (
            transcript_path TEXT PRIMARY KEY,
            parent_path TEXT,
            runtime TEXT NOT NULL CHECK (runtime IN ('claude','codex')),
            session_group TEXT, run_id TEXT, session_id TEXT NOT NULL,
            byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
            status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','missing')),
            first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );

CREATE INDEX idx_usage_transcripts_status_updated ON usage_transcripts(status, updated_at);

CREATE INDEX idx_events_group_run_seq
            ON runtime_events(session_group, run_id, event_seq);

INSERT INTO schema_migrations(version) VALUES(1);
INSERT INTO schema_migrations(version) VALUES(2);
INSERT INTO schema_migrations(version) VALUES(3);
INSERT INTO schema_migrations(version) VALUES(4);
INSERT INTO schema_migrations(version) VALUES(5);
INSERT INTO schema_migrations(version) VALUES(6);
INSERT INTO schema_migrations(version) VALUES(7);
INSERT INTO schema_migrations(version) VALUES(8);
INSERT INTO schema_migrations(version) VALUES(9);
INSERT INTO schema_migrations(version) VALUES(10);
INSERT INTO schema_migrations(version) VALUES(11);
INSERT INTO schema_migrations(version) VALUES(12);
INSERT INTO schema_migrations(version) VALUES(13);
INSERT INTO schema_migrations(version) VALUES(20);
INSERT INTO schema_migrations(version) VALUES(21);
INSERT INTO schema_migrations(version) VALUES(22);
