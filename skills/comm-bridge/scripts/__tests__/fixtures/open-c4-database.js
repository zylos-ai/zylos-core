import os from 'node:os';

const [firstRoot, restoredRoot, accountHome] = process.argv.slice(2);
if (accountHome) {
  const info = os.userInfo();
  os.userInfo = () => ({ ...info, homedir: accountHome });
}
process.env.ZYLOS_DIR = firstRoot;
const { DB_PATH } = await import('../../c4-config.js');
const { getDb } = await import('../../c4-db.js');
if (restoredRoot) process.env.ZYLOS_DIR = restoredRoot;
try {
  const db = getDb();
  console.log(JSON.stringify({ path: db.name, configured: DB_PATH, root: process.env.ZYLOS_DIR }));
  db.close();
} catch (error) {
  console.error(JSON.stringify({ code: error.code, message: error.message, path: DB_PATH, root: process.env.ZYLOS_DIR }));
  process.exitCode = 1;
}
