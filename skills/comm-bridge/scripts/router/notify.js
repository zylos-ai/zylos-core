import net from 'node:net';
import path from 'node:path';
import { ACTIVITY_MONITOR_DIR } from '../c4-config.js';

// A one-way hint: callers start this after paste without awaiting it. Neither
// an acknowledgment nor a failed connection can change the delivery ledger.
export function notifyDelivered(notification, options = {}) {
  return notifySupervisor('notify_delivered', notification, options);
}

export function notifyDeliveryFailed(notification, options = {}) {
  return notifySupervisor('notify_delivery_failed', notification, options);
}

function notifySupervisor(type, { conversationId, controlId, channel, sessionGroup, runId, sessionId, runtime, pastedAt }, {
  socketPath = path.join(ACTIVITY_MONITOR_DIR, 'am.sock'),
  timeoutMs = 5000,
  createConnection = net.createConnection,
} = {}) {
  return new Promise(resolve => {
    let socket, timer, settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve();
    }
    try {
      const line = JSON.stringify({
        version: 2, type, requestId: `dispatcher-${process.pid}-${pastedAt}`,
        conversationId, controlId, channel, sessionGroup, runId, sessionId, runtime, pastedAt,
      }) + '\n';
      timer = setTimeout(settle, timeoutMs);
      socket = createConnection(socketPath);
      socket.on('error', settle);
      socket.on('close', settle);
      socket.on('connect', () => {
        if (settled) return;
        try { socket.end(line, settle); } catch { settle(); }
      });
    } catch { settle(); }
  });
}
