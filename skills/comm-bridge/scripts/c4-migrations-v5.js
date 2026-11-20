export function migrateToV5(db) {
  db.exec(`
    CREATE TABLE session_hosts (
      source_group TEXT PRIMARY KEY,
      target_group TEXT NOT NULL,
      attached_by TEXT NOT NULL,
      attached_at INTEGER NOT NULL
    );
    CREATE INDEX idx_session_hosts_target ON session_hosts(target_group);
    CREATE TABLE session_host_allowlist (channel TEXT PRIMARY KEY);
  `);
}
