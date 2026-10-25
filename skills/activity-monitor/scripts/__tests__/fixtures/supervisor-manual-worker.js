import { createRequire } from 'node:module';
import { SupervisorLifecycle } from '../../supervisor-lifecycle.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
import { RestartRequestStore } from '../../restart-request-store.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
const Database = createRequire(new URL('../../../../comm-bridge/package.json', import.meta.url))('better-sqlite3');
const [filename, socketPath, binary, requestsFile, mode, pause] = process.argv.slice(2);
const database = new Database(filename);
const db = createStore(database, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: mode } }) });
async function barrier(name) {
  if (pause === name) { process.send({ barrier: name }); await new Promise(() => {}); }
}
const scenes = new SupervisorScenes({ env: process.env, connectionOptions: { socketPath, binary }, readMode: () => ({ mode }) });
const requests = new RestartRequestStore({ file: requestsFile });
const set = db.setDrainFence, clear = db.clearDrainFence;
db.setDrainFence = async (...args) => { const value = set(...args); await barrier('after-fence'); return value; };
db.clearDrainFence = async (...args) => { const value = clear(...args); await barrier('after-clear'); return value; };
const lifecycle = new SupervisorLifecycle({ db, requests,
  observeGroup: group => scenes.observeGroup(group),
  stop: async scene => { await scenes.stop(scene); await barrier('after-stop'); },
});
await barrier('after-intent');
await lifecycle.advanceManual({ configuration: { mode }, transition: db.getModeTransition(),
  fences: db.listDrainFences(), restartRequests: requests.read(), scenes: await scenes.observe({ configuration: { mode } }) });
process.send({ result: requests.read().length === 0 ? 'done' : 'pending' });
database.close();
