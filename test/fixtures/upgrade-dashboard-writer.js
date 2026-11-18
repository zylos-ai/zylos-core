import fs from 'node:fs';
import {createRequire} from 'node:module';
const Database = createRequire(import.meta.url)(process.env.UPGRADE_DRIVER);
const db = new Database(process.env.ZYLOS_DIR + '/components/dashboard/dashboard.db');
db.pragma('journal_mode = WAL');
const update = db.prepare('UPDATE writer_ticks SET ticks=ticks+1');
const timer = setInterval(() => update.run(), 5);
fs.writeFileSync(process.env.UPGRADE_READY, String(process.pid));
function stop() { clearInterval(timer); db.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
