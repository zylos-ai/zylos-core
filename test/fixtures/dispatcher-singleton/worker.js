import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSessionReader } from '../../../cli/lib/session-state-reader-async.js';

// Only the model terminal and its health observation are fixture
// boundaries. Ownership, recovery, scheduling, claims, tmux target guards,
// paste, Enter and database settlement all execute production code.
export async function run(version) {
  // A fixture-only launch barrier reproduces PM2 publishing its process then
  // losing the pidfile before production ownership admission starts.
  const barrier = process.env.SINGLETON_ADMISSION_BARRIER;
  if (barrier) while (!fs.existsSync(barrier)) await delay(20);
  process.env.C4_DISPATCHER_DISABLE_MAIN = '1';
  const { main } = await import('../../../skills/comm-bridge/scripts/c4-dispatcher.js');
  const { createDispatcher } = await import('../../../skills/comm-bridge/scripts/router/factory.js');
  const tmux = { socketPath: process.env.SINGLETON_TMUX_SOCKET };
  const reader = createSessionReader({ env: process.env, connectionOptions: tmux });
  const event = (type, fields = {}) => fs.appendFileSync(path.join(process.env.ZYLOS_DIR, 'owners.jsonl'),
    JSON.stringify({ type, pid: process.pid, version, ...fields }) + '\n');
  await main({ create() {
    event('create');
    const dispatcher = createDispatcher({ ...reader,
      readSessionState: async group => ({ identity: await reader.readLiveIdentity(group),
        status: { valid: true, value: { state: 'idle', idle_seconds: 60, health: 'ok', proc: { alive: true } } } }),
      readRuntimeHealth: () => ({ health: 'ok' }),
      notifyDelivered(fields) { event('pasted', fields); }, sendStatusNotice: async () => {},
      diagnostic(type, fields) { if (type === 'deliver') event('deliver', fields); },
    }, { tmux, pollIntervalMs: 40, delivery: { captureEnabled: false, periodicEnabled: false, verifyWaitMs: 20 } });
    return { ...dispatcher, async stop() { await dispatcher.stop(); event('stop'); } };
  } });
}
