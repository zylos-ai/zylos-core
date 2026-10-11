import { migrateSchema } from './migrations.js';
import { inspectLayout } from '../../comm-bridge/scripts/sqlite-schema.js';
export const SUPPORTED_SCHEMA_VERSION = 2;
export const supportsNewDatabase = true;
// Unmarked released layouts enter the explicit schema migration chain at 0.
// TEMPORARY PR817 real-host rollback probe: a version-only committed migration.
export const MIGRATIONS = Object.freeze({
  0: Object.freeze({ to: 1, migrate: migrateSchema }),
  1: Object.freeze({ to: 2, migrate() {} })
});
export const TABLES = {
  "sessions": [
    "token",
    "created_at",
    "last_seen_at"
  ],
  "uploads": [
    "id",
    "session_token",
    "path",
    "name",
    "size",
    "size_label",
    "mime",
    "kind",
    "created_at",
    "consumed"
  ]
};
export const COLUMN_DEFINITIONS = {"sessions": {"token": {"type": "TEXT", "pk": true}, "created_at": {"type": "INTEGER", "pk": false}, "last_seen_at": {"type": "INTEGER", "pk": false}}, "uploads": {"id": {"type": "TEXT", "pk": true}, "session_token": {"type": "TEXT", "pk": false}, "path": {"type": "TEXT", "pk": false}, "name": {"type": "TEXT", "pk": false}, "size": {"type": "INTEGER", "pk": false}, "size_label": {"type": "TEXT", "pk": false}, "mime": {"type": "TEXT", "pk": false}, "kind": {"type": "TEXT", "pk": false}, "created_at": {"type": "INTEGER", "pk": false}, "consumed": {"type": "INTEGER", "pk": false}}};
export function inspectSchema(db, { allowNew = false, strict = true } = {}) {
  return inspectLayout(db, 'web-console', SUPPORTED_SCHEMA_VERSION, TABLES, { allowNew, strict, definitions: COLUMN_DEFINITIONS, legacyOptional: {} });
}
