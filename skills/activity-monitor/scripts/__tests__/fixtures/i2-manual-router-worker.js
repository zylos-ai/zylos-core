// Real M1 dispatcher composition; only state freshness and external launch failure
// are controlled. Paste/keys use the production adapter and bound tmux target.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createDispatcher } from '../../../../comm-bridge/scripts/router/factory.js';
import { createStore } from '../../../../comm-bridge/scripts/c4-v2-store.js';
import { createSessionReader } from '../../../../../cli/lib/session-state-reader-async.js';
import { getSessionAdapter } from '../../../../../cli/lib/runtime/index.js';
const Database = createRequire(new URL('../../../../comm-bridge/package.json', import.meta.url))('better-sqlite3');
const [root, socketPath, binary, mode, scenario] = process.argv.slice(2);
const database = new Database(path.join(root, 'comm-bridge/c4.db'));
const config = { runtime: 'claude', session_mode: mode };
let offset = 0, releasePaste, held = false;
const now = () => Date.now() + offset;
const store = createStore(database, { now, readConfig: () => ({ state: 'ok', config }), validateComponent: () => true });
const db = { ...store, getDb: () => database, insertControl: (...args) => store.insertControl(...args).id,
  getControlById: id => database.prepare('SELECT * FROM control_queue WHERE id=?').get(id), expireTimedOutControls: () => 0, cleanupControlQueue: () => 0 };
const env = { ...process.env, HOME: root, ZYLOS_DIR: root }, tmux = { socketPath, binary, configFile: '/dev/null' };
const reader = createSessionReader({ env, connectionOptions: tmux });
const trace = (kind, fields = {}) => fs.appendFileSync(path.join(root, 'manual-router.jsonl'), JSON.stringify({ kind, ...fields }) + '\n');
const router = createDispatcher({ env, db, now, readSessionMode: () => ({ mode, keyPresent: true }),
  readZylosConfigStrict: () => ({ state: 'ok', config }),
  readSessionState: async group => ({ identity: await reader.readLiveIdentity(group), status: { valid: true, value: { state: 'idle', idle_seconds: 10, health: 'ok', proc: { alive: true } } } }),
  readRuntimeHealth: () => ({ missing: true }),
  getSessionAdapter: runtime => {
    const adapter = getSessionAdapter(runtime, { env, root, tmux, runtimeExecutable: () => '/bin/false' });
    const paste = adapter.sendText.bind(adapter), keys = adapter.sendKeys.bind(adapter), launch = adapter.launch.bind(adapter);
    adapter.sendText = async input => {
      await paste(input); trace('paste', { runId: input.target.runId, text: input.text });
      if (scenario === 'inflight' && !held && input.target.runId === 'run-1') {
        held = true; process.send({ barrier: 'after-real-paste', runId: input.target.runId });
        await new Promise(resolve => { releasePaste = resolve; });
      }
    };
    adapter.sendKeys = async input => { trace('keys-attempt', { runId: input.target.runId, keys: input.keys }); await keys(input); trace('keys-sent', { runId: input.target.runId, keys: input.keys }); };
    adapter.launch = async input => { trace('launch', { input }); try { const result = await launch(input); trace('launch-return', { input, result }); return result; } catch(error) { trace('launch-error', { input, code: error.code, message: error.message }); throw error; } };
    return adapter;
  },
  sleep: async () => {}, notifyDelivered: data => trace('notify', data),
  prepareSingle: async () => {}, findLegacySessions: async () => [], advanceLegacy: async () => {},
  handleExpired: async () => {}, formatConversation: row => row.content,
  diagnostic: (event, fields) => trace('diagnostic', { event, ...fields }), diagnostics: { maintain() {} }, log: message => trace('log', { message }),
}, { tmux, poolSize: 4, readyTimeoutMs: 100, delivery: { periodicEnabled: false, verifyWaitMs: 1, verifyAttempts: 1, captureEnabled: false } });
await router.initialize(); await router.idle();
process.on('message', async message => {
  const { id, op } = message;
  try {
    let result;
    if (op === 'tick') { offset += 1000; router.tick(); await delay(10); }
    else if (op === 'release') releasePaste();
    else if (op === 'drain') await router.idle();
    else if (op === 'state') result = { resident: router.state.resident, activations: [...router.state.activations.keys()], ready: router.state.ready };
    else if (op === 'stop') { releasePaste?.(); await router.stop(); database.close(); process.send({ id, result: true }); process.disconnect(); return; }
    else throw new Error(`Unknown operation ${op}`);
    process.send({ id, result });
  } catch(error) { process.send({ id, error: error.stack }); }
});
process.send({ ready: true });
