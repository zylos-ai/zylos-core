const quote = value => `"${value.replaceAll('"', '""')}"`;

/** Expand the ending reason without discarding deployment-owned columns/objects. */
export function migrateToV4(db) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()
      .some(key => key.table.toLowerCase() === 'run_endings')) {
      throw new Error(`Cannot rebuild run_endings: table ${quote(name)} has a foreign key referencing run_endings`);
    }
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='run_endings'").get()?.sql;
  if (!sql || !/reason\s+IN\s*\(/i.test(sql)) throw new Error('Run ending constraint is unavailable');
  const rewritten = sql.replace(/(reason\s+IN\s*\([^)]*)\)/i, "$1,'release')")
    .replace(/^CREATE\s+TABLE\s+(?:"run_endings"|`run_endings`|\[run_endings\]|run_endings)/i, 'CREATE TABLE run_endings_release_migration');
  const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='run_endings' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  const columns = db.prepare('PRAGMA table_xinfo(run_endings)').all().filter(row => row.hidden === 0).map(row => quote(row.name)).join(',');
  const legacy = db.pragma('legacy_alter_table', { simple: true });
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(rewritten);
    db.exec(`INSERT INTO run_endings_release_migration (${columns}) SELECT ${columns} FROM run_endings`);
    db.exec('DROP TABLE run_endings; ALTER TABLE run_endings_release_migration RENAME TO run_endings');
    for (const object of objects) db.exec(object.sql);
  } finally { db.pragma(`legacy_alter_table = ${legacy ? 'ON' : 'OFF'}`); }
}
