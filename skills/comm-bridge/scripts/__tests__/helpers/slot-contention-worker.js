import Database from 'better-sqlite3';
import { createStore } from '../../c4-v2-store.js';

const [filename, sessionGroup] = process.argv.slice(2);
const db = new Database(filename, { timeout: 5000 });
const store = createStore(db, { now: () => 1800000000000,
  readConfig: () => ({ state: 'ok', config: { session_mode: 'multi' } }) });
const deadline = setTimeout(() => { db.close(); process.exit(2); }, 10000);
process.once('message', () => {
  let result;
  try { result = { result: store.takeSlot(sessionGroup, { runId: 'contender', k: 1 }) }; }
  catch (error) { result = { error: error.code ?? error.message }; }
  clearTimeout(deadline); db.close();
  process.send(result, () => process.exit(result.error ? 1 : 0));
});
process.send({ ready: true });
