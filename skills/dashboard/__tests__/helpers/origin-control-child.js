// Isolated control boundary: real C4 validation, with a fixed observed tmux identity.
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '../../../comm-bridge/scripts/c4-v2-store.js';
import { guardDatabase } from '../../../comm-bridge/scripts/sqlite-schema.js';
import * as owner from '../../../comm-bridge/scripts/c4-schema.js';
const args = process.argv.slice(2);
const value = flag => args.includes(flag) ? args[args.indexOf(flag) + 1] : null;
const db = new Database(path.join(process.env.ZYLOS_DIR, 'controls.db'));
guardDatabase(db, owner);
const store = createStore(db, { readConfig: () => ({ state: 'ok', config: JSON.parse(fs.readFileSync(path.join(process.env.ZYLOS_DIR, '.zylos/config.json'))) }) });
try {
  const row = store.insertControl(value('--content'), { sessionGroup: value('--group'), appendAckSuffix: false,
    targetBinding: { expectedRunId: value('--target-run'), tmuxTarget: { serverGeneration: 'test', sessionId: '$1', paneId: '%1' } } });
  console.log(JSON.stringify({ ok: true, data: { id: row.id } }));
} catch (error) { console.log(JSON.stringify({ ok: false, error: { code: error.code } })); process.exitCode = 1; }
finally { db.close(); }
