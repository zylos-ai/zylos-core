// Runs inside the schema owner transaction; historical rows are not rewritten.
export function migrateToV2(db) {
  db.exec(`
    ALTER TABLE conversations ADD COLUMN session_group TEXT NOT NULL DEFAULT '';
    ALTER TABLE conversations ADD COLUMN session_id TEXT;
    ALTER TABLE checkpoints   ADD COLUMN session_group TEXT NOT NULL DEFAULT '*';
    ALTER TABLE checkpoints   ADD COLUMN no_content INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE control_queue ADD COLUMN session_group TEXT;
    ALTER TABLE control_queue ADD COLUMN target_binding TEXT;

    CREATE TABLE channel_namespaces (
      namespace TEXT COLLATE BINARY PRIMARY KEY NOT NULL
        CHECK (length(namespace) BETWEEN 1 AND 32
          AND instr(namespace, char(0)) = 0
          AND substr(namespace, 1, 1) GLOB '[a-z]'
          AND namespace NOT GLOB '*[^a-z0-9_-]*'
          AND namespace NOT IN ('origin', 'void', 'internal')),
      component_name TEXT COLLATE BINARY NOT NULL UNIQUE
    );
    CREATE TABLE group_heads (session_group TEXT PRIMARY KEY, head_id INTEGER NOT NULL);
    CREATE TABLE origin_sync_cursors (
      session_group TEXT PRIMARY KEY,
      synced_id INTEGER NOT NULL DEFAULT 0,
      checkpoint_id INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE drain_fences (
      session_group TEXT PRIMARY KEY, reason TEXT, run_id TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE mode_transitions (
      run_id TEXT PRIMARY KEY,
      source_mode TEXT NOT NULL CHECK (source_mode IN ('single','multi')),
      target_mode TEXT NOT NULL CHECK (target_mode IN ('single','multi') AND target_mode <> source_mode),
      phase TEXT NOT NULL CHECK (phase IN ('gating','converting','cutover','complete')),
      cutoff INTEGER, coverage_snapshot TEXT, absorbed_ids TEXT, reason TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE group_runtime_overrides (
      session_group TEXT COLLATE BINARY PRIMARY KEY NOT NULL,
      runtime TEXT COLLATE BINARY NOT NULL
    );
    CREATE TABLE group_model_overrides (
      session_group TEXT COLLATE BINARY NOT NULL,
      runtime TEXT COLLATE BINARY NOT NULL,
      model TEXT NOT NULL CHECK (length(trim(model)) > 0),
      effort TEXT NOT NULL CHECK (length(trim(effort)) > 0),
      PRIMARY KEY (session_group, runtime)
    );

    CREATE INDEX IF NOT EXISTS idx_conv_group_id ON conversations(session_group, id);
    CREATE INDEX IF NOT EXISTS idx_conv_group_status ON conversations(session_group, direction, status);
    CREATE INDEX IF NOT EXISTS idx_conv_channel_endpoint ON conversations(channel, endpoint_id, id);
    CREATE INDEX IF NOT EXISTS idx_conv_loadable_id ON conversations(id)
      WHERE (direction = 'in' AND status = 'delivered') OR direction = 'out';
    CREATE INDEX IF NOT EXISTS idx_ckpt_group_id ON checkpoints(session_group, id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mode_transitions_open
      ON mode_transitions((0)) WHERE phase <> 'complete';
  `);
}
