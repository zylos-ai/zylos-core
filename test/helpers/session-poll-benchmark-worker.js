import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [repo, service, durationRaw, view] = process.argv.slice(2);
const duration = Number(durationRaw);
const load = relative => import(pathToFileURL(path.join(repo, relative)).href);
let stop, timer;
let error;
const report = failure => { error ??= failure; };
let finish;
const elapsed = new Promise(resolve => { finish = resolve; timer = setTimeout(resolve, duration); });
const interrupted = () => finish();
process.on('SIGTERM', interrupted); process.on('SIGINT', interrupted);
try {
  if (service === 'dashboard') {
    const { CoreState } = await load('skills/dashboard/src/lib/core-state.js');
    const core = new CoreState({ zylosDir: process.env.ZYLOS_DIR });
    stop = () => core.stop();
    core.setWatched?.(view === 'watched');
    await core.start();
    if (core.snapshot.state === 'UNKNOWN') throw new Error(JSON.stringify(core.snapshot));
  } else if (service === 'monitor') {
    const { SupervisorScenes } = await load('skills/activity-monitor/scripts/supervisor-scenes.js');
    const { createSupervisor } = await load('skills/activity-monitor/scripts/supervisor.js');
    const { RestartRequestStore } = await load('skills/activity-monitor/scripts/restart-request-store.js');
    const cleanups = [];
    const { fixture } = await load('skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js');
    const database = fixture({ after(fn) { cleanups.unshift(fn); } }, {
      readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
    const scenes = new SupervisorScenes({ env: process.env,
      connectionOptions: { socketPath: process.env.BENCH_SOCKET, binary: process.env.BENCH_CLIENT },
      readMode: () => ({ mode: 'multi' }), reportError: report });
    const supervisor = createSupervisor({ db: database.store, scenes, env: process.env, zylosDir: process.env.ZYLOS_DIR,
      readConfiguration: async () => ({ mode: 'multi', runtime: 'claude', capacity: 12 }),
      readMode: () => ({ mode: 'multi' }), resolveTargetRuntime: async () => 'claude',
      prompts: { REFERENCE_REORG_PROMPT: 'Reference organization check' }, prepareReferenceReorg: async () => false,
      requestStore: new RestartRequestStore({ file: path.join(process.env.ZYLOS_DIR, 'requests.json') }),
      log: value => { if (value.error) report(new Error(JSON.stringify(value))); },
      loopOptions: { schedule: () => 1, cancel() {} } });
    scenes.readActivity = scene => supervisor.readActivity(scene);
    await supervisor.loop.start();
    const interval = setInterval(() => supervisor.loop.tick().catch(report), 1000);
    stop = async () => { clearInterval(interval); await supervisor.stop(); for (const cleanup of cleanups) await cleanup(); };
  } else if (service === 'dispatcher') {
    const cleanups = [];
    const { fixture } = await load('skills/comm-bridge/scripts/__tests__/c4-v2-test-helpers.js');
    const database = fixture({ after(fn) { cleanups.unshift(fn); } }, {
      readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
    const { createDispatcher } = await load('skills/comm-bridge/scripts/router/factory.js');
    const db = { ...database.store,
      getControlById: id => database.db.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
      expireTimedOutControls: () => 0, cleanupControlQueue: () => 0 };
    const dispatcher = createDispatcher({ env: process.env, db,
      readSessionMode: () => ({ mode: 'multi' }), log() {}, diagnostic() {}, maintainDiagnostics() {},
    },
      { tmux: { socketPath: process.env.BENCH_SOCKET, binary: process.env.BENCH_CLIENT } });
    stop = async () => { await dispatcher.stop(); for (const cleanup of cleanups) await cleanup(); };
    await dispatcher.start();
  } else throw new Error('Unknown benchmark service');
  await elapsed;
  if (error) throw error;
} finally {
  clearTimeout(timer); await stop?.();
  process.removeListener('SIGTERM', interrupted); process.removeListener('SIGINT', interrupted);
}
