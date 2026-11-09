import fs from 'node:fs';
import path from 'node:path';
import Database from '../../../comm-bridge/scripts/sqlite-driver.js';
import { inspectDatabase } from './schema.js';
import { assertCoreDatabaseAvailable } from '../../../comm-bridge/scripts/sqlite-schema.js';

// Reset must not create or migrate the service's database just to revoke tokens.
export function clearDashboardSessions(zylosDir) {
  assertCoreDatabaseAvailable(zylosDir);
  const file = path.join(zylosDir, 'components', 'dashboard', 'dashboard.db');
  if (!fs.existsSync(file)) return;
  const db = new Database(file, { fileMustExist: true, timeout: 5000 });
  try {
    db.transaction(() => {
      const schema = inspectDatabase(db);
      if (schema.currentVersion !== schema.targetVersion) throw new Error('Dashboard database must be upgraded before sessions can be cleared');
      db.prepare('DELETE FROM auth_sessions').run();
      db.prepare('DELETE FROM api_sessions').run();
    }).immediate();
  } finally { db.close(); }
}
