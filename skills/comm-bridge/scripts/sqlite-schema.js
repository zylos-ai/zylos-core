import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Ordinary entrypoints only consult the explicit active marker. Historical
// transactions are inspected by upgrade admission and explicit recovery tools.
function hasRecoveryMaterials(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  try {
    for (const relative of ['.zylos', '.zylos/upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    return !!present(path.join(root, '.zylos/upgrade/active.json'));
  } catch { return true; }
}

export function assertCoreDatabaseAvailable(root) {
  if (!hasRecoveryMaterials(root)) return;
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  for (const relative of ['.zylos', '.zylos/upgrade']) {
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
  for (const relative of ['.zylos/upgrade/active.json']) {
    if (present(path.join(root, relative))) throw new Error('Core databases unavailable: stable maintenance entry missing with recovery materials');
  }
}

// Strict inspection is the upgrade/recovery default; ordinary owners opt out
// only of the extra-table/column whitelist, retaining required-field checks.
export function inspectLayout(db, name, supported, tables, { allowNew = false, strict = true, legacyOptional = {}, definitions = {} } = {}) {
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
    if (strict && info.some(column => !columns.includes(column.name))) throw new Error(`${name}: unsupported columns in ${table}`);
  }
  if (strict && names.some(name => !Object.hasOwn(tables, name))) throw new Error(`${name}: unsupported tables in schema ${version}`);
  return { version, empty: false };
}

// Planning is read-only: recognize the starting layout, then resolve every step
// before any migration runs. Owners inspect the layout for the actual version,
// rather than requiring the target version's columns at an earlier step.
export function planDatabaseMigration(db, owner, { allowNew = false, strict = true } = {}) {
  const current = owner.inspectSchema(db, { allowNew, strict });
  const target = owner.SUPPORTED_SCHEMA_VERSION;
  if (!Number.isInteger(target) || target < 0 || !Number.isInteger(current.version) || current.version < 0 || current.version > target) {
    throw new Error('Invalid or unsupported schema migration version');
  }
  const steps = [];
  for (let version = current.version; version < target; version++) {
    const step = Object.hasOwn(owner.MIGRATIONS || {}, version) && owner.MIGRATIONS[version];
    if (!step || step.to !== version + 1 || typeof step.migrate !== 'function') {
      throw new Error(`Missing or invalid schema migration path ${version}→${version + 1}`);
    }
    steps.push({ from: version, to: step.to, migrate: step.migrate });
  }
  return { ...current, target, steps };
}

// One writer lock and one transaction cover the entire per-database chain.
// Migration callbacks must keep all changes on this SQLite connection.
export function migrateDatabase(db, owner, { allowNew = false, strict = true } = {}) {
  if (db.readonly) throw new Error('Cannot migrate a readonly database');
  const initial = planDatabaseMigration(db, owner, { allowNew, strict });
  if (initial.empty && db.name !== ':memory:' && db.name !== '') {
    const stat = fs.lstatSync(db.name);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe empty database file');
  }
  if (!initial.steps.length) return owner.inspectSchema(db, { strict });
  db.pragma('busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another initializer may have completed while this connection waited.
    const current = planDatabaseMigration(db, owner, { allowNew, strict });
    for (const step of current.steps) {
      step.migrate(db, { isNew: current.empty && step.from === current.version, from: step.from, to: step.to });
      db.pragma(`user_version = ${step.to}`);
      owner.inspectSchema(db, { strict });
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
  return owner.inspectSchema(db, { strict });
}

export function guardDatabase(db, owner, { readonly = false } = {}) {
  readonly ||= db.readonly;
  if (readonly) {
    const { steps, target, ...current } = planDatabaseMigration(db, owner, { strict: false });
    return current;
  }
  return migrateDatabase(db, owner, { allowNew: owner.supportsNewDatabase === true, strict: false });
}

export function preflightDatabase(Database, dbPath, owner, { allowMissing = false } = {}) {
  if (!fs.existsSync(dbPath)) {
    if (['-wal', '-shm', '-journal'].some(suffix => fs.existsSync(dbPath + suffix))) throw new Error(`Orphan database sidecar: ${dbPath}`);
    if (allowMissing && owner.supportsNewDatabase) {
      const empty = new Database(':memory:');
      try { planDatabaseMigration(empty, owner, { allowNew: true, strict: false }); } finally { empty.close(); }
      return { missing: true };
    }
    throw new Error(`Database not found: ${dbPath}`);
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const { steps, target, ...current } = planDatabaseMigration(db, owner, { strict: false });
    return current;
  } finally { db.close(); }
}
