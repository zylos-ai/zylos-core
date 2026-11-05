import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../../c4-v2-store.js';
import { createRouter } from '../../router/scheduler.js';
import { tmuxNameForGroup } from '../../../../../cli/lib/session-group-paths.js';

const [directory, phase, boundary] = process.argv.slice(2);
let clock = 1800000000000;
const database = new Database(path.join(directory, 'c4.db'));
const store = createStore(database, { now: () => clock, validateComponent: () => true,
  readConfig: () => ({ state: 'ok', config: { runtime: 'claude', session_mode: 'multi' } }) });
const file = name => path.join(directory, name);
const readScene = () => JSON.parse(fs.readFileSync(file('scene.json'), 'utf8'));
const record = (event, fields = {}) => fs.appendFileSync(file('events.jsonl'), JSON.stringify({ phase, event, ...fields }) + '\n');
function barrier(name) {
  if (phase !== 'crash' || boundary !== name) return;
  fs.writeFileSync(file('barrier.json'), JSON.stringify({ name, pid: process.pid }));
  // A lost parent must not leave a crash-boundary worker alive indefinitely.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10_000);
  process.stderr.write(`crash boundary ${name} timed out\n`);
  database.close();
  process.exit(2);
}
function ready(scene) {
  const prompt = store.insertControl('startup prompt', { sessionGroup: 'a', priority: 2, appendAckSuffix: false });
  scene.a.ready = true;
  scene.a.current = { runId: scene.a.runId, sessionId: scene.a.sessionId, startupControlIds: [prompt.id] };
  fs.writeFileSync(file('scene.json'), JSON.stringify(scene));
  record('ready', { promptId: prompt.id });
}
let router, finished = false;
const db = { ...store,
  getControlById: id => database.prepare('SELECT * FROM control_queue WHERE id=?').get(id),
  expireTimedOutControls: () => {}, cleanupControlQueue: () => {},
  expirePendingControls: options => { barrier('before-launch'); return store.expirePendingControls(options); },
};
router = createRouter({ db, now: () => clock,
  readSessionMode: () => ({ mode: 'multi' }),
  readLiveIdentity: async group => readScene()[group] ?? { present: false, ready: false },
  listGroupTmuxSessions: async () => Object.entries(readScene()).map(([sessionGroup, live]) => ({ sessionGroup, tmuxName: live.tmuxName })),
  readCurrentSession: async group => readScene()[group]?.current,
  readRuntimeHealth: () => ({ health: 'ok' }),
  getSessionAdapter: () => ({ launch: async input => {
    const scene = readScene();
    if (scene.a) { record('duplicate-launch'); throw Object.assign(Error('existing scene'), { code: 'NAME_CONFLICT' }); }
    record('launch', { runId: input.runId });
    scene.a = { present: true, ready: false, runtime: 'claude', tmuxName: tmuxNameForGroup('a'),
      runId: input.runId, sessionId: `session-${input.runId}`, createdAt: clock / 1000 };
    fs.writeFileSync(file('scene.json'), JSON.stringify(scene));
    barrier('before-ready'); ready(scene);
  }, stop: async () => { record('unexpected-stop'); throw Error('existing scene must be adopted'); } }),
  submit: async () => { throw Error('healthy runtime must not register'); },
  deliverControl: async row => {
    record('control', { id: row.id, content: row.content });
    database.prepare("UPDATE control_queue SET status='done' WHERE id=? AND status='running'").run(row.id);
    if (phase === 'restart' && store.listPendingContinuations().length === 0 && !finished) {
      finished = true;
      setImmediate(async () => { await router.stop(); database.close(); process.disconnect(); });
    }
  },
  deliverConversation: async () => { throw Error('no inbound in continuation fixture'); },
  handleExpired: async () => {}, prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
  diagnostic: (event, fields) => record(event, fields), alert: (event, fields) => record('alert', { alert: event, ...fields }),
}, { poolSize: () => 1, readyTimeoutMs: 1000, pollIntervalMs: 5 });
if (phase === 'restart' && boundary === 'before-launch') {
  // The dead Router cannot resume an unfinished launch: model the supervisor's observed
  // orphan selection at its adapter boundary, using the real store transaction.
  const slot = store.listSlotOccupancy().find(row => row.sessionGroup === 'a');
  if (!slot || slot.state !== 'running') throw Error('Crash lost running occupancy');
  clock = slot.createdAt * 1000 + 999;
  const orphans = [{sessionGroup:'a',runId:slot.runId}];
  if (store.pruneSlots({orphans,minAgeSeconds:1}).deletedOrphans.length !== 0) throw Error('Orphan removed before ready timeout');
  clock += 1;
  if (store.pruneSlots({orphans,minAgeSeconds:1}).deletedOrphans.length !== 1) throw Error('Expired orphan not removed');
  record('orphan-pruned', {runId:slot.runId});
}
await router.initialize();
if (phase === 'restart') {
  const scene = readScene();
  if (scene.a && !scene.a.ready) ready(scene);
}
for (let i = 0; i < 2; i++) { router.tick(); await router.idle(); await new Promise(resolve => setImmediate(resolve)); }
clock += 5000;
await router.start();
