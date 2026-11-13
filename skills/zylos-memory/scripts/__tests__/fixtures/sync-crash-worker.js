import fs from 'node:fs';
import path from 'node:path';
import { checkpoint, commit, list } from '../../sync-files.js';
import Database from '../../../../comm-bridge/scripts/sqlite-driver.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { createBatchReceipt } from '../../../../comm-bridge/scripts/c4-sync-batch.js';
import { projectConversation } from '../../../../comm-bridge/scripts/c4-query-format.js';
const [phase, end, token] = process.argv.slice(2);
const stop = stage => {
  fs.writeSync(1, stage + '\n');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};
const db = new Database(path.join(process.env.ZYLOS_DIR, 'comm-bridge', 'c4.db'));
const database = { ...createStore(db), getConversationsByRange: (begin, end) => db.prepare('SELECT * FROM conversations WHERE id BETWEEN ? AND ? ORDER BY id').all(begin, end) };
const after = database.getCoverageEnd('origin');
const batch = createBatchReceipt(database.getConversationsByRange(after + 1, Number(end)).map(projectConversation), { scope: 'origin', after, end: Number(end) });
await checkpoint({ token, end: Number(end), summary: `summary ${end}`, batch }, { database });
if (phase === 'before-rename') stop('checkpoint-written');
const rename = fs.renameSync;
fs.renameSync = (source, destination) => {
  rename(source, destination);
  if (path.basename(destination) === 'state.md') stop('state-published');
};
await commit({ token, input: { followedUpIds: [], inputs: await list(), batch } }, { database });
