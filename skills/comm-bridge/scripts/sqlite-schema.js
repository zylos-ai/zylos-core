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
export function inspectLayout(db, name, supported, tables, { allowNew = false, strict = true, allowExtraTables = !strict, allowExtraColumns = !strict, definitions = {}, migrateFromOlder = false } = {}) {
  const version = db.pragma('user_version', { simple: true });
  if (!Number.isInteger(version) || version < 0) {
    throw new Error(`${name}: invalid schema version ${version}; restore compatible code/data`);
  }
  if (version > supported) {
    throw new Error(`${name}: schema version ${version} exceeds supported ${supported}; restore compatible code/data`);
  }
  const objects = db.prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all();
  const names = objects.filter(row => row.type === 'table').map(row => row.name);
  if (!objects.length && version === 0) {
    if (!allowNew) throw new Error(`${name}: missing schema tables`);
    return { version, empty: true, extensions: { tables: [], columns: [] } };
  }
  // Version zero predates a defined baseline. Its callback gets the existing
  // layout as-is; the resulting v1 layout is checked before commit.
  if (migrateFromOlder && version < supported) return { version, empty: false, extensions: { tables: [], columns: [] } };
  if (!names.length && version === 0) throw new Error(`${name}: missing schema tables`);
  const extraColumns = [];
  for (const [table, columns] of Object.entries(tables)) {
    const info = db.prepare(`PRAGMA table_xinfo(${quote(table)})`).all();
    const actual = new Map(info.map(row => [row.name, row]));
    for (const column of columns) {
      if (!actual.has(column)) throw new Error(`${name}: unsupported schema ${version}, missing ${table}.${column}`);
      const expected = definitions[table]?.[column];
      const found = actual.get(column);
      if (expected && (found.type.toUpperCase() !== expected.type || Boolean(found.pk) !== expected.pk || found.hidden !== 0)) throw new Error(`${name}: unsupported definition for ${table}.${column}`);
    }
    for (const column of info) if (!columns.includes(column.name)) {
      // Core INSERT statements do not name locally added columns. An ordinary
      // NOT NULL column without a usable default would make those writes fail.
      const defaultSql = column.dflt_value?.trim();
      if (column.hidden === 0 && column.notnull && (defaultSql == null || /^\(*\s*NULL\s*\)*$/i.test(defaultSql))) {
        throw new Error(`${name}: unsafe extension column ${table}.${column.name}: NOT NULL without a usable default`);
      }
      extraColumns.push({ table, column: column.name });
    }
  }
  const extraTables = names.filter(table => !Object.hasOwn(tables, table));
  if (extraColumns.length && !allowExtraColumns) throw new Error(`${name}: unsupported columns ${extraColumns.map(({table,column}) => `${table}.${column}`).join(', ')}`);
  if (extraTables.length && !allowExtraTables) throw new Error(`${name}: unsupported tables in schema ${version}: ${extraTables.join(', ')}`);
  return { version, empty: false, extensions: { tables: extraTables, columns: extraColumns } };
}

