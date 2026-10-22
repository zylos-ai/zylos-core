import fs from 'node:fs';
import * as v1 from './c4-v1-owner.js';

export const CLOCK = 1767225600;
export const NEW_TABLES = ['channel_namespaces', 'group_heads', 'origin_sync_cursors',
  'drain_fences', 'mode_transitions', 'group_runtime_overrides', 'group_model_overrides'];
export function seedV1(db, { extensions = false } = {}) {
  db.exec(fs.readFileSync(new URL('../fixtures/migration-history/c4-v0.9.0-v1.sql', import.meta.url), 'utf8'));
  // Replace only invented fixture rows, never import a host database.
  db.exec('DELETE FROM conversations; DELETE FROM checkpoints; DELETE FROM control_queue;');
  const insert = db.prepare(`INSERT INTO conversations
    (id,timestamp,direction,channel,endpoint_id,content,status,delivery_action,priority,require_idle,retry_count)
    VALUES (?,datetime(?,'unixepoch'),'in',?,?,?,?,?,?,?,?)`);
  for (let id = 1; id <= 6; id++) {
    insert.run(id, CLOCK - 10, id === 6 ? 'void' : 'telegram', id === 6 ? 'session-handoff' : 'fixture',
      `message ${id}: 中文\n'"`, id === 4 ? 'pending' : id === 5 ? 'running' : 'delivered',
      id < 4 ? 'delivered' : null, id, id % 2, id % 3);
  }
  db.exec(`INSERT INTO checkpoints(id,timestamp,summary,start_conversation_id,end_conversation_id)
    VALUES(1,'2026-01-01 00:00:00','initial',NULL,NULL),(2,'2026-01-01 00:01:00','history',1,3)`);
  db.prepare(`INSERT INTO control_queue(id,raw_content,content,status,created_at,updated_at)
    VALUES(1,'work',?,'running',?,?)`).run('work ---- ack via: node example ack --id 1', CLOCK, CLOCK);
  if (extensions) db.exec(`CREATE TABLE user_notes(id INTEGER PRIMARY KEY,note TEXT);
    INSERT INTO user_notes VALUES(1,'retained'); ALTER TABLE conversations ADD COLUMN user_tag TEXT;
    UPDATE conversations SET user_tag='tag:' || id`);
}
export function oldRows(db) {
  return Object.fromEntries(Object.entries(v1.TABLES).map(([table, columns]) => [table,
    db.prepare(`SELECT ${columns.join(',')} FROM ${table} ORDER BY rowid`).all()]));
}
export function snapshot(db) {
  const schema = db.prepare('SELECT type,name,sql FROM sqlite_master ORDER BY name').all();
  const tables = schema.filter(row => row.type === 'table');
  return { version: db.pragma('user_version', { simple: true }), schema,
    rows: Object.fromEntries(tables.map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])) };
}
