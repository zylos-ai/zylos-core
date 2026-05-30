CREATE TABLE IF NOT EXISTS runtime_work (
  work_id TEXT PRIMARY KEY,

  source_system TEXT NOT NULL
    CHECK (source_system IN ('conversation', 'control', 'scheduler', 'component', 'memory')),
  source_id TEXT NOT NULL,
  source_run_id TEXT,

  kind TEXT NOT NULL
    CHECK (kind IN (
      'human_message',
      'control_message',
      'scheduled_task',
      'component_op',
      'memory_sync'
    )),

  state TEXT NOT NULL
    CHECK (state IN (
      'queued',
      'running',
      'waiting_user',
      'waiting_external',
      'done',
      'failed',
      'timeout',
      'cancelled'
    )),

  priority INTEGER NOT NULL DEFAULT 3
    CHECK (priority BETWEEN 1 AND 3),

  summary TEXT,
  subject TEXT,

  channel TEXT,
  endpoint_id TEXT,
  reply_channel TEXT,
  reply_endpoint TEXT,

  require_idle INTEGER NOT NULL DEFAULT 0,
  parent_work_id TEXT,

  lease_owner TEXT,
  lease_acquired_at INTEGER,
  lease_expires_at INTEGER,
  active_session TEXT,

  waiting_reason TEXT,
  waiting_on TEXT,

  closeout_status TEXT,
  closeout_summary TEXT,
  closeout_json TEXT,
  artifact_refs TEXT NOT NULL DEFAULT '[]',

  error_code TEXT,
  error_detail TEXT,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,

  FOREIGN KEY (parent_work_id) REFERENCES runtime_work(work_id)
);

CREATE INDEX IF NOT EXISTS idx_runtime_work_state_priority
  ON runtime_work(state, priority, created_at);

CREATE INDEX IF NOT EXISTS idx_runtime_work_source
  ON runtime_work(source_system, source_id);

CREATE INDEX IF NOT EXISTS idx_runtime_work_lease
  ON runtime_work(state, lease_expires_at);

CREATE TABLE IF NOT EXISTS runtime_work_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_json TEXT,
  created_at INTEGER NOT NULL,

  FOREIGN KEY (work_id) REFERENCES runtime_work(work_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runtime_work_event_work
  ON runtime_work_event(work_id, created_at);
