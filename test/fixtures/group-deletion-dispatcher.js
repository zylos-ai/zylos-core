import fs from 'node:fs';
import path from 'node:path';
import { runtimeTools } from '../helpers/group-deletion-runtime.js';
import { createSessionReader } from '../../cli/lib/session-state-reader-async.js';
import { getSessionAdapter } from '../../cli/lib/runtime/index.js';
import { readReadyIdentity } from '../../cli/lib/runtime/session-target.js';
process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
const { main } = await import('../../skills/comm-bridge/scripts/c4-dispatcher.js');
const { createDispatcher } = await import('../../skills/comm-bridge/scripts/router/factory.js');
const tools = runtimeTools(process.env), root = process.env.ZYLOS_DIR;
const tmux = { socketPath: process.env.GROUP_DELETION_TEST_SOCKET };
const reader = createSessionReader({ env: process.env, connectionOptions: tmux });
await main({ create: () => createDispatcher({
  ...reader,
  readCurrentSession: group => readReadyIdentity(group, process.env),
  readSessionState: async group => ({ identity: await reader.readLiveIdentity(group), status: { valid: true,
    value: { state: 'idle', idle_seconds: 60, health: 'ok', proc: { alive: true } } } }),
  readRuntimeHealth: () => ({ health: 'ok' }),
  getSessionAdapter(runtime) {
    const adapter = getSessionAdapter(runtime, { env: process.env, tmux });
    return Object.assign(adapter, {
      // Model invocation is the test boundary; production activation owns the
      // run id/claim/slot, and observes this real terminal through F2/F3.
      launch: async ({ sessionGroup, runId }) => tools.startRuntime(sessionGroup, { runId }),
    });
  },
  notifyDelivered() {}, sendStatusNotice: async () => {},
  diagnostic(event, fields) {
    const diagnostics = path.join(root, 'dispatcher-diagnostics.jsonl');
    if (!fs.existsSync(diagnostics) || fs.statSync(diagnostics).size < 262144) fs.appendFileSync(diagnostics, JSON.stringify({ event, ...fields }) + '\n');
    if (event === 'deliver') fs.appendFileSync(path.join(root, 'delivery-receipts.jsonl'), JSON.stringify(fields) + '\n');
  },
}, { tmux, delivery: { captureEnabled: false, periodicEnabled: false, verifyWaitMs: 20 }, pollIntervalMs: 50 }) });
