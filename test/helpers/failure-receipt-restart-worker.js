import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import * as db from '../../skills/comm-bridge/scripts/c4-db.js';
import { createFailureAlertSender } from '../../skills/comm-bridge/scripts/failure-alert.js';
import { createFailureReceiptDrainer } from '../../skills/comm-bridge/scripts/c4-failure-receipts.js';
import { SupervisorServerHealth } from '../../cli/lib/supervisor-server-health.js';
import { fileURLToPath } from 'node:url';

const [phase, marker] = process.argv.slice(2);
function barrier(observed) {
  fs.writeFileSync(marker, JSON.stringify({ phase: observed, pid: process.pid }));
  // Stop at a real durable admission/settlement boundary until the parent
  // kills and awaits this process. No transport exists in the first gap.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const owner = new SupervisorServerHealth({
  readAlertTarget: () => ({ channel: 'owner-test', endpoint: 'owner-private' }),
  sendAlert: (target, message) => new Promise((resolve, reject) => {
    if (phase === 'reserved') barrier('reserved');
    const child = spawn(process.execPath,
      [fileURLToPath(new URL('./failure-receipt-transport.js', import.meta.url)), target.channel, target.endpoint],
      { stdio: ['pipe', 'ignore', 'ignore'] });
    child.once('error', reject);
    child.once('close', code => resolve(code === 0));
    child.stdin.on('error', () => {});
    child.stdin.end(message);
  }),
});
// Advance only the injected poll clock; durable admission and backoff survive
// restart without changing the queue record or waiting thirty real seconds.
const now = () => Date.now() + (phase === 'resume' ? 31000 : 0);
const durable = createStore(db.getDb(), { now });
const store = { ...db, listFailureReceipts: durable.listFailureReceipts, settleFailureReceipt(id, outcome) {
  return db.settleFailureReceipt(id, outcome);
} };
try {
  const sendFailureAlert = createFailureAlertSender({ db, notifyOwner: message => owner.notify(message),
    now: () => Math.floor(now() / 1000) });
  await createFailureReceiptDrainer({ db: store, sendFailureAlert, now: () => Math.floor(now() / 1000) })();
} finally { db.close(); }
