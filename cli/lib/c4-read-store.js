import { readConfigStrict } from './config-store.js';
import path from 'node:path';

export async function openReadStore(zylosDir) {
  const [{ default: Database }, { createStore }, schema, { guardDatabase, assertCoreDatabaseAvailable }] = await Promise.all([
    import('better-sqlite3'),
    import('../../skills/comm-bridge/scripts/c4-v2-store.js'),
    import('../../skills/comm-bridge/scripts/c4-schema.js'),
    import('../../skills/comm-bridge/scripts/sqlite-schema.js'),
  ]);
  assertCoreDatabaseAvailable(zylosDir);
  const connection = new Database(path.join(zylosDir, 'comm-bridge', 'c4.db'), { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    guardDatabase(connection, schema, { readonly: true });
    return { store: createStore(connection, { readConfig: () => readConfigStrict(path.join(zylosDir, '.zylos', 'config.json')) }), close: () => connection.close() };
  } catch (error) { connection.close(); throw error; }
}