const emptyChanges = () => ({ addTables: {}, maybeTables: {}, dropTables: {}, renameTables: [], rebuildTables: [], addColumns: {}, maybeColumns: {}, dropColumns: {}, renameColumns: [], alterColumns: {}, rowChanges: [] });
const own = (object, key) => Object.hasOwn(object, key);
const quote = name => `"${name.replaceAll('"', '""')}"`;
function schemaSnapshot(db) {
  const tables = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    const columns = db.prepare(`PRAGMA table_xinfo(${quote(name)})`).all();
    tables[name] = {
      columns: new Map(columns.map(column => [column.name, column])),
      rows: db.prepare(`SELECT COUNT(*) AS count FROM ${quote(name)}`).get().count,
    };
  }
  return tables;
}
function names(object) { return Object.keys(object); }
function validateChanges(step) {
  if (!step.changes || typeof step.changes !== 'object') throw new Error(`Missing schema change declaration ${step.from}→${step.to}`);
  for (const key of Object.keys(step.changes)) if (!own(emptyChanges(),key)) throw new Error(`Unknown ${key} declaration ${step.from}→${step.to}`);
  const result = { ...emptyChanges(), ...step.changes };
  for (const key of ['addTables', 'maybeTables', 'dropTables', 'addColumns', 'maybeColumns', 'dropColumns', 'alterColumns']) {
    if (!result[key] || typeof result[key] !== 'object' || Array.isArray(result[key])) throw new Error(`Invalid ${key} declaration ${step.from}→${step.to}`);
  }
  for (const key of ['renameTables', 'renameColumns', 'rebuildTables', 'rowChanges']) {
    if (!Array.isArray(result[key])) throw new Error(`Invalid ${key} declaration ${step.from}→${step.to}`);
  }
  const validName = value => typeof value === 'string' && value.length > 0;
  const validNames = list => list.every(validName) && new Set(list).size === list.length;
  for (const key of ['rebuildTables', 'rowChanges']) if (!validNames(result[key])) throw new Error(`Invalid ${key} names ${step.from}→${step.to}`);
  for (const key of ['renameTables', 'renameColumns']) {
    for (const rename of result[key]) if (!rename || typeof rename !== 'object' || !validName(rename.from) || !validName(rename.to) || rename.from === rename.to || (key === 'renameColumns' && !validName(rename.table))) throw new Error(`Invalid ${key} entry ${step.from}→${step.to}`);
  }
  for (const key of ['addTables', 'maybeTables']) for (const value of Object.values(result[key])) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${key} table definition ${step.from}→${step.to}`);
  }
  for (const value of Object.values(result.dropTables)) if (!Array.isArray(value) || !validNames(value)) throw new Error(`Invalid dropTables columns ${step.from}→${step.to}`);
  for (const key of ['addColumns', 'maybeColumns']) for (const value of Object.values(result[key])) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${key} columns ${step.from}→${step.to}`);
  }
  for (const value of Object.values(result.dropColumns)) if (!Array.isArray(value) || !validNames(value)) throw new Error(`Invalid dropColumns columns ${step.from}→${step.to}`);
  for (const key of ['addTables', 'maybeTables', 'addColumns', 'maybeColumns']) {
    for (const [table, columns] of Object.entries(result[key])) {
      if (!validName(table)) throw new Error(`Invalid ${key} table name ${step.from}→${step.to}`);
      for (const [column, definition] of Object.entries(columns)) {
        if (!validName(column) || !definition || typeof definition !== 'object' || typeof definition.type !== 'string' || !definition.type || typeof definition.pk !== 'boolean') throw new Error(`Invalid ${key} column definition ${step.from}→${step.to}`);
      }
    }
  }
  for (const [table, columns] of Object.entries(result.alterColumns)) {
    if (!validName(table) || !columns || typeof columns !== 'object' || Array.isArray(columns)) throw new Error(`Invalid alterColumns table ${step.from}→${step.to}`);
    for (const [column, definition] of Object.entries(columns)) {
      if (!validName(column) || !definition || typeof definition !== 'object' || Array.isArray(definition) ||
          typeof definition.type !== 'string' || !definition.type || typeof definition.pk !== 'boolean' ||
          typeof definition.notnull !== 'boolean' || !(definition.default === null || typeof definition.default === 'string') ||
          Object.keys(definition).some(key => !['type','pk','notnull','default'].includes(key))) {
        throw new Error(`Invalid alterColumns definition ${table}.${column} ${step.from}→${step.to}`);
      }
    }
  }
  return result;
}
function assertDefinition(name, table, column, found, expected) {
  if (!found || found.type.toUpperCase() !== expected.type.toUpperCase() || Boolean(found.pk) !== expected.pk || found.hidden !== 0) {
    throw new Error(`${name}: unsupported definition for ${table}.${column}`);
  }
}
function sameColumnDefinition(left, right) {
  return ['type','notnull','dflt_value','pk','hidden'].every(key => left[key] === right[key]);
}
function assertAlteredDefinition(name, table, column, found, expected) {
  if (!found || found.type.toUpperCase() !== expected.type.toUpperCase() || Boolean(found.pk) !== expected.pk ||
      Boolean(found.notnull) !== expected.notnull || found.dflt_value !== expected.default || found.hidden !== 0) {
    throw new Error(`${name}: declared core definition not reached for ${table}.${column}`);
  }
}
function coreColumnsBySourceVersion(owner, steps) {
  if (!steps.some(step => Object.keys(step.changes?.alterColumns || {}).length)) return new Map();
  if (!owner.TABLES || typeof owner.TABLES !== 'object') throw new Error('Core table contract required for alterColumns');
  let core = new Map(Object.entries(owner.TABLES).map(([table, columns]) => [table, new Set(columns)]));
  const byVersion = new Map();
  for (const step of [...steps].reverse()) {
    if (step.from === 0) continue;
    const prior = new Map([...core].map(([table, columns]) => [table, new Set(columns)]));
    const changes = step.changes;
    for (const table of [...names(changes.addTables), ...names(changes.maybeTables)]) prior.delete(table);
    for (const {from,to} of changes.renameTables) {
      if (prior.has(to)) {prior.set(from,prior.get(to));prior.delete(to);}
    }
    for (const [table, columns] of Object.entries(changes.dropTables)) prior.set(table,new Set(columns));
    for (const [table, columns] of Object.entries(changes.addColumns)) for (const column of names(columns)) prior.get(table)?.delete(column);
    for (const [table, columns] of Object.entries(changes.maybeColumns)) for (const column of names(columns)) prior.get(table)?.delete(column);
    for (const {table,from,to} of changes.renameColumns) if (prior.get(table)?.has(to)) {prior.get(table).delete(to);prior.get(table).add(from);}
    for (const [table, columns] of Object.entries(changes.dropColumns)) for (const column of columns) prior.get(table)?.add(column);
    byVersion.set(step.from,prior);
    core=prior;
  }
  return byVersion;
}
function beforeStep(name, before, changes, coreColumns) {
  for (const table of changes.rebuildTables) if (!own(before, table)) throw new Error(`${name}: declared rebuilt table ${table} missing`);
  for (const table of names(changes.addTables)) if (own(before, table)) throw new Error(`${name}: new core table ${table} collides with existing table`);
  for (const [table, definitions] of Object.entries(changes.maybeTables)) if (own(before, table)) {
    for (const [column, expected] of Object.entries(definitions)) assertDefinition(name, table, column, before[table].columns.get(column), expected);
  }
  for (const [table, columns] of Object.entries(changes.dropTables)) {
    if (!own(before, table)) throw new Error(`${name}: declared removed table ${table} missing`);
    const extras = [...before[table].columns.keys()].filter(column => !columns.includes(column));
    if (extras.length) throw new Error(`${name}: cannot remove ${table}; undeclared columns ${extras.map(column => `${table}.${column}`).join(', ')}`);
    const missing = columns.filter(column => !before[table].columns.has(column));
    if (missing.length) throw new Error(`${name}: cannot remove ${table}; declared columns absent ${missing.map(column => `${table}.${column}`).join(', ')}`);
  }
  for (const { from, to } of changes.renameTables) {
    if (!own(before, from) || own(before, to)) throw new Error(`${name}: invalid or colliding table rename ${from}→${to}`);
  }
  for (const [table, columns] of Object.entries(changes.addColumns)) {
    if (!own(before, table)) throw new Error(`${name}: missing table for new columns ${table}`);
    for (const column of names(columns)) if (before[table].columns.has(column)) throw new Error(`${name}: new core column ${table}.${column} collides with existing column`);
  }
  for (const [table, columns] of Object.entries(changes.maybeColumns)) {
    if (!own(before, table)) throw new Error(`${name}: missing table for optional columns ${table}`);
    for (const [column, expected] of Object.entries(columns)) if (before[table].columns.has(column)) assertDefinition(name, table, column, before[table].columns.get(column), expected);
  }
  for (const { table, from, to } of changes.renameColumns) {
    if (!own(before, table) || !before[table].columns.has(from) || before[table].columns.has(to)) throw new Error(`${name}: invalid or colliding column rename ${table}.${from}→${to}`);
  }
  for (const [table, columns] of Object.entries(changes.dropColumns)) {
    if (!own(before, table)) throw new Error(`${name}: missing table for removed columns ${table}`);
    for (const column of columns) if (!before[table].columns.has(column)) throw new Error(`${name}: declared removed column ${table}.${column} missing`);
  }
  for (const [table, columns] of Object.entries(changes.alterColumns)) {
    for (const column of names(columns)) {
      if (!before[table]?.columns.has(column) || before[table].columns.get(column).hidden !== 0 ||
          !coreColumns?.get(table)?.has(column)) {
        throw new Error(`${name}: cannot alter non-core column ${table}.${column}`);
      }
      if ((changes.dropColumns[table] || []).includes(column) || own(changes.addColumns[table] || {},column) ||
          own(changes.maybeColumns[table] || {},column) || changes.renameColumns.some(item => item.table === table && (item.from === column || item.to === column))) {
        throw new Error(`${name}: conflicting core column change ${table}.${column}`);
      }
    }
  }
}
function afterStep(name, before, after, changes) {
  const expectedTables = new Map(Object.entries(before));
  for (const table of names(changes.dropTables)) expectedTables.delete(table);
  for (const { from, to } of changes.renameTables) { expectedTables.set(to, expectedTables.get(from)); expectedTables.delete(from); }
  for (const table of [...names(changes.addTables), ...names(changes.maybeTables)]) if (!expectedTables.has(table)) expectedTables.set(table, null);
  for (const table of expectedTables.keys()) if (!own(after, table)) throw new Error(`${name}: undeclared removal of table ${table}`);
  for (const table of names(after)) if (!expectedTables.has(table)) throw new Error(`${name}: undeclared addition of table ${table}`);
  const sourceFor = target => changes.renameTables.find(rename => rename.to === target)?.from || target;
  for (const [table, previous] of expectedTables) {
    const source = sourceFor(table);
    const old = previous?.columns || new Map();
    const expected = new Set(old.keys());
    for (const column of changes.dropColumns[source] || []) expected.delete(column);
    for (const rename of changes.renameColumns.filter(item => item.table === source)) { expected.delete(rename.from); expected.add(rename.to); }
    for (const column of names(changes.addColumns[source] || {})) expected.add(column);
    for (const column of names(changes.maybeColumns[source] || {})) expected.add(column);
    if (!previous) for (const column of names(changes.addTables[table] || changes.maybeTables[table] || {})) expected.add(column);
    for (const column of expected) if (!after[table].columns.has(column)) throw new Error(`${name}: undeclared removal of column ${table}.${column}`);
    for (const column of after[table].columns.keys()) if (!expected.has(column)) throw new Error(`${name}: undeclared addition of column ${table}.${column}`);
    for (const [column, definition] of Object.entries(changes.addTables[table] || changes.maybeTables[table] || {})) {
      assertDefinition(name, table, column, after[table].columns.get(column), definition);
    }
    for (const [column, definition] of Object.entries(changes.addColumns[source] || {})) {
      assertDefinition(name, table, column, after[table].columns.get(column), definition);
    }
    for (const [column, definition] of Object.entries(changes.maybeColumns[source] || {})) {
      assertDefinition(name, table, column, after[table].columns.get(column), definition);
    }
    for (const [column, definition] of Object.entries(changes.alterColumns[source] || {})) {
      assertAlteredDefinition(name, table, column, after[table].columns.get(column), definition);
    }
    if (previous) for (const [column, definition] of old) {
      if ((changes.dropColumns[source] || []).includes(column)) continue;
      if (own(changes.alterColumns[source] || {},column)) continue;
      const target = changes.renameColumns.find(item => item.table === source && item.from === column)?.to || column;
      const retained = after[table].columns.get(target);
      if (retained && !sameColumnDefinition(definition, retained)) throw new Error(`${name}: undeclared definition change in ${table}.${target}`);
    }
    if (previous && !changes.rowChanges.includes(source) && !changes.rowChanges.includes(table) && after[table].rows !== previous.rows) {
      throw new Error(`${name}: undeclared row-count change in ${table}`);
    }
  }
}

