import path from 'node:path';
import { loadCoreConfigStore } from './core-config-loader.js';
import { OPEN_MODE_TRANSITION } from './c4-transition-state.js';

// Migration callbacks are synchronous. Load pure readers without importing
// config.js; choose the instance path only when an ambiguous row needs F1.
const { readConfigStrict, configUnreadable } = await loadCoreConfigStore();
function sessionModeKeyPresent() {
  const root = process.env.ZYLOS_DIR || path.join(process.env.HOME, 'zylos');
  const result = readConfigStrict(path.join(root, '.zylos', 'config.json'));
  if (result.state === 'error') throw configUnreadable(result.error);
  if (result.state === 'missing' || !Object.hasOwn(result.config, 'session_mode')) return false;
  if (!['single', 'multi'].includes(result.config.session_mode)) {
    throw configUnreadable(new TypeError('session_mode must be "single" or "multi"'));
  }
  return true;
}
const quote = value => `"${value.replaceAll('"', '""')}"`;

export function migrateToV5(db) {
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    if (db.prepare(`PRAGMA foreign_key_list(${quote(name)})`).all()
      .some(key => key.table.toLowerCase() === 'mode_transitions')) {
      throw new Error(`Cannot rebuild mode_transitions: table ${quote(name)} has a foreign key referencing mode_transitions`);
    }
  }
  const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='mode_transitions'").get()?.sql;
  const phaseCheck = /\bCHECK\s*\(\s*phase\s+IN\s*\(\s*'(?:[^']|'')*'(?:\s*,\s*'(?:[^']|'')*')*\s*\)\s*\)/gi;
  if (!sql || [...sql.matchAll(phaseCheck)].length !== 1) throw new Error('Mode transition phase constraint is unavailable or ambiguous');
  const rewritten = sql.replace(phaseCheck, "CHECK (phase IN ('gating','converting','cutover','complete','cancelled'))")
    .replace(/^CREATE\s+TABLE\s+(?:"mode_transitions"|`mode_transitions`|\[mode_transitions\]|mode_transitions)/i, 'CREATE TABLE mode_transitions_release_migration')
    // Prepend the column so deployment-owned table constraints remain last.
    .replace(/^(CREATE TABLE mode_transitions_release_migration\s*\()/i, "$1kind TEXT NOT NULL DEFAULT 'switch' CHECK (kind IN ('switch','first_migration')),");
  if (rewritten === sql || !rewritten.startsWith('CREATE TABLE mode_transitions_release_migration')) throw new Error('Mode transition table definition is unavailable');
  const objects = db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name='mode_transitions' AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name").all();
  const columns = db.prepare('PRAGMA table_xinfo(mode_transitions)').all().filter(row => row.hidden === 0).map(row => quote(row.name)).join(',');
  const needsConfig = Boolean(db.prepare(`SELECT 1 FROM mode_transitions WHERE ${OPEN_MODE_TRANSITION} AND cutoff IS NULL LIMIT 1`).get());
  const missingKey = needsConfig && !sessionModeKeyPresent();
  const kind = `CASE
    WHEN cutoff IS NOT NULL AND source_mode='single' THEN 'first_migration'
    WHEN ${OPEN_MODE_TRANSITION} AND cutoff IS NULL AND ? THEN 'first_migration'
    ELSE 'switch' END`;
  const legacy = db.pragma('legacy_alter_table', { simple: true });
  db.pragma('legacy_alter_table = ON');
  try {
    db.exec(rewritten);
    db.prepare(`INSERT INTO mode_transitions_release_migration (${columns},kind) SELECT ${columns},${kind} FROM mode_transitions`).run(missingKey ? 1 : 0);
    db.exec('DROP TABLE mode_transitions; ALTER TABLE mode_transitions_release_migration RENAME TO mode_transitions');
    for (const object of objects) {
      if (object.type !== 'index' || object.name.toLowerCase() !== 'idx_mode_transitions_open') db.exec(object.sql);
    }
    db.exec(`CREATE UNIQUE INDEX idx_mode_transitions_open ON mode_transitions((0)) WHERE ${OPEN_MODE_TRANSITION}`);
  } finally { db.pragma(`legacy_alter_table = ${legacy ? 'ON' : 'OFF'}`); }
}
