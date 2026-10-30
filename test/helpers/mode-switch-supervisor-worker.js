import fs from 'node:fs';
import path from 'node:path';
import { startSupervisor } from '../../skills/activity-monitor/scripts/supervisor-main.js';
import * as db from '../../skills/comm-bridge/scripts/c4-db.js';
import { createModeSwitchConverter } from '../../skills/activity-monitor/scripts/mode-switch-convert.js';
import { readSessionMode, writeSessionModeAtCutover } from '../../cli/lib/config.js';
const fault = process.argv[2] ?? '';
const logs = [], events = [];
let restartCalls = 0, confirmationCalls = 0, service, runtimeScenes = [];
const stoppedRuns = [];
let injectedFailure = '';
const convert = createModeSwitchConverter({db,zylosDir:process.env.ZYLOS_DIR});
const pause = label => { process.send({ boundary: label }); return new Promise(() => {}); };
const database = { ...db };
const setPhase = db.setModeTransitionPhase;
database.setModeTransitionPhase = async (...args) => {
  if (args[1] === 'complete' && fault === 'before-complete') return pause('before-complete');
  const result = setPhase(...args);
  if (args[1] === 'complete' && fault === 'after-complete') return pause('after-complete');
  return result;
};
const findScene = group => runtimeScenes.find(scene => scene.sessionGroup === group || group === null && scene.sessionGroup === 'origin') ?? { present:false };
const scenes = { observe: async () => runtimeScenes.map(scene=>({...scene})), observeGroup: async group => ({...findScene(group)}), readIdentity: async group => ({...findScene(group)}), listRuns: async () => runtimeScenes.filter(scene=>scene.present), readRun: async group => findScene(group), stop: async scene => { stoppedRuns.push(scene.runId); runtimeScenes = runtimeScenes.filter(value=>value.runId !== scene.runId); } };
const snapshot = () => ({ row: db.getModeTransition(), last: db.getLastCompletedModeTransition(), fences: db.listDrainFences(), mode: readSessionMode(), logs, restartCalls, confirmationCalls, stoppedRuns, messages:db.getDb().prepare('SELECT id,status FROM conversations ORDER BY id').all() });
service = await startSupervisor({ db: database, scenes, legacyPresent: async () => false,
  legacyStatus: { tick() {}, close() {} }, machineTasks: { tick() {}, stop() {} },
  convertModeTransition: row => { if (['export','check'].includes(injectedFailure)) throw Object.assign(new Error('fixture conversion I/O failure'),{code:'EIO',step:injectedFailure}); return convert(row); },
  loopOptions: { schedule: () => 1, cancel() {} },
  writeMode: async mode => {
    if (injectedFailure==='config') throw Object.assign(new Error('fixture lock timeout'),{code:'CONFIG_LOCK_TIMEOUT'});
    if (fault === 'before-config') return pause('before-config');
    const result = writeSessionModeAtCutover(mode);
    if (fault === 'after-config') return pause('after-config');
    return result;
  },
  restartLauncherConfirmation: { advance: async () => {
    if (injectedFailure==='pm2') return {confirmed:false,pending:false};
    if (!restartCalls) { restartCalls++; return { confirmed: false, pending: true }; }
    confirmationCalls++;
    if (fault === 'before-confirm') return pause('before-confirm');
    return { confirmed: true, pending: false };
  } },
  readSyncMarker: async () => ({ held: false, stale: false }),
  sendAlert: () => { throw new Error('external notification forbidden'); }, log: value => logs.push(value),
});
process.send({ ready: true, ...snapshot() });
process.on('message', async message => {
  try {
    if (message === 'tick') { await service.supervisor.loop.tick(); process.send(snapshot()); }
    else if (message === 'snapshot') process.send(snapshot());
    else if (message === 'stop') { await service.stop(); process.send({ stopped: true }); process.disconnect(); }
    else if (Object.hasOwn(message ?? {},'controlGroup')) { db.getDb().prepare("INSERT INTO control_queue(raw_content,content,status,ack_deadline_at,created_at,updated_at,session_group) VALUES('control','control','running',NULL,1,1,?)").run(message.controlGroup); process.send(snapshot()); }
    else if (message === 'expire-controls') { for(const row of db.getDb().prepare("SELECT id FROM control_queue WHERE status='running'").all()) db.expireControlById(row.id); process.send(snapshot()); }
    else if (Object.hasOwn(message ?? {},'failure')) { injectedFailure=message.failure; process.send(snapshot()); }
    else if (message?.scenes) { runtimeScenes=message.scenes; process.send(snapshot()); }
    else if (message?.seed) {
      const connection = db.getDb();
      const add = connection.prepare("INSERT INTO conversations(direction,channel,endpoint_id,content,status,session_group) VALUES('in','fixture',?,?,'pending',?)");
      for (const row of message.seed) add.run(row.endpoint ?? 'frozen', row.content, row.group ?? '');
      process.send({ seeded: message.seed.length });
    }
  } catch (error) { process.send({ error: error.code ?? error.message, stack: error.stack }); }
});
