import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { EventEmitter } from 'node:events';

assert.ok(process.env.ZYLOS_CHAT_INTEGRATION === '1');
assert.equal(fs.realpathSync(process.env.HOME), process.env.HOME);
assert.ok(process.env.TEST_PRIVATE_SOCKET.startsWith(path.dirname(process.env.HOME) + path.sep));

if (process.argv.includes('--deliver')) {
  const { openTmuxConnection } = await import('../../cli/lib/runtime/tmux-connection.js');
  const { resolveSessionTarget } = await import('../../cli/lib/runtime/session-target.js');
  const { SessionAdapter } = await import('../../cli/lib/runtime/session-adapter.js');
  const connection = await openTmuxConnection({ socketPath: process.env.TEST_PRIVATE_SOCKET });
  try {
    const target = await resolveSessionTarget({ sessionGroup: 'origin', connection });
    const adapter = new SessionAdapter();
    await adapter.sendText({ connection, target, text: 'dashboard-delivery-control' });
    await adapter.sendKeys({ connection, target, keys: ['Enter'] });
    console.log('DELIVERED');
  } finally { connection.close(); }
} else {
  // Block optional version checks. Backend state/usage/tmux providers remain real.
  https.get = () => {
    const request = Object.assign(new EventEmitter(), { destroy() {} });
    queueMicrotask(() => request.emit('error', new Error('External HTTPS disabled by isolated test')));
    return request;
  };
  const { createServer } = await import('../../skills/dashboard/src/index.js');
  const server = createServer();
  server.listen(0, '127.0.0.1', () => console.log(`DASHBOARD_URL=http://127.0.0.1:${server.address().port}`));
  process.on('SIGTERM', async () => {
    server.closeAllConnections();
    await server.closeAttachments();
    server.close(() => process.exit(0));
  });
}
