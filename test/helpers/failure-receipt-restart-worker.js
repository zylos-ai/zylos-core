import fs from 'node:fs';
import { spawn } from 'node:child_process';
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
const store = { ...db, settleFailureReceipt(id, outcome) {
  if (phase === 'sent' && outcome === 'sent') barrier('sent');
  return db.settleFailureReceipt(id, outcome);
} };
try {
  const drain = createFailureReceiptDrainer({ db: store, sendStatusNotice: sender });
  await drain();
} finally { db.close(); }
