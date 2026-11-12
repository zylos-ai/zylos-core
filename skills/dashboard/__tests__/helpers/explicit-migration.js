import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { dashboardSchemaOwner } from '../../src/lib/schema-owner.js';

// Existing Dashboard data is migrated only through the explicit owner path
// (upgrade worker or first takeover); an ordinary Store open refuses it.
export function migrateDashboardFile(file) {
  const db = new Database(file, { fileMustExist: true });
  try { return dashboardSchemaOwner.migrate(db); } finally { db.close(); }
}