// Planning is read-only: recognize the starting layout, then resolve every step
// before any migration runs. Owners inspect the layout for the actual version,
// rather than requiring the target version's columns at an earlier step.
export function planDatabaseMigration(db, owner, { allowNew = false, strict = true, allowExtraTables, allowExtraColumns } = {}) {
  const current = owner.inspectSchema(db, { allowNew, strict, allowExtraTables, allowExtraColumns });
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
    steps.push({ from: version, to: step.to, migrate: step.migrate, changes: version === 0 ? null : validateChanges({ ...step, from: version }) });
  }
  return { ...current, target, steps };
}

// One writer lock and one transaction cover the entire per-database chain.
// Migration callbacks must keep all changes on this SQLite connection.
export function migrateDatabase(db, owner, { allowNew = false, strict = true, allowExtraTables, allowExtraColumns } = {}) {
  if (db.readonly) throw new Error('Cannot migrate a readonly database');
  const options = { allowNew, strict, allowExtraTables, allowExtraColumns };
  const initial = planDatabaseMigration(db, owner, options);
  if (initial.empty && db.name !== ':memory:' && db.name !== '') {
    const stat = fs.lstatSync(db.name);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe empty database file');
  }
  if (!initial.steps.length) return owner.inspectSchema(db, options);
  db.pragma('busy_timeout = 5000');
  db.exec('BEGIN IMMEDIATE');
  try {
    // Another initializer may have completed while this connection waited.
    const current = planDatabaseMigration(db, owner, options);
    const coreColumns = coreColumnsBySourceVersion(owner,current.steps);
    for (const step of current.steps) {
      const before = step.from === 0 ? null : schemaSnapshot(db);
      if (before) beforeStep(owner.name || 'database', before, step.changes, coreColumns.get(step.from));
      step.migrate(db, { isNew: current.empty && step.from === current.version, from: step.from, to: step.to });
      if (before) afterStep(owner.name || 'database', before, schemaSnapshot(db), step.changes);
      db.pragma(`user_version = ${step.to}`);
      owner.inspectSchema(db, options);
    }
    db.exec('COMMIT');
  } catch (error) {
    if (db.inTransaction) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { error.rollbackError = rollbackError; }
    }
    throw error;
  }
  return owner.inspectSchema(db, options);
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
