// Process fixture: production dispatcher scheduler / supervisor entry, real SQLite, socket and tmux.
// External runtime, clock, transport faults and D3 terminal outcomes are injected.
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { startSupervisor } from '../../supervisor-main.js';
import { SupervisorScenes } from '../../supervisor-scenes.js';
import { createRouter } from '../../../../comm-bridge/scripts/router/scheduler.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { guardDatabase } from '../../../../comm-bridge/scripts/sqlite-schema.js';
import * as schema from '../../../../comm-bridge/scripts/c4-schema.js';
import { submit } from '../../../../../cli/lib/am-sock-client.js';
import { createSessionReader } from '../../../../../cli/lib/session-state-reader-async.js';
import { readRuntimeHealth } from '../../../../../cli/lib/session-state-reader.js';
import { readReadyIdentity } from '../../../../../cli/lib/runtime/session-target.js';
import { getSessionAdapter } from '../../../../../cli/lib/runtime/index.js';
import { listGroupTmuxSessions } from '../../../../../cli/lib/session-group-paths.js';
const Database = createRequire(import.meta.url)('better-sqlite3');
const [role, root, tmuxSocket, binary, initialClock] = process.argv.slice(2);
let clock = Number(initialClock), fault = '', service, router;
const held = [];
const traceFile = path.join(root, `${role}.jsonl`);
const trace = (kind, data = {}) => fs.appendFileSync(traceFile, JSON.stringify({ kind, pid: process.pid, clock, ...data }) + '\n');
const config = () => JSON.parse(fs.readFileSync(path.join(root, '.zylos/config.json'), 'utf8'));
const sqlite = new Database(path.join(root, 'comm-bridge/c4.db'));
guardDatabase(sqlite, schema); sqlite.pragma('journal_mode=WAL');
const store = createStore(sqlite, { now: () => clock, readConfig: () => ({ state: 'ok', config: config() }), validateComponent: () => true, validateModel: () => true });
const db = { ...store, insertControl:(...args)=>store.insertControl(...args).id, getDb: () => sqlite, getControlById: id => sqlite.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
  expireTimedOutControls: () => 0, cleanupControlQueue: () => 0 };
