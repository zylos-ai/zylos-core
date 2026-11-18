// Disposable process used to exercise recovery after actual process death.
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { getMaxConversationId } from '../../../../comm-bridge/scripts/c4-db.js';
import { appendInbox } from '../../../../zylos-memory/scripts/memory-append.js';
import { GlobalMemoryHandoverCoordinator } from '../../global-memory-handover.js';

const [root, filename, point] = process.argv.slice(2);
const database = new Database(filename);
const store = createStore(database, { validateComponent: () => true,
  readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
const kill = () => process.kill(process.pid, 'SIGKILL');
const io = Object.create(fs);
io.renameSync = (source, destination) => {
  if (point === 'before-plan' && destination.endsWith('/plan.json')) kill();
  fs.renameSync(source, destination);
  if (point === 'plan' && destination.endsWith('/plan.json')) kill();
  if (point === 'rename' && destination.endsWith('/previous/_global/inbox.md')) kill();
};
const owner = new GlobalMemoryHandoverCoordinator({
  zylosDir: root, db: { ...store, getMaxConversationId: () => getMaxConversationId(database),
    insertControl: (...args) => { const result = store.insertControl(...args); if (point === 'enqueue') kill(); return result; } },
  readMode: () => ({ keyPresent: true, mode: 'multi' }), readRequests: () => [],
  legacyPresent: () => false, observe: () => [], fsImpl: io,
  append: async settings => { const result = await appendInbox(settings); if (point === 'append') kill(); return result; },
});
const result = await owner.advance();
database.close();
if (result?.failed) throw new Error(JSON.stringify(result));
