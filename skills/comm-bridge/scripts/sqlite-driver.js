import { createRequire } from 'node:module';

/**
 * The one SQLite driver of this process.
 *
 * Several installed copies of better-sqlite3 can be reachable from one process: the Core package's own, the comm-bridge
 * skill's, and any other copy under `.claude/skills/<name>/node_modules`. Two copies are two independent SQLite
 * libraries even at the same version. When one copy closes a connection to a database file, the process loses every
 * POSIX lock it holds on that file, including the locks of the other copy's open connections; another process then
 * believes it is the last connection, checkpoints and removes the WAL and shared-memory files, and the remaining reader
 * keeps reading the removed shared memory and never sees new rows again.
 *
 * So every module that opens SQLite takes the driver from here. Each installed copy of this file resolves the
 * better-sqlite3 next to it, but the first one loaded in the process is kept under a process-wide symbol and every
 * later copy of this file returns that same driver.
 */
const DRIVER = Symbol.for('zylos.better-sqlite3');

const Database = globalThis[DRIVER] ??= createRequire(import.meta.url)('better-sqlite3');

export default Database;
