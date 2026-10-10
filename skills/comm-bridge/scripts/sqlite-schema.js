import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export function assertCoreDatabaseAvailable(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  for (const relative of ['.zylos', '.zylos/upgrade', '.backup', '.backup/self-upgrade']) {
    const file = path.join(root, relative), stat = present(file);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Core databases unavailable: unsafe recovery directory ${file}`);
  }
  const stable = path.join(root, '.zylos/upgrade/maintenance.cjs');
  const stat = present(stable);
  if (stat) {
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Core databases unavailable: unsafe stable maintenance entry');
    return require(stable).assertCoreDatabaseAvailable(root);
  }
  // Legacy/first-adoption deployments may have no stable recovery entry yet.
  // An existing transaction cannot be safely classified by weaker duplicate
  // rules during partial deployment: keep it isolated until stability returns.
  for (const relative of ['.zylos/upgrade/active.json', '.zylos/upgrade/cleanup.json']) {
    if (present(path.join(root, relative))) throw new Error('Core databases unavailable: stable maintenance entry missing with recovery materials');
  }
  const base = path.join(root, '.backup/self-upgrade');
  if (present(base) && fs.readdirSync(base).length) throw new Error('Core databases unavailable: stable maintenance entry missing with recovery transactions');
}

export function inspectLayout(db, name, supported, tables, { allowNew = false, legacyOptional = {}, definitions = {} } = {}) {
  const version = db.pragma('user_version', { simple: true });
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`${name}: invalid schema version ${version}; restore compatible code/data`);
  }
  if (version > supported) {
    throw new Error(`${name}: schema version ${version} exceeds supported ${supported}; restore compatible code/data`);
  }
  const objects = db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  const names = objects.filter(row => row.type === 'table').map(row => row.name);
  if (!names.length && version === 0 && allowNew) {
    // No user tables does not imply an empty schema (e.g. an unknown view).
    if (objects.length) throw new Error(`${name}: unsupported objects in empty schema`);
    return { version, empty: true };
  }
  for (const [table, columns] of Object.entries(tables)) {
    if (version === 0 && legacyOptional[table] === true && !names.includes(table)) continue;
    const info = db.prepare(`PRAGMA table_info(${table})`).all();
    const actual = new Map(info.map(row => [row.name, row]));
    for (const column of columns) {
      if (version === 0 && Array.isArray(legacyOptional[table]) && legacyOptional[table].includes(column) && !actual.has(column)) continue;
      if (!actual.has(column)) throw new Error(`${name}: unsupported schema ${version}, missing ${table}.${column}`);
      const expected = definitions[table]?.[column];
      const found = actual.get(column);
      if (expected && (found.type.toUpperCase() !== expected.type || Boolean(found.pk) !== expected.pk)) throw new Error(`${name}: unsupported definition for ${table}.${column}`);
    }
    if (info.some(column => !columns.includes(column.name))) throw new Error(`${name}: unsupported columns in ${table}`);
  }
  if (names.some(name => !Object.hasOwn(tables, name))) throw new Error(`${name}: unsupported tables in schema ${version}`);
  return { version, empty: false };
}

export function guardDatabase(db, owner, { readonly = false } = {}) {
  readonly ||= db.readonly;
  // Creation can be interrupted after SQLite opens the file, or another
  // initializer can create it first. The current contents, not existsSync
  // before opening, determine whether the owner may initialize it.
  const allowNew = !readonly && owner.supportsNewDatabase === true;
  const initial = owner.inspectSchema(db, { allowNew });
  if (initial.empty && db.name !== ':memory:' && db.name !== '') {
    const stat = fs.lstatSync(db.name);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe empty database file');
  }
  if (readonly || initial.version === owner.SUPPORTED_SCHEMA_VERSION) return initial;
  db.pragma('busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = owner.inspectSchema(db, { allowNew });
    if (current.version !== owner.SUPPORTED_SCHEMA_VERSION) {
      owner.migrate(db, { isNew: current.empty });
      owner.inspectSchema(db);
      db.pragma(`user_version = ${owner.SUPPORTED_SCHEMA_VERSION}`);
      owner.inspectSchema(db);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
  return owner.inspectSchema(db);
}

export function preflightDatabase(Database, dbPath, owner, { allowMissing = false } = {}) {
  if (!fs.existsSync(dbPath)) {
    if (['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(dbPath + suffix))) throw new Error(`Orphan database sidecar: ${dbPath}`);
    if (allowMissing && owner.supportsNewDatabase) return { missing: true };
    throw new Error(`Database not found: ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try { return owner.inspectSchema(db); } finally { db.close(); }
}
