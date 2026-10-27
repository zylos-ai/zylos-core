/** Add explicit saved routing facts without inferring targets for existing tasks. */
export function migrateToV2(db) {
  db.exec('ALTER TABLE tasks ADD COLUMN session_component TEXT');
  db.exec('ALTER TABLE tasks ADD COLUMN session_group_name TEXT');
}
