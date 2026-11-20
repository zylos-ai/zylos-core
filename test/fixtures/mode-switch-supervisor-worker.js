// Disposable supervisor process: real socket, lifecycle queue, loop and private C4.
// Runtime observation and peripheral workers are bounded providers; no runtime,
// dispatcher, tmux server, PM2 daemon or external sender is started here.
import Database from 'better-sqlite3';
import path from 'node:path';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import { readSessionMode, readZylosConfigOrThrow } from '../../cli/lib/config.js';
import { startSupervisor } from '../../skills/activity-monitor/scripts/supervisor-main.js';

const root = process.env.ZYLOS_DIR;
const database = new Database(path.join(root, 'comm-bridge/c4.db'));
database.pragma('journal_mode=WAL'); database.pragma('busy_timeout=1000');
const store = createStore(database, { validateComponent: () => true, validateModel: () => true,
  readConfig: () => ({ state: 'ok', config: readZylosConfigOrThrow() }) });
let forbiddenCalls = 0;
const forbidden = () => { forbiddenCalls++; throw new Error('runtime mutation or external action forbidden in supervisor crash fixture'); };
let service, stopping, operations = Promise.resolve();
const state = () => ({ forbiddenCalls, phase: store.getModeTransition()?.phase ?? null,
  gates: store.listDrainFences().map(row => row.sessionGroup) });
const stop = () => stopping ??= (async () => {
  await operations; await service?.stop();
  if (service?.server.listening) throw new Error('Supervisor socket still listening during cleanup');
  database.close();
  process.disconnect?.();
})();
try {
  service = await startSupervisor({ env: process.env,
    db: { ...store, getDb: () => database },
    readMode: readSessionMode, readConfig: readZylosConfigOrThrow, legacyPresent: () => false,
    scenes: { observe: async () => [], observeGroup: async () => ({ present: false }),
      readIdentity: async () => ({ present: false }), listRuns: async () => [], readRun: async () => null,
      stop: forbidden, bindTarget: forbidden },
    resolveTargetRuntime: () => 'claude', checkAuth: async () => ({ status: 'authenticated' }),
    readSyncMarker: () => ({ held: false, stale: false }),
    legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
    loopOptions: { schedule: () => 1, cancel() {} },
    writeMode: forbidden, restartDispatcherConfirmation: { advance: forbidden },
    sendAlert: forbidden, log() {},
  });
  process.on('message', message => {
    operations = operations.then(async () => {
      if (!['tick', 'state'].includes(message?.type) || !Number.isSafeInteger(message.id)) throw new Error('Unexpected worker IPC request');
      if (message.type === 'tick') await service.supervisor.loop.tick();
      process.send?.({ type: message.type === 'tick' ? 'ticked' : 'state', id: message.id, ...state() });
    }).catch(error => { process.send?.({ type: 'failed', error: error.message }); process.exitCode = 1; void stop(); });
  });
  process.on('SIGTERM', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  process.on('disconnect', () => { void stop().catch(error => { console.error(error.message); process.exitCode = 1; }); });
  process.send?.({ type: 'ready', ...state() });
} catch (error) {
  console.error(error.stack ?? error.message); await stop(); process.exitCode = 1;
}
