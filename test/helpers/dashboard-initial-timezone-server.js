import fs from 'node:fs';
import path from 'node:path';
import { sendJson } from '../../skills/dashboard/src/lib/http.js';
import { workbenchAnswer } from '../../skills/dashboard/__tests__/fixtures/workbench-browser-api.js';

// Every Dashboard module is real, including the version checker. The parent
// routes this process's outbound HTTPS through a local proxy that refuses every
// tunnel, so the real check() fails offline and its errors are swallowed.
const root = process.env.ZYLOS_DIR;
fs.writeFileSync(path.join(root, '.env'), 'TZ=Asia/Singapore\n');
fs.writeFileSync(path.join(root, 'components/dashboard/config.json'), JSON.stringify({ auth: { password: 'initial-timezone-password' } }));
const { createServer } = await import('../../skills/dashboard/src/index.js');
const server = createServer();
const handler = server.listeners('request')[0];
server.removeAllListeners('request');
const streams = new Set();
server.on('request', (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (url.pathname === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`event: instance\ndata: ${JSON.stringify({ session_mode: { sessionMode: 'multi', transition: null, globalGate: null, blocked: null, supervisor: 'reachable', lastCompleted: null, lastEvents: [] }, agent: { name: 'browser-case' }, updated_at: '2026-11-15T02:00:00Z' })}\n\n`);
    streams.add(res); res.on('close', () => streams.delete(res)); return;
  }
  if (url.pathname.startsWith('/api/')) {
    const value = workbenchAnswer(url, Date.now());
    if (url.pathname === '/api/instance') {
      value.accounts.claude = { used_percentage: 42, live: false, recordedAt: Date.parse('2026-11-14T15:59:00Z') };
    }
    return sendJson(res, value === undefined ? 404 : 200, value ?? { error: 'not_found' });
  }
  return handler(req, res);
});
server.listen(0, '127.0.0.1', () => fs.writeFileSync(path.join(root, 'listener.json'),
  JSON.stringify({ origin: `http://127.0.0.1:${server.address().port}`, pid: process.pid })));
process.once('SIGTERM', () => {
  for (const stream of streams) stream.end();
  server.closeAllConnections(); server.close();
});