const env = { ...process.env, HOME: root, ZYLOS_DIR: root };
const tmux = { socketPath: tmuxSocket, binary, configFile: '/dev/null' };
const reader = createSessionReader({ env, connectionOptions: tmux });
const readMode = () => ({ mode: config().session_mode, keyPresent: true });
if (role === 'm4') {
  const scenes = new SupervisorScenes({ env, connectionOptions: tmux, readMode });
  service = await startSupervisor({ env, db, scenes, now: () => clock, readMode,
    readConfiguration: () => ({ mode: config().session_mode, runtime: 'claude', capacity: 4 }),
    resolveTargetRuntime: group => db.resolveSessionLaunchConfig({ sessionGroup: group, sessionMode: config().session_mode }).runtime,
    machineTasks: { tick() {}, stop() {} }, legacyStatus: { tick() {}, close() {} },
    sendAlert: async () => { throw new Error('external send forbidden'); }, log: value => trace('log', { value }),
    loopOptions: { schedule: () => 1, cancel() {} } });
  const peers=new Set();service.server.on('connection',socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket))});
  const realRegister = service.supervisor.health.registerStartAttempt.bind(service.supervisor.health);
  service.supervisor.health.registerStartAttempt = async request => {
    trace('request', { request });
    // Deliberate negative-control defects are local to this fixture process.
    if(fault==='bad-backoff'){const s=service.supervisor.health.store(request.runtime),v=s.read();v.scheduling.lastRecoveryAt=0;s.write(v)}
    const response = await realRegister(request);
    trace('persisted-response', { request, response, health: service.supervisor.health.store(request.runtime).read() });
    if (fault === 'hold' && response.result === 'registered') await new Promise(resolve => held.push(resolve));
    if(fault==='no-reply')for(const socket of peers)socket.destroy();
    if (fault === 'invalid' && response.result === 'registered') response.reason = 'invalid-reason';
    return response;
  };
} else {
  router = createRouter({ db, now: () => clock, readSessionMode: readMode,
    readLiveIdentity: reader.readLiveIdentity, readCurrentSession: readReadyIdentity,
    listGroupTmuxSessions: () => listGroupTmuxSessions(tmux), readRuntimeHealth,
    getSessionAdapter: runtime => {
      const adapter = getSessionAdapter(runtime, { root, env, tmux, runtimeExecutable: () => path.join(root, runtime) });
      const launch = adapter.launch.bind(adapter);
      adapter.launch = async input => { trace('launch', { input, f10: JSON.parse(fs.readFileSync(path.join(root, 'activity-monitor/runtime-health', `${runtime}.json`), 'utf8')) }); return launch(input); };
      return adapter;
    },
    submit: async request => {
      trace('request', { request, round:router.state.round });
      const result = await submit(request, { socketPath: path.join(root, 'activity-monitor/am.sock'), replyMaxMs: 150 });
      trace('reply', { request, result });
      if (fault === 'pause-grant' && result.kind === 'accepted') await new Promise(resolve => held.push(resolve));
      if (fault === 'fence-grant' && result.kind === 'accepted') db.setDrainFence(request.sessionGroup, { reason: 'manual_restart', runId: request.runId });
      return result;
    },
    deliverControl: async row => sqlite.prepare("UPDATE control_queue SET status='done' WHERE id=?").run(row.id),
    deliverConversation: async (row, live) => db.markDelivered(row.id, { sessionId: live.sessionId }),
    handleExpired: async () => {}, prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
    diagnostic: (event, fields) => trace('diagnostic', { event, ...fields }), log: value => trace('log', { value }),
  }, { poolSize: 4, readyTimeoutMs: 10000 });
  await router.initialize();
}
process.on('message', async message => {
  const { id, op, ...arg } = message;
  try {
    let result;
    if (op === 'clock') clock = arg.now;
    else if (op === 'fault') fault = arg.value;
    else if (op === 'release') { while (held.length) held.shift()(); }
    else if (op === 'round') { router.tick(); for(let i=0;i<6;i++) { await router.idle(); await delay(0); } }
    else if (op === 'scan') await service.supervisor.loop.runRound();
    else if (op === 'seed') {
      const s = service.supervisor.health.store(arg.runtime || 'claude'), value = s.read();
      value.health = arg.health || 'unavailable'; value.reason = value.health === 'rate_limited' ? 'rate_limit' : 'runtime_unavailable';
      Object.assign(value.scheduling, arg.budget || {}); s.write(value);
    } else if (op === 'health') result = service.supervisor.health.store(arg.runtime || 'claude').read();
    else if (op === 'message') {
      const request={version:2,type:'route',requestId:'input-'+clock,noReply:false,receivedAt:clock,channel:'fixture',endpoint:'input',componentName:'fixture',sessionGroup:arg.group || 'chat'};
      result=await new Promise((resolve,reject)=>{const socket=net.createConnection(path.join(root,'activity-monitor/am.sock'));let text='';socket.on('error',reject);socket.on('connect',()=>socket.write(JSON.stringify(request)+'\n'));socket.on('data',chunk=>text+=chunk);socket.on('end',()=>{try{resolve(JSON.parse(text))}catch(e){reject(e)}})});trace('route',{request,result});
    }
    else if (op === 'settled') result = [...router.state.activations.values()].map(a=>({settled:a.launchSettled,group:a.group}));
    else if (op === 'live') result = await reader.readLiveIdentity(arg.group);
    else if (op === 'runtime') result = db.setSessionRuntimeConfig({sessionGroup:arg.group,runtime:arg.runtime});
    else if (op === 'probe') {
      const observer=service.supervisor.observer;
      const pending=observer.requestProbe('claude',{force:true});
      await Promise.all([...observer.preparations]);
      const probe=observer.probes.get('claude');
      if(!probe?.controlId) throw new Error('probe did not create D3: '+JSON.stringify({result:await pending,live:await reader.readLiveIdentity(arg.group),trace:fs.readFileSync(traceFile,'utf8')}));
      if(probe.scene.sessionGroup!==arg.group)throw new Error('wrong probe scene: '+probe.scene.sessionGroup);
      sqlite.prepare('UPDATE control_queue SET status=?,last_error=? WHERE id=?').run(arg.terminal==='STALE_TARGET'?'failed':arg.terminal||'failed',arg.terminal==='STALE_TARGET'?'STALE_TARGET':null,probe.controlId);
      if(fault==='bad-group-link'){const association=service.supervisor.health.associations.get('claude');if(association?.sessionGroup===probe.scene.sessionGroup)association.runId=probe.scene.runId;}
      await observer.pollProbe(probe);result=await pending;trace('probe',{group:arg.group,runId:probe.scene.runId,controlId:probe.controlId,result});
    } else if (op === 'exit') await service.supervisor.health.noteRunExited('claude', arg.runId);
    else if (op === 'add') {
      const row = db.insertConversation('in', arg.group, 'fixture', 'incoming');
      sqlite.prepare("UPDATE conversations SET timestamp=datetime(?,'unixepoch') WHERE id=?").run(clock / 1000, row.id); result = row;
    } else if (op === 'fence') result = db.setDrainFence(arg.group, { reason: 'upgrade', runId: 'fixture' });
    else if (op === 'unfence') result = db.clearDrainFence(arg.group);
    else if (op === 'stop') { await router?.stop(); await service?.stop(); sqlite.close(); process.send({ id, result: true }); process.disconnect(); return; }
    else throw new Error(`unknown op ${op}`);
    process.send({ id, result });
  } catch (error) { process.send({ id, error: error.stack }); }
});
process.send({ ready: true, role, pid: process.pid });
