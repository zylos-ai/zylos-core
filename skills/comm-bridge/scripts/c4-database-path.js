import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function canonicalPath(target) {
  let existing = path.resolve(target);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

export function assertTestDatabasePath(databasePath) {
  const testEntry = path.basename(process.argv[1] || '').endsWith('.test.js');
  if (!testEntry && !process.env.NODE_TEST_CONTEXT && !process.env.JEST_WORKER_ID && process.env.ZYLOS_TEST_RUN !== '1') return;
  // HOME is overridden by fixtures; the account home identifies the live instance.
  const live = canonicalPath(path.join(os.userInfo().homedir, 'zylos'));
  const relative = path.relative(live, canonicalPath(databasePath));
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
    const error = new Error('Test C4 database path points at the live instance');
    error.code = 'TEST_DATABASE_PATH_UNSAFE';
    throw error;
  }
}
