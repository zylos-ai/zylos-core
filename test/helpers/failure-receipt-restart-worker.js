import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createStore } from '../../skills/comm-bridge/scripts/c4-v2-store.js';
import * as db from '../../skills/comm-bridge/scripts/c4-db.js';
import { createStatusNoticeSender } from '../../skills/comm-bridge/scripts/c4-status-notice.js';
import { createFailureReceiptDrainer } from '../../skills/comm-bridge/scripts/c4-failure-receipts.js';
import { fileURLToPath } from 'node:url';

const [phase, marker] = process.argv.slice(2);
function barrier(observed) {
  fs.writeFileSync(marker, JSON.stringify({ phase: observed, pid: process.pid }));
  // Deliberately keep this process alive at a real synchronous product boundary
  // until the parent kills and awaits it. No transport exists in the first gap.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}
const sender = createStatusNoticeSender({ db, diagnostic() {}, log() {},
  script: fileURLToPath(new URL('./failure-receipt-transport.js', import.meta.url)),
  spawn: (...args) => {
    if (phase === 'reserved') barrier('reserved');
    return spawn(...args);
  },
});
// Restart preserves the persisted schedule; advance only the injected clock
// to the next eligible poll instead of waiting 30 seconds in this fixture.
const now = () => Date.now() + (phase === 'resume' ? 31000 : 0);
const durable = createStore(db.getDb(), { now });
const store = { ...db, listFailureReceipts: durable.listFailureReceipts, settleFailureReceipt(id, outcome) {
  if (phase === 'sent' && outcome === 'sent') barrier('sent');
  return db.settleFailureReceipt(id, outcome);
} };
try {
  const drain = createFailureReceiptDrainer({ db: store, sendStatusNotice: sender, now: () => Math.floor(now() / 1000) });
  await drain();
} finally { db.close(); }
