import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import Database from 'better-sqlite3';
import { createStore } from '../../c4-v2-store.js';
import { createRouter } from '../../router/scheduler.js';
import { tmuxNameForGroup } from '../../../../../cli/lib/session-group-paths.js';

const [directory, phase, boundary] = process.argv.slice(2);
const now = 1800000000000;
const database = new Database(path.join(directory, 'c4.db'));
const store = createStore(database, { now: () => now, validateComponent: () => true,
  readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }), validateModel: () => true });
const file = name => path.join(directory, name);
const readScene = () => JSON.parse(fs.readFileSync(file('scene.json'), 'utf8'));
const record = (event, fields = {}) => fs.appendFileSync(file('events.jsonl'), JSON.stringify({ phase, event, ...fields }) + '\n');
function barrier(name) {
  if (phase !== 'crash' || name !== boundary) return;
  fs.writeFileSync(file('barrier.json'), JSON.stringify({ name, pid: process.pid }));
  // A synchronous test barrier freezes the exact observed production boundary.
  // Parent SIGKILLs this process; no graceful cleanup or finally block runs.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
function publishReady(scene) {
  const recovery = store.insertControl('recovery', { sessionGroup: 'a', priority: 0, bypassState: true, appendAckSuffix: false });
  const prompt = store.insertControl('startup', { sessionGroup: 'a', priority: 2, appendAckSuffix: false });
  scene.a.ready = true;
  scene.a.current = { runId: scene.a.runId, sessionId: scene.a.sessionId, startupControlIds: [prompt.id] };
  fs.writeFileSync(file('scene.json'), JSON.stringify(scene));
  record('ready', { recoveryId: recovery.id, promptId: prompt.id });
}
let router;
let done = false;
const db = { ...store,
  getControlById: id => database.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
  expireTimedOutControls: seconds => database.prepare("UPDATE control_queue SET status='timeout' WHERE status IN ('pending','running') AND ack_deadline_at<?").run(seconds).changes,
  cleanupControlQueue: () => {},
  recoverOrphanRunning: options => { record('recover'); return store.recoverOrphanRunning(options); },
  claimConversation: id => { const result = store.claimConversation(id); if (result) barrier('claimed'); return result; },
  expirePendingControls: options => { barrier('reserved'); const result = store.expirePendingControls(options); barrier('old-controls-expired'); return result; },
};
router = createRouter({ db, now: () => now,
  readSessionMode: () => ({ mode: 'multi', keyPresent: true }),
  readLiveIdentity: async group => readScene()[group] ?? { present: false, ready: false },
  listGroupTmuxSessions: async () => Object.entries(readScene()).map(([sessionGroup, live]) => ({ sessionGroup, tmuxName: live.tmuxName })),
  readCurrentSession: async group => readScene()[group]?.current,
  readRuntimeHealth: () => ({ health: 'ok' }),
  getSessionAdapter: () => ({ launch: async input => {
    const scene = readScene();
    if (scene.a) { record('duplicate-launch'); throw Object.assign(Error('duplicate scene'), { code: 'NAME_CONFLICT' }); }
    record('launch', { runId: input.runId });
    scene.a = { present: true, ready: false, runtime: 'claude', tmuxName: tmuxNameForGroup('a'),
      runId: input.runId, sessionId: `session-${input.runId}`, createdAt: now / 1000 };
    fs.writeFileSync(file('scene.json'), JSON.stringify(scene));
    barrier('scene-created');
    publishReady(scene); barrier('ready-published');
  }, stop: async () => { record('unexpected-stop'); throw Error('fixture scene must be adopted'); } }),
  submit: async () => { throw Error('healthy runtime must not register'); },
  deliverControl: async row => {
    record('control', { id: row.id, content: row.content });
    database.prepare("UPDATE control_queue SET status='done' WHERE id=? AND status='running'").run(row.id);
  },
  deliverConversation: async (row, live) => {
    barrier('startup-controls-delivered'); record('paste', { id: row.id }); barrier('business-pasted');
    store.markDelivered(row.id, { sessionId: live.sessionId }); record('settled', { id: row.id });
    if (phase === 'restart' && !done) {
      done = true;
      setImmediate(async () => { await router.stop(); database.close(); process.disconnect(); });
    }
  },
  handleExpired: async () => {}, prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
  diagnostic: (event, fields) => record(event, fields), alert: (event, fields) => record('alert', { alert: event, ...fields }),
}, { poolSize: 1, readyTimeoutMs: 1000, pollIntervalMs: 5 });
await router.initialize();
if (phase === 'restart') {
  process.send({ initialized: true });
  await once(process, 'message');
  const scene = readScene();
  // This fixture hook is outside Router: finish a pre-existing process startup
  // only after restart has observed the persisted unready scene.
  if (scene.a && !scene.a.ready) publishReady(scene);
}
await router.start();
