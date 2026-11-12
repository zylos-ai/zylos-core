import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { migrateSchema13 } from './schema13.js';

// Historical Dashboard databases as data: schema 13 (standalone v0.6.9) with
// retained rows, and schema 20 (the first Core-managed baseline) built on it.
export function legacy(file) {
  const db = new Database(file);
  migrateSchema13(db);
  db.exec(`
    INSERT INTO runtime_events(id,ingest_id,event_seq,timestamp,event_type,category) VALUES('old','old',1,'2026-01-01','prompt','activity');
    INSERT INTO auth_sessions(token_hash,created_at,last_activity_at) VALUES('retained',1,2);`);
  db.close();
}

export function schema20(file) {
  legacy(file);
  const db = new Database(file);
  db.exec(`
    CREATE TABLE core_log_cursors (
      stream TEXT NOT NULL, file_dev INTEGER NOT NULL, file_ino INTEGER NOT NULL,
      generation INTEGER NOT NULL CHECK(generation>=1), anchor_len INTEGER NOT NULL DEFAULT 0 CHECK(anchor_len BETWEEN 0 AND 4096),
      anchor_sha256 TEXT, file_name TEXT NOT NULL, byte_offset INTEGER NOT NULL DEFAULT 0 CHECK(byte_offset>=0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','done','gap','source_missing')),
      updated_at TEXT NOT NULL DEFAULT(datetime('now')), PRIMARY KEY(stream,file_dev,file_ino,generation),
      CHECK((anchor_len=0)=(anchor_sha256 IS NULL)), CHECK(anchor_len>0 OR byte_offset=0)
    );
    CREATE UNIQUE INDEX idx_core_log_cursors_active ON core_log_cursors(stream,file_dev,file_ino) WHERE status='active';
    ALTER TABLE runtime_events ADD COLUMN session_group TEXT;
    ALTER TABLE runtime_events ADD COLUMN run_id TEXT;
    CREATE INDEX idx_events_group_seq ON runtime_events(session_group,event_seq);
    INSERT INTO schema_migrations(version) VALUES(20);
    INSERT INTO metric_points(timestamp,metric_name,metric_value,source) VALUES('2026-01-01','retained',42,'fixture');
  `);
  db.close();
}
