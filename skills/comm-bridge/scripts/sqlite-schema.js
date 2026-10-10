import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Legacy runtime directories need no recovery validation until materials exist.
// Damaged recovery links count as materials so absence cannot hide a transaction.
function hasRecoveryMaterials(root) {
  const present = file => {
    try { return fs.lstatSync(file); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  // Unmarked clean terminals are history, not authority to execute recovery.
  // Inspect only bounded JSON/structure here, without owner/mode checks or code.
  const cleanTerminal = (j, id) => {
    const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
    const absolute = value => typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
    const dbs = ['comm-bridge/c4.db', 'scheduler/scheduler.db', 'web-console/web-console.db'];
    if (!j || j.formatVersion !== 1 || j.transactionId !== id || j.zylosDir !== fs.realpathSync(root) ||
        !['upgrade_complete', 'restored_complete', 'aborted_before_install'].includes(j.phase) ||
        j.cleanup?.complete !== true || j.cleanup.servicesRestored !== true || j.terminalEvidence?.verified !== true ||
        j.terminalServicesStopped || j.installerExitUnconfirmed || j.finalizerExitUnconfirmed ||
        j.installerStarted && !j.installerExitConfirmed || j.finalizerStarted && !j.finalizerExitConfirmed) return false;
    const aborted = j.phase === 'aborted_before_install', i = j.initialIdentity;
    if (j.installationIntent !== !aborted || j.terminalEvidence.kind !== (aborted ? 'original_deployment_and_readonly_data' : 'code_data_services') ||
        !i || Array.isArray(i) || !absolute(j.nodePath) || i.nodePath !== j.nodePath || j.skillsDir !== path.join(j.zylosDir, '.claude', 'skills') ||
        !absolute(i.packageJson) || !digest(i.packageHash) || !absolute(i.cliRoot) || !digest(i.cliHash) ||
        !absolute(i.workerPath) || !digest(i.workerHash) || i.ecosystemHash !== null && !digest(i.ecosystemHash) ||
        !Array.isArray(i.databases) || i.databases.length !== dbs.length || i.databases.some((d, index) => !d || d.source !== dbs[index] || typeof d.exists !== 'boolean') ||
        !Array.isArray(j.coreManifest) || !j.coreManifest.length || j.coreManifest.length > 256 ||
        !Array.isArray(j.originalServices) || j.originalServices.some(s => !s || typeof s.name !== 'string' || !s.name || !absolute(s.script))) return false;
    const members = new Set();
    for (const e of j.coreManifest) {
      if (!e || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(e.name) || members.has(e.name) || typeof e.existedBefore !== 'boolean' ||
          typeof e.backedUp !== 'boolean' || (e.existedBefore ? !aborted && !e.backedUp || !digest(e.originalHash) : e.originalHash !== null)) return false;
      members.add(e.name);
    }
    return aborted || j.dbBackupDir === path.join(j.zylosDir, '.backup', 'db', id) && digest(j.snapshotManifestHash);
  };
  try {
    if (present(path.join(root, '.zylos/upgrade/active.json'))) return true;
    for (const relative of ['.zylos', '.zylos/upgrade', '.backup', '.backup/self-upgrade']) {
      const file = path.join(root, relative), stat = present(file);
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        if (relative !== '.zylos' && relative !== '.backup' || !fs.statSync(file).isDirectory()) return true;
      } else if (!stat.isDirectory()) return true;
    }
    const active = path.join(root, '.backup/self-upgrade');
    if (!present(active)) return false;
    const entries = fs.readdirSync(active, {withFileTypes:true});
    if (entries.length > 10000) return true;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}$/.test(entry.name)) return true;
      const file = path.join(active, entry.name, 'journal.json'), stat = present(file);
      if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024 ||
          !cleanTerminal(JSON.parse(fs.readFileSync(file, 'utf8')), entry.name)) return true;
    }
    // A marker published during the scan takes precedence over clean history.
    return !!present(path.join(root, '.zylos/upgrade/active.json'));
  } catch {
    return true;
  }
}

export function assertCoreDatabaseAvailable(root) {
  if (!hasRecoveryMaterials(root)) return;
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
  for (const relative of ['.zylos/upgrade/active.json']) {
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
