import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startSupervisor } from '../../supervisor-main.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { SupervisorLifecycle } from '../../supervisor-lifecycle.js';
import { RestartRequestStore } from '../../restart-request-store.js';
const Database = createRequire(new URL('../../../../comm-bridge/package.json', import.meta.url))('better-sqlite3');
const [socketPath, binary, mode, variant = ''] = process.argv.slice(2);
const root = process.env.ZYLOS_DIR, database = new Database(path.join(root, 'comm-bridge/c4.db'));
const runtime = JSON.parse(fs.readFileSync(path.join(root, '.zylos/config.json'))).runtime;
const store = createStore(database, { readConfig: () => ({ state: 'ok', config: { runtime, session_mode: mode } }) });
let busy = false, syncHeld = false, stopped = [], events = [], pauseRead = false, releaseRead;
const barrier = name => { if (variant === name) { process.send({ barrier: name }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); } };
const requestStore = new RestartRequestStore({ file: path.join(root, 'activity-monitor/restart-requests.json') });
const publish = requestStore.publish;
requestStore.publish = (file, rows) => {
  barrier(rows.length ? 'before-intent' : 'before-remove'); publish(file, rows); barrier(rows.length ? 'after-intent' : 'after-remove');
};
const scenes = new SupervisorScenes({ env: process.env, connectionOptions: { socketPath, binary }, readMode: () => ({ mode }),
  readActivity: () => ({ state: busy ? 'running' : 'idle', idleSince: busy ? null : 1 }), readUsage: () => null });
const originalReadRun = scenes.readRun.bind(scenes);
scenes.readRun = async group => {
  if (pauseRead) { pauseRead = false; process.send({ barrier: 'reading-target' }); await new Promise(resolve => { releaseRead = resolve; }); }
  return originalReadRun(group);
};
const originalStop = scenes.stop.bind(scenes);
scenes.stop = async scene => { stopped.push({ runId: scene.runId, runtime: scene.runtime, target: scene.tmuxTarget }); const result = await originalStop(scene); barrier('after-stop'); return result; };
if (variant === 'clear-manual') {
  const original = SupervisorLifecycle.prototype.advanceReclaim;
  SupervisorLifecycle.prototype.advanceReclaim = async function(fence, context, options) {
    if (fence.reason === 'manual_restart') return this.clear(fence, context);
    return original.call(this, fence, context, options);
  };
}
const db = { ...store, getDb: () => database,
  setDrainFence(...args) { const result = store.setDrainFence(...args); barrier('after-fence'); return result; },
  clearDrainFence(...args) { const result = store.clearDrainFence(...args); barrier('after-clear'); return result; },
};
if (variant === 'early-clear') { db.countRunningConversations = () => 0; db.countGlobalRunningConversations = () => 0; }
if (variant === 'retarget') {
  const original = SupervisorLifecycle.prototype.advanceManual;
  SupervisorLifecycle.prototype.advanceManual = async function(context) {
    for (const request of context.restartRequests.filter(row => row.reason === 'manual_restart')) {
      const scene = this.scene(request.mode === 'single' ? null : 'origin', context);
      if (scene.present) request.expectedRunId = scene.runId;
    }
    return original.call(this, context);
  };
}
if (variant === 'waiting') {
  db.countRunningConversations = group => {
    const count = store.countRunningConversations(group);
    if (count > 0 && store.getDrainFence(group)?.reason === 'upgrade') {
      process.send({ barrier: 'waiting_inflight', count });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
    }
    return count;
  };
}
const service = await startSupervisor({ env: process.env, db, scenes, requestStore,
  readMode: () => ({ mode }), readConfiguration: () => ({ mode, runtime, capacity: 4 }), resolveTargetRuntime: () => runtime,
  readSyncMarker: () => ({ held: syncHeld, stale: false }), machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} },
  restoreTransition: async () => { if (variant === 'clear-all') database.exec('DELETE FROM drain_fences'); },
  sendAlert: () => {}, log: event => events.push(event), loopOptions: { schedule: () => 1, cancel() {} } });
const state = async () => ({ requests: service.supervisor.admission.store.read(), fences: store.listDrainFences(),
  scene: await scenes.observeGroup(mode === 'single' ? null : 'origin'), stopped, events,
  running: store.countGlobalRunningConversations() });
process.send({ ready: true, ...(await state()) });
process.on('message', async command => {
  try {
    if (command === 'arm-read') pauseRead = true;
    if (command === 'release-read') releaseRead();
    if (command === 'tick') await service.supervisor.loop.tick();
    if (command === 'busy') { busy = true; syncHeld = true; }
    if (command === 'stop') { await service.stop(); database.close(); process.send({ stopped: true }); process.disconnect(); return; }
    process.send(await state());
  } catch (error) { process.send({ error: error.stack }); }
});
