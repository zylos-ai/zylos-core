const quote = value => `"${value.replaceAll('"', '""')}"`;

/** Expand the ending reason without discarding deployment-owned columns/objects. */
export function migrateToV3(db) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()
      .some(key => key.table.toLowerCase() === 'run_endings')) {
      throw new Error(`Cannot rebuild run_endings: table ${quote(name)} has a foreign key referencing run_endings`);
    }
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_endings'").get()?.sql;
  if (!sql || !/reason\s+IN\s*\(/i.test(sql)) throw new Error('Run ending constraint is unavailable');
  const rewritten = sql.replace(/(reason\s+IN\s*\([^)]*)\)/i, "$1,'delete')")
    .replace(/^CREATE\s+TABLE\s+(?:"run_endings"|`run_endings`|\[run_endings\]|run_endings)/i, 'CREATE TABLE run_endings_deletion_migration');
  const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='run_endings' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  const columns = db.prepare('PRAGMA table_xinfo(run_endings)').all().filter(row => row.hidden === 0).map(row => quote(row.name)).join(',');
  const legacy = db.pragma('legacy_alter_table', { simple: true });
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(rewritten);
    db.exec(`INSERT INTO run_endings_deletion_migration (${columns}) SELECT ${columns} FROM run_endings`);
    db.exec('DROP TABLE run_endings; ALTER TABLE run_endings_deletion_migration RENAME TO run_endings');
    for (const object of objects) db.exec(object.sql);
  } finally { db.pragma(`legacy_alter_table = ${legacy ? 'ON' : 'OFF'}`); }
  db.exec(`
    ALTER TABLE drain_fences ADD COLUMN operation_id TEXT;
    ALTER TABLE drain_fences ADD COLUMN actor TEXT;
    CREATE TABLE group_deletion_audit (
      operation_id TEXT PRIMARY KEY NOT NULL,
      session_group TEXT,
      draft_local_id TEXT,
      actor TEXT NOT NULL,
      run_id TEXT,
      target_key TEXT NOT NULL,
      cutoff_id INTEGER NOT NULL CHECK (cutoff_id >= 0),
      generation_id TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      status TEXT NOT NULL CHECK (status IN ('started','done')),
      preview_messages INTEGER NOT NULL,
      preview_attachments INTEGER NOT NULL,
      preview_files INTEGER NOT NULL,
      deleted_messages INTEGER NOT NULL DEFAULT 0,
      deleted_attachments INTEGER NOT NULL DEFAULT 0,
      deleted_files INTEGER NOT NULL DEFAULT 0,
      counts_estimated INTEGER NOT NULL DEFAULT 0 CHECK (counts_estimated IN (0,1)),
      cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0)
    );
  `);
}
