import { inspectLayout } from '../../comm-bridge/scripts/sqlite-schema.js';
export const SUPPORTED_SCHEMA_VERSION = 1;
export const supportsNewDatabase = true;
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
export function inspectSchema(db, { allowNew = false } = {}) {
  return inspectLayout(db, 'web-console', SUPPORTED_SCHEMA_VERSION, TABLES, { allowNew, definitions: COLUMN_DEFINITIONS, legacyOptional: {} });
}
