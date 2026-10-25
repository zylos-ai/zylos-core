import { createRequire } from 'node:module';
import { SupervisorLifecycle } from '../../supervisor-lifecycle.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { getSessionAdapter } from '../../../../../cli/lib/runtime/index.js';
import { openTmuxConnection } from '../../../../../cli/lib/runtime/tmux-connection.js';
import { observeSessionTarget } from '../../../../../cli/lib/runtime/session-target.js';
const Database = createRequire(new URL('../../../../comm-bridge/package.json', import.meta.url))('better-sqlite3');
const [filename, socketPath, binary, pause] = process.argv.slice(2);
const database = new Database(filename);
const db = createStore(database, { readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
const options = { socketPath, binary };
const adapter = getSessionAdapter('claude', { tmux: options });
async function barrier(name) {
  if (pause === name) { process.send({ barrier: name }); await new Promise(() => {}); }
}
async function observeGroup(group) {
  let connection;
  try {
    connection = await openTmuxConnection(options);
    const observed = await observeSessionTarget({ connection, sessionGroup: group });
    // The shared fixture runs sleep, so this exercises the exited-runtime cleanup path.
    return { ...observed, sessionGroup: group, processRunning: false };
  } finally { connection?.close(); }
}
const lifecycle = new SupervisorLifecycle({ db, observeGroup,
  stop: async scene => {
    await barrier('before-stop');
    await adapter.stop({ tmuxName: scene.tmuxName, expectedRunId: scene.runId });
    await barrier('after-stop');
  },
});
await barrier('after-fence');
// Test-only negative control: an unsafe restart discards the durable authority.
if (pause === 'mutant-clear-fence') db.clearDrainFence('origin', { expectedReason: 'upgrade', expectedRunId: 'run-1' });
const result = await lifecycle.advanceReclaim(db.getDrainFence('origin'), { configuration: { mode: 'multi' },
  transition: db.getModeTransition(), fences: db.listDrainFences(), restartRequests: [], scenes: [await observeGroup('origin')] });
process.send({ result }); database.close();
