import Database from 'better-sqlite3';
import { dataError } from './c4-session-group.js';
export function withDeadlineRead(filename, owner, deadlineAt, operation, { now = Date.now, open = (file, options) => new Database(file, options) } = {}) {
  if (!Number.isFinite(deadlineAt)) throw dataError('INVALID_ARGS', 'deadlineAt must be Unix milliseconds');
  let connection;
  let budgetLimited = false;
  function timeout() {
    const remaining = deadlineAt - now();
    if (remaining <= 0) throw dataError('deadline_exceeded', 'Read deadline elapsed');
    budgetLimited = remaining <= 5000;
    return Math.max(0, Math.floor(Math.min(5000, remaining)));
  }
  try {
    connection = open(filename, { readonly: true, fileMustExist: true, timeout: timeout() });
    connection.pragma(`busy_timeout = ${timeout()}`);
    const layout = owner.inspectSchema(connection, { strict: false });
    if (layout.version !== undefined && layout.version !== owner.SUPPORTED_SCHEMA_VERSION) throw dataError('DB_READ_FAILED', 'Read requires the current schema');
    connection.pragma(`busy_timeout = ${timeout()}`);
    return operation(connection);
  } catch (error) {
    if (error.code?.startsWith('SQLITE_BUSY')) throw dataError(budgetLimited && now() >= deadlineAt ? 'deadline_exceeded' : 'DB_BUSY', error.message, { cause: error });
    throw error;
  } finally { connection?.close(); }
}
